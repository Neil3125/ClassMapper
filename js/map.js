// Leaflet map: campus tiles, class markers, live location, route line,
// and pin-drop mode for correcting building coordinates.

import { settings, saveSettings } from './store.js';

const CAMPUS_CENTER = [32.4298, -85.7065];
const CAMPUS_BOUNDS = [
  [32.4175, -85.7165],
  [32.4375, -85.6985],
];

let map;
let layers = {};
let markerGroup;
let routeLine;
let lastRouteShape = null;
let meMarker;
let meAccuracy;
let meHeadingMarker;
let meAnimFrame = null;
let meDisplayed = null; // {lat, lon} currently on screen, for interpolation
let pinDropHandler = null;

export function init(elementId = 'map') {
  map = L.map(elementId, {
    center: CAMPUS_CENTER,
    zoom: 16,
    zoomControl: false,
    maxBounds: CAMPUS_BOUNDS,
    maxBoundsViscosity: 0.5,
  });

  layers.street = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '© OpenStreetMap contributors',
  });

  layers.satellite = L.tileLayer(
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    { maxZoom: 19, attribution: 'Imagery © Esri' },
  );

  (settings().satellite ? layers.satellite : layers.street).addTo(map);

  L.control.zoom({ position: 'bottomright' }).addTo(map);
  markerGroup = L.layerGroup().addTo(map);

  watchContainerSize(elementId);

  return map;
}

// If the container resizes without Leaflet being told, its renderer keeps the
// old pixel bounds and clips every drawn route away to an empty path. That
// happens on phone rotation and when mobile browser chrome hides on scroll.
function watchContainerSize(elementId) {
  let pending;
  const refit = () => {
    clearTimeout(pending);
    pending = setTimeout(() => map?.invalidateSize({ animate: false }), 150);
  };

  window.addEventListener('resize', refit);
  window.addEventListener('orientationchange', refit);

  if ('ResizeObserver' in window) {
    new ResizeObserver(refit).observe(document.getElementById(elementId));
  }
}

export function toggleSatellite() {
  const on = !settings().satellite;
  map.removeLayer(on ? layers.street : layers.satellite);
  (on ? layers.satellite : layers.street).addTo(map);
  saveSettings({ satellite: on });
  return on;
}

function classIcon(label, state) {
  return L.divIcon({
    className: 'cm-pin-wrap',
    html: `<div class="cm-pin cm-pin--${state}"><span>${label}</span></div>`,
    iconSize: [34, 34],
    iconAnchor: [17, 17],
    popupAnchor: [0, -18],
  });
}

/**
 * Draw markers for a list of stops.
 * stops: [{ building, label, state: 'next'|'later'|'done', title, subtitle }]
 */
export function renderStops(stops, { onSelect } = {}) {
  markerGroup.clearLayers();

  for (const stop of stops) {
    if (!stop.building) continue;
    const m = L.marker([stop.building.lat, stop.building.lon], {
      icon: classIcon(stop.label, stop.state),
      keyboard: true,
      title: stop.title,
    });
    m.bindPopup(
      `<strong>${escapeHtml(stop.title)}</strong><br>` +
        `${escapeHtml(stop.subtitle ?? '')}<br>` +
        `<em>${escapeHtml(stop.building.name)}</em>` +
        (stop.building.moved ? '<br><small>pin corrected by you</small>' : ''),
    );
    if (onSelect) m.on('click', () => onSelect(stop));
    m.addTo(markerGroup);
  }
}

/**
 * A route is two stacked polylines: a wide casing underneath and the coloured
 * core on top. A single stroke disappears against satellite imagery; the
 * casing keeps it readable over any basemap.
 * Returns [casing, core] so callers can dispose of both.
 */
function routePair(shape, { active = false } = {}) {
  const casing = L.polyline(shape, {
    className: 'cm-route-casing',
    weight: 9,
    opacity: 1,
    interactive: false,
  });
  const core = L.polyline(shape, {
    className: `cm-route${active ? ' cm-route--active' : ''}`,
    weight: 5,
    opacity: 1,
    interactive: false,
  });
  return [casing, core];
}

// Two shapes end in "the same place" (~2m, in local degrees at campus
// latitude) — used to decide whether a redraw can update the existing line
// in place instead of tearing it down, so a 30s refresh or a live-progress
// trim doesn't visibly flicker the route away and back.
function endpointsClose(a, b, thresholdDeg = 0.00002) {
  if (!a?.length || !b?.length) return false;
  const pa = a[a.length - 1];
  const pb = b[b.length - 1];
  return Math.abs(pa[0] - pb[0]) < thresholdDeg && Math.abs(pa[1] - pb[1]) < thresholdDeg;
}

export function drawRoute(shape) {
  if (routeLine && shape?.length && endpointsClose(lastRouteShape, shape)) {
    routeLine.forEach((l) => l.setLatLngs(shape));
    lastRouteShape = shape;
    return;
  }
  if (routeLine) routeLine.forEach((l) => map.removeLayer(l));
  routeLine = null;
  lastRouteShape = null;
  if (!shape?.length) return;

  routeLine = routePair(shape, { active: true });
  routeLine.forEach((l) => l.addTo(map));
  lastRouteShape = shape;
}

/** Shrinks the current route line in place to `remainingShape` — no teardown, so it doesn't flicker as you walk. Does nothing if there's no route line drawn. */
export function trimRouteToProgress(remainingShape) {
  if (!routeLine || !remainingShape?.length) return;
  routeLine.forEach((l) => l.setLatLngs(remainingShape));
  lastRouteShape = remainingShape;
}

export function clearRoute() {
  drawRoute(null);
}

// Separate layer set from the single next-class route above, so the whole-day
// view can show, hide, or solo individual legs without disturbing it.
let legLayers = [];
let lastLegShapes = [];

function legsCompatible(prevShapes, legs) {
  if (prevShapes.length !== legs.length) return false;
  return legs.every((leg, i) => {
    const hasShape = Boolean(leg?.shape?.length);
    const hadShape = Boolean(prevShapes[i]?.length);
    if (hasShape !== hadShape) return false;
    return !hasShape || endpointsClose(prevShapes[i], leg.shape);
  });
}

/** Draw the day route as one polyline pair per leg, each independently toggleable. */
export function drawLegs(legs) {
  if (legsCompatible(lastLegShapes, legs)) {
    legs.forEach((leg, i) => {
      if (leg?.shape?.length) legLayers[i]?.forEach((l) => l.setLatLngs(leg.shape));
    });
    lastLegShapes = legs.map((l) => l?.shape ?? null);
    return;
  }
  clearLegs();
  legLayers = legs.map((leg) => {
    if (!leg?.shape?.length) return null;
    const pair = routePair(leg.shape);
    pair.forEach((l) => l.addTo(map));
    return pair;
  });
  lastLegShapes = legs.map((l) => l?.shape ?? null);
}

export function clearLegs() {
  legLayers.forEach((pair) => pair?.forEach((l) => map.removeLayer(l)));
  legLayers = [];
  lastLegShapes = [];
}

export function setLegVisible(i, visible) {
  legLayers[i]?.forEach((l) => l.setStyle({ opacity: visible ? 1 : 0 }));
}

function reducedMotion() {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

/** Eases the dot (and heading arrow, if any) from wherever it's currently drawn to the new fix, instead of jumping between GPS updates. */
function animateMeTo(lat, lon, durationMs = 450) {
  if (reducedMotion()) {
    meDisplayed = { lat, lon };
    meMarker.setLatLng([lat, lon]);
    meHeadingMarker?.setLatLng([lat, lon]);
    return;
  }

  const from = meDisplayed ?? { lat, lon };
  const to = { lat, lon };
  const start = performance.now();
  if (meAnimFrame) cancelAnimationFrame(meAnimFrame);

  const step = (now) => {
    const t = Math.min(1, (now - start) / durationMs);
    const eased = 1 - (1 - t) ** 2;
    meDisplayed = { lat: from.lat + (to.lat - from.lat) * eased, lon: from.lon + (to.lon - from.lon) * eased };
    meMarker.setLatLng([meDisplayed.lat, meDisplayed.lon]);
    meHeadingMarker?.setLatLng([meDisplayed.lat, meDisplayed.lon]);
    meAnimFrame = t < 1 ? requestAnimationFrame(step) : null;
  };
  meAnimFrame = requestAnimationFrame(step);
}

/**
 * `heading` (degrees, 0 = north) is optional — pass a finite number to show a
 * direction arrow, or omit/null to hide it (e.g. while stationary, where a
 * device- or fix-derived heading isn't meaningful).
 */
export function showMe(lat, lon, accuracy, heading) {
  if (!meMarker) {
    meMarker = L.circleMarker([lat, lon], {
      className: 'cm-me',
      radius: 8,
      weight: 3,
    }).addTo(map);
    meAccuracy = L.circle([lat, lon], { className: 'cm-me-accuracy', radius: accuracy ?? 0, weight: 1 }).addTo(map);
    meDisplayed = { lat, lon };
  } else {
    // The accuracy ring is secondary — snap it immediately rather than
    // animating, so only the dot itself (the thing you're actually reading)
    // eases between fixes.
    meAccuracy.setLatLng([lat, lon]).setRadius(accuracy ?? 0);
    animateMeTo(lat, lon);
  }

  if (Number.isFinite(heading)) {
    if (!meHeadingMarker) {
      meHeadingMarker = L.marker([meDisplayed.lat, meDisplayed.lon], {
        icon: L.divIcon({
          className: 'cm-me-heading-wrap',
          html: '<div class="cm-me-heading"></div>',
          iconSize: [26, 26],
          iconAnchor: [13, 13],
        }),
        interactive: false,
        keyboard: false,
        zIndexOffset: 1000,
      }).addTo(map);
    }
    // Rotate the inner div, not the element Leaflet itself positions —
    // Leaflet drives that one's transform for placement (translate3d), and
    // overwriting it here would fight that and break the marker's position.
    const arrow = meHeadingMarker.getElement()?.querySelector('.cm-me-heading');
    if (arrow) arrow.style.transform = `rotate(${heading}deg)`;
  } else if (meHeadingMarker) {
    map.removeLayer(meHeadingMarker);
    meHeadingMarker = null;
  }
}

export function fitTo(points, opts = {}) {
  const pts = points.filter(Boolean).map((p) => (Array.isArray(p) ? p : [p.lat, p.lon]));
  if (!pts.length) return;
  if (pts.length === 1) map.setView(pts[0], 17, { animate: true });
  else map.fitBounds(L.latLngBounds(pts), { padding: [50, 90], maxZoom: 18, ...opts });
}

export function panTo(point, zoom = 18) {
  if (point) map.setView([point.lat, point.lon], zoom, { animate: true });
}

/** Next map click resolves with {lat, lon}; call the returned fn to cancel. */
export function pickPoint(onPick) {
  cancelPick();
  map.getContainer().classList.add('cm-picking');
  pinDropHandler = (e) => {
    cancelPick();
    onPick({ lat: Number(e.latlng.lat.toFixed(6)), lon: Number(e.latlng.lng.toFixed(6)) });
  };
  map.once('click', pinDropHandler);
  return cancelPick;
}

export function cancelPick() {
  if (pinDropHandler) map.off('click', pinDropHandler);
  pinDropHandler = null;
  map?.getContainer().classList.remove('cm-picking');
}

/** Fires on a plain map-background click (not while pin-drop mode is armed). */
export function onBackgroundClick(handler) {
  map.on('click', () => {
    if (pinDropHandler) return; // pin-drop owns this click
    handler();
  });
}

export function invalidate() {
  map?.invalidateSize();
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
