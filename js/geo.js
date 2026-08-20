// Pure geometry helpers for live tracking: bearing, arrival detection, and
// progress-along-a-walked-route math. Deliberately zero dependencies (no
// localStorage, no other app module) so this stays trivially unit-testable
// and reusable from anywhere without dragging in unrelated state.

const EARTH_R = 6371000;

function toRad(d) {
  return (d * Math.PI) / 180;
}

function toDeg(r) {
  return (r * 180) / Math.PI;
}

// Accepts either {lat, lon} or a [lat, lon] pair (route.js's decoded shape
// format) and normalizes to [lat, lon].
function coord(p) {
  return Array.isArray(p) ? p : [p.lat, p.lon];
}

export function haversine(a, b) {
  const [lat1d, lon1d] = coord(a);
  const [lat2d, lon2d] = coord(b);
  const dLat = toRad(lat2d - lat1d);
  const dLon = toRad(lon2d - lon1d);
  const lat1 = toRad(lat1d);
  const lat2 = toRad(lat2d);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.sqrt(h));
}

/** Initial great-circle bearing from a to b, in degrees, 0 = north. */
export function bearing(a, b) {
  const [lat1d, lon1d] = coord(a);
  const [lat2d, lon2d] = coord(b);
  const lat1 = toRad(lat1d);
  const lat2 = toRad(lat2d);
  const dLon = toRad(lon2d - lon1d);
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/** Interpolate between two compass headings along the shorter arc (so 350°→10° passes through 0°, not the long way around). */
export function lerpAngleDeg(a, b, t) {
  const diff = ((((b - a) % 360) + 540) % 360) - 180;
  return (((a + diff * t) % 360) + 360) % 360;
}

export function isArrived(point, dest, thresholdM = 20) {
  return haversine(point, dest) <= thresholdM;
}

// Flat-earth (equirectangular) projection around a local origin — accurate
// enough at campus scale (a few hundred meters to ~1km bbox) and far simpler
// than a true geodesic segment projection.
function toXY(p, origin) {
  const [lat, lon] = coord(p);
  const [olat, olon] = coord(origin);
  return {
    x: toRad(lon - olon) * Math.cos(toRad(olat)) * EARTH_R,
    y: toRad(lat - olat) * EARTH_R,
  };
}

/**
 * Projects `point` onto the walked polyline `shape` (array of [lat, lon]
 * pairs, matching route.js's decoded shape). Returns the closest segment,
 * how far along it the projection falls, the projected [lat, lon], and the
 * remaining walking distance from that projection to the end of the shape.
 */
export function nearestPointOnPolyline(shape, point) {
  if (!shape || shape.length === 0) {
    const [lat, lon] = coord(point);
    return { segIndex: 0, t: 0, projected: [lat, lon], remainingMeters: 0 };
  }
  if (shape.length === 1) {
    return { segIndex: 0, t: 0, projected: coord(shape[0]), remainingMeters: 0 };
  }

  const origin = shape[0];
  const pXY = toXY(point, origin);

  let best = null;
  for (let i = 0; i < shape.length - 1; i++) {
    const aXY = toXY(shape[i], origin);
    const bXY = toXY(shape[i + 1], origin);
    const dx = bXY.x - aXY.x;
    const dy = bXY.y - aXY.y;
    const lenSq = dx * dx + dy * dy;
    let t = lenSq === 0 ? 0 : ((pXY.x - aXY.x) * dx + (pXY.y - aXY.y) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));
    const projX = aXY.x + dx * t;
    const projY = aXY.y + dy * t;
    const distSq = (pXY.x - projX) ** 2 + (pXY.y - projY) ** 2;
    // <= (not <) so an exact tie — the point sitting on a shared vertex —
    // prefers the later segment: t=0 on the next leg rather than t=1 on the
    // one just finished, so progress-along-route only ever moves forward.
    if (!best || distSq <= best.distSq) {
      const [alat, alon] = coord(shape[i]);
      const [blat, blon] = coord(shape[i + 1]);
      best = { segIndex: i, t, projected: [alat + (blat - alat) * t, alon + (blon - alon) * t], distSq };
    }
  }

  let remainingMeters = haversine(best.projected, coord(shape[best.segIndex + 1]));
  for (let i = best.segIndex + 1; i < shape.length - 1; i++) {
    remainingMeters += haversine(coord(shape[i]), coord(shape[i + 1]));
  }

  return { segIndex: best.segIndex, t: best.t, projected: best.projected, remainingMeters };
}

export function remainingRouteMeters(shape, point) {
  return nearestPointOnPolyline(shape, point).remainingMeters;
}

/** The trailing portion of `shape` from the user's projected position onward — feeds a route line that shrinks as you walk instead of staying full-length. */
export function trimShapeToProgress(shape, point) {
  if (!shape || shape.length === 0) return [];
  const { segIndex, projected } = nearestPointOnPolyline(shape, point);
  return [projected, ...shape.slice(segIndex + 1)];
}
