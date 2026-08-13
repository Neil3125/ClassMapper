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
  OCR_MODEL: 'ocrModel', // whichever Gemini model candidate last worked
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
  offline: false,        // opt-in service worker; see registerServiceWorker()
  cardCollapsed: false,  // next-class card hidden down to its handle bar
  textScale: 1,          // root font-size multiplier; layout is all rem
  theme: 'auto',         // 'auto' follows the OS | 'light' | 'dark'
  highContrast: false,
  semesterStart: '',     // 'YYYY-MM-DD' — see schedule.js on why these stay strings
  semesterEnd: '',
  onboarded: false,      // seen the first-run welcome tour
};

export function settings() {
  return { ...DEFAULT_SETTINGS, ...read(KEYS.SETTINGS, {}) };
}

export function saveSettings(patch) {
  write(KEYS.SETTINGS, { ...settings(), ...patch });
}

// What a backup actually carries: your classes and everything you've taught
// or configured — not the API key (yours to keep, never leaves this device),
// and not ROUTES/FIRED, which are regenerable caches rather than settings.
// Restoring a stale FIRED, in particular, could suppress a real notification
// later if the dates ever lined up — better to just not carry it.
const BACKUP_KEYS = [KEYS.CLASSES, KEYS.OVERRIDES, KEYS.CUSTOM, KEYS.ALIASES, KEYS.SETTINGS, KEYS.OCR_MODEL];

export function exportAll() {
  const out = {};
  for (const key of BACKUP_KEYS) {
    const val = read(key, null);
    if (val !== null) out[key] = val;
  }
  return { app: 'ClassMapper', version: 1, exported: new Date().toISOString(), data: out };
}

export function importAll(payload) {
  if (!payload || payload.app !== 'ClassMapper') throw new Error('Not a ClassMapper backup file');
  for (const [key, val] of Object.entries(payload.data ?? {})) {
    if (BACKUP_KEYS.includes(key)) write(key, val);
  }
}
