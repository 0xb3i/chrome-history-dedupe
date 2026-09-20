import assert from 'node:assert/strict';
import test from 'node:test';
import { exportUserDataBackup, importUserDataBackup } from '../src/user-data-backup.js';
import {
  TITLE_OVERRIDES_STORAGE_KEY as T, TITLE_OVERRIDES_MIGRATION_STORAGE_KEY as V,
  GROUP_NAME_OVERRIDES_STORAGE_KEY as G, PINNED_URLS_STORAGE_KEY as P,
  CAPTURED_PAGE_TITLES_STORAGE_KEY as C,
  saveTitleOverride, saveCapturedPageTitles, loadCapturedPageTitles
} from '../src/storage.js';
import { buildHistoryIndex } from '../src/history-index/derive.js';
import { filterHistoryItemsByQuery } from '../src/history-utils.js';

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
    assert.deepEqual(await importUserDataBackup(source), { titles: 1, groups: 1, pins: 1, capturedTitles: 0 });
    assert.equal(writes.length, 1);
    assert.equal(values[V], 6);
    assert.deepEqual(values[T]['https://example.com/concrete'], source.data[T]['https://example.com/old']);
    assert.equal(values[T]['https://example.com/old'], undefined);
    const exported = await exportUserDataBackup();
    assert.equal(exported.version, 2);
    assert.deepEqual(exported.data, values);
    assert.ok(Number.isFinite(Date.parse(exported.exportedAt)));
    await importUserDataBackup(exported);
    assert.deepEqual((await exportUserDataBackup()).data, values);
  } finally { delete globalThis.chrome; }
});

test('captured page titles roundtrip as current names without requiring another visit', async () => {
  const url = 'https://space.bilibili.com/673779175';
  const title = '量子位的个人空间';
  const values = { [V]: 6, [C]: { [url]: { title, updatedAt: 100 } } };
  storage(values);
  try {
    const exported = await exportUserDataBackup();
    assert.equal(exported.version, 2);
    assert.deepEqual(exported.data[C], values[C]);
    for (const key of Object.keys(values)) delete values[key];
    const counts = await importUserDataBackup(exported);
    assert.equal(counts.capturedTitles, 1);
    const indexes = await buildHistoryIndex([{ url, title: url, visitCount: 2 }], {
      capturedPageTitles: await loadCapturedPageTitles(), yieldControl: async () => {}
    });
    const [result] = filterHistoryItemsByQuery(indexes.get('all'), '量子位');
    assert.equal(result.title, title);
    assert.deepEqual(result.searchMatch.aliases, []);
  } finally { delete globalThis.chrome; }
});

test('capture restore preserves current valid names and only restores versioned redirect relationships', async () => {
  const first = 'https://example.com/first';
  const second = 'https://example.com/second';
  const legacy = 'https://example.com/legacy';
  const final = 'https://example.com/final';
  const values = { [V]: 6, [C]: {
    [first]: { title: '当前名称', updatedAt: 10 },
    [second]: { title: second, updatedAt: 100 }
  } };
  storage(values);
  try {
    await importUserDataBackup({ ...backup({ [C]: {
      [first]: { title: '备份名称', updatedAt: 999 },
      [second]: { title: '恢复名称', updatedAt: 20, resolvedUrl: final, resolutionVersion: 1 },
      [legacy]: { title: '旧捕获名称', updatedAt: 30, resolvedUrl: final }
    } }), version: 2 });
    assert.deepEqual(values[C][first], { title: '当前名称', updatedAt: 10 });
    assert.deepEqual(values[C][second], {
      title: '恢复名称', updatedAt: 20, resolvedUrl: final, resolutionVersion: 1
    });
    assert.deepEqual(values[C][legacy], { title: '旧捕获名称', updatedAt: 30 });
    const exported = await exportUserDataBackup();
    assert.deepEqual(exported.data[C], values[C]);
  } finally { delete globalThis.chrome; }
});

test('capture backup validation rejects the entire payload before any annotation changes', async () => {
  const values = {};
  const writes = storage(values);
  try {
    for (const captured of [undefined, [], null, { page: {} },
      { page: { title: '标题', updatedAt: 'bad' } },
      { page: { title: '标题', updatedAt: 10, resolvedUrl: 12 } },
      { page: { title: '标题', updatedAt: 10, resolutionVersion: '1' } }]) {
      await assert.rejects(importUserDataBackup({ ...backup({
        [T]: { 'https://example.com/renamed': '重命名' }, [C]: captured
      }), version: 2 }));
    }
    assert.deepEqual(values, {});
    assert.equal(writes.length, 0);
  } finally { delete globalThis.chrome; }
});

test('capture restoration is bounded and concurrent live capture survives the shared lock', async () => {
  const values = { [V]: 6 };
  storage(values);
  try {
    const records = Object.fromEntries(Array.from({ length: 5001 }, (_, index) => [
      `https://example.com/page/${index}`, { title: `页面 ${index}`, updatedAt: index }
    ]));
    const exportedBeforeImport = await exportUserDataBackup();
    assert.deepEqual(exportedBeforeImport.data[C], {});
    await Promise.all([
      importUserDataBackup({ ...backup({ [C]: records }), version: 2 }),
      saveCapturedPageTitles([{ key: 'https://example.com/live', title: '刚加载完成', updatedAt: 6000 }])
    ]);
    assert.equal(Object.keys(values[C]).length, 5000);
    assert.equal(values[C]['https://example.com/live'].title, '刚加载完成');
    assert.equal(values[C]['https://example.com/page/5000'].title, '页面 5000');
    assert.equal(values[C]['https://example.com/page/0'], undefined);
    assert.equal(Object.keys((await exportUserDataBackup()).data[C]).length, 5000);
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
