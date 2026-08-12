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
