import assert from 'node:assert/strict';
import test from 'node:test';

import {
  INLINE_RENAME_PREPARE_TIMEOUT_MS,
  waitForInlineRenamePreparation
} from '../src/rename-shortcut.js';

test('inline rename preparation succeeds without waiting for its deadline', async () => {
  let clearedTimeoutId;
  const result = await waitForInlineRenamePreparation(Promise.resolve(), {
    setTimeoutApi: () => 17,
    clearTimeoutApi: (timeoutId) => {
      clearedTimeoutId = timeoutId;
    }
  });

  assert.equal(result, true);
  assert.equal(clearedTimeoutId, 17);
});

test('stalled inline rename preparation reaches a bounded fallback deadline', async () => {
  let triggerDeadline;
  let requestedDelay;
  const stalledPreparation = new Promise(() => {});
  const resultPromise = waitForInlineRenamePreparation(stalledPreparation, {
    setTimeoutApi: (callback, delay) => {
      triggerDeadline = callback;
      requestedDelay = delay;
      return 23;
    },
    clearTimeoutApi: () => {}
  });

  triggerDeadline();

  assert.equal(await resultPromise, false);
  assert.equal(requestedDelay, INLINE_RENAME_PREPARE_TIMEOUT_MS);
});

test('failed inline rename preparation falls back instead of rejecting', async () => {
  const result = await waitForInlineRenamePreparation(Promise.reject(new Error('blocked')), {
    setTimeoutApi: () => 31,
    clearTimeoutApi: () => {}
  });

  assert.equal(result, false);
});
