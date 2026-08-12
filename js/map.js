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
let meMarker;
let meAccuracy;
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

export function drawRoute(shape) {
  if (routeLine) map.removeLayer(routeLine);
  routeLine = null;
  if (!shape?.length) return;

  routeLine = L.polyline(shape, {
    className: 'cm-route',
    weight: 5,
    opacity: 0.9,
    lineJoin: 'round',
    lineCap: 'round',
  }).addTo(map);
}

export function clearRoute() {
  drawRoute(null);
}

// Separate layer set from the single next-class route above, so the whole-day
// view can show, hide, or solo individual legs without disturbing it.
let legLayers = [];

/** Draw the day route as one polyline per leg, so each can be toggled on its own. */
export function drawLegs(legs) {
  clearLegs();
  legLayers = legs.map((leg) => {
    if (!leg?.shape?.length) return null;
    return L.polyline(leg.shape, {
      className: 'cm-route',
      weight: 5,
      opacity: 0.9,
      lineJoin: 'round',
      lineCap: 'round',
    }).addTo(map);
  });
}

export function clearLegs() {
  legLayers.forEach((l) => l && map.removeLayer(l));
  legLayers = [];
}

export function setLegVisible(i, visible) {
  legLayers[i]?.setStyle({ opacity: visible ? 0.9 : 0 });
}

export function showMe(lat, lon, accuracy) {
  if (!meMarker) {
    meMarker = L.circleMarker([lat, lon], {
      className: 'cm-me',
      radius: 8,
      weight: 3,
    }).addTo(map);
    meAccuracy = L.circle([lat, lon], { className: 'cm-me-accuracy', radius: accuracy ?? 0, weight: 1 }).addTo(map);
  } else {
    meMarker.setLatLng([lat, lon]);
    meAccuracy.setLatLng([lat, lon]).setRadius(accuracy ?? 0);
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

export function invalidate() {
  map?.invalidateSize();
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
