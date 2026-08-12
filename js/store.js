// Thin localStorage wrapper. Everything ClassMapper knows about you lives here
// and nowhere else — no server, no sync, no upload.

const PREFIX = 'classmapper:';

export const KEYS = {
  CLASSES: 'classes',
  API_KEY: 'geminiKey',
  OVERRIDES: 'buildingOverrides', // { buildingId: {lat, lon} }
  CUSTOM: 'customBuildings',      // buildings you added by pin-drop
  ALIASES: 'learnedAliases',      // { "ENGR 204": buildingId }
  ROUTES: 'routeCache',
  SETTINGS: 'settings',
  FIRED: 'firedAlerts',
};

export function read(key, fallback) {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function write(key, value) {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
    return true;
  } catch (err) {
    console.warn('Storage write failed', key, err);
    return false;
  }
}

export function remove(key) {
  localStorage.removeItem(PREFIX + key);
}

export const DEFAULT_SETTINGS = {
  bufferMin: 5,          // extra minutes of slack before "leave by"
  walkSpeed: 1.35,       // m/s, used by the offline fallback estimate
  notifications: false,
  satellite: false,
};

export function settings() {
  return { ...DEFAULT_SETTINGS, ...read(KEYS.SETTINGS, {}) };
}

export function saveSettings(patch) {
  write(KEYS.SETTINGS, { ...settings(), ...patch });
}

// Everything, as one portable object — for the export/backup button.
export function exportAll() {
  const out = {};
  for (const key of Object.values(KEYS)) {
    if (key === KEYS.API_KEY) continue; // never include the key in a backup
    const val = read(key, null);
    if (val !== null) out[key] = val;
  }
  return { app: 'ClassMapper', version: 1, exported: new Date().toISOString(), data: out };
}

export function importAll(payload) {
  if (!payload || payload.app !== 'ClassMapper') throw new Error('Not a ClassMapper backup file');
  for (const [key, val] of Object.entries(payload.data ?? {})) {
    if (key === KEYS.API_KEY) continue;
    write(key, val);
  }
}
