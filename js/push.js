// Background alerts: notify.js fires alerts locally while the app is open;
// this computes the same kind of alerts (heads-up, leave-now) ahead of time
// and hands the finished text + timestamps to the push relay, which
// delivers them via the browser's Push API even if ClassMapper is fully
// closed by then. All the scheduling logic — what to say, when to say it —
// still happens here, on-device; the relay only ever sees the result.

import * as S from './schedule.js';
import * as B from './buildings.js';
import * as R from './route.js';
import { settings } from './store.js';
import { RELAY_URL, VAPID_PUBLIC_KEY } from './push-config.js';

export function configured() {
  return Boolean(RELAY_URL && VAPID_PUBLIC_KEY);
}

function urlBase64ToUint8Array(base64url) {
  const pad = '='.repeat((4 - (base64url.length % 4)) % 4);
  const base64 = (base64url + pad).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

export async function getSubscription() {
  if (!('serviceWorker' in navigator)) return null;
  const reg = await navigator.serviceWorker.getRegistration();
  if (!reg) return null;
  return reg.pushManager.getSubscription();
}

export async function isSubscribed() {
  return Boolean(await getSubscription());
}

/** Subscribes this browser to push, registering the service worker first if it isn't already (background alerts don't require opting into offline mode — the two are independent uses of the same worker). */
export async function subscribe() {
  if (!configured()) throw new Error('Background alerts need a relay deployed first — see push-relay/README.md.');
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    throw new Error("This browser doesn't support background push.");
  }
  const wanted = new URL('sw.js', location.href).href;
  const reg = (await navigator.serviceWorker.getRegistration()) ?? (await navigator.serviceWorker.register(wanted));
  await navigator.serviceWorker.ready;
  const existing = await reg.pushManager.getSubscription();
  if (existing) return existing;
  return reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
  });
}

/** Unsubscribes and asks the relay to forget anything still pending for this browser — best effort, since the relay's own TTL cleans up regardless. */
export async function unsubscribe() {
  const sub = await getSubscription();
  if (!sub) return;
  if (configured()) {
    try {
      await fetch(`${RELAY_URL}/unschedule`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscription: sub.toJSON() }),
      });
    } catch {
      // Relay unreachable — the subscription still gets torn down locally.
    }
  }
  await sub.unsubscribe();
}

let lastSyncAt = 0;
const SYNC_THROTTLE_MS = 3 * 60 * 1000;

/**
 * Recomputes upcoming alerts (heads-up + leave-now, mirroring notify.js's
 * own wording) for classes in roughly the next 20 hours and sends them to
 * the relay. Safe to call often — internally throttled — so callers don't
 * need to reason about when it's "worth" syncing.
 *
 * `here`, if given, is your current `{lat, lon}` — used only to estimate a
 * walk time for the very next class. Every class after that chains its
 * origin from the previous one's building, the same way the day-route
 * feature already does; a day's first class beyond that has no way to know
 * where you'll be standing, so it's skipped rather than guessed at.
 */
export async function syncSchedule(here, { force = false } = {}) {
  if (!configured()) return;
  if (!force && Date.now() - lastSyncAt < SYNC_THROTTLE_MS) return;

  const sub = await getSubscription();
  if (!sub) return;
  lastSyncAt = Date.now();

  const cfg = settings();
  const classes = S.list();
  const now = new Date();
  const horizon = new Date(now.getTime() + 20 * 60 * 60 * 1000);

  const occurrences = [S.nextClass(now, classes, cfg), ...S.upcoming(now, classes, 12, cfg)]
    .filter(Boolean)
    .filter((o) => o.startsAt <= horizon && !o.isNow);

  const alerts = [];
  let originPoint = here ?? null;
  const lastBuildingByDay = new Map();

  for (const occ of occurrences) {
    const b = occ.cls.buildingId ? B.get(occ.cls.buildingId) : null;
    if (!b) continue;

    const dayKey = S.localDateStr(occ.startsAt);
    const origin = originPoint ?? lastBuildingByDay.get(dayKey) ?? null;
    lastBuildingByDay.set(dayKey, b);
    originPoint = null; // only the very first occurrence gets the live position
    if (!origin) continue; // no way to estimate this one's walk time

    const route = await R.walk(origin, b);
    const walkMin = route?.minutes ?? 0;
    const leaveAt = S.leaveBy(occ.startsAt, walkMin, cfg.bufferMin);
    const code = occ.cls.code || occ.cls.title || 'class';
    const body = `${walkMin} min walk to ${b.name}${occ.cls.room ? ` · Room ${occ.cls.room}` : ''}`;
    // Deliberately includes dayKey, unlike notify.js's local tags
    // (`${cls.id}:${cls.startMin}`) — a recurring weekly class reuses the
    // same id+startMin on every occurrence, and relay entries can sit
    // pending for up to a day, so the date has to be part of the identity
    // here to avoid two different Mondays' alerts colliding. notify.js's
    // local firing doesn't need this since its "already fired" state is
    // itself scoped to today and reset daily.
    const idBase = `${occ.cls.id}:${occ.cls.startMin}:${dayKey}`;

    if (cfg.headsUpAlert) {
      alerts.push({ tag: `${idBase}:headsup`, sendAt: leaveAt.getTime() - 10 * 60000, title: `Leave in about 10 min for ${code}`, body });
    }
    alerts.push({ tag: idBase, sendAt: leaveAt.getTime(), title: `Time to leave for ${code}`, body });
  }

  const subJson = sub.toJSON();

  // Clear before replacing rather than merging — otherwise a deleted class,
  // a changed time, or a settings change (buffer, passing period) would
  // leave its old alert sitting in the relay's queue to fire anyway. The
  // relay's own TTL is a backstop for this, not the primary mechanism.
  try {
    await fetch(`${RELAY_URL}/unschedule`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscription: subJson }),
    });
  } catch (err) {
    console.warn('Push unschedule (pre-sync clear) failed', err);
  }

  if (!alerts.length) return;

  alerts.sort((a, b) => a.sendAt - b.sendAt);
  const trimmed = alerts.slice(0, 50); // matches the relay's own cap

  try {
    await fetch(`${RELAY_URL}/schedule`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscription: subJson, alerts: trimmed }),
    });
  } catch (err) {
    console.warn('Push schedule sync failed', err);
  }
}
