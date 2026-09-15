import assert from 'node:assert/strict';
import test from 'node:test';
import { exportUserDataBackup, importUserDataBackup } from '../src/user-data-backup.js';
import {
  TITLE_OVERRIDES_STORAGE_KEY as T, TITLE_OVERRIDES_MIGRATION_STORAGE_KEY as V,
  GROUP_NAME_OVERRIDES_STORAGE_KEY as G, PINNED_URLS_STORAGE_KEY as P,
  saveTitleOverride
} from '../src/storage.js';

function storage(values, fail = false) {
  const writes = [];
  globalThis.chrome = { runtime: {}, storage: { local: {
    get(key, callback) { setImmediate(() => callback({ [key]: structuredClone(values[key]) })); },
    set(next, callback) {
      setImmediate(() => {
        if (fail) globalThis.chrome.runtime.lastError = { message: 'quota exceeded' };
        else { Object.assign(values, structuredClone(next)); writes.push(next); }
        callback();
        delete globalThis.chrome.runtime.lastError;
      });
    }
  } } };
  return writes;
}
function backup(data) {
  return { format: 'history-dedupe-user-data', version: 1,
    data: { [T]: {}, [V]: 6, [G]: {}, [P]: [], ...data } };
}

test('legacy backup migrates concrete targets, retains annotations and imports atomically', async () => {
  const values = {};
  const writes = storage(values);
  try {
    const source = backup({ [V]: 3, [T]: {
      'https://example.com/old': { title: '我的资料', targetUrl: 'https://example.com/concrete', updatedAt: 123 }
    }, [G]: { 'example.com': '工作' }, [P]: ['https://example.com/concrete'] });
    assert.deepEqual(await importUserDataBackup(source), { titles: 1, groups: 1, pins: 1 });
    assert.equal(writes.length, 1);
    assert.equal(values[V], 6);
    assert.deepEqual(values[T]['https://example.com/concrete'], source.data[T]['https://example.com/old']);
    assert.equal(values[T]['https://example.com/old'], undefined);
    const exported = await exportUserDataBackup();
    assert.deepEqual(exported.data, values);
    assert.ok(Number.isFinite(Date.parse(exported.exportedAt)));
    await importUserDataBackup(exported);
    assert.deepEqual((await exportUserDataBackup()).data, values);
  } finally { delete globalThis.chrome; }
});

test('current redirect keys survive roundtrip and conflicts preserve all existing user edits', async () => {
  const existing = { title: '新名称', targetUrl: 'https://example.com/alias', updatedAt: 50 };
  const values = { [V]: 6, [T]: { 'https://example.com/canonical': existing },
    [G]: { 'example.com': '现在的分组' }, [P]: ['https://example.com/first'], cache: 'keep' };
  storage(values);
  try {
    const source = backup({ [T]: {
      'https://example.com/canonical': { ...existing, title: '备份名称', updatedAt: 999 },
      'https://example.com/second': '第二页'
    }, [G]: { 'example.com': '旧分组', 'another.com': '其他' },
    [P]: ['https://example.com/second', 'https://example.com/first'] });
    await importUserDataBackup(source);
    assert.deepEqual(values[T]['https://example.com/canonical'], existing);
    assert.equal(values[T]['https://example.com/alias'], undefined);
    assert.equal(values[G]['example.com'], '现在的分组');
    assert.deepEqual(values[P], ['https://example.com/first', 'https://example.com/second']);
    assert.equal(values.cache, 'keep');
    assert.equal((await exportUserDataBackup()).data.cache, undefined);
  } finally { delete globalThis.chrome; }
});

test('invalid and future backup data never writes partial annotations', async () => {
  const values = {};
  const writes = storage(values);
  try {
    for (const source of [null, {}, { ...backup({}), version: 99 }, backup({ [V]: 99 }),
      backup({ [G]: { 'example.com': {} } }), backup({ [T]: { a: { title: 'x', updatedAt: 'bad' } } }),
      backup({ [T]: [] }), backup({ [P]: [null] })]) {
      await assert.rejects(importUserDataBackup(source));
    }
    assert.equal(writes.length, 0);
    assert.deepEqual(values, {});
  } finally { delete globalThis.chrome; }
});

test('concurrent normal rename and restore both survive the shared storage locks', async () => {
  const values = { [V]: 6 };
  storage(values);
  try {
    await Promise.all([
      importUserDataBackup(backup({ [T]: { 'https://example.com/restored': '恢复名称' } })),
      saveTitleOverride('https://example.com/new', '刚刚编辑')
    ]);
    assert.equal(values[T]['https://example.com/restored'].title, '恢复名称');
    assert.equal(values[T]['https://example.com/new'].title, '刚刚编辑');
  } finally { delete globalThis.chrome; }
});

test('failed persistence rejects recovery without claiming success', async () => {
  const values = {};
  storage(values, true);
  try {
    await assert.rejects(importUserDataBackup(backup({})), /quota exceeded/);
    assert.deepEqual(values, {});
  } finally { delete globalThis.chrome; }
});
