// ClassMapper — boot, state, and all screen wiring.

import * as store from './store.js';
import * as B from './buildings.js';
import * as S from './schedule.js';
import * as R from './route.js';
import * as M from './map.js';
import * as geo from './geo.js';
import * as OCR from './ocr.js';
import * as N from './notify.js';
import * as EXT from './external.js';
import { APP_VERSION, BUILD_DATE } from './version.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const state = {
  me: null,            // {lat, lon, accuracy} from geolocation
  route: null,         // current route to next class

  // Exactly one feature owns the map at a time. Previously the day route and
  // the building search each tracked their own flag, and refresh() only knew
  // about the day one — so a search result could never be cleared and just sat
  // on the map until something else happened to overwrite it.
  mapMode: 'next',     // 'next' | 'day' | 'find'
  mapContext: null,    // { building } for 'find'; day route uses dayLegs below

  dayLegs: null,       // [{fromLabel, toLabel, meters, minutes, shape, approximate}], when shown
  dayLegVisible: [],   // bool per leg, parallel to dayLegs
  drafts: null,        // parsed import awaiting review
  editingId: null,
  routeToken: 0,       // guards against out-of-order route responses
  panelOpener: null,   // element to hand focus back to when a panel closes
  viewDay: null,       // day index being viewed in the Today panel; null = today
  classFilter: '',     // class-list search text
  todayView: 'day',    // 'day' | 'week' — which view the Today panel shows
  lastRouteOrigin: null, // {lat, lon} the walk time was last computed from
  lastRouteRefreshAt: 0, // Date.now() of that computation
  routeAbort: null,      // AbortController for the in-flight R.walk() in refresh()

  // Live tracking: everything updateLiveProgress() needs on every GPS fix,
  // set alongside state.route in refresh() so the two can't disagree.
  routeDestination: null, // {lat, lon, name} of the current next-class building
  nextOccurrence: null,   // the `next` object from S.nextClass(), as of the last refresh()
  boardArgs: null,        // last args passed to renderBoard(), so a live update can re-render with just `arrived` overridden
  arrivedNow: false,      // in-memory hysteresis flag — not persisted, resets on reload
  smoothedHeading: null,  // degrees, eased across noisy GPS fixes
  lastHeadingFix: null,   // {lat, lon} a bearing-derived heading was last computed from
};

// ---------- boot ----------

async function boot() {
  applyDisplaySettings(); // before anything paints, to avoid a theme flash
  M.init('map');

  try {
    await B.load();
  } catch (err) {
    toast('Could not load campus building data', true);
    console.error(err);
  }

  // Wire each area independently: one missing element shouldn't stop the rest
  // of the app from working.
  for (const [name, fn] of [
    ['day chips', buildDayChips],
    ['color swatches', buildColorRow],
    ['building list', buildBuildingOptions],
    ['top bar', wireTopbar],
    ['panels', wirePanels],
    ['class form', wireClassForm],
    ['import', wireImport],
    ['settings', wireSettings],
    ['day route legend', wireDayLegend],
    ['next card toggle', wireNextCardToggle],
    ['today view tabs', wireTodayViewTabs],
  ]) {
    try {
      fn();
    } catch (err) {
      console.error(`ClassMapper: failed to wire ${name}`, err);
    }
  }

  refresh();
  startGeolocation();

  // One ticker drives the countdown, the alerts, and the class rollover.
  setInterval(tick, 30_000);

  registerServiceWorker();
  wireNotificationActions();
}

/**
 * Snooze/Got it on a notification only work through a service worker (see
 * notify.js), which can't touch localStorage itself — it hands the action
 * off here instead. Two paths land on the same handler: a postMessage from
 * the worker if a tab was already open, or a `?notif-action=` query string
 * on a fresh load if the worker had to open one.
 */
function wireNotificationActions() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', (e) => {
      if (e.data?.type !== 'cm-notification-action') return;
      handleNotificationAction(e.data.action, e.data.tag);
    });
  }

  const params = new URLSearchParams(location.search);
  const action = params.get('notif-action');
  const tag = params.get('tag');
  if (action && tag) {
    handleNotificationAction(action, tag);
    history.replaceState(null, '', location.pathname);
  }
}

function handleNotificationAction(action, tag) {
  if (action === 'snooze') {
    N.snooze(tag, 5);
    refresh();
  }
  // 'gotit' just dismisses the notification (already closed by the worker) — nothing else to do.
}

/**
 * Offline mode is opt-in (Settings → Offline mode).
 *
 * A service worker caches the app's own files, which is what makes the app work
 * with no signal — but it also sits between the page and the server forever. A
 * worker that gets into a bad state can keep serving stale files with no way to
 * fix it from inside the app. Turning it on deliberately, once you know the app
 * works, keeps that failure mode out of your way. reset.html is the escape
 * hatch if it ever does misbehave.
 */
async function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;

  // Note: the bare path is required — registering 'sw.js?v=N' fails in Chrome.
  const wanted = new URL('sw.js', location.href).href;

  try {
    const regs = await navigator.serviceWorker.getRegistrations();

    if (!store.settings().offline) {
      // Not opted in: make sure no worker is left running from a previous try.
      await Promise.all(regs.map((r) => r.unregister()));
      return;
    }

    // Drop registrations pointing at a different script URL (an older build).
    for (const reg of regs) {
      const url = reg.active?.scriptURL ?? reg.installing?.scriptURL ?? reg.waiting?.scriptURL;
      if (url && url !== wanted) await reg.unregister();
    }

    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloading) return;
      reloading = true;
      location.reload();
    });

    const reg = await navigator.serviceWorker.register(wanted);
    reg.update().catch(() => {});
  } catch (err) {
    console.warn('Service worker registration failed', err);
  }
}

// ---------- geolocation ----------

function startGeolocation() {
  if (!('geolocation' in navigator)) return;
  if (!window.isSecureContext) {
    // http:// on a phone silently never fires — say so rather than spin.
    setNote("Live location needs HTTPS. Deploy to GitHub Pages to see your position.");
    return;
  }
  const MOVE_THRESHOLD_M = 25; // don't recompute for GPS jitter smaller than this
  const MIN_REFRESH_GAP_MS = 10_000; // ...or more often than this, even if moving

  navigator.geolocation.watchPosition(
    (pos) => {
      const { latitude, longitude, accuracy, heading, speed } = pos.coords;
      const first = !state.me;
      state.me = { lat: latitude, lon: longitude, accuracy };

      // Prefer the device's own heading once it's moving fast enough for
      // that to be meaningful (stationary heading readings are noise);
      // otherwise derive one from consecutive fixes, only recomputed once
      // you've moved enough that GPS jitter alone can't spin it.
      let rawHeading = null;
      if (Number.isFinite(heading) && Number.isFinite(speed) && speed > 0.3) {
        rawHeading = heading;
        state.lastHeadingFix = state.me;
      } else if (state.lastHeadingFix && R.haversine(state.lastHeadingFix, state.me) >= 3) {
        rawHeading = geo.bearing(state.lastHeadingFix, state.me);
        state.lastHeadingFix = state.me;
      }
      if (rawHeading !== null) {
        state.smoothedHeading =
          state.smoothedHeading === null ? rawHeading : geo.lerpAngleDeg(state.smoothedHeading, rawHeading, 0.35);
      }

      M.showMe(latitude, longitude, accuracy, state.smoothedHeading);
      // Pure local math — arrival detection, live distance/ETA, route
      // trimming — so it runs on every fix, not gated by the movement/time
      // thresholds below that exist specifically to ration the routing API.
      updateLiveProgress();

      if (first) {
        state.lastRouteOrigin = state.me;
        state.lastRouteRefreshAt = Date.now();
        refresh();
        return;
      }

      // Recompute while you're actually walking, not just on the fixed 30s
      // tick — but only for real movement, and not more than once per
      // MIN_REFRESH_GAP_MS, so GPS jitter can't spam the routing API.
      if (state.mapMode !== 'next') return;
      const movedM = state.lastRouteOrigin ? R.haversine(state.lastRouteOrigin, state.me) : Infinity;
      const elapsedMs = Date.now() - state.lastRouteRefreshAt;
      if (movedM >= MOVE_THRESHOLD_M && elapsedMs >= MIN_REFRESH_GAP_MS) {
        state.lastRouteOrigin = state.me;
        state.lastRouteRefreshAt = Date.now();
        refresh();
      }
    },
    (err) => {
      if (err.code === err.PERMISSION_DENIED) {
        setNote('Location is off, so walk times start from your first class instead.');
      }
    },
    { enableHighAccuracy: true, maximumAge: 15_000, timeout: 20_000 },
  );
}

/** Reset everything updateLiveProgress() depends on — used whenever refresh() lands on a state with no routable next class. */
function clearLiveProgress() {
  state.routeDestination = null;
  state.nextOccurrence = null;
  state.boardArgs = null;
  state.arrivedNow = false;
  const liveEl = $('#next-live');
  if (liveEl) liveEl.hidden = true;
}

/**
 * Runs on every GPS fix — pure local math against the route already in hand,
 * so it isn't gated by the movement/time thresholds that exist specifically
 * to ration the routing API. Handles arrival detection, the live
 * distance/ETA line under the leave-by countdown, and — only while the map
 * is actually showing the next-class route — trimming that route line to
 * how much of the walk is left.
 */
function updateLiveProgress() {
  const liveEl = $('#next-live');
  if (
    !state.route ||
    !state.routeDestination ||
    !state.nextOccurrence ||
    state.nextOccurrence.isNow ||
    !state.me ||
    state.route.samePlace
  ) {
    if (liveEl) liveEl.hidden = true;
    return;
  }

  const remainingMeters = state.route.shape?.length
    ? geo.remainingRouteMeters(state.route.shape, state.me)
    : R.haversine(state.me, state.routeDestination) * 1.3;
  const { walkSpeed } = store.settings();
  const liveWalkMin = Math.max(0, Math.round(remainingMeters / walkSpeed / 60));

  // Enter "arrived" at 20m, only leave it past 35m — hysteresis so standing
  // right at the boundary doesn't flicker the board back and forth.
  const arrived = geo.isArrived(state.me, state.routeDestination, state.arrivedNow ? 35 : 20);
  if (arrived !== state.arrivedNow) {
    state.arrivedNow = arrived;
    if (state.boardArgs) renderBoard({ ...state.boardArgs, arrived });
    if (arrived) {
      N.finishWalkingNotification({ cls: state.nextOccurrence.cls, buildingName: state.routeDestination.name });
    }
  }

  if (arrived) {
    if (liveEl) liveEl.hidden = true;
  } else {
    if (liveEl) {
      const eta = new Date(Date.now() + (remainingMeters / walkSpeed) * 1000);
      liveEl.textContent = `Now ≈${liveWalkMin} min · ${R.fmtDistance(Math.round(remainingMeters))} · arrive ${fmtClock(eta)}`;
      liveEl.hidden = false;
    }
    N.updateWalkingNotification({
      cls: state.nextOccurrence.cls,
      buildingName: state.routeDestination.name,
      remainingMeters,
      liveWalkMin,
    });
  }

  // The map redraw is the one part of this that must respect the
  // single-map-owner model — a day route or a building search the user is
  // actively looking at should never get silently overwritten.
  if (state.mapMode === 'next' && !arrived && state.route.shape?.length) {
    M.trimRouteToProgress(geo.trimShapeToProgress(state.route.shape, state.me));
  }
}

// ---------- the main card ----------

function tick() {
  refresh();
}

async function refresh() {
  buildBuildingOptions();
  renderClassList();
  renderToday();

  const classes = S.list();
  const hasClasses = classes.length > 0;
  $('#nextcard-empty').hidden = hasClasses;
  $('#nextcard-body').hidden = !hasClasses;
  if (!hasClasses) {
    // Don't wipe a search result just because there are no classes — that was
    // one of the paths that used to strand the route with no way to clear it.
    if (state.mapMode === 'next') {
      M.renderStops([]);
      M.clearRoute();
    }
    clearLiveProgress();
    updateCardSummary('No classes yet');
    return;
  }

  const now = new Date();
  const cfg = store.settings();
  const phase = S.semesterPhase(now, cfg);
  const next = S.nextClass(now, classes, cfg);
  renderStopsForToday(now, next);
  // Independent of whether `next` resolves to a routable class below — this
  // just needs the schedule, so it's safe to compute before any of the
  // early-return paths that follow.
  renderUpNext(now, classes, cfg);

  if (!next) {
    const headline =
      phase === 'before'
        ? "Semester hasn't started"
        : phase === 'after'
          ? "Semester's over"
          : 'Nothing left this week';
    $('#next-label').textContent = headline;
    $('#next-code').textContent = '—';
    $('#next-time').textContent = '';
    $('#next-where').textContent =
      phase === 'before'
        ? `Classes begin ${cfg.semesterStart}.`
        : phase === 'after'
          ? `Classes ended ${cfg.semesterEnd}.`
          : '';
    $('#next-walk').textContent = '';
    $('#next-leave').textContent = '';
    $('#next-steps').hidden = true;
    $('#next-openin').hidden = true;
    clearLiveProgress();
    updateCardSummary(headline);
    announce(headline);
    return;
  }

  const b = next.cls.buildingId ? B.get(next.cls.buildingId) : null;
  updateOpenInLinks(b);

  // Label the card by how far off the class is.
  const dayOffset = Math.round((startOfDay(next.startsAt) - startOfDay(now)) / 86400000);
  let label = 'Next class';
  if (next.isNow) label = 'Happening now';
  else if (dayOffset === 1) label = 'Next class · tomorrow';
  else if (dayOffset > 1) label = `Next class · ${S.DAY_NAMES[next.startsAt.getDay()]}`;
  $('#next-label').textContent = label;

  $('#next-code').textContent = next.cls.code || next.cls.title || 'Class';
  $('#next-time').textContent = `${S.fmtTime(next.cls.startMin)}`;
  $('#next-where').textContent = b
    ? `${b.name}${next.cls.room ? ` · Room ${next.cls.room}` : ''}`
    : `⚠ No building set${next.cls.buildingRaw ? ` (${next.cls.buildingRaw})` : ''}`;

  const codeForSummary = next.cls.code || next.cls.title || 'Class';
  updateCardSummary(next.isNow ? `${codeForSummary} · now` : `${codeForSummary} · ${S.fmtTime(next.cls.startMin)}`);

  // Every exit below must announce, or the live region goes stale and reports
  // a class that is no longer next.
  const codeForSr = next.cls.code || next.cls.title || 'Next class';
  const whenForSr = `at ${S.fmtTime(next.cls.startMin)}`;

  if (!b) {
    $('#next-walk').textContent = '';
    $('#next-steps').hidden = true;
    setNote('Open My classes and pick a building so I can route you there.');
    clearLiveProgress();
    renderBoard({ next, unrouted: 'No building set' });
    announce(`${codeForSr} ${whenForSr}. No building set, so no route.`);
    return;
  }

  // Route from wherever you are; if location is unavailable, route from the
  // class before this one, which is where you'll actually be standing.
  const origin = state.me ?? previousStop(now, next);

  if (!origin) {
    $('#next-walk').textContent = 'Turn on location for a walk time';
    $('#next-steps').hidden = true;
    clearLiveProgress();
    renderBoard({ next, unrouted: `Starts ${S.fmtTime(next.cls.startMin)}` });
    announce(`${codeForSr} ${whenForSr}, ${b.name}. Walk time needs your location.`);
    return;
  }

  // A live GPS origin is skipped from route.js's permanent cache — it's
  // almost never within a fixed point's ~1m cache precision of a prior fix,
  // so caching it would just flood and evict real building-pair routes.
  const isLiveOrigin = origin === state.me;
  state.routeAbort?.abort();
  state.routeAbort = new AbortController();
  const token = ++state.routeToken;
  const route = await R.walk(origin, b, { cache: !isLiveOrigin, signal: state.routeAbort.signal });
  if (token !== state.routeToken) return; // a newer refresh already won

  state.route = route;
  if (!route) return;

  // A new destination (different class, or the building was corrected)
  // means any in-progress "arrived" state no longer applies to it.
  if (state.routeDestination?.lat !== b.lat || state.routeDestination?.lon !== b.lon) {
    state.arrivedNow = false;
  }
  state.routeDestination = { lat: b.lat, lon: b.lon, name: b.name };
  state.nextOccurrence = next;

  // The day-route legend owns the map while it's open — leave its lines alone,
  // but keep computing walk time and leave-by below so the card doesn't go
  // stale just because you're looking at the whole day.
  if (state.mapMode === 'next') M.drawRoute(route.shape);

  const leaveAt = S.leaveBy(next.startsAt, route.minutes, cfg.bufferMin);
  const minsToLeave = Math.round((leaveAt - now) / 60000);

  $('#next-walk').textContent = route.samePlace
    ? 'Same building — no walk'
    : `${route.minutes} min walk · ${R.fmtDistance(route.meters)}`;

  state.boardArgs = { next, leaveAt, minsToLeave, walkMin: route.minutes };
  renderBoard({ ...state.boardArgs, arrived: state.arrivedNow });
  // Position/destination may already be known even if this particular tick
  // didn't come from a GPS fix (e.g. the 30s ticker) — let the live numbers
  // catch up to the route that was just (re)computed.
  updateLiveProgress();

  const steps = $('#next-steps');
  if (route.steps?.length) {
    $('#next-steps-list').innerHTML = route.steps.map((s) => `<li>${escapeHtml(s)}</li>`).join('');
    steps.hidden = false;
  } else {
    steps.hidden = true;
  }

  setNote(
    route.approximate
      ? 'Straight-line estimate — the routing service is unreachable.'
      : '',
  );

  // Coarse buckets, not the live countdown: announcing "leave in 11 min" then
  // "leave in 10 min" every tick would be worse than saying nothing.
  const urgency = next.isNow
    ? 'in progress'
    : minsToLeave <= 0
      ? 'leave now'
      : minsToLeave <= 5
        ? 'leave within 5 minutes'
        : 'upcoming';
  announce(
    `${next.cls.code || next.cls.title || 'Next class'} at ${S.fmtTime(next.cls.startMin)}` +
      `${b ? `, ${b.name}` : ''}. ${urgency === 'upcoming' ? `Leave by ${fmtClock(leaveAt)}` : urgency}.`,
  );

  if (!next.isNow) {
    // Heads-up fires strictly before leaveAt; maybeAlert only fires at/after
    // it — their windows never overlap, so there's no double-fire risk, and
    // each guards its own fired-id independently.
    N.maybeHeadsUp({ cls: next.cls, leaveAt, walkMin: route.minutes, buildingName: b.name }, now);
    N.maybeAlert({ cls: next.cls, leaveAt, walkMin: route.minutes, buildingName: b.name }, now);
  }
}

/** Point the next-class card's "Open in" links at the given building. */
function updateOpenInLinks(b) {
  const openIn = $('#next-openin');
  if (!b) {
    openIn.hidden = true;
    return;
  }
  $('#open-google').href = EXT.googleMapsUrl(b);
  $('#open-apple').href = EXT.appleMapsUrl(b);
  $('#open-waze').href = EXT.wazeUrl(b);
  openIn.hidden = false;
}

// ---------- find any building ----------

/**
 * Route to any campus building, whether or not a class meets there — the
 * library, the dining hall, an advisor's office.
 */
async function findBuilding() {
  const building = await pickBuilding('Find a building', 'Any of the 53 campus buildings.');
  if (!building) return;

  // Optional second step: plan from a specific building instead of "from
  // here." Cancel (relabeled) means the common case — use current location.
  const fromBuilding = await pickBuilding(
    'Route from?',
    'Pick a starting building, or use your current location.',
    { cancelLabel: 'Use current location' },
  );

  closePanels();
  enterMapMode('find', { building, origin: fromBuilding });

  const originPoint = fromBuilding ?? state.me;
  M.renderStops([
    { building, label: '★', state: 'find', title: building.name, subtitle: 'Searched' },
    ...(fromBuilding
      ? [{ building: fromBuilding, label: '●', state: 'later', title: fromBuilding.name, subtitle: 'Starting point' }]
      : []),
  ]);
  M.panTo(building);

  // The status bar goes up immediately, before any routing — so there is always
  // a way out even if the route never resolves.
  renderMapStatus();

  if (!originPoint) {
    setFindMeta('Turn on location for a walk time');
    announce(`Showing ${building.name} on the map`);
    return;
  }

  setFindMeta('Finding a walking route…');
  const route = await R.walk(originPoint, building, { cache: originPoint !== state.me });
  // Bail if the user has since dismissed this or searched something else.
  if (state.mapMode !== 'find' || state.mapContext?.building?.id !== building.id) return;

  M.drawRoute(route?.shape ?? []);
  M.fitTo([originPoint, building]);
  const meta = route
    ? `${route.minutes} min walk · ${R.fmtDistance(route.meters)}${route.approximate ? ' (estimated)' : ''}`
    : 'No route available';
  setFindMeta(meta);
  announce(`${fromBuilding ? `${fromBuilding.name} to ` : ''}${building.name} — ${meta}`);
}

function setFindMeta(text) {
  const el = $('#map-status-meta');
  el.textContent = text;
  el.hidden = !text;
}

// ---------- who owns the map ----------

function enterMapMode(mode, context = null) {
  // Always tear down whatever the previous owner drew, so modes can't leave
  // orphaned layers behind each other.
  M.clearLegs();
  M.clearRoute();
  state.dayLegs = null;
  state.dayLegVisible = [];

  state.mapMode = mode;
  state.mapContext = context;
}

/** Hand the map back to the next-class view. The single way out of any mode. */
function exitMapMode() {
  if (state.mapMode === 'next') return;
  enterMapMode('next');
  $('#map-status').hidden = true;
  M.renderStops([]);
  refresh();
}

function renderMapStatus() {
  const box = $('#map-status');
  if (state.mapMode === 'next') {
    box.hidden = true;
    return;
  }

  const isFind = state.mapMode === 'find';
  const origin = state.mapContext?.origin ?? null; // a chosen building, or null = current location
  $('#map-status-eyebrow').textContent = isFind ? (origin ? 'Route' : 'Showing') : 'Route';
  $('#map-status-title').textContent = isFind
    ? (origin ? `${origin.name} → ${state.mapContext?.building?.name ?? 'Building'}` : state.mapContext?.building?.name ?? 'Building')
    : state.mapContext?.label ?? "Today's route";

  $('#day-legend-showall').hidden = isFind;
  $('#map-status-meta').hidden = !isFind;

  const links = $('#map-status-links');
  const b = state.mapContext?.building;
  if (isFind && b) {
    $('#find-google').href = EXT.googleMapsUrl(b, { origin });
    $('#find-apple').href = EXT.appleMapsUrl(b, { origin });
    // Waze has no way to represent a fixed start point — hide it rather than
    // link somewhere that would silently ignore the origin you just chose.
    $('#find-waze').hidden = Boolean(origin);
    $('#find-waze').href = EXT.wazeUrl(b);
    links.hidden = false;
  } else {
    links.hidden = true;
  }

  box.hidden = false;
  renderDayLegend();
}

// ---------- the board ----------

let lastDigits = null;

/**
 * The countdown is the whole point of this screen, so it gets the hierarchy:
 * one big number, a draining bar, and colour that only appears once time is
 * actually short. Urgency is set once on the container and inherited.
 */
function renderBoard({ next, leaveAt, minsToLeave, walkMin, unrouted, arrived }) {
  const board = $('#next-board');
  const digitsEl = $('#next-digits');
  const unitEl = $('#next-unit');
  const labelEl = $('#next-countlabel');
  const leaveEl = $('#next-leave');
  const fill = $('#next-bar-fill');

  let digits;
  let unit = 'min';
  let label = 'Leave in';
  let urgency = 'ample';
  let leaveLine;

  // No route available (no building, or no location to route from). Fall back
  // to counting down to the class itself — never leave stale digits on screen.
  if (unrouted) {
    const mins = Math.max(0, Math.round((next.startsAt - new Date()) / 60000));
    if (next.isNow) {
      digits = 'NOW';
      unit = '';
      label = 'In class';
      urgency = 'now';
      leaveLine = `Ends at ${S.fmtTime(next.cls.endMin)}`;
    } else if (mins < 60) {
      digits = String(mins);
      label = 'Starts in';
      urgency = mins <= 5 ? 'soon' : 'ample';
      leaveLine = unrouted;
    } else {
      const hrs = Math.floor(mins / 60);
      digits = String(hrs);
      unit = hrs === 1 ? 'hr' : 'hrs';
      label = 'Starts in';
      leaveLine = unrouted;
    }
    applyBoard({ board, digitsEl, unitEl, labelEl, leaveEl, fill, digits, unit, label, urgency, leaveLine, pct: 1 });
    return;
  }

  if (next.isNow) {
    digits = 'NOW';
    unit = '';
    label = 'In class';
    urgency = 'now';
    leaveLine = `Ends at ${S.fmtTime(next.cls.endMin)}`;
  } else if (arrived) {
    // A resolved state, not an urgency level — you got there, the countdown
    // isn't the point anymore.
    digits = 'HERE';
    unit = '';
    label = 'Arrived';
    urgency = 'arrived';
    leaveLine = `Class starts at ${S.fmtTime(next.cls.startMin)}`;
  } else if (minsToLeave <= 0) {
    const behind = Math.abs(minsToLeave);
    digits = 'GO';
    unit = '';
    label = behind > 1 ? `${behind} min behind` : 'Leave now';
    urgency = 'now';
    leaveLine = `${walkMin} min walk · arrive ${fmtClock(new Date(Date.now() + walkMin * 60000))}`;
  } else if (minsToLeave < 60) {
    digits = String(minsToLeave);
    urgency = minsToLeave <= 5 ? 'soon' : 'ample';
    leaveLine = `Leave by ${fmtClock(leaveAt)}`;
  } else {
    const hrs = Math.floor(minsToLeave / 60);
    digits = String(hrs);
    unit = hrs === 1 ? 'hr' : 'hrs';
    leaveLine = `Leave by ${fmtClock(leaveAt)}`;
  }

  // The bar drains over the last hour of waiting; full when there's ages to go.
  const pct = next.isNow || arrived || minsToLeave <= 0 ? 1 : Math.max(0, Math.min(1, minsToLeave / 60));
  applyBoard({ board, digitsEl, unitEl, labelEl, leaveEl, fill, digits, unit, label, urgency, leaveLine, pct });
}

/** The single place the board is actually painted, shared by both code paths. */
function applyBoard({ board, digitsEl, unitEl, labelEl, leaveEl, fill, digits, unit, label, urgency, leaveLine, pct }) {
  board.classList.toggle('is-soon', urgency === 'soon');
  board.classList.toggle('is-now', urgency === 'now');
  board.classList.toggle('is-arrived', urgency === 'arrived');
  digitsEl.classList.toggle('is-word', !/^\d+$/.test(digits));

  // Split-flap tick, only when the value actually changed — the refresh runs
  // every 30s and re-animating identical digits would just be noise.
  if (lastDigits !== null && lastDigits !== digits) {
    digitsEl.classList.remove('is-flipping');
    void digitsEl.offsetWidth; // restart the animation
    digitsEl.classList.add('is-flipping');
  }
  lastDigits = digits;

  digitsEl.textContent = digits;
  unitEl.textContent = unit;
  unitEl.hidden = !unit;
  labelEl.textContent = label;
  leaveEl.textContent = leaveLine;
  fill.style.transform = `scaleX(${pct})`;
}

/**
 * A quiet strip of what comes after the class the board is already counting
 * down to — supplements the hero, never repeats it. Kept visually small on
 * purpose: the countdown numerals are still the one thing meant to dominate.
 */
function renderUpNext(now, classes, cfg) {
  const box = $('#next-upnext');
  const row = $('#next-upnext-row');
  if (!box || !row) return;

  const items = S.upcoming(now, classes, 3, cfg);
  if (!items.length) {
    box.hidden = true;
    return;
  }

  row.innerHTML = items
    .map(({ cls }) => {
      const b = cls.buildingId ? B.get(cls.buildingId) : null;
      return `<button type="button" class="upnext-chip" data-building="${b ? b.id : ''}">
        <span class="tag-dot" style="--dot: var(--${colorFor(cls)})" aria-hidden="true"></span>
        <span class="upnext-chip__code">${escapeHtml(cls.code || cls.title || 'Class')}</span>
        <span class="upnext-chip__time">${S.fmtTime(cls.startMin)}</span>
      </button>`;
    })
    .join('');

  row.onclick = (e) => {
    const chip = e.target.closest('[data-building]');
    const id = chip?.dataset.building;
    const b = id ? B.get(id) : null;
    if (b) M.panTo(b);
  };

  box.hidden = false;
}

/** Keep the handle bar's one-line summary current, whether or not the card is collapsed. */
function updateCardSummary(text) {
  const el = $('#nextcard-toggle-summary');
  if (el) el.textContent = text;
}

function setCardCollapsed(collapsed) {
  $('#nextcard').classList.toggle('nextcard--collapsed', collapsed);
  $('#nextcard-toggle').setAttribute('aria-expanded', String(!collapsed));
  M.invalidate(); // more/less map is now visible under the card
}

function wireNextCardToggle() {
  setCardCollapsed(Boolean(store.settings().cardCollapsed));
  $('#nextcard-toggle').onclick = () => {
    const collapsed = !$('#nextcard').classList.contains('nextcard--collapsed');
    setCardCollapsed(collapsed);
    store.saveSettings({ cardCollapsed: collapsed });
  };
}

/** Where you'll be before `next`: the building of the preceding class today. */
function previousStop(now, next) {
  const today = S.classesToday(now);
  const idx = today.findIndex((c) => c.id === next.cls.id && c.startMin === next.cls.startMin);
  for (let i = idx - 1; i >= 0; i--) {
    const b = today[i].buildingId ? B.get(today[i].buildingId) : null;
    if (b) return { lat: b.lat, lon: b.lon };
  }
  return null;
}

function renderStopsForToday(now, next) {
  const nowMin = S.minutesNow(now);
  const today = S.classesToday(now);
  const stops = today.map((cls, i) => {
    const b = cls.buildingId ? B.get(cls.buildingId) : null;
    const isNext = next && cls.id === next.cls.id && cls.startMin === next.cls.startMin;
    return {
      building: b,
      label: String(i + 1),
      state: isNext ? 'next' : cls.endMin <= nowMin ? 'done' : 'later',
      title: cls.code || cls.title || 'Class',
      subtitle: `${S.fmtTime(cls.startMin)}–${S.fmtTime(cls.endMin)}${cls.room ? ` · Room ${cls.room}` : ''}`,
      cls,
    };
  });

  // Nothing today but a class later this week: still show where it is.
  if (!stops.length && next?.cls.buildingId) {
    const b = B.get(next.cls.buildingId);
    if (b) {
      stops.push({
        building: b,
        label: '1',
        state: 'next',
        title: next.cls.code || 'Class',
        subtitle: `${S.DAY_NAMES[next.startsAt.getDay()]} ${S.fmtTime(next.cls.startMin)}`,
        cls: next.cls,
      });
    }
  }

  // Another mode owns the markers and the viewport right now — the 30s refresh
  // tick must not quietly redraw over a route the user is still looking at.
  if (state.mapMode !== 'next') return;

  M.renderStops(stops, { onSelect: (s) => M.panTo(s.building) });

  const pts = stops.map((s) => s.building).filter(Boolean);
  if (state.me) pts.push(state.me);
  if (pts.length) M.fitTo(pts);
}

// ---------- today panel ----------

/**
 * A Date for the day currently being viewed. `state.viewDay` is a day index
 * (0-6); null means today. Always resolves forward, so on Wednesday picking
 * "Monday" shows next Monday rather than a day that's already gone.
 */
function viewedDate(now = new Date()) {
  if (state.viewDay == null) return now;
  const offset = (state.viewDay - now.getDay() + 7) % 7;
  const d = new Date(now);
  d.setDate(d.getDate() + offset);
  return d;
}

function dayHeading(date, now = new Date()) {
  const offset = Math.round((startOfDay(date) - startOfDay(now)) / 86400000);
  if (offset === 0) return 'Today';
  if (offset === 1) return 'Tomorrow';
  return S.DAY_NAMES[date.getDay()];
}

function renderDayPicker(now = new Date()) {
  const row = $('#day-picker-row');
  if (!row) return;
  const classes = S.list();
  const viewing = viewedDate(now).getDay();

  row.innerHTML = S.DAY_LETTERS.map((d, i) => {
    const has = S.classesOn(i, classes).length > 0;
    return `<button type="button" class="day-chip ${i === now.getDay() ? 'day-chip--today' : ''} ${has ? 'day-chip--has' : ''}"
      data-viewday="${i}" aria-pressed="${i === viewing}"
      aria-label="${S.DAY_NAMES[i]}${has ? '' : ', no classes'}">${d}</button>`;
  }).join('');

  row.onclick = (e) => {
    const chip = e.target.closest('[data-viewday]');
    if (!chip) return;
    const picked = Number(chip.dataset.viewday);
    // Tapping the day you're already on goes back to today.
    state.viewDay = picked === viewedDate(now).getDay() && picked !== now.getDay() ? null : picked;
    renderToday();
  };
}

function renderToday() {
  const now = new Date();
  const date = viewedDate(now);
  const isToday = startOfDay(date).getTime() === startOfDay(now).getTime();
  const dateStr = S.localDateStr(date);
  // Skipping only ever makes sense for today or a day still coming — undoing
  // one stays available regardless, in case a past view still shows one.
  const canSkip = S.compareToDateString(date, S.localDateStr(now)) !== -1;
  const list = $('#today-list');
  // A class on another day is never "next", so don't highlight it as such.
  const next = isToday ? S.nextClass(now, S.list(), store.settings()) : null;

  renderDayPicker(now);
  $('#today-h').textContent = dayHeading(date, now);

  // Everything that meets this weekday, skipped or not — skipped ones still
  // get a row (muted, with Undo) instead of silently vanishing. Gaps below
  // are computed from the active ones only, so skipping a middle class
  // correctly widens the free block around it.
  const allForDay = S.classesOn(date.getDay(), S.list());
  const isSkipped = (c) => (c.skipDates ?? []).includes(dateStr);

  if (!allForDay.length) {
    list.innerHTML = `<li class="is-gap">No classes ${isToday ? 'today' : `on ${S.DAY_NAMES[date.getDay()]}`}.</li>`;
    $('#today-summary').innerHTML = `<strong>${S.DAY_NAMES[date.getDay()]}</strong> — nothing scheduled. Enjoy it.`;
    $('#btn-route-day').disabled = true;
    $('#btn-route-day-google').hidden = true;
    return;
  }

  const rows = [];
  let lastActiveEnd = null;
  for (const cls of allForDay) {
    const skipped = isSkipped(cls);
    if (!skipped && lastActiveEnd != null) {
      const gap = cls.startMin - lastActiveEnd;
      if (gap > 0) rows.push({ type: 'gap', minutes: gap, from: lastActiveEnd, to: cls.startMin });
    }
    rows.push({ type: 'class', cls, skipped });
    if (!skipped) lastActiveEnd = cls.endMin;
  }

  list.innerHTML = rows
    .map((item) => {
      if (item.type === 'gap') {
        return `<li class="is-gap">${fmtDuration(item.minutes)} free · ${S.fmtTime(item.from)}–${S.fmtTime(item.to)}</li>`;
      }
      const cls = item.cls;
      const b = cls.buildingId ? B.get(cls.buildingId) : null;
      const isNext = !item.skipped && next && cls.id === next.cls.id && cls.startMin === next.cls.startMin;
      const skipAction = item.skipped
        ? `<span class="item__badge item__badge--muted">Skipped</span><button class="btn btn--sm" data-unskip="${cls.id}">Undo</button>`
        : canSkip
          ? `<button class="btn btn--sm" data-skip="${cls.id}">Skip</button>`
          : '';
      return `<li class="${isNext ? 'is-next' : ''} ${item.skipped ? 'is-skipped' : ''}">
        <div class="item__top">
          <span class="item__code"><span class="tag-dot" style="--dot: var(--${colorFor(cls)})" aria-hidden="true"></span>${escapeHtml(cls.code || cls.title || 'Class')}</span>
          <span class="item__time">${S.fmtTime(cls.startMin)}–${S.fmtTime(cls.endMin)}</span>
        </div>
        <div class="item__meta">${b ? escapeHtml(b.name) : '⚠ no building'}${cls.room ? ` · Room ${escapeHtml(cls.room)}` : ''}${cls.instructor ? ` · ${escapeHtml(cls.instructor)}` : ''}</div>
        ${skipAction ? `<div class="item__actions">${skipAction}</div>` : ''}
      </li>`;
    })
    .join('');

  list.onclick = (e) => {
    const skipBtn = e.target.closest('[data-skip]');
    if (skipBtn) {
      const cls = S.list().find((c) => c.id === skipBtn.dataset.skip);
      if (cls) {
        S.upsert({ ...cls, skipDates: [...(cls.skipDates ?? []), dateStr] });
        toast(`Skipped ${cls.code || 'class'} for ${dayHeading(date, now).toLowerCase()}`);
        refresh();
      }
      return;
    }
    const unskipBtn = e.target.closest('[data-unskip]');
    if (unskipBtn) {
      const cls = S.list().find((c) => c.id === unskipBtn.dataset.unskip);
      if (cls) {
        S.upsert({ ...cls, skipDates: (cls.skipDates ?? []).filter((d) => d !== dateStr) });
        toast('Restored');
        refresh();
      }
    }
  };

  const activePlan = S.dayPlan(date); // skip-aware, for the summary line only
  const classCount = activePlan.filter((p) => p.type === 'class').length;
  if (classCount) {
    $('#today-summary').innerHTML =
      `<strong>${S.DAY_NAMES[date.getDay()]}</strong> — ${classCount} class${classCount === 1 ? '' : 'es'}, ` +
      `${S.fmtTime(activePlan[0].cls.startMin)} to ${S.fmtTime([...activePlan].reverse().find((p) => p.type === 'class').cls.endMin)}.`;
  } else {
    $('#today-summary').innerHTML = `<strong>${S.DAY_NAMES[date.getDay()]}</strong> — everything's skipped today.`;
  }
  $('#btn-route-day').disabled = classCount < 2;

  const stops = S.classesOnDate(date, S.list())
    .map((c) => (c.buildingId ? B.get(c.buildingId) : null))
    .filter(Boolean);
  const dayGoogleBtn = $('#btn-route-day-google');
  const dayUrl = EXT.googleMapsDayUrl(stops);
  if (dayUrl) {
    dayGoogleBtn.href = dayUrl;
    dayGoogleBtn.hidden = false;
  } else {
    dayGoogleBtn.hidden = true;
  }
}

// ---------- week-at-a-glance ----------

/** The 7 concrete dates of the current calendar week, Sunday through Saturday. */
function currentWeekDates(now = new Date()) {
  const sunday = new Date(now);
  sunday.setDate(sunday.getDate() - sunday.getDay());
  sunday.setHours(0, 0, 0, 0);
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(sunday);
    d.setDate(d.getDate() + i);
    return d;
  });
}

/**
 * All 7 days side by side for the current week — a different read of the
 * schedule than the single-day Today list, not a replacement for it. Uses
 * concrete dates (not just weekdays) specifically so a one-off skip shows up
 * as visibly skipped here too, same as in the day view.
 */
function renderWeek() {
  const now = new Date();
  const grid = $('#week-grid');
  const classes = S.list();

  grid.innerHTML = currentWeekDates(now)
    .map((d, i) => {
      const isToday = startOfDay(d).getTime() === startOfDay(now).getTime();
      const dateStr = S.localDateStr(d);
      const dayClasses = S.classesOn(i, classes); // full weekday list — skipped ones still shown
      const blocks = dayClasses
        .map((c) => {
          const skipped = (c.skipDates ?? []).includes(dateStr);
          return `<div class="weekgrid__block ${skipped ? 'is-skipped' : ''}">
            <span class="weekgrid__code">${escapeHtml(c.code || c.title || 'Class')}</span>
            <span class="weekgrid__time">${S.fmtTime(c.startMin)}</span>
          </div>`;
        })
        .join('');
      return `<div class="weekgrid__col ${isToday ? 'is-today' : ''}">
        <div class="weekgrid__head">${S.DAY_NAMES[i].slice(0, 3)} <span class="weekgrid__date">${d.getMonth() + 1}/${d.getDate()}</span></div>
        ${blocks || '<div class="weekgrid__empty">—</div>'}
      </div>`;
    })
    .join('');
}

function wireTodayViewTabs() {
  const tabs = $('#today-viewtabs');
  if (!tabs) return;
  tabs.onclick = (e) => {
    const btn = e.target.closest('[data-view]');
    if (!btn) return;
    const view = btn.dataset.view;
    state.todayView = view;
    $$('#today-viewtabs [data-view]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === view)));
    $('#today-day-view').hidden = view !== 'day';
    $('#today-week-view').hidden = view !== 'week';
    if (view === 'week') renderWeek();
  };
}

async function showDayRoute() {
  const now = new Date();
  const date = viewedDate(now);
  const isToday = startOfDay(date).getTime() === startOfDay(now).getTime();
  const namedStops = S.classesOnDate(date, S.list())
    .map((c) => (c.buildingId ? { cls: c, point: B.get(c.buildingId) } : null))
    .filter(Boolean);

  if (namedStops.length < 2) {
    toast('Need at least two classes with buildings that day', true);
    return;
  }

  const dayLabel = isToday ? "Today's route" : `${S.DAY_NAMES[date.getDay()]}'s route`;
  enterMapMode('day', { label: dayLabel });
  closePanels();
  renderMapStatus();
  toast(`Routing ${isToday ? 'your whole day' : S.DAY_NAMES[date.getDay()]}…`);

  // Only start from your live position when the route is for today — on any
  // other day where you're standing right now is irrelevant.
  const named = state.me && isToday
    ? [{ cls: null, point: state.me }, ...namedStops]
    : namedStops;
  const points = named.map((n) => ({ lat: n.point.lat, lon: n.point.lon }));

  const result = await R.chain(points);
  if (state.mapMode !== 'day') return; // dismissed while the routing call was in flight

  const labelFor = (pt) => {
    const match = named.find((n) => Math.abs(n.point.lat - pt.lat) < 1e-6 && Math.abs(n.point.lon - pt.lon) < 1e-6);
    return match?.cls ? match.cls.code || match.cls.title || 'Class' : 'You are here';
  };

  state.dayLegs = result.legs.map((leg, i) => ({
    fromLabel: labelFor(result.stops[i]),
    toLabel: labelFor(result.stops[i + 1]),
    meters: leg?.meters ?? 0,
    minutes: leg?.minutes ?? 0,
    shape: leg?.shape ?? [],
    approximate: leg?.approximate ?? false,
  }));
  state.dayLegVisible = state.dayLegs.map(() => true);

  M.drawLegs(state.dayLegs);
  M.fitTo(points);
  renderMapStatus();

  toast(
    `Whole day: ${R.fmtDistance(result.meters)} of walking, about ${fmtDuration(result.minutes)}` +
      (result.approximate ? ' (estimated)' : ''),
  );
}

/** Fills the per-leg toggle list. Visibility of the bar itself is renderMapStatus's job. */
function renderDayLegend() {
  const list = $('#day-legend-list');
  if (!state.dayLegs?.length) {
    list.innerHTML = '';
    list.hidden = true;
    return;
  }
  list.hidden = false;

  const allVisible = state.dayLegVisible.every(Boolean);
  const soloIndex = !allVisible && state.dayLegVisible.filter(Boolean).length === 1
    ? state.dayLegVisible.indexOf(true)
    : -1;

  $('#day-legend-list').innerHTML = state.dayLegs
    .map((leg, i) => {
      const visible = state.dayLegVisible[i];
      const solo = i === soloIndex;
      return `<li class="dayleg ${visible ? '' : 'is-off'} ${solo ? 'is-solo' : ''}" data-leg="${i}">
        <input type="checkbox" class="dayleg__check" data-toggle="${i}" ${visible ? 'checked' : ''}
               aria-label="Show ${escapeHtml(leg.fromLabel)} to ${escapeHtml(leg.toLabel)} on the map">
        <button type="button" class="dayleg__label" data-solo="${i}">${escapeHtml(leg.fromLabel)} → ${escapeHtml(leg.toLabel)}</button>
        <span class="dayleg__meta">${leg.minutes} min${leg.approximate ? ' ~' : ''}</span>
      </li>`;
    })
    .join('');
}

function wireDayLegend() {
  const list = $('#day-legend-list');

  list.addEventListener('change', (e) => {
    const cb = e.target.closest('input[data-toggle]');
    if (!cb) return;
    const i = Number(cb.dataset.toggle);
    state.dayLegVisible[i] = cb.checked;
    M.setLegVisible(i, cb.checked);
    renderDayLegend();
  });

  list.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-solo]');
    if (!btn) return;
    const i = Number(btn.dataset.solo);

    // Tapping the only visible leg again restores the full route.
    const alreadySolo = state.dayLegVisible[i] && state.dayLegVisible.filter(Boolean).length === 1;
    state.dayLegVisible = state.dayLegVisible.map((_, idx) => (alreadySolo ? true : idx === i));
    state.dayLegVisible.forEach((v, idx) => M.setLegVisible(idx, v));
    renderDayLegend();
  });

  $('#day-legend-showall').onclick = () => {
    state.dayLegVisible = state.dayLegs.map(() => true);
    state.dayLegVisible.forEach((v, i) => M.setLegVisible(i, v));
    renderDayLegend();
  };

  $('#map-status-close').onclick = exitMapMode;

  // Tapping empty map while a search is up dismisses it — the natural gesture.
  // Deliberately not for the day route: its per-leg toggles invite map-adjacent
  // interaction, and dismissing that on a stray tap would be irritating.
  M.onBackgroundClick(() => {
    if (state.mapMode === 'find') exitMapMode();
  });
}

// ---------- class list & editor ----------

/** Does a class match the search box? Checks code, title, building and room. */
function matchesFilter(cls, needle) {
  if (!needle) return true;
  const b = cls.buildingId ? B.get(cls.buildingId) : null;
  return [cls.code, cls.title, cls.room, b?.name, cls.buildingRaw, cls.instructor]
    .filter(Boolean)
    .some((v) => String(v).toLowerCase().includes(needle));
}

function renderClassList() {
  const classes = S.list();
  const ul = $('#class-list');

  // The search box only earns its space once the list is long enough to need it.
  const searchWrap = $('#class-search-wrap');
  if (searchWrap) searchWrap.hidden = classes.length < 6;

  if (!classes.length) {
    ul.innerHTML = '<li class="is-gap">Nothing added yet.</li>';
    return;
  }

  const needle = state.classFilter.trim().toLowerCase();
  const sorted = [...classes]
    .filter((c) => matchesFilter(c, needle))
    .sort(
      (a, b) => S.DAY_LETTERS.indexOf(a.days[0]) - S.DAY_LETTERS.indexOf(b.days[0]) || a.startMin - b.startMin,
    );

  if (!sorted.length) {
    ul.innerHTML = `<li class="is-gap">No classes match “${escapeHtml(state.classFilter.trim())}”.</li>`;
    return;
  }

  // A day-name header appears whenever the sort's primary day (days[0],
  // already what it's sorted by) changes — a class meeting M/W/F shows up
  // once, under Monday, not three times. This is a management list, not a
  // calendar; the calendar-accurate view is Today's Week tab.
  ul.innerHTML = sorted
    .map((c, i) => {
      const primaryDay = c.days[0];
      const header =
        i === 0 || sorted[i - 1].days[0] !== primaryDay
          ? `<li class="classlist__daylabel">${escapeHtml(S.DAY_NAMES[S.DAY_LETTERS.indexOf(primaryDay)] ?? primaryDay)}</li>`
          : '';

      const b = c.buildingId ? B.get(c.buildingId) : null;
      return `${header}<li class="${b ? '' : 'is-bad'}" data-id="${c.id}">
        <div class="item__top">
          <span class="item__code"><span class="tag-dot" style="--dot: var(--${colorFor(c)})" aria-hidden="true"></span>${escapeHtml(c.code || 'Class')}</span>
          <span class="item__time">${S.fmtDays(c.days)} · ${S.fmtTime(c.startMin)}–${S.fmtTime(c.endMin)}</span>
        </div>
        ${c.title ? `<div class="item__meta">${escapeHtml(c.title)}</div>` : ''}
        <div class="item__meta">
          ${b ? escapeHtml(b.name) : `<span class="item__badge">no building</span> ${escapeHtml(c.buildingRaw || '')}`}
          ${c.room ? ` · Room ${escapeHtml(c.room)}` : ''}
          ${c.instructor ? ` · ${escapeHtml(c.instructor)}` : ''}
        </div>
        ${c.notes ? `<div class="item__meta item__meta--notes">${escapeHtml(c.notes)}</div>` : ''}
        <div class="item__actions">
          <button class="btn btn--sm" data-edit="${c.id}">Edit</button>
          ${b ? `<button class="btn btn--sm" data-show="${c.id}">Show on map</button>` : ''}
          ${b ? `<a class="openin__btn" href="${EXT.googleMapsUrl(b)}" target="_blank" rel="noopener">Open in Maps</a>` : ''}
        </div>
      </li>`;
    })
    .join('');

  ul.onclick = (e) => {
    const edit = e.target.closest('[data-edit]');
    if (edit) return openEditor(edit.dataset.edit);
    const show = e.target.closest('[data-show]');
    if (show) {
      const cls = S.list().find((c) => c.id === show.dataset.show);
      const b = cls?.buildingId ? B.get(cls.buildingId) : null;
      if (b) {
        closePanels();
        M.panTo(b);
      }
    }
  };
}

function buildDayChips() {
  const row = $('#days-row');
  row.innerHTML = S.DAY_LETTERS.map(
    (d, i) =>
      `<button type="button" class="day-chip" data-day="${d}" aria-pressed="false" title="${S.DAY_NAMES[i]}">${d}</button>`,
  ).join('');
  row.onclick = (e) => {
    const chip = e.target.closest('.day-chip');
    if (!chip) return;
    chip.setAttribute('aria-pressed', chip.getAttribute('aria-pressed') === 'true' ? 'false' : 'true');
  };
}

// ---------- class colour tags ----------

const TAG_COLORS = ['tag-1', 'tag-2', 'tag-3', 'tag-4', 'tag-5', 'tag-6', 'tag-7', 'tag-8'];

/**
 * A stable pick from the palette based on the course code — so the same
 * code always lands on the same colour across two separate imports, with no
 * need to persist anything until you actually choose one yourself.
 */
function autoColorFor(code) {
  const s = String(code ?? '');
  let hash = 0;
  for (let i = 0; i < s.length; i++) hash = (hash * 31 + s.charCodeAt(i)) | 0;
  return TAG_COLORS[Math.abs(hash) % TAG_COLORS.length];
}

/** The colour actually shown for a class: its own choice, or the auto pick. */
function colorFor(cls) {
  return cls.color || autoColorFor(cls.code || cls.title || cls.id || '');
}

function buildColorRow() {
  const row = $('#color-row');
  if (!row) return;
  row.innerHTML = TAG_COLORS.map(
    (t, i) =>
      `<button type="button" class="swatch" data-color="${t}" style="--swatch-color: var(--${t})"
        aria-pressed="false" aria-label="Colour ${i + 1}"></button>`,
  ).join('');
  row.onclick = (e) => {
    const btn = e.target.closest('.swatch');
    if (!btn) return;
    // Tapping the already-selected swatch clears it back to auto-assigned.
    const wasSelected = btn.getAttribute('aria-pressed') === 'true';
    setColorSwatch(wasSelected ? null : btn.dataset.color);
  };
}

function setColorSwatch(color) {
  $$('#color-row .swatch').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.color === color)));
  const form = $('#form-class');
  if (form) form.color.value = color ?? '';
}

function selectedDays() {
  return $$('#days-row .day-chip[aria-pressed="true"]').map((c) => c.dataset.day);
}

function setDays(days) {
  $$('#days-row .day-chip').forEach((c) => c.setAttribute('aria-pressed', String((days ?? []).includes(c.dataset.day))));
}

function buildBuildingOptions() {
  const dl = $('#building-options');
  if (!dl) return;
  dl.innerHTML = B.all().map((b) => `<option value="${escapeHtml(b.name)}"></option>`).join('');
  const count = $('#building-count');
  if (count) count.textContent = String(B.all().length);
}

function openEditor(id = null) {
  state.editingId = id;
  const form = $('#form-class');
  form.reset();
  $('#form-error').hidden = true;
  $('#building-feedback').textContent = '';
  $('#building-feedback').className = 'feedback';

  if (id) {
    const c = S.list().find((x) => x.id === id);
    if (!c) return;
    $('#edit-h').textContent = 'Edit class';
    form.id.value = c.id;
    form.code.value = c.code ?? '';
    form.title.value = c.title ?? '';
    form.start.value = S.fmtTime(c.startMin);
    form.end.value = S.fmtTime(c.endMin);
    form.room.value = c.room ?? '';
    form.instructor.value = c.instructor ?? '';
    form.notes.value = c.notes ?? '';
    const b = c.buildingId ? B.get(c.buildingId) : null;
    form.building.value = b ? b.name : c.buildingRaw ?? '';
    setDays(c.days);
    setColorSwatch(c.color ?? null);
    $('#btn-delete-class').hidden = false;
  } else {
    $('#edit-h').textContent = 'Add class';
    setDays([]);
    setColorSwatch(null);
    $('#btn-delete-class').hidden = true;
  }

  openPanel('#panel-edit');
}

function wireClassForm() {
  const form = $('#form-class');

  form.building.addEventListener('input', () => {
    const fb = $('#building-feedback');
    const val = form.building.value.trim();
    if (!val) {
      fb.textContent = '';
      fb.className = 'feedback';
      return;
    }
    const { building, confidence } = B.match(val);
    if (building) {
      fb.textContent = `→ ${building.name}${confidence === 'exact' ? '' : ' (matched)'}`;
      fb.className = 'feedback feedback--good';
    } else {
      fb.textContent = 'No building matches that. Check the spelling, or add it in Settings.';
      fb.className = 'feedback feedback--bad';
    }
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#form-error');
    const fail = (msg) => {
      err.textContent = msg;
      err.hidden = false;
    };

    const code = form.code.value.trim();
    if (!code) return fail('Give the class a course code.');

    const days = selectedDays();
    if (!days.length) return fail('Pick at least one day.');

    const startMin = S.parseTime(form.start.value);
    const endMin = S.parseTime(form.end.value);
    if (startMin == null) return fail('Start time looks wrong. Try "9:00 AM" or "14:00".');
    if (endMin == null) return fail('End time looks wrong. Try "9:50 AM" or "14:50".');
    if (endMin <= startMin) return fail('End time has to be after the start time.');

    const raw = form.building.value.trim();
    const { building } = B.match(raw);
    if (!building) return fail("I don't recognise that building. Pick one from the list.");

    // Start from the existing record (if editing) so fields the form doesn't
    // expose — skip dates, colour — survive a save instead of getting wiped,
    // since upsert() replaces the whole record rather than patching it.
    const existing = form.id.value ? S.list().find((c) => c.id === form.id.value) : null;
    const candidate = {
      ...existing,
      id: form.id.value || undefined,
      code,
      title: form.title.value.trim(),
      days,
      startMin,
      endMin,
      buildingId: building.id,
      buildingRaw: raw,
      room: form.room.value.trim(),
      instructor: form.instructor.value.trim(),
      notes: form.notes.value.trim(),
      color: form.color.value || undefined,
    };

    const conflicts = S.findConflicts(candidate, S.list());
    if (conflicts.length) {
      const desc = conflicts
        .map((c) => `${c.code || 'a class'} (${S.fmtDays(c.days)} ${S.fmtTime(c.startMin)}–${S.fmtTime(c.endMin)})`)
        .join(', ');
      const ok = await confirmDialog('Overlaps with an existing class', `This overlaps with ${desc}.`, {
        confirmLabel: 'Save anyway',
      });
      if (!ok) return;
    }

    S.upsert(candidate);

    // Teach the matcher if you typed something non-obvious.
    if (raw && raw.toLowerCase() !== building.name.toLowerCase()) B.learnAlias(raw, building.id);

    err.hidden = true;
    closePanels();
    toast('Class saved');
    refresh();
  });

  $('#btn-delete-class').onclick = async () => {
    if (!state.editingId) return;
    const removed = S.list().find((c) => c.id === state.editingId);
    if (!removed) return;
    if (!(await confirmDialog('Delete this class?', removed.code || 'This class', {
      confirmLabel: 'Delete',
      danger: true,
    }))) return;

    S.remove(state.editingId);
    closePanels();
    refresh();
    // Undo rather than a second are-you-sure: the delete is cheap to reverse.
    toast(`Deleted ${removed.code || 'class'}`, false, {
      label: 'Undo',
      onClick: () => {
        S.upsert(removed);
        toast('Restored');
        refresh();
      },
    });
  };
}

// ---------- import ----------

function wireImport() {
  const dz = $('#dropzone');
  const input = $('#file-input');

  // No click handler here on purpose: <label id="dropzone"> already wraps
  // <input id="file-input">, and a click on a label natively forwards to the
  // control it wraps. Also calling input.click() here fired the file picker
  // a second time on the same tap — desktop Chrome silently tolerates that,
  // but mobile Safari/Chrome cancel or drop the picker when a file input's
  // .click() is re-entered from within another click handler, which is why
  // this was quietly broken specifically on phones.
  dz.onkeydown = (e) => {
    // <label> has no native Enter/Space activation even with tabindex, so
    // keyboard access still needs this.
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      input.click();
    }
  };
  dz.ondragover = (e) => {
    e.preventDefault();
    dz.classList.add('is-over');
  };
  dz.ondragleave = () => dz.classList.remove('is-over');
  dz.ondrop = (e) => {
    e.preventDefault();
    dz.classList.remove('is-over');
    const file = e.dataTransfer.files?.[0];
    if (file) handleImage(file);
  };
  input.onchange = () => {
    if (input.files?.[0]) handleImage(input.files[0]);
    input.value = '';
  };

  // Paste a screenshot straight in — only while the import panel is open.
  document.addEventListener('paste', (e) => {
    if ($('#panel-import').hidden) return;
    const item = [...(e.clipboardData?.items ?? [])].find((i) => i.type.startsWith('image/'));
    if (item) handleImage(item.getAsFile());
  });

  $('#btn-goto-settings').onclick = () => openPanel('#panel-settings');
  $('#btn-review-cancel').onclick = () => {
    state.drafts = null;
    showImportStage('start');
  };
  $('#btn-review-save').onclick = saveDrafts;

  // A toggle rather than always-visible: the dropzone is still the common
  // path, and showing a textarea by default would make the panel look more
  // complicated than it needs to for a screenshot import.
  const textToggle = $('#btn-import-text-toggle');
  const textBlock = $('#import-text-block');
  textToggle.onclick = () => {
    const showing = textBlock.hidden;
    textBlock.hidden = !showing;
    textToggle.setAttribute('aria-expanded', String(showing));
    if (showing) $('#import-text-input').focus();
  };
  $('#btn-import-text-go').onclick = () => handleTextImport($('#import-text-input').value);
}

function showImportStage(stage) {
  $('#import-nokey').hidden = OCR.hasKey();
  $('#import-start').hidden = stage !== 'start';
  $('#import-busy').hidden = stage !== 'busy';
  $('#import-review').hidden = stage !== 'review';
}

/** Shared by both import paths — a parse result's draft shape is identical whether it came from a screenshot or typed text. */
function applyParseResult(result) {
  state.drafts = result.classes;
  renderReview(result.warnings);
  showImportStage(result.classes.length ? 'review' : 'start');
  if (!result.classes.length) toast(result.warnings[0] ?? 'Nothing found there', true);
}

async function handleImage(file) {
  if (!file) return;
  if (!file.type.startsWith('image/')) return toast('That needs to be an image', true);
  if (file.size > 8 * 1024 * 1024) return toast('That image is over 8 MB — try a smaller screenshot', true);
  if (!OCR.hasKey()) {
    showImportStage('start');
    return toast('Add your Gemini API key in Settings first', true);
  }

  showImportStage('busy');
  try {
    applyParseResult(await OCR.parseScreenshot(file));
  } catch (err) {
    showImportStage('start');
    toast(err.message, true);
  }
}

async function handleTextImport(text) {
  if (!String(text ?? '').trim()) return toast('Paste or type your schedule first', true);
  if (!OCR.hasKey()) {
    showImportStage('start');
    return toast('Add your Gemini API key in Settings first', true);
  }

  showImportStage('busy');
  try {
    applyParseResult(await OCR.parseText(text));
    $('#import-text-input').value = '';
  } catch (err) {
    showImportStage('start');
    toast(err.message, true);
  }
}

function renderReview(warnings = []) {
  const warnBox = $('#import-warnings');
  warnBox.innerHTML = warnings.length
    ? `<div class="feedback feedback--warn">${warnings.map(escapeHtml).join('<br>')}</div>`
    : '';

  const ul = $('#review-list');
  ul.innerHTML = state.drafts
    .map((c, i) => {
      const b = c.buildingId ? B.get(c.buildingId) : null;
      return `<li class="${b ? '' : 'is-bad'}">
        <div class="item__top">
          <span class="item__code">${escapeHtml(c.code || 'Class')}</span>
          <span class="item__time">${S.fmtDays(c.days)} · ${S.fmtTime(c.startMin)}–${S.fmtTime(c.endMin)}</span>
        </div>
        ${c.title ? `<div class="item__meta">${escapeHtml(c.title)}</div>` : ''}
        <div class="item__meta">
          ${b ? `✓ ${escapeHtml(b.name)}` : `<span class="item__badge">pick a building</span>`}
          ${c.room ? ` · Room ${escapeHtml(c.room)}` : ''}
        </div>
        ${c.buildingRaw ? `<div class="item__meta hint">Schedule says: “${escapeHtml(c.buildingRaw)}”</div>` : ''}
        <div class="item__actions">
          <select data-pick="${i}">
            <option value="">— choose building —</option>
            ${B.all()
              .map((bb) => `<option value="${bb.id}" ${bb.id === c.buildingId ? 'selected' : ''}>${escapeHtml(bb.name)}</option>`)
              .join('')}
          </select>
          <button class="btn btn--sm" data-drop="${i}">Remove</button>
        </div>
      </li>`;
    })
    .join('');

  ul.onchange = (e) => {
    const sel = e.target.closest('[data-pick]');
    if (!sel) return;
    const draft = state.drafts[Number(sel.dataset.pick)];
    draft.buildingId = sel.value;
    // Teach it, so this abbreviation resolves itself next term.
    if (sel.value && draft.buildingRaw) B.learnAlias(draft.buildingRaw, sel.value);
    renderReview(warnings);
  };
  ul.onclick = (e) => {
    const drop = e.target.closest('[data-drop]');
    if (!drop) return;
    state.drafts.splice(Number(drop.dataset.drop), 1);
    if (!state.drafts.length) {
      state.drafts = null;
      showImportStage('start');
      return;
    }
    renderReview(warnings);
  };
}

async function saveDrafts() {
  if (!state.drafts?.length) return;
  const missing = state.drafts.filter((c) => !c.buildingId).length;
  if (missing) {
    const ok = await confirmDialog(
      'Save without buildings?',
      `${missing} class${missing === 1 ? '' : 'es'} still ${missing === 1 ? 'has' : 'have'} no building, so I can't route you there.`,
      { confirmLabel: 'Save anyway' },
    );
    if (!ok) return;
  }

  const existing = S.list();
  const isDupe = (c) =>
    existing.some(
      (e) => e.code === c.code && e.startMin === c.startMin && S.fmtDays(e.days) === S.fmtDays(c.days),
    );

  // One summary dialog for the whole batch rather than one per row — an
  // import can be a dozen classes, and a dialog per overlap would be a wall
  // of clicks.
  const conflictCount = state.drafts.filter((c) => !isDupe(c) && S.findConflicts(c, existing).length > 0).length;
  if (conflictCount) {
    const ok = await confirmDialog(
      'Some overlap your existing schedule',
      `${conflictCount} imported class${conflictCount === 1 ? '' : 'es'} overlap${conflictCount === 1 ? 's' : ''} something already on your schedule.`,
      { confirmLabel: 'Save anyway' },
    );
    if (!ok) return;
  }

  let added = 0;
  let skipped = 0;
  for (const draft of state.drafts) {
    if (isDupe(draft)) {
      skipped++;
      continue;
    }
    S.upsert(draft);
    added++;
  }

  state.drafts = null;
  showImportStage('start');
  closePanels();
  toast(`Added ${added} class${added === 1 ? '' : 'es'}` + (skipped ? `, skipped ${skipped} already there` : ''));
  refresh();
}

// ---------- settings ----------

/**
 * Text scale and contrast are just token overrides on <html>, so applying them
 * before first paint avoids a flash of the default theme.
 */
function applyDisplaySettings() {
  const { textScale, highContrast, theme } = store.settings();
  const root = document.documentElement;
  root.style.setProperty('--text-scale', String(textScale ?? 1));

  // 'auto' leaves the attribute off entirely so the prefers-color-scheme
  // media query decides. Setting it to "auto" would break those selectors.
  if (theme === 'light' || theme === 'dark') root.setAttribute('data-theme', theme);
  else root.removeAttribute('data-theme');

  if (highContrast) root.setAttribute('data-contrast', 'high');
  else root.removeAttribute('data-contrast');

  // Keep the browser UI (status bar, address bar) in step with the theme.
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) {
    const dark = theme === 'dark'
      || (theme !== 'light' && window.matchMedia?.('(prefers-color-scheme: dark)').matches);
    meta.setAttribute('content', dark ? '#1b1712' : '#8f1d21');
  }
}

/**
 * Long-press shortcut on the Settings icon (Phase: quick theme toggle) — flips
 * between light and dark without opening the panel. 'auto' is treated as
 * whatever it currently resolves to, so the first press always lands on the
 * opposite of what's on screen right now, matching what the user expects to see.
 */
function toggleTheme() {
  const current = store.settings().theme;
  const resolvedDark =
    current === 'dark' || (current !== 'light' && window.matchMedia?.('(prefers-color-scheme: dark)').matches);
  const next = resolvedDark ? 'light' : 'dark';
  store.saveSettings({ theme: next });
  applyDisplaySettings();
  const themeInput = $('#input-theme');
  if (themeInput) themeInput.value = next;
  if (navigator.vibrate) navigator.vibrate(15);
}

function wireSettings() {
  $('#app-version').textContent = `ClassMapper v${APP_VERSION} · ${BUILD_DATE}`;

  const cfg = store.settings();
  $('#input-buffer').value = String(cfg.bufferMin);
  $('#input-speed').value = String(cfg.walkSpeed);
  $('#toggle-notify').checked = N.enabled();
  $('#toggle-alert-cue').checked = N.alertCueEnabled();
  $('#toggle-headsup').checked = N.headsUpEnabled();
  if (OCR.hasKey()) $('#input-key').placeholder = '•••••••• saved';

  $('#btn-save-key').onclick = () => {
    const val = $('#input-key').value.trim();
    if (!val) return setKeyFeedback('Paste a key first.', 'bad');
    OCR.setKey(val);
    $('#input-key').value = '';
    $('#input-key').placeholder = '•••••••• saved';
    setKeyFeedback('Key saved on this device.', 'good');
    showImportStage('start');
  };

  $('#btn-test-key').onclick = async () => {
    const val = $('#input-key').value.trim() || OCR.getKey();
    setKeyFeedback('Checking…');
    try {
      await OCR.testKey(val);
      setKeyFeedback('Key works.', 'good');
    } catch (err) {
      setKeyFeedback(err.message, 'bad');
    }
  };

  $('#btn-clear-key').onclick = () => {
    OCR.setKey('');
    $('#input-key').value = '';
    $('#input-key').placeholder = 'AIza…';
    setKeyFeedback('Key removed.', 'good');
    showImportStage('start');
  };

  $('#toggle-notify').onchange = async (e) => {
    const fb = $('#notify-feedback');
    if (e.target.checked) {
      try {
        await N.enable();
        fb.textContent = "Alerts on. They only fire while ClassMapper is open.";
        fb.className = 'feedback feedback--good';
      } catch (err) {
        e.target.checked = false;
        fb.textContent = err.message;
        fb.className = 'feedback feedback--bad';
      }
    } else {
      N.disable();
      fb.textContent = 'Alerts off.';
      fb.className = 'feedback';
    }
  };

  $('#toggle-alert-cue').onchange = (e) => {
    store.saveSettings({ alertCue: e.target.checked });
    if (e.target.checked) N.playAlertCue();
  };

  $('#toggle-headsup').onchange = (e) => store.saveSettings({ headsUpAlert: e.target.checked });

  $('#btn-test-cue').onclick = () => N.playAlertCue();

  // --- display ---
  $('#input-theme').value = cfg.theme ?? 'auto';
  $('#input-theme').onchange = (e) => {
    store.saveSettings({ theme: e.target.value });
    applyDisplaySettings();
  };
  $('#input-textscale').value = String(cfg.textScale ?? 1);
  $('#toggle-contrast').checked = Boolean(cfg.highContrast);
  $('#input-textscale').onchange = (e) => {
    store.saveSettings({ textScale: Number(e.target.value) });
    applyDisplaySettings();
    M.invalidate(); // the card changed height, so the map's box did too
  };
  $('#toggle-contrast').onchange = (e) => {
    store.saveSettings({ highContrast: e.target.checked });
    applyDisplaySettings();
  };

  // --- semester range ---
  $('#input-semester-start').value = cfg.semesterStart ?? '';
  $('#input-semester-end').value = cfg.semesterEnd ?? '';
  const onSemesterChange = () => {
    const start = $('#input-semester-start').value;
    const end = $('#input-semester-end').value;
    const fb = $('#semester-feedback');
    if (start && end && start > end) {
      // Plain string compare is correct and safe for ISO YYYY-MM-DD.
      fb.textContent = 'The end date is before the start date.';
      fb.className = 'feedback feedback--bad';
      return;
    }
    store.saveSettings({ semesterStart: start, semesterEnd: end });
    fb.textContent = start || end ? 'Saved.' : 'No limit set — all classes always count.';
    fb.className = 'feedback feedback--good';
    refresh();
  };
  $('#input-semester-start').onchange = onSemesterChange;
  $('#input-semester-end').onchange = onSemesterChange;

  $('#toggle-offline').checked = Boolean(cfg.offline);
  $('#toggle-offline').onchange = async (e) => {
    const fb = $('#offline-feedback');
    store.saveSettings({ offline: e.target.checked });
    if (e.target.checked) {
      fb.textContent = 'Caching the app…';
      fb.className = 'feedback';
      await registerServiceWorker();
      const ok = (await navigator.serviceWorker.getRegistrations()).length > 0;
      fb.textContent = ok
        ? 'Offline mode on. The app will open without a signal.'
        : "This browser wouldn't enable offline mode. Everything else still works.";
      fb.className = 'feedback ' + (ok ? 'feedback--good' : 'feedback--bad');
      if (!ok) {
        store.saveSettings({ offline: false });
        e.target.checked = false;
      }
    } else {
      await clearAppCache();
      fb.textContent = 'Offline mode off and cache cleared.';
      fb.className = 'feedback';
    }
  };

  $('#btn-test-notify').onclick = () => {
    const fb = $('#notify-feedback');
    try {
      N.testAlert();
      fb.textContent = 'Sent.';
      fb.className = 'feedback feedback--good';
    } catch (err) {
      fb.textContent = err.message;
      fb.className = 'feedback feedback--bad';
    }
  };

  $('#input-buffer').onchange = (e) => {
    store.saveSettings({ bufferMin: Number(e.target.value) });
    refresh();
  };
  $('#input-speed').onchange = (e) => {
    store.saveSettings({ walkSpeed: Number(e.target.value) });
    store.remove(store.KEYS.ROUTES); // cached durations used the old pace
    refresh();
  };

  $('#btn-fix-pin').onclick = async () => {
    const building = await pickBuilding('Move a building pin', 'Which building is in the wrong place?');
    if (!building) return;
    closePanels();
    M.panTo(building);
    startPick(`Tap where “${building.name}” really is`, (pt) => {
      B.setOverride(building.id, pt);
      toast(`Moved ${building.name}`);
      store.remove(store.KEYS.ROUTES);
      refresh();
    });
  };

  $('#btn-add-building').onclick = async () => {
    const chosenName = await openModal({
      title: 'Add a missing building',
      message: 'Name it, then tap its spot on the map.',
      mode: 'text',
      inputLabel: 'Building name',
      confirmLabel: 'Next',
    });
    if (!chosenName) return;
    closePanels();
    startPick(`Tap where “${chosenName}” is`, (pt) => {
      try {
        const b = B.addCustom(chosenName, pt);
        toast(`Added ${b.name}`);
        buildBuildingOptions();
        refresh();
      } catch (err) {
        toast(err.message, true);
      }
    });
  };

  $('#btn-export').onclick = () => {
    const blob = new Blob([JSON.stringify(store.exportAll(), null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `classmapper-backup-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Revoking immediately can cancel the download before some mobile browsers
    // finish reading the blob — give it a moment first.
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    dataFeedback('Backup downloading. Your API key is not included.', 'good');
  };

  $('#btn-copy-backup').onclick = async () => {
    const text = JSON.stringify(store.exportAll(), null, 2);
    try {
      if (!navigator.clipboard) throw new Error('no Clipboard API');
      await navigator.clipboard.writeText(text);
      dataFeedback('Backup copied. Paste it somewhere safe, like Notes.', 'good');
    } catch {
      // Clipboard API needs a permission some mobile browsers just refuse —
      // fall back to the same paste box used for restoring, pre-filled and
      // selected, so the user can copy it by hand instead.
      const box = $('#backup-paste');
      box.hidden = false;
      box.value = text;
      box.focus();
      box.select();
      dataFeedback("Couldn't copy automatically — it's selected below, copy it manually.", 'bad');
    }
  };

  $('#file-restore').onchange = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    await restoreBackup(await file.text());
    e.target.value = '';
  };

  $('#btn-paste-restore').onclick = () => {
    const box = $('#backup-paste');
    const confirmBtn = $('#btn-paste-restore-confirm');
    const opening = box.hidden;
    box.hidden = !opening;
    confirmBtn.hidden = !opening;
    if (opening) {
      box.value = '';
      box.focus();
    }
  };

  $('#btn-paste-restore-confirm').onclick = async () => {
    await restoreBackup($('#backup-paste').value);
    $('#backup-paste').hidden = true;
    $('#btn-paste-restore-confirm').hidden = true;
  };

  $('#btn-wipe').onclick = async () => {
    const ok = await confirmDialog(
      'Delete everything?',
      'Your classes, pin corrections, API key and settings will be removed from this device. This cannot be undone — export a backup first if you might want them back.',
      { confirmLabel: 'Delete everything', danger: true },
    );
    if (!ok) return;
    for (const key of Object.values(store.KEYS)) store.remove(key);
    await clearAppCache();
    location.reload();
  };

  // Escape hatch: a stale service worker or cache should never be a dead end.
  $('#btn-reset-cache').onclick = async () => {
    const el = $('#cache-feedback');
    el.textContent = 'Clearing…';
    el.className = 'feedback';
    await clearAppCache();
    el.textContent = 'Cleared. Reloading…';
    el.className = 'feedback feedback--good';
    setTimeout(() => location.reload(), 600);
  };

  renderOverrides();
}

/** Drop every service worker and cached file. Leaves your schedule alone. */
async function clearAppCache() {
  try {
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
    }
    if ('caches' in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
  } catch (err) {
    console.warn('Cache clear failed', err);
  }
}

function renderOverrides() {
  const box = $('#override-list');
  const moved = B.all().filter((b) => b.moved);
  const custom = B.all().filter((b) => b.source === 'user');
  if (!moved.length && !custom.length) {
    box.innerHTML = '';
    return;
  }
  box.innerHTML =
    moved.map((b) => `<div><span>${escapeHtml(b.name)} — pin moved</span><button class="btn btn--sm" data-reset="${b.id}">Reset</button></div>`).join('') +
    custom.map((b) => `<div><span>${escapeHtml(b.name)} — added by you</span><button class="btn btn--sm" data-del="${b.id}">Remove</button></div>`).join('');

  box.onclick = (e) => {
    const reset = e.target.closest('[data-reset]');
    if (reset) {
      B.setOverride(reset.dataset.reset, null);
      renderOverrides();
      refresh();
      return;
    }
    const del = e.target.closest('[data-del]');
    if (del) {
      B.removeCustom(del.dataset.del);
      renderOverrides();
      buildBuildingOptions();
      refresh();
    }
  };
}

function setKeyFeedback(msg, kind = '') {
  const el = $('#key-feedback');
  el.textContent = msg;
  el.className = 'feedback' + (kind ? ` feedback--${kind}` : '');
}

function dataFeedback(msg, kind = '') {
  const el = $('#data-feedback');
  el.textContent = msg;
  el.className = 'feedback' + (kind ? ` feedback--${kind}` : '');
}

/** Shared by both restore paths: pick a file, or paste JSON text directly. */
async function restoreBackup(rawText) {
  const text = String(rawText ?? '').trim();
  if (!text) {
    dataFeedback('Nothing to restore.', 'bad');
    return;
  }
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    dataFeedback("That doesn't look like a valid backup file.", 'bad');
    return;
  }
  try {
    store.importAll(payload);
    await B.load();
    dataFeedback('Backup restored.', 'good');
    buildBuildingOptions();
    refresh();
  } catch (err) {
    dataFeedback(err.message, 'bad');
  }
}

// ---------- pin drop ----------

function startPick(message, onPick) {
  $('#pick-text').textContent = message;
  $('#pick-banner').hidden = false;
  const cancel = M.pickPoint((pt) => {
    $('#pick-banner').hidden = true;
    onPick(pt);
    renderOverrides();
  });
  $('#pick-cancel').onclick = () => {
    cancel();
    $('#pick-banner').hidden = true;
  };
}

// ---------- panels & chrome ----------

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function openPanel(sel) {
  closePanels({ restoreFocus: false });
  const panel = $(sel);
  // Remember what opened this so focus can go back there on close — otherwise
  // keyboard users land at the top of the document every time.
  state.panelOpener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  panel.hidden = false;
  $('#scrim').hidden = false;

  if (sel === '#panel-import') showImportStage(state.drafts ? 'review' : 'start');
  if (sel === '#panel-settings') renderOverrides();

  // Land on the heading rather than the first control, so the panel's purpose
  // is announced before its options.
  panel.querySelector('h2')?.focus();
}

function closePanels({ restoreFocus = true } = {}) {
  const wasOpen = $$('.panel').some((p) => !p.hidden);
  $$('.panel').forEach((p) => (p.hidden = true));
  $('#scrim').hidden = true;
  if (wasOpen && restoreFocus && state.panelOpener?.isConnected) state.panelOpener.focus();
  if (wasOpen) state.panelOpener = null;
}

function openPanelEl() {
  return $$('.panel').find((p) => !p.hidden) ?? null;
}

function wirePanels() {
  $('#scrim').onclick = () => closePanels();
  $$('[data-close]').forEach((b) => (b.onclick = () => closePanels()));

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      // <dialog> handles its own Escape; don't close the panel underneath it too.
      if ($('#modal').open) return;
      closePanels();
      M.cancelPick();
      $('#pick-banner').hidden = true;
      exitMapMode(); // dismisses a day route or a building search alike
      return;
    }

    // Trap Tab inside an open panel — it used to escape into the map behind it,
    // leaving keyboard users tabbing through an interface they can't see.
    if (e.key !== 'Tab') return;
    const panel = openPanelEl();
    if (!panel) return;

    const items = [...panel.querySelectorAll(FOCUSABLE)].filter(
      (el) => el.offsetParent !== null || el === document.activeElement,
    );
    if (!items.length) return;

    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;

    if (!panel.contains(active)) {
      e.preventDefault();
      (e.shiftKey ? last : first).focus();
    } else if (e.shiftKey && active === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  });
}

function wireTopbar() {
  $('#btn-today').onclick = () => {
    renderToday();
    openPanel('#panel-today');
  };
  $('#class-search').oninput = (e) => {
    state.classFilter = e.target.value;
    renderClassList();
  };

  $('#btn-classes').onclick = () => {
    renderClassList();
    openPanel('#panel-classes');
  };
  // Tap opens Settings as usual; a ~500ms hold toggles the theme in place
  // instead, so switching light/dark doesn't require a trip into the panel.
  {
    const btnSettings = $('#btn-settings');
    let longPressTimer = null;
    let longPressFired = false;
    btnSettings.addEventListener('pointerdown', () => {
      longPressFired = false;
      clearTimeout(longPressTimer);
      longPressTimer = setTimeout(() => {
        longPressFired = true;
        toggleTheme();
      }, 500);
    });
    for (const evt of ['pointerup', 'pointerleave', 'pointercancel']) {
      btnSettings.addEventListener(evt, () => clearTimeout(longPressTimer));
    }
    btnSettings.onclick = () => {
      if (longPressFired) {
        longPressFired = false;
        return;
      }
      openPanel('#panel-settings');
    };
  }
  $('#btn-find').onclick = findBuilding;
  $('#btn-add').onclick = () => openEditor(null);
  $('#btn-add-empty').onclick = () => openEditor(null);
  $('#btn-import').onclick = () => openPanel('#panel-import');
  $('#btn-import-empty').onclick = () => openPanel('#panel-import');
  $('#btn-route-day').onclick = showDayRoute;

  $('#btn-satellite').onclick = (e) => {
    const on = M.toggleSatellite();
    e.currentTarget.setAttribute('aria-pressed', String(on));
  };
  if (store.settings().satellite) $('#btn-satellite').setAttribute('aria-pressed', 'true');

  $('#btn-locate').onclick = () => {
    if (state.me) M.panTo(state.me, 18);
    else toast('Location not available yet');
  };
}

// ---------- helpers ----------

let toastTimer;
/**
 * Transient feedback. `action` optionally adds a button ({ label, onClick }),
 * used for Undo after a delete.
 * The element carries role="status"/aria-live, so this is also how screen
 * reader users hear about saves and errors — it used to be silent to them.
 */
function toast(msg, bad = false, action = null) {
  const el = $('#toast');
  const btn = $('#toast-action');
  $('#toast-text').textContent = msg;
  el.className = 'toast' + (bad ? ' is-bad' : '');
  // Errors interrupt; routine confirmations wait their turn.
  el.setAttribute('role', bad ? 'alert' : 'status');
  el.setAttribute('aria-live', bad ? 'assertive' : 'polite');

  if (action) {
    btn.textContent = action.label;
    btn.hidden = false;
    btn.onclick = () => {
      el.hidden = true;
      clearTimeout(toastTimer);
      action.onClick();
    };
  } else {
    btn.hidden = true;
    btn.onclick = null;
  }

  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), action ? 8000 : bad ? 5200 : 3200);
}

/**
 * Announce a state change to screen readers, and only when it actually
 * changed — the 30s refresh tick calls this constantly with identical text,
 * and rewriting a live region re-announces it every single time.
 */
let lastAnnounced = '';
function announce(msg) {
  const text = String(msg ?? '').trim();
  if (!text || text === lastAnnounced) return;
  lastAnnounced = text;
  $('#sr-status').textContent = text;
}

function setNote(msg) {
  const el = $('#next-note');
  el.textContent = msg ?? '';
  el.hidden = !msg;
}

// ---------- modal (replaces prompt/confirm) ----------

/**
 * Native <dialog> handles focus trapping, Escape, and inerting the background
 * for us. It also works where prompt()/confirm() don't: some mobile browsers
 * suppress those outright, which used to make pin-drop silently do nothing.
 * Resolves to `false`/`null` on cancel.
 */
function openModal({
  title,
  message = '',
  mode = 'confirm',        // 'confirm' | 'picker' (must match a building) | 'text' (free text)
  confirmLabel = 'OK',
  cancelLabel = 'Cancel',
  danger = false,
  initial = '',
  inputLabel = 'Building',
}) {
  const dlg = $('#modal');
  const picker = $('#modal-picker');
  const input = $('#modal-input');
  const confirmBtn = $('#modal-confirm');
  const feedback = $('#modal-feedback');

  $('#modal-title').textContent = title;
  $('#modal-message').textContent = message;
  confirmBtn.textContent = confirmLabel;
  confirmBtn.className = 'btn ' + (danger ? 'btn--danger' : 'btn--primary');
  // Always set explicitly — a previous call's custom label must not leak
  // into this one, since the same dialog element is reused every time.
  $('#modal-cancel').textContent = cancelLabel;

  const isPicker = mode === 'picker';
  const isText = mode === 'text';
  const wantsInput = isPicker || isText;

  picker.hidden = !wantsInput;
  $('#modal-input-label').textContent = inputLabel;
  // Only the picker should autocomplete against known buildings; naming a new
  // one shouldn't suggest the names it can't be.
  if (isPicker) input.setAttribute('list', 'building-options');
  else input.removeAttribute('list');
  input.value = initial;
  feedback.textContent = '';
  feedback.className = 'feedback';

  const emptyResult = wantsInput ? null : false;

  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      input.oninput = null;
      dlg.close();
      resolve(value);
    };

    if (isPicker) {
      // Live "→ matched building" feedback, same matcher the class form uses.
      input.oninput = () => {
        const val = input.value.trim();
        if (!val) {
          feedback.textContent = '';
          feedback.className = 'feedback';
          return;
        }
        const { building } = B.match(val);
        feedback.textContent = building ? `→ ${building.name}` : 'No building matches that yet';
        feedback.className = 'feedback ' + (building ? 'feedback--good' : 'feedback--bad');
      };
    }

    confirmBtn.onclick = () => {
      if (mode === 'confirm') return finish(true);

      const raw = input.value.trim();
      if (!raw) {
        feedback.textContent = isPicker ? 'Pick a building from the list first.' : 'Enter a name first.';
        feedback.className = 'feedback feedback--bad';
        input.focus();
        return;
      }
      if (isText) return finish(raw);

      const { building } = B.match(raw);
      if (!building) {
        feedback.textContent = 'No building matches that. Check the spelling.';
        feedback.className = 'feedback feedback--bad';
        input.focus();
        return;
      }
      finish(building);
    };
    $('#modal-cancel').onclick = () => finish(emptyResult);
    // Covers Escape, which fires `close` without going through our buttons.
    dlg.addEventListener('close', () => finish(emptyResult), { once: true });

    dlg.showModal();
    (wantsInput ? input : confirmBtn).focus();
  });
}

const confirmDialog = (title, message, opts = {}) =>
  openModal({ title, message, mode: 'confirm', confirmLabel: opts.confirmLabel ?? 'Confirm', danger: opts.danger });

const pickBuilding = (title, message = '', opts = {}) =>
  openModal({ title, message, mode: 'picker', confirmLabel: 'Select', cancelLabel: opts.cancelLabel ?? 'Cancel' });

function fmtClock(date) {
  const h24 = date.getHours();
  const h = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h}:${String(date.getMinutes()).padStart(2, '0')} ${h24 < 12 ? 'AM' : 'PM'}`;
}

function fmtDuration(mins) {
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h} hr ${m} min` : `${h} hr`;
}

function startOfDay(d) {
  const c = new Date(d);
  c.setHours(0, 0, 0, 0);
  return c;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

boot();
