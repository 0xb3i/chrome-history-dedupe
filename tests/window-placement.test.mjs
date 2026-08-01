import assert from 'node:assert/strict';
import test from 'node:test';

import { getCenteredCoordinate } from '../src/window-placement.js';

test('popup placement preserves negative coordinates for displays left of the primary display', () => {
  assert.equal(getCenteredCoordinate(-1920, 1920, 480), -1200);
});

test('popup placement preserves negative coordinates for displays above the primary display', () => {
  assert.equal(getCenteredCoordinate(-1080, 1080, 230), -655);
});

test('popup placement centers on displays with positive coordinates', () => {
  assert.equal(getCenteredCoordinate(1920, 2560, 480), 2960);
});

test('popup placement rejects incomplete window bounds', () => {
  assert.equal(getCenteredCoordinate(undefined, 1920, 480), undefined);
  assert.equal(getCenteredCoordinate(0, undefined, 480), undefined);
  assert.equal(getCenteredCoordinate(0, 1920, undefined), undefined);
});
