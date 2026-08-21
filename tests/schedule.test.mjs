// Time logic tests — the part most likely to be subtly wrong.
// Run: node --test tests/

import { test } from 'node:test';
import assert from 'node:assert/strict';

// schedule.js imports store.js, which touches localStorage. Stub it before import.
globalThis.localStorage = {
  _d: new Map(),
  getItem(k) { return this._d.has(k) ? this._d.get(k) : null; },
  setItem(k, v) { this._d.set(k, String(v)); },
  removeItem(k) { this._d.delete(k); },
};

const S = await import('../js/schedule.js');

// A fixed local-time clock. Month is 0-based; 2026-08-12 is a Wednesday.
const at = (y, m, d, hh, mm) => new Date(y, m, d, hh, mm, 0, 0);

const CS101 = { id: 'cs', code: 'CS 101', days: ['M', 'W', 'F'], startMin: 9 * 60, endMin: 9 * 60 + 50, buildingId: 'b1' };
const CALC = { id: 'calc', code: 'Calculus', days: ['M', 'W', 'F'], startMin: 10 * 60, endMin: 10 * 60 + 50, buildingId: 'b2' };
const LAB = { id: 'lab', code: 'Bio Lab', days: ['T', 'R'], startMin: 13 * 60, endMin: 15 * 60 + 50, buildingId: 'b3' };
const ALL = [CS101, CALC, LAB];

test('parseTime handles the formats a student would actually type', () => {
  assert.equal(S.parseTime('9:00 AM'), 540);
  assert.equal(S.parseTime('9:00am'), 540);
  assert.equal(S.parseTime('09:00'), 540);
  assert.equal(S.parseTime('14:50'), 890);
  assert.equal(S.parseTime('2:50 PM'), 890);
  assert.equal(S.parseTime('12:00 AM'), 0);
  assert.equal(S.parseTime('12:30 PM'), 750);
  assert.equal(S.parseTime('p.m.'), null);
  assert.equal(S.parseTime('25:00'), null);
  assert.equal(S.parseTime(''), null);
});

test('fmtTime round-trips through parseTime', () => {
  for (const mins of [0, 540, 590, 720, 750, 890, 1439]) {
    assert.equal(S.parseTime(S.fmtTime(mins)), mins, `failed at ${mins}`);
  }
});

test('nextClass picks the upcoming class later the same day', () => {
  // Wednesday 09:55 — CS just ended, Calculus is next.
  const r = S.nextClass(at(2026, 7, 12, 9, 55), ALL);
  assert.equal(r.cls.code, 'Calculus');
  assert.equal(r.minutesAway, 5);
  assert.equal(r.isNow, false);
  assert.equal(r.startsAt.getDate(), 12);
  assert.equal(r.startsAt.getHours(), 10);
});

test('nextClass reports a class in progress rather than skipping it', () => {
  // Wednesday 09:20 — mid-CS 101.
  const r = S.nextClass(at(2026, 7, 12, 9, 20), ALL);
  assert.equal(r.cls.code, 'CS 101');
  assert.equal(r.isNow, true);
});

test('a class that just ended is not returned', () => {
  // Wednesday 09:50 exactly — CS is over at 09:50.
  const r = S.nextClass(at(2026, 7, 12, 9, 50), ALL);
  assert.equal(r.cls.code, 'Calculus');
});

test('after the last class of the day it rolls to tomorrow', () => {
  // Wednesday 18:00 -> Thursday's lab.
  const r = S.nextClass(at(2026, 7, 12, 18, 0), ALL);
  assert.equal(r.cls.code, 'Bio Lab');
  assert.equal(r.startsAt.getDate(), 13);
  assert.equal(r.startsAt.getDay(), 4); // Thursday
});

test('Friday evening rolls forward to Monday', () => {
  // Friday 2026-08-14 at 20:00 -> Monday 2026-08-17, CS 101 at 09:00.
  const r = S.nextClass(at(2026, 7, 14, 20, 0), ALL);
  assert.equal(r.cls.code, 'CS 101');
  assert.equal(r.startsAt.getDay(), 1); // Monday
  assert.equal(r.startsAt.getDate(), 17);
  assert.equal(r.startsAt.getHours(), 9);
});

test('a weekend with no classes still finds Monday', () => {
  // Saturday 2026-08-15.
  const r = S.nextClass(at(2026, 7, 15, 12, 0), ALL);
  assert.equal(r.cls.code, 'CS 101');
  assert.equal(r.startsAt.getDate(), 17);
});

test('no classes at all returns null', () => {
  assert.equal(S.nextClass(at(2026, 7, 12, 9, 0), []), null);
});

test('a schedule with only Sunday classes still resolves', () => {
  const sunday = [{ id: 's', code: 'Chapel', days: ['U'], startMin: 660, endMin: 720 }];
  const r = S.nextClass(at(2026, 7, 12, 9, 0), sunday); // Wednesday
  assert.equal(r.cls.code, 'Chapel');
  assert.equal(r.startsAt.getDay(), 0);
  assert.equal(r.startsAt.getDate(), 16);
});

test('classesToday returns only today, in start order', () => {
  const wed = S.classesToday(at(2026, 7, 12, 8, 0), ALL);
  assert.deepEqual(wed.map((c) => c.code), ['CS 101', 'Calculus']);

  const thu = S.classesToday(at(2026, 7, 13, 8, 0), ALL);
  assert.deepEqual(thu.map((c) => c.code), ['Bio Lab']);

  const sat = S.classesToday(at(2026, 7, 15, 8, 0), ALL);
  assert.deepEqual(sat, []);
});

test('currentClass only matches inside the meeting window', () => {
  assert.equal(S.currentClass(at(2026, 7, 12, 9, 30), ALL)?.code, 'CS 101');
  assert.equal(S.currentClass(at(2026, 7, 12, 9, 55), ALL), null);
  assert.equal(S.currentClass(at(2026, 7, 12, 9, 0), ALL)?.code, 'CS 101'); // inclusive start
  assert.equal(S.currentClass(at(2026, 7, 12, 9, 50), ALL), null);          // exclusive end
});

test('dayPlan interleaves gaps between classes', () => {
  const plan = S.dayPlan(at(2026, 7, 12, 8, 0), ALL);
  assert.deepEqual(plan.map((p) => p.type), ['class', 'gap', 'class']);
  assert.equal(plan[1].minutes, 10); // 9:50 -> 10:00
});

test('dayPlan has no trailing gap and handles a single class', () => {
  const plan = S.dayPlan(at(2026, 7, 13, 8, 0), ALL); // Thursday, lab only
  assert.deepEqual(plan.map((p) => p.type), ['class']);
});

test('leaveBy subtracts walk time and buffer', () => {
  const startsAt = at(2026, 7, 12, 10, 0);
  assert.equal(S.leaveBy(startsAt, 8, 5).getHours(), 9);
  assert.equal(S.leaveBy(startsAt, 8, 5).getMinutes(), 47);
  assert.equal(S.leaveBy(startsAt, 8, 0).getMinutes(), 52);
});

test('leaveBy crosses an hour boundary correctly', () => {
  const leave = S.leaveBy(at(2026, 7, 12, 9, 5), 10, 5);
  assert.equal(leave.getHours(), 8);
  assert.equal(leave.getMinutes(), 50);
});

test('midnight-adjacent classes do not wrap', () => {
  const late = [{ id: 'n', code: 'Night', days: ['W'], startMin: 23 * 60 + 30, endMin: 23 * 60 + 59 }];
  const r = S.nextClass(at(2026, 7, 12, 23, 0), late);
  assert.equal(r.cls.code, 'Night');
  assert.equal(r.startsAt.getDate(), 12);
  assert.equal(r.minutesAway, 30);
});

test('DAY_LETTERS lines up with Date#getDay', () => {
  // 2026-08-12 is a Wednesday; getDay() === 3.
  assert.equal(at(2026, 7, 12, 0, 0).getDay(), 3);
  assert.equal(S.DAY_LETTERS[3], 'W');
  assert.equal(S.DAY_NAMES[3], 'Wednesday');
  assert.equal(S.DAY_LETTERS.length, 7);
});

test('minutesNow reads local wall clock', () => {
  assert.equal(S.minutesNow(at(2026, 7, 12, 14, 30)), 870);
  assert.equal(S.minutesNow(at(2026, 7, 12, 0, 0)), 0);
});

test('fmtDays joins registrar-style', () => {
  assert.equal(S.fmtDays(['M', 'W', 'F']), 'MWF');
  assert.equal(S.fmtDays(['T', 'R']), 'TR');
  assert.equal(S.fmtDays([]), '');
});

// --- semester range -------------------------------------------------------

test('compareToDateString compares in LOCAL time, not UTC', () => {
  // The whole point: `new Date('2026-08-12')` is midnight UTC, which is still
  // Aug 11 anywhere west of Greenwich. These must agree regardless of zone.
  assert.equal(S.compareToDateString(at(2026, 7, 12, 0, 5), '2026-08-12'), 0);
  assert.equal(S.compareToDateString(at(2026, 7, 12, 23, 55), '2026-08-12'), 0);
  assert.equal(S.compareToDateString(at(2026, 7, 11, 23, 55), '2026-08-12'), -1);
  assert.equal(S.compareToDateString(at(2026, 7, 13, 0, 5), '2026-08-12'), 1);
});

test('compareToDateString rejects junk', () => {
  assert.equal(S.compareToDateString(at(2026, 7, 12, 9, 0), ''), null);
  assert.equal(S.compareToDateString(at(2026, 7, 12, 9, 0), '08/12/2026'), null);
  assert.equal(S.compareToDateString(at(2026, 7, 12, 9, 0), undefined), null);
});

test('semesterPhase with no range set is always "in"', () => {
  assert.equal(S.semesterPhase(at(2026, 7, 12, 9, 0), {}), 'in');
  assert.equal(S.semesterPhase(at(2026, 7, 12, 9, 0), { semesterStart: '', semesterEnd: '' }), 'in');
});

test('semesterPhase bounds are inclusive on both ends', () => {
  const range = { semesterStart: '2026-08-12', semesterEnd: '2026-12-04' };
  assert.equal(S.semesterPhase(at(2026, 7, 11, 23, 0), range), 'before');
  assert.equal(S.semesterPhase(at(2026, 7, 12, 0, 1), range), 'in');   // first day counts
  assert.equal(S.semesterPhase(at(2026, 11, 4, 23, 0), range), 'in');  // last day counts
  assert.equal(S.semesterPhase(at(2026, 11, 5, 0, 1), range), 'after');
});

test('nextClass returns null outside the semester', () => {
  const before = { semesterStart: '2026-09-01' };
  const after = { semesterEnd: '2026-08-01' };
  assert.equal(S.nextClass(at(2026, 7, 12, 8, 0), ALL, before), null);
  assert.equal(S.nextClass(at(2026, 7, 12, 8, 0), ALL, after), null);
});

test('a semester ending today still returns today\'s remaining classes', () => {
  // The off-by-one this guards: an end date of "today" must not cut today off.
  const range = { semesterEnd: '2026-08-12' };
  const r = S.nextClass(at(2026, 7, 12, 8, 0), ALL, range);
  assert.equal(r.cls.code, 'CS 101');
  assert.equal(r.startsAt.getDate(), 12);
});

test('nextClass will not roll forward past the semester end', () => {
  // Wednesday evening: normally rolls to Thursday's lab, but the term ends today.
  const range = { semesterEnd: '2026-08-12' };
  assert.equal(S.nextClass(at(2026, 7, 12, 18, 0), ALL, range), null);
  // Without the range it does roll forward, proving the range is what stopped it.
  assert.equal(S.nextClass(at(2026, 7, 12, 18, 0), ALL).cls.code, 'Bio Lab');
});

test('before the semester starts, there is no "next class" at all', () => {
  // Deliberate: three days before term, "Semester hasn't started — classes
  // begin Aug 17" is more useful than routing to a class 3 days out. The card
  // renders that message off the null.
  const range = { semesterStart: '2026-08-17' };
  assert.equal(S.nextClass(at(2026, 7, 14, 8, 0), ALL, range), null);

  // ...and on the first day of term it starts working immediately.
  const r = S.nextClass(at(2026, 7, 17, 8, 0), ALL, range);
  assert.equal(r.cls.code, 'CS 101');
  assert.equal(r.startsAt.getDate(), 17);
  assert.equal(r.startsAt.getDay(), 1);
});

// --- localDateStr / classesOnDate (skip-a-day groundwork) -----------------

test('localDateStr formats in LOCAL time with zero-padding', () => {
  assert.equal(S.localDateStr(at(2026, 7, 12, 23, 55)), '2026-08-12');
  assert.equal(S.localDateStr(at(2026, 0, 5, 0, 1)), '2026-01-05');
});

test('classesOnDate matches classesOn when nothing is skipped', () => {
  const wed = S.classesOnDate(at(2026, 7, 12, 8, 0), ALL);
  assert.deepEqual(wed.map((c) => c.code), ['CS 101', 'Calculus']);
});

test('classesOnDate drops a class skipped for that exact date only', () => {
  const skippedOnce = { ...CS101, skipDates: ['2026-08-12'] };
  const classes = [skippedOnce, CALC, LAB];

  const skippedWed = S.classesOnDate(at(2026, 7, 12, 8, 0), classes);
  assert.deepEqual(skippedWed.map((c) => c.code), ['Calculus']);

  // The *next* Wednesday isn't skipped — only 8/12 was.
  const nextWed = S.classesOnDate(at(2026, 7, 19, 8, 0), classes);
  assert.deepEqual(nextWed.map((c) => c.code), ['CS 101', 'Calculus']);

  // Monday (8/10) is a different date, so 8/12's skip doesn't touch it.
  const mon = S.classesOnDate(at(2026, 7, 10, 8, 0), classes);
  assert.deepEqual(mon.map((c) => c.code), ['CS 101', 'Calculus']);
});

test('a skipped occurrence is excluded from nextClass and dayPlan', () => {
  const skippedOnce = { ...CS101, skipDates: ['2026-08-12'] };
  const classes = [skippedOnce, CALC, LAB];

  const next = S.nextClass(at(2026, 7, 12, 8, 0), classes);
  assert.equal(next.cls.code, 'Calculus');

  const plan = S.dayPlan(at(2026, 7, 12, 8, 0), classes);
  assert.deepEqual(plan.map((p) => p.type), ['class']); // just Calculus, no gap
});

// --- upcoming() -------------------------------------------------------------

test('upcoming returns the classes after nextClass, in order', () => {
  // Monday 8/10, before anything starts: next is CS101 9:00.
  const next = S.nextClass(at(2026, 7, 10, 8, 0), ALL);
  assert.equal(next.cls.code, 'CS 101');

  const up = S.upcoming(at(2026, 7, 10, 8, 0), ALL, 3);
  assert.deepEqual(up.map((r) => `${r.cls.code}@${r.startsAt.getDate()}`), [
    'Calculus@10', // Monday 10:00
    'Bio Lab@11',  // Tuesday 13:00 — LAB meets T/R, easy to forget between Mon and Wed
    'CS 101@12',   // Wednesday 9:00
  ]);
});

test('upcoming respects the semester range and skip dates like nextClass does', () => {
  const skippedOnce = { ...CALC, skipDates: ['2026-08-10'] };
  const classes = [CS101, skippedOnce, LAB];
  const up = S.upcoming(at(2026, 7, 10, 8, 0), classes, 2);
  // Monday's Calculus is skipped, so the next two are Tuesday's lab, then
  // Wednesday's CS101 — not both of Wednesday's meetings.
  assert.deepEqual(up.map((r) => r.cls.code), ['Bio Lab', 'CS 101']);

  // Semester ends today: today's own remaining meeting still counts (the
  // range is inclusive of its last day), but Wednesday's classes don't.
  const range = { semesterEnd: '2026-08-10' };
  const upBounded = S.upcoming(at(2026, 7, 10, 8, 0), ALL, 3, range);
  assert.deepEqual(upBounded.map((r) => r.cls.code), ['Calculus']);
});

test('upcoming returns fewer than requested once the semester range cuts it off', () => {
  // A weekly class always recurs on its own — "running out" only really
  // happens against a semester boundary, so that's what this tests: next
  // Monday's meeting (8/17) falls after the term ends.
  const one = [{ id: 'x', code: 'Solo', days: ['M'], startMin: 600, endMin: 650 }];
  const range = { semesterEnd: '2026-08-10' };
  const up = S.upcoming(at(2026, 7, 10, 8, 0), one, 3, range);
  assert.deepEqual(up, []);
});

// --- findConflicts ----------------------------------------------------------

test('findConflicts flags an overlapping time on a shared day', () => {
  const candidate = { id: 'new', days: ['M', 'W'], startMin: 570, endMin: 620 }; // 9:30-10:20
  const conflicts = S.findConflicts(candidate, ALL);
  assert.deepEqual(conflicts.map((c) => c.code).sort(), ['CS 101', 'Calculus']);
});

test('findConflicts ignores back-to-back classes that only touch at the boundary', () => {
  // Fills the 10-minute gap between CS101 ending (9:50) and Calculus starting
  // (10:00) exactly — touches both boundaries, overlaps neither.
  const candidate = { id: 'new', days: ['M'], startMin: 590, endMin: 600 };
  assert.deepEqual(S.findConflicts(candidate, ALL), []);
});

test('findConflicts ignores classes on different days entirely', () => {
  const candidate = { id: 'new', days: ['T', 'R'], startMin: 540, endMin: 590 }; // same time as CS101, different days
  assert.deepEqual(S.findConflicts(candidate, ALL), []);
});

test('findConflicts excludes the candidate itself when editing', () => {
  // Editing CS101 in place: same id, same slot — must not conflict with itself.
  assert.deepEqual(S.findConflicts(CS101, ALL), []);
});

// --- passing period (classes actually end `passingMin` minutes early) -----

test('effectiveEndMin subtracts the passing period, clamped to never precede the start', () => {
  const cls = { startMin: 600, endMin: 660 }; // 10:00-11:00
  assert.equal(S.effectiveEndMin(cls, 10), 650);
  assert.equal(S.effectiveEndMin(cls, 0), 660);
  assert.equal(S.effectiveEndMin(cls), 660); // default: off
  assert.equal(S.effectiveEndMin(cls, 90), 600); // an absurd passing period still can't precede start
});

test('nextClass treats a class as over once the passing period elapses, not at its printed end', () => {
  const hourly = { id: 'h1', code: 'HIST 100', days: ['M'], startMin: 600, endMin: 660 }; // 10:00-11:00 printed
  // A Monday. 10:55 — printed end (11:00) hasn't passed, but a 10-min passing
  // period means it effectively ended at 10:50.
  const now = at(2026, 7, 17, 10, 55);
  const withoutPassing = S.nextClass(now, [hourly], {});
  assert.equal(withoutPassing.isNow, true); // no setting: still "in class" per the printed time

  // With the setting, it's no longer "now" — and since it's the only class,
  // the scan rolls all the way to its next weekly occurrence, not today.
  const withPassing = S.nextClass(now, [hourly], { passingMin: 10 });
  assert.equal(withPassing.isNow, false);
  assert.equal(withPassing.startsAt.getDate(), 24); // next Monday, not the 17th
});

test('nextClass still reports isNow inside the passing-adjusted window', () => {
  const hourly = { id: 'h1', code: 'HIST 100', days: ['M'], startMin: 600, endMin: 660 };
  const now = at(2026, 7, 17, 10, 45); // before the 10:50 effective end
  const next = S.nextClass(now, [hourly], { passingMin: 10 });
  assert.equal(next.isNow, true);
});

test('dayPlan measures the gap from the effective end, not the printed one', () => {
  // Back-to-back on the schedule (10:00-11:00 then 11:00-12:00), but the
  // first actually clears out 10 min early — a real 10-min gap opens up.
  const first = { id: 'a', code: 'A', days: ['M'], startMin: 600, endMin: 660 };
  const second = { id: 'b', code: 'B', days: ['M'], startMin: 660, endMin: 720 };
  const now = at(2026, 7, 17, 9, 0); // any time that Monday — dayPlan doesn't gate on `now`'s clock
  const plan = S.dayPlan(now, [first, second], { passingMin: 10 });
  const gap = plan.find((p) => p.type === 'gap');
  assert.ok(gap, 'expected a gap to open up between back-to-back classes');
  assert.equal(gap.minutes, 10);
  assert.equal(gap.from, 650);
  assert.equal(gap.to, 660);

  const planWithoutPassing = S.dayPlan(now, [first, second], {});
  assert.equal(planWithoutPassing.some((p) => p.type === 'gap'), false); // truly back-to-back without the setting
});

test('currentClass treats the passing-adjusted end the same way nextClass does', () => {
  const hourly = { id: 'h1', code: 'HIST 100', days: ['M'], startMin: 600, endMin: 660 };
  const stillIn = at(2026, 7, 17, 10, 45);
  const alreadyOut = at(2026, 7, 17, 10, 55);
  assert.equal(S.currentClass(stillIn, [hourly], { passingMin: 10 })?.id, 'h1');
  assert.equal(S.currentClass(alreadyOut, [hourly], { passingMin: 10 }), null);
  assert.equal(S.currentClass(alreadyOut, [hourly], {})?.id, 'h1'); // no setting: still in class per the printed time
});
