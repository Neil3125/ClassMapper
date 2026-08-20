// "Leave by" alerts.
//
// Browser notifications only fire while the app is open — going further needs a
// push server, which this app deliberately doesn't have. Each class fires at
// most once per day per alert kind, tracked in storage so a refresh doesn't
// re-alert you.
//
// Snooze/Got it buttons only render on a notification shown through an active
// service worker registration — that's a browser platform limit, not a
// choice made here (plain `new Notification()` supports no actions in any
// browser). Offline mode is opt-in, so most users won't have a worker
// registered; fire() below feature-detects and falls back to a plain
// Notification with no actions but still-working tag-based replacement.

import { read, write, KEYS, settings, saveSettings } from './store.js';
import { fmtDistance } from './route.js';

export function supported() {
  return 'Notification' in window;
}

export function permission() {
  return supported() ? Notification.permission : 'unsupported';
}

export async function enable() {
  if (!supported()) throw new Error("This browser doesn't support notifications");
  const result = await Notification.requestPermission();
  if (result !== 'granted') {
    saveSettings({ notifications: false });
    throw new Error('Notifications were blocked. Enable them in your browser site settings.');
  }
  saveSettings({ notifications: true });
  return true;
}

export function disable() {
  saveSettings({ notifications: false });
}

export function enabled() {
  return settings().notifications && permission() === 'granted';
}

export function alertCueEnabled() {
  return Boolean(settings().alertCue);
}

export function headsUpEnabled() {
  return Boolean(settings().headsUpAlert);
}

/**
 * A short vibration pattern plus a two-tone beep, synthesised with Web Audio
 * so there's no audio file to fetch — offline mode stays unaffected. Silent
 * notifications are easy to miss with a phone in a pocket or on silent-but-
 * vibrate; this gives leave-by alerts a second, harder-to-miss channel.
 */
export function playAlertCue() {
  try {
    if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
  } catch {
    // Vibration API is a nice-to-have; never let it break the alert itself.
  }

  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const now = ctx.currentTime;

    [[880, now], [1175, now + 0.16]].forEach(([freq, start]) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.001, start);
      gain.gain.exponentialRampToValueAtTime(0.2, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, start + 0.14);
      osc.connect(gain).connect(ctx.destination);
      osc.start(start);
      osc.stop(start + 0.15);
    });

    // Let the tail finish, then release the audio context.
    setTimeout(() => ctx.close().catch(() => {}), 500);
  } catch (err) {
    console.warn('Alert tone failed', err);
  }
}

function todayKey(d = new Date()) {
  // Local-date key, built from parts so there's no UTC shift.
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

function fired() {
  const store = read(KEYS.FIRED, {});
  const key = todayKey();
  if (store.day !== key) return { day: key, ids: [] };
  return store;
}

function markFired(id) {
  const store = fired();
  if (!store.ids.includes(id)) store.ids.push(id);
  write(KEYS.FIRED, store);
}

function unmarkFired(id) {
  const store = fired();
  const i = store.ids.indexOf(id);
  if (i === -1) return;
  store.ids.splice(i, 1);
  write(KEYS.FIRED, store);
}

export function alreadyFired(id) {
  return fired().ids.includes(id);
}

// ---------- snooze ----------

function snoozeMap() {
  return read(KEYS.SNOOZED, {});
}

export function isSnoozed(id, now = new Date()) {
  const until = snoozeMap()[id];
  return typeof until === 'number' && now.getTime() < until;
}

/** Silences an alert id for `minutes`, and clears its fired flag so it can fire again once the snooze lapses rather than staying suppressed for the rest of the day. */
export function snooze(id, minutes = 5) {
  const map = snoozeMap();
  map[id] = Date.now() + minutes * 60000;
  write(KEYS.SNOOZED, map);
  unmarkFired(id);
}

// ---------- pure timing predicates ----------
// No storage or Notification API involved — easy to unit test against plain
// Date fixtures, and it keeps the "when does this fire" logic in one place
// per alert kind instead of buried in each fire path below.

export function shouldFireHeadsUp(now, leaveAt, minsBefore = 10) {
  return now >= new Date(leaveAt.getTime() - minsBefore * 60000) && now < leaveAt;
}

export function shouldFireLeave(now, leaveAt) {
  return now >= leaveAt;
}

export function isRunningLate(now, leaveAt, thresholdMin = 10) {
  return now - leaveAt > thresholdMin * 60000;
}

// ---------- delivery ----------

async function getActiveRegistration() {
  if (!('serviceWorker' in navigator) || !navigator.serviceWorker.controller) return null;
  try {
    return (await navigator.serviceWorker.getRegistration()) ?? null;
  } catch {
    return null;
  }
}

const ACTIONS = [
  { action: 'snooze', title: 'Snooze 5 min' },
  { action: 'gotit', title: 'Got it' },
];

/**
 * Shows a notification via an active service worker registration when one
 * exists (so `actions` render), or a plain page Notification otherwise. Both
 * paths honour `tag`-based replacement, so a repeated call with the same tag
 * updates the on-screen notification in place either way — only the action
 * buttons are SW-only, a real browser platform limit, not a gap in this code.
 */
async function fire(title, options, { withActions = false } = {}) {
  const reg = withActions ? await getActiveRegistration() : null;
  if (reg) {
    await reg.showNotification(title, { ...options, actions: ACTIONS });
    return;
  }
  const n = new Notification(title, options);
  n.onclick = () => {
    window.focus();
    n.close();
  };
}

/**
 * Fire the leave-now alert for a class, once per day. `leaveAt` is a Date;
 * we alert when now >= leaveAt. Once that moment is more than 10 minutes
 * past, this defers to the distinct "running late" alert instead of sending
 * the now-stale "time to leave" wording.
 */
export async function maybeAlert({ cls, leaveAt, walkMin, buildingName }, now = new Date()) {
  if (!enabled()) return false;
  if (!shouldFireLeave(now, leaveAt)) return false;

  const id = `${cls.id}:${cls.startMin}`;
  if (isSnoozed(id, now) || alreadyFired(id)) return false;

  if (isRunningLate(now, leaveAt)) {
    markFired(id);
    return maybeLateAlert({ cls, leaveAt, walkMin, buildingName }, now);
  }

  try {
    await fire(
      `Time to leave for ${cls.code || 'class'}`,
      { body: `${walkMin} min walk to ${buildingName}${cls.room ? ` · Room ${cls.room}` : ''}`, tag: id, requireInteraction: false },
      { withActions: true },
    );
    if (alertCueEnabled()) playAlertCue();
    markFired(id);
    return true;
  } catch (err) {
    console.warn('Notification failed', err);
    return false;
  }
}

/**
 * A softer heads-up before the leave-now alert (opt-out via Settings). Uses
 * its own suffixed id so it can never collide with, or suppress, the main
 * leave-now alert's fired state.
 */
export async function maybeHeadsUp({ cls, leaveAt, walkMin, buildingName }, now = new Date(), minsBefore = 10) {
  if (!enabled() || !headsUpEnabled()) return false;
  if (!shouldFireHeadsUp(now, leaveAt, minsBefore)) return false;

  const id = `${cls.id}:${cls.startMin}:headsup`;
  if (isSnoozed(id, now) || alreadyFired(id)) return false;

  try {
    await fire(`Leave in about ${minsBefore} min for ${cls.code || 'class'}`, {
      body: `${walkMin} min walk to ${buildingName}${cls.room ? ` · Room ${cls.room}` : ''}`,
      tag: id,
      requireInteraction: false,
    });
    markFired(id);
    return true;
  } catch (err) {
    console.warn('Heads-up notification failed', err);
    return false;
  }
}

/** A distinct "running late" notification, used internally once maybeAlert's leave-now window has passed rather than staying silent. */
async function maybeLateAlert({ cls, leaveAt, walkMin, buildingName }, now) {
  const id = `${cls.id}:${cls.startMin}:late`;
  if (isSnoozed(id, now) || alreadyFired(id)) return false;

  try {
    await fire(
      `Running late for ${cls.code || 'class'}`,
      {
        body: `You were due to leave by now — ${walkMin} min walk to ${buildingName}${cls.room ? ` · Room ${cls.room}` : ''}`,
        tag: id,
        requireInteraction: false,
      },
      { withActions: true },
    );
    if (alertCueEnabled()) playAlertCue();
    markFired(id);
    return true;
  } catch (err) {
    console.warn('Late notification failed', err);
    return false;
  }
}

// ---------- live-updating walking notification ----------
// In-memory only (not persisted) — reset on reload same as the fired-alert
// day rollover would naturally make stale anyway.
let lastWalkingText = {};
const finishedWalking = new Set();

/**
 * Updates the leave-now notification in place with live remaining
 * distance/time while you're actually walking. No-ops until the leave-now
 * alert has actually fired — there's nothing to update otherwise — and
 * skips re-notifying when the text hasn't visibly changed. Deliberately
 * silent (no re-vibrate/re-sound per update) and has no action buttons —
 * "snooze" doesn't mean anything once you're already walking.
 */
export async function updateWalkingNotification({ cls, buildingName, remainingMeters, liveWalkMin }) {
  const id = `${cls.id}:${cls.startMin}`;
  if (!enabled() || !alreadyFired(id) || finishedWalking.has(id)) return;

  const text = `≈${liveWalkMin} min · ${fmtDistance(Math.round(remainingMeters))} to ${buildingName}`;
  if (lastWalkingText[id] === text) return;
  lastWalkingText[id] = text;

  try {
    await fire(`On your way to ${cls.code || 'class'}`, { body: text, tag: id, requireInteraction: false, silent: true });
  } catch (err) {
    console.warn('Walking notification update failed', err);
  }
}

/** Fires once, replacing the walking notification with an arrival message, then stops further updates for this class today. */
export async function finishWalkingNotification({ cls, buildingName }) {
  const id = `${cls.id}:${cls.startMin}`;
  if (!enabled() || !alreadyFired(id) || finishedWalking.has(id)) return;
  finishedWalking.add(id);
  delete lastWalkingText[id];

  try {
    await fire(`Arrived at ${buildingName}`, { body: `${cls.code || 'Class'} — you're here.`, tag: id, requireInteraction: false, silent: true });
  } catch (err) {
    console.warn('Arrival notification failed', err);
  }
}

/** Test notification so you can confirm it works before relying on it. Stays synchronous (not async) so the existing try/catch call site still catches the permission check synchronously. */
export function testAlert() {
  if (permission() !== 'granted') throw new Error('Enable notifications first');
  fire(
    'ClassMapper alerts are working',
    { body: "You'll get a nudge like this when it's time to leave." },
    { withActions: true },
  ).catch((err) => console.warn('Test notification failed', err));
}
