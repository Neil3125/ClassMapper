// ClassMapper — boot, state, and all screen wiring.

import * as store from './store.js';
import * as B from './buildings.js';
import * as S from './schedule.js';
import * as R from './route.js';
import * as M from './map.js';
import * as OCR from './ocr.js';
import * as N from './notify.js';
import * as EXT from './external.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const state = {
  me: null,            // {lat, lon, accuracy} from geolocation
  route: null,         // current route to next class
  showingDay: false,
  dayLegs: null,       // [{fromLabel, toLabel, meters, minutes, shape, approximate}], when shown
  dayLegVisible: [],   // bool per leg, parallel to dayLegs
  drafts: null,        // parsed import awaiting review
  editingId: null,
  routeToken: 0,       // guards against out-of-order route responses
};

// ---------- boot ----------

async function boot() {
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
    ['building list', buildBuildingOptions],
    ['top bar', wireTopbar],
    ['panels', wirePanels],
    ['class form', wireClassForm],
    ['import', wireImport],
    ['settings', wireSettings],
    ['day route legend', wireDayLegend],
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
  navigator.geolocation.watchPosition(
    (pos) => {
      const { latitude, longitude, accuracy } = pos.coords;
      const first = !state.me;
      state.me = { lat: latitude, lon: longitude, accuracy };
      M.showMe(latitude, longitude, accuracy);
      if (first) refresh();
    },
    (err) => {
      if (err.code === err.PERMISSION_DENIED) {
        setNote('Location is off, so walk times start from your first class instead.');
      }
    },
    { enableHighAccuracy: true, maximumAge: 15_000, timeout: 20_000 },
  );
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
    M.renderStops([]);
    M.clearRoute();
    return;
  }

  const now = new Date();
  const next = S.nextClass(now, classes);
  renderStopsForToday(now, next);

  if (!next) {
    $('#next-label').textContent = 'Nothing left this week';
    $('#next-code').textContent = '—';
    $('#next-time').textContent = '';
    $('#next-where').textContent = '';
    $('#next-walk').textContent = '';
    $('#next-leave').textContent = '';
    $('#next-steps').hidden = true;
    $('#next-openin').hidden = true;
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

  if (!b) {
    $('#next-walk').textContent = '';
    $('#next-leave').textContent = '';
    $('#next-steps').hidden = true;
    setNote('Open My classes and pick a building so I can route you there.');
    return;
  }

  // Route from wherever you are; if location is unavailable, route from the
  // class before this one, which is where you'll actually be standing.
  const origin = state.me ?? previousStop(now, next);

  if (!origin) {
    $('#next-walk').textContent = 'Walk time needs your location';
    $('#next-leave').textContent = '';
    $('#next-steps').hidden = true;
    return;
  }

  const token = ++state.routeToken;
  const route = await R.walk(origin, b);
  if (token !== state.routeToken) return; // a newer refresh already won

  state.route = route;
  if (!route) return;

  // The day-route legend owns the map while it's open — leave its lines alone,
  // but keep computing walk time and leave-by below so the card doesn't go
  // stale just because you're looking at the whole day.
  if (!state.showingDay) M.drawRoute(route.shape);

  const { bufferMin } = store.settings();
  const leaveAt = S.leaveBy(next.startsAt, route.minutes, bufferMin);
  const minsToLeave = Math.round((leaveAt - now) / 60000);

  $('#next-walk').textContent = route.samePlace
    ? 'Same building — no walk'
    : `${route.minutes} min walk · ${R.fmtDistance(route.meters)}`;

  const leaveEl = $('#next-leave');
  leaveEl.classList.remove('pill--late', 'pill--now');
  if (next.isNow) {
    leaveEl.textContent = `In progress until ${S.fmtTime(next.cls.endMin)}`;
    leaveEl.classList.add('pill--now');
  } else if (minsToLeave <= 0) {
    leaveEl.textContent = minsToLeave < -1 ? `Leave now — ${Math.abs(minsToLeave)} min behind` : 'Leave now';
    leaveEl.classList.add('pill--late');
  } else if (minsToLeave < 60) {
    leaveEl.textContent = `Leave in ${minsToLeave} min (${fmtClock(leaveAt)})`;
  } else {
    leaveEl.textContent = `Leave by ${fmtClock(leaveAt)}`;
  }

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

  if (!next.isNow) {
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

  M.renderStops(stops, { onSelect: (s) => M.panTo(s.building) });

  if (!state.showingDay) {
    const pts = stops.map((s) => s.building).filter(Boolean);
    if (state.me) pts.push(state.me);
    if (pts.length) M.fitTo(pts);
  }
}

// ---------- today panel ----------

function renderToday() {
  const now = new Date();
  const plan = S.dayPlan(now);
  const list = $('#today-list');
  const next = S.nextClass(now);

  if (!plan.length) {
    list.innerHTML = '<li class="is-gap">No classes today.</li>';
    $('#today-summary').innerHTML = `<strong>${S.DAY_NAMES[now.getDay()]}</strong> — nothing scheduled. Enjoy it.`;
    $('#btn-route-day').disabled = true;
    $('#btn-route-day-google').hidden = true;
    return;
  }

  const classCount = plan.filter((p) => p.type === 'class').length;
  list.innerHTML = plan
    .map((item) => {
      if (item.type === 'gap') {
        return `<li class="is-gap">${fmtDuration(item.minutes)} free · ${S.fmtTime(item.from)}–${S.fmtTime(item.to)}</li>`;
      }
      const cls = item.cls;
      const b = cls.buildingId ? B.get(cls.buildingId) : null;
      const isNext = next && cls.id === next.cls.id && cls.startMin === next.cls.startMin;
      return `<li class="${isNext ? 'is-next' : ''}">
        <div class="item__top">
          <span class="item__code">${escapeHtml(cls.code || cls.title || 'Class')}</span>
          <span class="item__time">${S.fmtTime(cls.startMin)}–${S.fmtTime(cls.endMin)}</span>
        </div>
        <div class="item__meta">${b ? escapeHtml(b.name) : '⚠ no building'}${cls.room ? ` · Room ${escapeHtml(cls.room)}` : ''}</div>
      </li>`;
    })
    .join('');

  $('#today-summary').innerHTML =
    `<strong>${S.DAY_NAMES[now.getDay()]}</strong> — ${classCount} class${classCount === 1 ? '' : 'es'}, ` +
    `${S.fmtTime(plan[0].cls.startMin)} to ${S.fmtTime([...plan].reverse().find((p) => p.type === 'class').cls.endMin)}.`;
  $('#btn-route-day').disabled = classCount < 2;

  const stops = S.classesToday(now)
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

async function showDayRoute() {
  const now = new Date();
  const namedStops = S.classesToday(now)
    .map((c) => (c.buildingId ? { cls: c, point: B.get(c.buildingId) } : null))
    .filter(Boolean);

  if (namedStops.length < 2) {
    toast('Need at least two classes with buildings today', true);
    return;
  }

  state.showingDay = true;
  M.clearRoute();
  closePanels();
  toast('Routing your whole day…');

  // "You are here" has no class attached; every other point maps back to the
  // class it's the location of, so each leg can be labeled by name.
  const named = state.me
    ? [{ cls: null, point: state.me }, ...namedStops]
    : namedStops;
  const points = named.map((n) => ({ lat: n.point.lat, lon: n.point.lon }));

  const result = await R.chain(points);
  if (!state.showingDay) return; // closed while the routing call was in flight

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
  renderDayLegend();

  toast(
    `Whole day: ${R.fmtDistance(result.meters)} of walking, about ${fmtDuration(result.minutes)}` +
      (result.approximate ? ' (estimated)' : ''),
  );
}

function exitDayRoute() {
  state.showingDay = false;
  state.dayLegs = null;
  state.dayLegVisible = [];
  M.clearLegs();
  $('#day-legend').hidden = true;
  refresh();
}

function renderDayLegend() {
  const box = $('#day-legend');
  if (!state.dayLegs?.length) {
    box.hidden = true;
    return;
  }
  box.hidden = false;

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

  $('#day-legend-close').onclick = exitDayRoute;
}

// ---------- class list & editor ----------

function renderClassList() {
  const classes = S.list();
  const ul = $('#class-list');
  if (!classes.length) {
    ul.innerHTML = '<li class="is-gap">Nothing added yet.</li>';
    return;
  }
  const sorted = [...classes].sort(
    (a, b) => S.DAY_LETTERS.indexOf(a.days[0]) - S.DAY_LETTERS.indexOf(b.days[0]) || a.startMin - b.startMin,
  );
  ul.innerHTML = sorted
    .map((c) => {
      const b = c.buildingId ? B.get(c.buildingId) : null;
      return `<li class="${b ? '' : 'is-bad'}" data-id="${c.id}">
        <div class="item__top">
          <span class="item__code">${escapeHtml(c.code || 'Class')}</span>
          <span class="item__time">${S.fmtDays(c.days)} · ${S.fmtTime(c.startMin)}–${S.fmtTime(c.endMin)}</span>
        </div>
        ${c.title ? `<div class="item__meta">${escapeHtml(c.title)}</div>` : ''}
        <div class="item__meta">
          ${b ? escapeHtml(b.name) : `<span class="item__badge">no building</span> ${escapeHtml(c.buildingRaw || '')}`}
          ${c.room ? ` · Room ${escapeHtml(c.room)}` : ''}
        </div>
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
    const b = c.buildingId ? B.get(c.buildingId) : null;
    form.building.value = b ? b.name : c.buildingRaw ?? '';
    setDays(c.days);
    $('#btn-delete-class').hidden = false;
  } else {
    $('#edit-h').textContent = 'Add class';
    setDays([]);
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

  form.addEventListener('submit', (e) => {
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

    S.upsert({
      id: form.id.value || undefined,
      code,
      title: form.title.value.trim(),
      days,
      startMin,
      endMin,
      buildingId: building.id,
      buildingRaw: raw,
      room: form.room.value.trim(),
    });

    // Teach the matcher if you typed something non-obvious.
    if (raw && raw.toLowerCase() !== building.name.toLowerCase()) B.learnAlias(raw, building.id);

    err.hidden = true;
    closePanels();
    toast('Class saved');
    refresh();
  });

  $('#btn-delete-class').onclick = () => {
    if (!state.editingId) return;
    if (!confirm('Delete this class?')) return;
    S.remove(state.editingId);
    closePanels();
    toast('Class deleted');
    refresh();
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
}

function showImportStage(stage) {
  $('#import-nokey').hidden = OCR.hasKey();
  $('#import-start').hidden = stage !== 'start';
  $('#import-busy').hidden = stage !== 'busy';
  $('#import-review').hidden = stage !== 'review';
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
    const result = await OCR.parseScreenshot(file);
    state.drafts = result.classes;
    renderReview(result.warnings);
    showImportStage(result.classes.length ? 'review' : 'start');
    if (!result.classes.length) toast(result.warnings[0] ?? 'Nothing found in that image', true);
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

function saveDrafts() {
  if (!state.drafts?.length) return;
  const missing = state.drafts.filter((c) => !c.buildingId).length;
  if (missing && !confirm(`${missing} class${missing === 1 ? '' : 'es'} still have no building and won't be routable. Save anyway?`)) {
    return;
  }

  const existing = S.list();
  const isDupe = (c) =>
    existing.some(
      (e) => e.code === c.code && e.startMin === c.startMin && S.fmtDays(e.days) === S.fmtDays(c.days),
    );

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

function wireSettings() {
  const cfg = store.settings();
  $('#input-buffer').value = String(cfg.bufferMin);
  $('#input-speed').value = String(cfg.walkSpeed);
  $('#toggle-notify').checked = N.enabled();
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

  $('#btn-fix-pin').onclick = () => {
    const name = prompt('Which building? (type part of its name)');
    if (!name) return;
    const { building } = B.match(name);
    if (!building) return toast('No building matches that', true);
    closePanels();
    M.panTo(building);
    startPick(`Tap where “${building.name}” really is`, (pt) => {
      B.setOverride(building.id, pt);
      toast(`Moved ${building.name}`);
      store.remove(store.KEYS.ROUTES);
      refresh();
    });
  };

  $('#btn-add-building').onclick = () => {
    const name = prompt('Name for the new building');
    if (!name?.trim()) return;
    closePanels();
    startPick(`Tap where “${name.trim()}” is`, (pt) => {
      try {
        const b = B.addCustom(name.trim(), pt);
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
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `classmapper-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    dataFeedback('Backup downloaded. Your API key is not included.', 'good');
  };

  $('#file-restore').onchange = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      store.importAll(JSON.parse(await file.text()));
      await B.load();
      dataFeedback('Backup restored.', 'good');
      buildBuildingOptions();
      refresh();
    } catch (err) {
      dataFeedback(err.message, 'bad');
    }
    e.target.value = '';
  };

  $('#btn-wipe').onclick = async () => {
    if (!confirm('Delete your classes, pins, key and settings from this device? This cannot be undone.')) return;
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

function openPanel(sel) {
  closePanels();
  $(sel).hidden = false;
  $('#scrim').hidden = false;
  if (sel === '#panel-import') showImportStage(state.drafts ? 'review' : 'start');
  if (sel === '#panel-settings') renderOverrides();
}

function closePanels() {
  $$('.panel').forEach((p) => (p.hidden = true));
  $('#scrim').hidden = true;
}

function wirePanels() {
  $('#scrim').onclick = closePanels;
  $$('[data-close]').forEach((b) => (b.onclick = closePanels));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closePanels();
      M.cancelPick();
      $('#pick-banner').hidden = true;
      if (state.showingDay) exitDayRoute();
    }
  });
}

function wireTopbar() {
  $('#btn-today').onclick = () => {
    renderToday();
    openPanel('#panel-today');
  };
  $('#btn-classes').onclick = () => {
    renderClassList();
    openPanel('#panel-classes');
  };
  $('#btn-settings').onclick = () => openPanel('#panel-settings');
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
function toast(msg, bad = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'toast' + (bad ? ' is-bad' : '');
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), bad ? 5200 : 3200);
}

function setNote(msg) {
  const el = $('#next-note');
  el.textContent = msg ?? '';
  el.hidden = !msg;
}

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
