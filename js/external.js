// Deep links into Google Maps, Apple Maps, and Waze.
//
// These are each provider's documented "universal" HTTPS link format: on a
// phone they open the native app if it's installed and fall back to the web
// version if it isn't, on both iOS and Android — no custom URL scheme
// (geo:, comgooglemaps://) needed, and no API key. Tapping one just hands
// off to that app; ClassMapper doesn't see anything past that point.
//
// Origin is deliberately omitted everywhere: all three providers default to
// the device's own live GPS when no starting point is given, which is more
// accurate than anything ClassMapper could supply and works even if you
// never granted this page location access.

function coord(p) {
  return `${p.lat},${p.lon}`;
}

function dedupeAdjacent(stops) {
  const same = (a, b) => Math.abs(a.lat - b.lat) < 1e-6 && Math.abs(a.lon - b.lon) < 1e-6;
  return stops.filter((s, i) => i === 0 || !same(s, stops[i - 1]));
}

export function googleMapsUrl(dest, { mode = 'walking' } = {}) {
  const params = new URLSearchParams({ api: '1', destination: coord(dest), travelmode: mode });
  return `https://www.google.com/maps/dir/?${params}`;
}

export function appleMapsUrl(dest, { mode = 'walking' } = {}) {
  const flag = mode === 'walking' ? 'w' : mode === 'transit' ? 'r' : 'd';
  const params = new URLSearchParams({ daddr: coord(dest), dirflg: flag });
  return `https://maps.apple.com/?${params}`;
}

/** Waze has no origin parameter at all — it always starts from wherever you are. */
export function wazeUrl(dest) {
  const params = new URLSearchParams({ ll: coord(dest), navigate: 'yes' });
  return `https://waze.com/ul?${params}`;
}

/**
 * The whole day, stop to stop, in order. Google Maps' link format is the
 * only one of the three that supports multiple waypoints — Apple Maps and
 * Waze links only ever take a single destination — so a multi-stop day plan
 * is Google-only by design. Back-to-back classes in the same building are
 * collapsed so you're not routed to somewhere you're already standing.
 *
 * `stops` is a list of {lat, lon}. Returns null if there's nothing to route.
 */
export function googleMapsDayUrl(stops, { mode = 'walking' } = {}) {
  const deduped = dedupeAdjacent(stops.filter(Boolean));
  if (!deduped.length) return null;

  const destination = deduped[deduped.length - 1];
  const waypoints = deduped.slice(0, -1);

  const params = new URLSearchParams({ api: '1', destination: coord(destination), travelmode: mode });
  if (waypoints.length) params.set('waypoints', waypoints.map(coord).join('|'));
  return `https://www.google.com/maps/dir/?${params}`;
}
