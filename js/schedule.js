// Class records and the "what's next" time logic.
//
// Deliberately avoids parsing date strings: class times are stored as a
// day-of-week letter plus minutes-since-midnight, and compared against the
// local clock. Nothing round-trips through `new Date("...")`, so there is no
// UTC-shift surprise.

import { read, write, KEYS } from './store.js';

export const DAY_LETTERS = ['U', 'M', 'T', 'W', 'R', 'F', 'S']; // index === Date#getDay()
export const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function minutesNow(d = new Date()) {
  return d.getHours() * 60 + d.getMinutes();
}

export function parseTime(str) {
  const m = String(str ?? '').trim().match(/^(\d{1,2}):?(\d{2})?\s*([ap]\.?m\.?)?$/i);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2] ?? 0);
  const mer = m[3]?.toLowerCase().replace(/\./g, '');
  if (h > 23 || min > 59) return null;
  if (mer === 'pm' && h !== 12) h += 12;
  if (mer === 'am' && h === 12) h = 0;
  return h * 60 + min;
}

export function fmtTime(mins) {
  if (mins == null) return '';
  const h24 = Math.floor(mins / 60) % 24;
  const m = mins % 60;
  const h = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h}:${String(m).padStart(2, '0')} ${h24 < 12 ? 'AM' : 'PM'}`;
}

export function fmtDays(days) {
  return (days ?? []).join('');
}

// --- CRUD -----------------------------------------------------------------

export function list() {
  return read(KEYS.CLASSES, []);
}

export function save(classes) {
  write(KEYS.CLASSES, classes);
}

export function upsert(cls) {
  const classes = list();
  const rec = { ...cls, id: cls.id || crypto.randomUUID() };
  const i = classes.findIndex((c) => c.id === rec.id);
  if (i >= 0) classes[i] = rec;
  else classes.push(rec);
  save(classes);
  return rec;
}

export function remove(id) {
  save(list().filter((c) => c.id !== id));
}

export function clearAll() {
  save([]);
}

// --- occurrences ----------------------------------------------------------

/**
 * Every meeting of every class on a given weekday, sorted by start time.
 * `dayIndex` is a JS getDay() value.
 */
export function classesOn(dayIndex, classes = list()) {
  const letter = DAY_LETTERS[dayIndex];
  return classes
    .filter((c) => (c.days ?? []).includes(letter))
    .sort((a, b) => a.startMin - b.startMin);
}

export function classesToday(now = new Date(), classes = list()) {
  return classesOn(now.getDay(), classes);
}

/**
 * The next class meeting at or after `now`, scanning up to 7 days ahead so a
 * Friday afternoon correctly rolls forward to Monday morning.
 *
 * `range` is an optional {semesterStart, semesterEnd} pair; passing nothing
 * means no restriction, which keeps this function pure and easy to test.
 *
 * Returns { cls, startsAt: Date, endsAt: Date, minutesAway, isNow } or null.
 */
export function nextClass(now = new Date(), classes = list(), range = {}) {
  if (!classes.length) return null;
  if (semesterPhase(now, range) !== 'in') return null;
  const nowMin = minutesNow(now);

  for (let offset = 0; offset < 8; offset++) {
    const day = (now.getDay() + offset) % 7;
    for (const cls of classesOn(day, classes)) {
      // Today: skip meetings that have already finished.
      if (offset === 0 && cls.endMin <= nowMin) continue;

      const startsAt = new Date(now);
      startsAt.setDate(startsAt.getDate() + offset);
      startsAt.setHours(Math.floor(cls.startMin / 60), cls.startMin % 60, 0, 0);

      // Don't point at a meeting that falls outside the semester — including
      // one a few days out that lands past the end date.
      if (semesterPhase(startsAt, range) !== 'in') continue;

      const endsAt = new Date(startsAt);
      endsAt.setHours(Math.floor(cls.endMin / 60), cls.endMin % 60, 0, 0);

      return {
        cls,
        startsAt,
        endsAt,
        minutesAway: Math.round((startsAt - now) / 60000),
        isNow: offset === 0 && cls.startMin <= nowMin && nowMin < cls.endMin,
      };
    }
  }
  return null;
}

// --- semester range ---------------------------------------------------------

/**
 * Compare a local date against a 'YYYY-MM-DD' string without ever handing that
 * string to `new Date()`. A date-only string parses as **UTC**, so west of
 * Greenwich `new Date('2026-08-12')` is the 11th locally — the exact bug this
 * module was written to avoid. Splitting the parts and comparing numerically
 * keeps everything in local time.
 * Returns -1 if `d` is before the string's day, 0 if same day, 1 if after.
 */
export function compareToDateString(d, str) {
  const m = String(str ?? '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const a = d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
  const b = Number(m[1]) * 10000 + Number(m[2]) * 100 + Number(m[3]);
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Where `now` sits relative to an optional semester range.
 * Both bounds are inclusive — a class on the last day still counts.
 * Returns 'before' | 'after' | 'in'.
 */
export function semesterPhase(now = new Date(), range = {}) {
  if (compareToDateString(now, range.semesterStart) === -1) return 'before';
  if (compareToDateString(now, range.semesterEnd) === 1) return 'after';
  return 'in';
}

/** The class happening right now, if any. */
export function currentClass(now = new Date(), classes = list()) {
  const nowMin = minutesNow(now);
  return classesToday(now, classes).find((c) => c.startMin <= nowMin && nowMin < c.endMin) ?? null;
}

/**
 * Today's schedule with the gaps between classes filled in, for the day view.
 * Returns [{type:'class', cls} | {type:'gap', minutes}]
 */
export function dayPlan(now = new Date(), classes = list()) {
  const today = classesToday(now, classes);
  const out = [];
  today.forEach((cls, i) => {
    out.push({ type: 'class', cls });
    const next = today[i + 1];
    if (next) {
      const gap = next.startMin - cls.endMin;
      if (gap > 0) out.push({ type: 'gap', minutes: gap, from: cls.endMin, to: next.startMin });
    }
  });
  return out;
}

/** Minutes from `now` until you must leave, given a walk of `walkMin`. */
export function leaveBy(startsAt, walkMin, bufferMin = 5) {
  const leave = new Date(startsAt.getTime() - (walkMin + bufferMin) * 60000);
  return leave;
}
