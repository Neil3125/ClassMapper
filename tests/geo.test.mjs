import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  haversine,
  bearing,
  lerpAngleDeg,
  isArrived,
  nearestPointOnPolyline,
  remainingRouteMeters,
  trimShapeToProgress,
} from '../js/geo.js';

test('bearing points north/east/south/west at the cardinal cases', () => {
  const origin = { lat: 32.4279, lon: -85.7057 };
  assert.ok(bearing(origin, { lat: origin.lat + 0.01, lon: origin.lon }) < 1); // north
  assert.ok(Math.abs(bearing(origin, { lat: origin.lat, lon: origin.lon + 0.01 }) - 90) < 1); // east
  assert.ok(Math.abs(bearing(origin, { lat: origin.lat - 0.01, lon: origin.lon }) - 180) < 1); // south
  assert.ok(Math.abs(bearing(origin, { lat: origin.lat, lon: origin.lon - 0.01 }) - 270) < 1); // west
});

test('lerpAngleDeg takes the shorter arc, including across the 0/360 wrap', () => {
  assert.equal(Math.round(lerpAngleDeg(350, 10, 0.5)), 0);
  assert.equal(Math.round(lerpAngleDeg(10, 350, 0.5)), 0);
  assert.equal(Math.round(lerpAngleDeg(0, 90, 0.5)), 45);
  assert.equal(Math.round(lerpAngleDeg(0, 180, 1)), 180);
});

test('isArrived is true at/inside the threshold and false just outside it', () => {
  const dest = { lat: 32.4279, lon: -85.7057 };
  const close = { lat: 32.42795, lon: -85.7057 }; // ~5.5m north
  const far = { lat: 32.4290, lon: -85.7057 }; // ~120m north
  assert.equal(isArrived(close, dest, 20), true);
  assert.equal(isArrived(far, dest, 20), false);
  assert.equal(isArrived(dest, dest, 20), true);
});

test('nearestPointOnPolyline projects onto a straight meridian segment', () => {
  // A north-south line; a point offset to the east should project straight west onto it.
  const shape = [
    [32.4270, -85.7057],
    [32.4290, -85.7057],
  ];
  const point = { lat: 32.4280, lon: -85.7050 };
  const result = nearestPointOnPolyline(shape, point);
  assert.equal(result.segIndex, 0);
  assert.ok(result.t > 0.4 && result.t < 0.6);
  assert.ok(Math.abs(result.projected[0] - 32.4280) < 0.0001);
  assert.ok(Math.abs(result.projected[1] - (-85.7057)) < 0.0001);
  // Remaining distance should roughly match the northward half of the segment (~110m).
  const expected = haversine(result.projected, shape[1]);
  assert.ok(Math.abs(result.remainingMeters - expected) < 1);
});

test('remainingRouteMeters sums the projected remainder across multiple segments', () => {
  const shape = [
    [32.4270, -85.7057],
    [32.4280, -85.7057],
    [32.4290, -85.7057],
  ];
  const atStart = remainingRouteMeters(shape, { lat: 32.4270, lon: -85.7057 });
  const wholeLength = haversine(shape[0], shape[1]) + haversine(shape[1], shape[2]);
  assert.ok(Math.abs(atStart - wholeLength) < 1);

  const atSecondVertex = remainingRouteMeters(shape, { lat: 32.4280, lon: -85.7057 });
  assert.ok(Math.abs(atSecondVertex - haversine(shape[1], shape[2])) < 1);
});

test('trimShapeToProgress keeps the projected point plus every vertex ahead of it', () => {
  const shape = [
    [32.4270, -85.7057],
    [32.4280, -85.7057],
    [32.4290, -85.7057],
  ];
  const trimmed = trimShapeToProgress(shape, { lat: 32.4280, lon: -85.7057 });
  assert.equal(trimmed.length, 2);
  assert.ok(Math.abs(trimmed[0][0] - 32.4280) < 0.0001);
  assert.deepEqual(trimmed[1], shape[2]);
});

test('trimShapeToProgress on an empty shape returns an empty array', () => {
  assert.deepEqual(trimShapeToProgress([], { lat: 0, lon: 0 }), []);
});
