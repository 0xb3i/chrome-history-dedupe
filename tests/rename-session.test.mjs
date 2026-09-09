import assert from 'node:assert/strict';
import test from 'node:test';

import { createRenameSession } from '../src/rename-session.js';

test('completion of canceled A cannot close replacement dialog B', async () => {
  const session = createRenameSession();
  const saveA = deferred();
  const effects = [];
  session.open('A');
  const pendingA = session.run((value) => {
    assert.equal(value, 'A');
    return saveA.promise;
  }, {
    pending: (value) => effects.push(['pending', value]),
    success: () => { effects.push(['success']); session.close(); },
    error: (error) => effects.push(['error', error.message])
  });
  session.close();
  session.open('B');
  saveA.resolve();
  await pendingA;
  assert.equal(session.value, 'B');
  assert.deepEqual(effects, [['pending', true]]);
});

test('duplicate submissions execute only one operation until the current save settles', async () => {
  const session = createRenameSession();
  const save = deferred();
  let operationCount = 0;
  const effects = [];
  const callbacks = {
    pending: (value) => effects.push(['pending', value]),
    success: () => effects.push(['success']),
    error: (error) => effects.push(['error', error.message])
  };
  const operation = () => { operationCount += 1; return save.promise; };
  session.open('A');
  const first = session.run(operation, callbacks);
  await session.run(operation, callbacks);
  assert.equal(operationCount, 1);
  save.resolve();
  await first;
  assert.deepEqual(effects, [['pending', true], ['success'], ['pending', false]]);
});

test('a stale error cannot alter the replacement pending session or its error message', async () => {
  const session = createRenameSession();
  const saveA = deferred();
  const saveB = deferred();
  const effects = [];
  const callbacks = (name) => ({
    pending: (value) => effects.push([name, 'pending', value]),
    success: () => effects.push([name, 'success']),
    error: (error) => effects.push([name, 'error', error.message])
  });
  session.open('A');
  const first = session.run(() => saveA.promise, callbacks('A'));
  session.close();
  session.open('B');
  const second = session.run(() => saveB.promise, callbacks('B'));
  saveA.reject(new Error('A failed'));
  await first;
  let duplicateExecuted = false;
  await session.run(() => { duplicateExecuted = true; }, callbacks('B'));
  assert.equal(duplicateExecuted, false);
  assert.deepEqual(effects, [['A', 'pending', true], ['B', 'pending', true]]);
  saveB.reject(new Error('B failed'));
  await second;
  assert.deepEqual(effects.slice(2), [['B', 'error', 'B failed'], ['B', 'pending', false]]);
  assert.equal(session.value, 'B');
});

test('current failures permit retry, and closed sessions do not run operations', async () => {
  const session = createRenameSession();
  const effects = [];
  const callbacks = {
    pending: (value) => effects.push(['pending', value]),
    success: () => effects.push(['success']),
    error: (error) => effects.push(['error', error.message])
  };
  session.open('A');
  await session.run(() => { throw new Error('retry'); }, callbacks);
  await session.run(async () => {}, callbacks);
  assert.deepEqual(effects, [
    ['pending', true], ['error', 'retry'], ['pending', false],
    ['pending', true], ['success'], ['pending', false]
  ]);
  session.close();
  let ranWhileClosed = false;
  await session.run(() => { ranWhileClosed = true; }, callbacks);
  assert.equal(ranWhileClosed, false);
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
