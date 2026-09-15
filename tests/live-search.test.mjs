import assert from 'node:assert/strict';
import test from 'node:test';

import { createLiveSearch } from '../src/live-search.js';

test('typing waits for a pause and searches only the latest conditions', () => {
  const h = harness();
  h.value.query = 'a';
  h.controller.input();
  h.clock.advance(100);
  h.value.query = 'alpha';
  h.controller.input();
  h.clock.advance(179);
  assert.deepEqual(h.calls, []);
  h.value.range = 'week';
  h.clock.advance(1);
  assert.deepEqual(h.calls, [{ query: 'alpha', range: 'week' }]);
  assert.equal(h.edited, 2);
  assert.equal(h.submitted, 1);
});

test('composition cancels an earlier pending search and submits only complete Chinese input', () => {
  const h = harness();
  h.controller.input();
  h.clock.advance(100);
  h.controller.compositionStart();
  h.value.query = 'zhou';
  h.controller.input({ isComposing: true });
  h.clock.advance(500);
  assert.deepEqual(h.calls, []);
  h.value.query = '周会';
  h.controller.compositionEnd();
  h.clock.advance(179);
  assert.deepEqual(h.calls, []);
  h.clock.advance(1);
  assert.deepEqual(h.calls, [{ query: '周会', range: 'all' }]);
});

test('the input event immediately after compositionend does not create a duplicate search', () => {
  const h = harness();
  h.controller.compositionStart();
  h.value.query = '周会';
  h.controller.compositionEnd();
  h.controller.input();
  h.clock.advance(1000);
  assert.deepEqual(h.calls, [{ query: '周会', range: 'all' }]);
  assert.equal(h.submitted, 1);
});

test('isComposing input protects against submitting partial input without compositionstart', () => {
  const h = harness();
  h.value.query = 'zhou';
  h.controller.input({ isComposing: true });
  h.controller.submit();
  h.clock.advance(1000);
  assert.equal(h.submitted, 0);
  h.value.query = '周';
  h.controller.compositionEnd();
  h.clock.advance(180);
  assert.deepEqual(h.calls, [{ query: '周', range: 'all' }]);
});

test('range changes apply immediately and cancel the pending text search', () => {
  const h = harness();
  h.value.query = 'weekly';
  h.controller.input();
  h.value.range = 'month';
  h.controller.change();
  assert.deepEqual(h.calls, [{ query: 'weekly', range: 'month' }]);
  h.clock.advance(1000);
  assert.equal(h.calls.length, 1);
  assert.equal(h.edited, 2);
  assert.equal(h.submitted, 1);
});

test('range changes during composition wait and use the latest range and complete query', () => {
  const h = harness();
  h.controller.compositionStart();
  h.value.query = 'zhou';
  h.controller.input({ isComposing: true });
  h.value.range = 'week';
  h.controller.change();
  h.value.range = 'month';
  h.controller.change();
  h.controller.submit();
  h.clock.advance(1000);
  assert.deepEqual(h.calls, []);
  h.value.query = '周会';
  h.controller.compositionEnd();
  h.controller.input();
  h.clock.advance(180);
  assert.deepEqual(h.calls, [{ query: '周会', range: 'month' }]);
  assert.equal(h.submitted, 1);
});

test('explicit submit runs immediately and returns the search promise unchanged', async () => {
  const completion = Promise.resolve('done');
  const h = harness({ search: () => completion });
  h.controller.input();
  const submitted = h.controller.submit();
  assert.equal(submitted, completion);
  assert.equal(await submitted, 'done');
  h.clock.advance(1000);
  assert.equal(h.submitted, 1);
});

test('cancel removes pending work without preventing future input', () => {
  const h = harness();
  h.controller.input();
  h.controller.cancel();
  h.clock.advance(1000);
  assert.deepEqual(h.calls, []);
  h.value.query = 'new';
  h.controller.input();
  h.clock.advance(180);
  assert.deepEqual(h.calls, [{ query: 'new', range: 'all' }]);
});

test('dispose cancels pending work and ignores all later events', () => {
  const h = harness();
  h.controller.input();
  h.controller.dispose();
  h.controller.input();
  h.controller.compositionStart();
  h.controller.compositionEnd();
  h.controller.change();
  h.controller.submit();
  h.clock.advance(1000);
  assert.deepEqual(h.calls, []);
  assert.equal(h.edited, 1);
  assert.equal(h.pending, 1);
  assert.equal(h.submitted, 0);
});

test('submission marks state before search and leaves failures with the caller', () => {
  const failure = new Error('index unavailable');
  const h = harness({ search: () => {
    assert.equal(h.submitted, 1);
    throw failure;
  } });
  assert.throws(() => h.controller.submit(), (error) => error === failure);
});

function harness(options = {}) {
  const clock = fakeClock();
  const h = {
    clock, value: { query: '', range: 'all' }, calls: [],
    edited: 0, submitted: 0, pending: 0
  };
  h.controller = createLiveSearch({
    read: () => h.value,
    search: (query, range) => h.calls.push({ query, range }),
    markEdited: () => { h.edited += 1; },
    markSubmitted: () => { h.submitted += 1; },
    onPending: () => { h.pending += 1; },
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    ...options
  });
  return h;
}

function fakeClock() {
  let now = 0;
  let nextId = 0;
  const timers = new Map();
  return {
    setTimer(callback, delay) {
      const id = nextId++;
      timers.set(id, { callback, due: now + delay });
      return id;
    },
    clearTimer(id) { timers.delete(id); },
    advance(duration) {
      const target = now + duration;
      while (true) {
        const next = [...timers].sort((a, b) => a[1].due - b[1].due)[0];
        if (!next || next[1].due > target) break;
        const [id, { callback, due }] = next;
        now = due;
        timers.delete(id);
        callback();
      }
      now = target;
    }
  };
}
