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

/**
 * 'YYYY-MM-DD' from a LOCAL date — never `toISOString()`, which is UTC and
 * would shift the date near midnight, the exact trap this file avoids
 * everywhere else (see `compareToDateString` below). Used to key one-off
 * skipped occurrences (`skipDates`) against a specific calendar date.
 */
export function localDateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
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

/**
 * classesOn(), narrowed to one specific calendar date rather than just a
 * weekday. classesOn() has no way to know about a one-off cancellation — it
 * only ever sees "meets on Wednesdays" — so this is the version everything
 * that has a concrete date should call instead.
 */
export function classesOnDate(date, classes = list()) {
  const dateStr = localDateStr(date);
  return classesOn(date.getDay(), classes).filter((c) => !(c.skipDates ?? []).includes(dateStr));
}

export function classesToday(now = new Date(), classes = list()) {
  return classesOnDate(now, classes);
}

/**
 * Some schools run every class `passingMin` minutes short of its printed end
 * time so the room clears out before the next class starts on the hour — the
 * room is free, and you should be moving, before the schedule's own endMin.
 * Clamped to never land before the class's own start, so a pathologically
 * short class (or an overlarge passing period) can't produce a negative
 * window.
 */
export function effectiveEndMin(cls, passingMin = 0) {
  return Math.max(cls.startMin, cls.endMin - passingMin);
}

/**
 * Shared scan behind both `nextClass` and `upcoming`: walks up to 8 days
 * forward from `now` (so a Friday afternoon rolls to Monday morning),
 * collecting meetings in chronological order and stopping once `limit` are
 * found. One implementation means the two can't quietly drift apart on the
 * semester-range or skip-date edge cases.
 */
function scanMeetings(now, classes, range, limit) {
  if (!classes.length) return [];
  if (semesterPhase(now, range) !== 'in') return [];
  const nowMin = minutesNow(now);
  const passingMin = range.passingMin ?? 0;
  const out = [];

  for (let offset = 0; offset < 8 && out.length < limit; offset++) {
    const dateForOffset = new Date(now);
    dateForOffset.setDate(dateForOffset.getDate() + offset);

    for (const cls of classesOnDate(dateForOffset, classes)) {
      const effEnd = effectiveEndMin(cls, passingMin);
      // Today: skip meetings that have already effectively finished.
      if (offset === 0 && effEnd <= nowMin) continue;

      const startsAt = new Date(now);
      startsAt.setDate(startsAt.getDate() + offset);
      startsAt.setHours(Math.floor(cls.startMin / 60), cls.startMin % 60, 0, 0);

      // Don't point at a meeting that falls outside the semester — including
      // one a few days out that lands past the end date.
      if (semesterPhase(startsAt, range) !== 'in') continue;

      const endsAt = new Date(startsAt);
      endsAt.setHours(Math.floor(cls.endMin / 60), cls.endMin % 60, 0, 0);

      out.push({
        cls,
        startsAt,
        endsAt,
        minutesAway: Math.round((startsAt - now) / 60000),
        isNow: offset === 0 && cls.startMin <= nowMin && nowMin < effEnd,
      });

      if (out.length >= limit) break;
    }
  }
  return out;
}

/**
 * The next class meeting at or after `now`.
 *
 * `range` is an optional {semesterStart, semesterEnd} pair; passing nothing
 * means no restriction, which keeps this function pure and easy to test.
 *
 * Returns { cls, startsAt: Date, endsAt: Date, minutesAway, isNow } or null.
 */
export function nextClass(now = new Date(), classes = list(), range = {}) {
  return scanMeetings(now, classes, range, 1)[0] ?? null;
}

/**
 * The classes chronologically *after* the one `nextClass` returns — for a
 * short "up next" preview, not a second copy of the hero countdown. Shares
 * `nextClass`'s exact scan so the two can never disagree about what's next.
 */
export function upcoming(now = new Date(), classes = list(), count = 3, range = {}) {
  return scanMeetings(now, classes, range, count + 1).slice(1);
}

/**
 * Existing classes that share a day with `candidate` and overlap in time.
 * A warning, not a rule — some students genuinely do have overlapping
 * optional sections — so this only ever informs, never blocks on its own.
 */
export function findConflicts(candidate, classes = list()) {
  const days = new Set(candidate.days ?? []);
  return classes.filter((c) => {
    if (c.id && c.id === candidate.id) return false;
    if (!(c.days ?? []).some((d) => days.has(d))) return false;
    return candidate.startMin < c.endMin && candidate.endMin > c.startMin;
  });
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

/** The class happening right now, if any — effectively ended (see effectiveEndMin) counts as over. */
export function currentClass(now = new Date(), classes = list(), range = {}) {
  const nowMin = minutesNow(now);
  const passingMin = range.passingMin ?? 0;
  return (
    classesToday(now, classes).find(
      (c) => c.startMin <= nowMin && nowMin < effectiveEndMin(c, passingMin),
    ) ?? null
  );
}

/**
 * Today's schedule with the gaps between classes filled in, for the day view.
 * Gaps are measured from each class's effective end, not its printed one, so
 * a school that dismisses `passingMin` minutes early shows the real walking
 * window instead of one that looks shorter than it actually is.
 * Returns [{type:'class', cls} | {type:'gap', minutes}]
 */
export function dayPlan(now = new Date(), classes = list(), range = {}) {
  const passingMin = range.passingMin ?? 0;
  const today = classesToday(now, classes);
  const out = [];
  today.forEach((cls, i) => {
    out.push({ type: 'class', cls });
    const next = today[i + 1];
    if (next) {
      const effEnd = effectiveEndMin(cls, passingMin);
      const gap = next.startMin - effEnd;
      if (gap > 0) out.push({ type: 'gap', minutes: gap, from: effEnd, to: next.startMin });
    }
  });
  return out;
}

/** Minutes from `now` until you must leave, given a walk of `walkMin`. */
export function leaveBy(startsAt, walkMin, bufferMin = 5) {
  const leave = new Date(startsAt.getTime() - (walkMin + bufferMin) * 60000);
  return leave;
}
