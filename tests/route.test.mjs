// route.js's caching behavior — the part a live-GPS-origin call must NOT
// participate in, or it floods and evicts the permanent building-pair cache.
// Run: node --test tests/

import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.localStorage = {
  _d: new Map(),
  getItem(k) { return this._d.has(k) ? this._d.get(k) : null; },
  setItem(k, v) { this._d.set(k, String(v)); },
  removeItem(k) { this._d.delete(k); },
};

let fetchCalls = 0;
globalThis.fetch = async () => {
  fetchCalls++;
  return {
    ok: true,
    json: async () => ({
      trip: { legs: [{ shape: '', maneuvers: [] }], summary: { length: 0.05, time: 40 } },
    }),
  };
};

const R = await import('../js/route.js');

test('walk() caches by default — a second call for the same pair skips the network', async () => {
  fetchCalls = 0;
  const a = { lat: 32.4270, lon: -85.7057 };
  const b = { lat: 32.4300, lon: -85.7080 };
  const first = await R.walk(a, b);
  assert.equal(fetchCalls, 1);
  assert.equal(first.cached, undefined);
  const second = await R.walk(a, b);
  assert.equal(fetchCalls, 1);
  assert.equal(second.cached, true);
});

test('walk() with cache:false always hits the network and never populates the cache', async () => {
  fetchCalls = 0;
  const a = { lat: 32.4200, lon: -85.7000 };
  const b = { lat: 32.4250, lon: -85.7050 };
  await R.walk(a, b, { cache: false });
  assert.equal(fetchCalls, 1);
  await R.walk(a, b, { cache: false });
  assert.equal(fetchCalls, 2, 'a live-origin call must re-fetch, not reuse a cache entry');

  // A follow-up cache:true call for the exact same pair still misses the
  // network cache — proving the cache:false calls never wrote anything.
  await R.walk(a, b);
  assert.equal(fetchCalls, 3);
});

test('walk() returns the same-place shortcut without touching the network or cache', async () => {
  fetchCalls = 0;
  const a = { lat: 32.4270, lon: -85.7057 };
  const b = { lat: 32.4270, lon: -85.70571 }; // a few meters away
  const result = await R.walk(a, b);
  assert.equal(result.samePlace, true);
  assert.equal(fetchCalls, 0);
});
