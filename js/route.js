// Walking routes.
//
// Primary: FOSSGIS's public Valhalla instance, pedestrian costing, no API key.
// Building-to-building routes never change, so every result is cached by
// coordinate pair — the free endpoint gets hit once per pair, ever.
// If the network is gone, a haversine estimate keeps the app useful.

import { read, write, KEYS, settings } from './store.js';

const ENDPOINT = 'https://valhalla1.openstreetmap.de/route';
const CACHE_LIMIT = 300;

export function haversine(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Straight line inflated by a detour factor — what we use when offline. */
export function estimate(a, b) {
  const { walkSpeed } = settings();
  const meters = haversine(a, b) * 1.3;
  return {
    meters: Math.round(meters),
    seconds: Math.round(meters / walkSpeed),
    minutes: Math.max(1, Math.round(meters / walkSpeed / 60)),
    shape: [
      [a.lat, a.lon],
      [b.lat, b.lon],
    ],
    steps: [],
    approximate: true,
  };
}

// Valhalla returns Google-style encoded polylines at 1e6 precision.
function decodeShape(str, precision = 6) {
  const factor = 10 ** precision;
  const coords = [];
  let index = 0;
  let lat = 0;
  let lon = 0;

  while (index < str.length) {
    let result = 0;
    let shift = 0;
    let byte;
    do {
      byte = str.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lat += result & 1 ? ~(result >> 1) : result >> 1;

    result = 0;
    shift = 0;
    do {
      byte = str.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lon += result & 1 ? ~(result >> 1) : result >> 1;

    coords.push([lat / factor, lon / factor]);
  }
  return coords;
}

function cacheKey(a, b) {
  const r = (n) => n.toFixed(5);
  return `${r(a.lat)},${r(a.lon)}>${r(b.lat)},${r(b.lon)}`;
}

function readCache(key) {
  return read(KEYS.ROUTES, {})[key] ?? null;
}

function writeCache(key, value) {
  const cache = read(KEYS.ROUTES, {});
  cache[key] = value;
  const keys = Object.keys(cache);
  if (keys.length > CACHE_LIMIT) {
    for (const k of keys.slice(0, keys.length - CACHE_LIMIT)) delete cache[k];
  }
  write(KEYS.ROUTES, cache);
}

/**
 * Walking route from a to b, each {lat, lon}.
 * Always resolves — falls back to an estimate rather than throwing.
 */
export async function walk(a, b, { signal } = {}) {
  if (!a || !b) return null;

  const key = cacheKey(a, b);
  const cached = readCache(key);
  if (cached) return { ...cached, cached: true };

  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal,
      body: JSON.stringify({
        locations: [
          { lat: a.lat, lon: a.lon, type: 'break' },
          { lat: b.lat, lon: b.lon, type: 'break' },
        ],
        costing: 'pedestrian',
        costing_options: { pedestrian: { walking_speed: settings().walkSpeed * 3.6 } },
        directions_options: { units: 'kilometers' },
      }),
    });
    if (!res.ok) throw new Error(`Routing service returned ${res.status}`);

    const data = await res.json();
    const leg = data?.trip?.legs?.[0];
    const summary = data?.trip?.summary;
    if (!leg || !summary) throw new Error('Routing service returned no route');

    const result = {
      meters: Math.round(summary.length * 1000),
      seconds: Math.round(summary.time),
      minutes: Math.max(1, Math.round(summary.time / 60)),
      shape: decodeShape(leg.shape),
      steps: (leg.maneuvers ?? [])
        .map((m) => m.instruction)
        .filter(Boolean),
      approximate: false,
    };

    writeCache(key, result);
    return result;
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    console.warn('Routing failed, using straight-line estimate:', err.message);
    return { ...estimate(a, b), failed: true };
  }
}

/** Chain a list of {lat, lon} stops into consecutive legs. */
export async function chain(points, opts) {
  const legs = [];
  for (let i = 0; i < points.length - 1; i++) {
    legs.push(await walk(points[i], points[i + 1], opts));
  }
  return {
    legs,
    meters: legs.reduce((s, l) => s + (l?.meters ?? 0), 0),
    minutes: legs.reduce((s, l) => s + (l?.minutes ?? 0), 0),
    approximate: legs.some((l) => l?.approximate),
  };
}

export function fmtDistance(meters) {
  if (meters == null) return '';
  if (meters < 1000) return `${meters} m`;
  return `${(meters / 1000).toFixed(1)} km`;
}
