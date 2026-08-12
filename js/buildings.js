// Building lookup: seed data from OSM, layered with your pin-drop corrections,
// your custom buildings, and aliases learned during schedule import.

import { read, write, KEYS } from './store.js';

let seed = [];
let index = new Map(); // id -> building (with overrides applied)

export async function load() {
  const res = await fetch('data/buildings.json');
  if (!res.ok) throw new Error('Could not load building data');
  const doc = await res.json();
  seed = doc.buildings;
  rebuild();
  return all();
}

function rebuild() {
  const overrides = read(KEYS.OVERRIDES, {});
  const custom = read(KEYS.CUSTOM, []);
  const learned = read(KEYS.ALIASES, {});

  // Reverse the learned map: buildingId -> [raw strings that resolved to it]
  const learnedFor = {};
  for (const [raw, id] of Object.entries(learned)) {
    (learnedFor[id] ??= []).push(raw);
  }

  index = new Map();
  for (const b of [...seed, ...custom]) {
    const ov = overrides[b.id];
    index.set(b.id, {
      ...b,
      lat: ov?.lat ?? b.lat,
      lon: ov?.lon ?? b.lon,
      moved: Boolean(ov),
      aliases: [...(b.aliases ?? []), ...(learnedFor[b.id] ?? [])],
    });
  }
}

export function all() {
  return [...index.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function get(id) {
  return index.get(id) ?? null;
}

// --- matching -------------------------------------------------------------

function normalize(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/["'’.,]/g, '')
    .replace(/\b(hall|building|bldg|center|centre|ctr|the)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Strip a trailing room number so "Chappie James 204" still matches.
function stripRoom(s) {
  return String(s ?? '').replace(/\s+(room\s*)?[A-Za-z]?-?\d{1,4}[A-Za-z]?$/i, '').trim();
}

/**
 * Resolve a free-text building string to a building.
 * Returns { building, confidence: 'exact'|'alias'|'fuzzy'|null, room }.
 */
export function match(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return { building: null, confidence: null, room: '' };

  // Pull a room number off the end if there is one.
  const roomMatch = raw.match(/\s+(?:room\s*)?([A-Za-z]?-?\d{1,4}[A-Za-z]?)$/i);
  const room = roomMatch ? roomMatch[1] : '';
  const namePart = stripRoom(raw);

  // A previously-learned mapping always wins.
  const learned = read(KEYS.ALIASES, {});
  const learnedId = learned[raw.toLowerCase()] ?? learned[namePart.toLowerCase()];
  if (learnedId && index.has(learnedId)) {
    return { building: index.get(learnedId), confidence: 'exact', room };
  }

  const target = normalize(namePart);
  if (!target) return { building: null, confidence: null, room };

  const list = [...index.values()];

  for (const b of list) {
    if (normalize(b.name) === target) return { building: b, confidence: 'exact', room };
  }
  for (const b of list) {
    if ((b.aliases ?? []).some((a) => normalize(a) === target)) {
      return { building: b, confidence: 'alias', room };
    }
  }
  // Substring both directions — "brimmer" hits the long official name.
  for (const b of list) {
    const n = normalize(b.name);
    if (n.includes(target) || target.includes(n)) return { building: b, confidence: 'fuzzy', room };
  }
  for (const b of list) {
    if ((b.aliases ?? []).some((a) => {
      const n = normalize(a);
      return n && (n.includes(target) || target.includes(n));
    })) {
      return { building: b, confidence: 'fuzzy', room };
    }
  }

  return { building: null, confidence: null, room };
}

/** Remember that `raw` means `buildingId`, so next term it just works. */
export function learnAlias(raw, buildingId) {
  const key = String(raw ?? '').trim().toLowerCase();
  if (!key || !index.has(buildingId)) return;
  const learned = read(KEYS.ALIASES, {});
  learned[key] = buildingId;
  write(KEYS.ALIASES, learned);
  rebuild();
}

/** Move a building's pin (pin-drop correction). Pass null to reset to OSM. */
export function setOverride(buildingId, latlon) {
  const overrides = read(KEYS.OVERRIDES, {});
  if (latlon) overrides[buildingId] = { lat: latlon.lat, lon: latlon.lon };
  else delete overrides[buildingId];
  write(KEYS.OVERRIDES, overrides);
  rebuild();
}

/** Add a building the OSM data doesn't have. */
export function addCustom(name, latlon) {
  const custom = read(KEYS.CUSTOM, []);
  const id = 'custom-' + name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (index.has(id)) throw new Error('A building with that name already exists');
  custom.push({ id, name, lat: latlon.lat, lon: latlon.lon, aliases: [], source: 'user' });
  write(KEYS.CUSTOM, custom);
  rebuild();
  return index.get(id);
}

export function removeCustom(id) {
  write(KEYS.CUSTOM, read(KEYS.CUSTOM, []).filter((b) => b.id !== id));
  rebuild();
}

/** Compact list for the Gemini prompt: id + name + a few aliases. */
export function promptManifest() {
  return all().map((b) => ({
    id: b.id,
    name: b.name,
    aka: (b.aliases ?? []).slice(0, 4),
  }));
}
