// notify.js's pure timing predicates — no storage or Notification API
// involved, so these are testable against plain Date fixtures.
// Run: node --test tests/

import { test } from 'node:test';
import assert from 'node:assert/strict';

// notify.js imports store.js (localStorage) and route.js (no storage, but
// still resolved at module load) — stub localStorage before import.
globalThis.localStorage = {
  _d: new Map(),
  getItem(k) { return this._d.has(k) ? this._d.get(k) : null; },
  setItem(k, v) { this._d.set(k, String(v)); },
  removeItem(k) { this._d.delete(k); },
};

const N = await import('../js/notify.js');

const at = (y, m, d, hh, mm) => new Date(y, m, d, hh, mm, 0, 0);

test('shouldFireHeadsUp is true only in the window before leaveAt', () => {
  const leaveAt = at(2026, 7, 12, 9, 0);
  assert.equal(N.shouldFireHeadsUp(at(2026, 7, 12, 8, 49), leaveAt), false); // 11 min early — outside
  assert.equal(N.shouldFireHeadsUp(at(2026, 7, 12, 8, 50), leaveAt), true); // exactly 10 min early
  assert.equal(N.shouldFireHeadsUp(at(2026, 7, 12, 8, 55), leaveAt), true);
  assert.equal(N.shouldFireHeadsUp(at(2026, 7, 12, 9, 0), leaveAt), false); // at leaveAt, leave-now's turn now
  assert.equal(N.shouldFireHeadsUp(at(2026, 7, 12, 9, 1), leaveAt), false);
});

test('shouldFireLeave is true at and after leaveAt, never before', () => {
  const leaveAt = at(2026, 7, 12, 9, 0);
  assert.equal(N.shouldFireLeave(at(2026, 7, 12, 8, 59), leaveAt), false);
  assert.equal(N.shouldFireLeave(at(2026, 7, 12, 9, 0), leaveAt), true);
  assert.equal(N.shouldFireLeave(at(2026, 7, 12, 9, 5), leaveAt), true);
});

test('isRunningLate only trips past the threshold, not at or just under it', () => {
  const leaveAt = at(2026, 7, 12, 9, 0);
  assert.equal(N.isRunningLate(at(2026, 7, 12, 9, 5), leaveAt), false);
  assert.equal(N.isRunningLate(at(2026, 7, 12, 9, 10), leaveAt), false); // exactly at threshold — not yet "running late"
  assert.equal(N.isRunningLate(at(2026, 7, 12, 9, 11), leaveAt), true);
  assert.equal(N.isRunningLate(at(2026, 7, 12, 9, 10), leaveAt, 5), true); // a tighter custom threshold
});

test('the heads-up and leave-now windows never overlap', () => {
  const leaveAt = at(2026, 7, 12, 9, 0);
  for (let m = -20; m <= 20; m++) {
    const now = at(2026, 7, 12, 9, m < 0 ? 60 + m : m); // crude minute walk around 9:00
    const headsUp = N.shouldFireHeadsUp(now, leaveAt);
    const leave = N.shouldFireLeave(now, leaveAt);
    assert.ok(!(headsUp && leave), `both fired at offset ${m}`);
  }
});

test('snooze silences an id for the given window, then it lapses', () => {
  // snooze() stamps its expiry from the real wall clock (Date.now()), not a
  // fixture — so isSnoozed() here is checked relative to real "now" too.
  const id = 'test-class:540';
  const before = new Date();
  assert.equal(N.isSnoozed(id, before), false);
  N.snooze(id, 5);
  assert.equal(N.isSnoozed(id, new Date()), true);
  assert.equal(N.isSnoozed(id, new Date(Date.now() + 4 * 60000)), true);
  assert.equal(N.isSnoozed(id, new Date(Date.now() + 6 * 60000)), false);
});
