import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CAPTURED_PAGE_TITLES_STORAGE_KEY,
  loadTitleOverrides,
  normalizeCapturedPageMap,
  normalizeCapturedTitleMap,
  normalizeLastSearchState,
  normalizePageTitleOverrideMap,
  normalizePinnedPageKeys,
  saveCapturedPageTitles,
  saveTitleOverride,
  togglePinnedUrlKey,
  updateCapturedTitleRecords
} from '../src/storage.js';

test('last search state normalizes query, range, and renamed filter', () => {
  assert.deepEqual(
    normalizeLastSearchState({
      query: '  MEEGO   story  ',
      range: 'week',
      showRenamedOnly: true,
      showMinimalMode: true
    }),
    {
      query: 'MEEGO story',
      range: 'week',
      showRenamedOnly: true,
      showMinimalMode: true
    }
  );
});

test('last search state falls back to the main page default for invalid ranges', () => {
  assert.deepEqual(normalizeLastSearchState({ query: 'MEEGO', range: 'forever' }), {
    query: 'MEEGO',
    range: 'month',
    showRenamedOnly: false,
    showMinimalMode: false
  });
});

test('legacy title overrides collapse by page identity without deleting unrelated same-name pages', () => {
  const migrated = normalizePageTitleOverrideMap(new Map([
    ['https://example.com/docs/abc12345/tools', 'First name'],
    ['https://example.com/docs/abc12345/settings', 'Last stored name'],
    ['https://example.com/docs/xyz98765/tools', 'Last stored name']
  ]));

  assert.deepEqual([...migrated], [
    ['https://example.com/docs/abc12345', {
      title: 'Last stored name',
      targetUrl: 'https://example.com/docs/abc12345/settings',
      updatedAt: 0
    }],
    ['https://example.com/docs/xyz98765', {
      title: 'Last stored name',
      targetUrl: 'https://example.com/docs/xyz98765/tools',
      updatedAt: 0
    }]
  ]);
});

test('structured title overrides keep the most recently updated record per page', () => {
  const migrated = normalizePageTitleOverrideMap(new Map([
    ['https://example.com/docs/abc12345/tools', {
      title: 'Newer name',
      targetUrl: 'https://example.com/docs/abc12345/tools',
      updatedAt: 200
    }],
    ['https://example.com/docs/abc12345/settings', {
      title: 'Older name',
      targetUrl: 'https://example.com/docs/abc12345/settings',
      updatedAt: 100
    }]
  ]));

  assert.equal(migrated.size, 1);
  assert.equal(migrated.get('https://example.com/docs/abc12345').title, 'Newer name');
});

test('legacy query-level renames collapse by path and keep the latest record', () => {
  const baseUrl = 'https://dataleap-va.tiktok-row.net/dorado/instance';
  const firstUrl = `${baseUrl}?_instanceD_=first`;
  const latestUrl = `${baseUrl}?searchType=content&keyword=109477584`;
  const migrated = normalizePageTitleOverrideMap(new Map([
    [firstUrl, {
      title: '旧实例名',
      targetUrl: firstUrl,
      updatedAt: 100
    }],
    [latestUrl, {
      title: '最新实例名',
      targetUrl: latestUrl,
      updatedAt: 200
    }]
  ]));

  assert.deepEqual([...migrated], [[baseUrl, {
    title: '最新实例名',
    targetUrl: latestUrl,
    updatedAt: 200
  }]]);
  assert.deepEqual(
    [...normalizePinnedPageKeys([firstUrl, latestUrl])],
    [baseUrl]
  );
});

test('loading version 3 overrides persists the latest page-identity migration', async () => {
  const storageKey = 'deduped-history-title-overrides';
  const migrationKey = 'deduped-history-title-overrides-migration';
  const baseUrl = 'https://example.com/projects/prj12345';
  const firstUrl = `${baseUrl}/tasks/task0001/overview`;
  const latestUrl = `${baseUrl}/tasks/task0002/settings`;
  const values = {
    [migrationKey]: 3,
    [storageKey]: {
      [firstUrl]: {
        title: '旧实例名',
        targetUrl: firstUrl,
        updatedAt: 100
      },
      [latestUrl]: {
        title: '最新实例名',
        targetUrl: latestUrl,
        updatedAt: 200
      }
    }
  };
  globalThis.chrome = createStorageChrome(values);

  try {
    const overrides = await loadTitleOverrides();

    assert.equal(overrides.size, 1);
    assert.equal(overrides.get(baseUrl).title, '最新实例名');
    assert.equal(values[migrationKey], 5);
    assert.deepEqual(Object.keys(values[storageKey]), [baseUrl]);
  } finally {
    delete globalThis.chrome;
  }
});

test('loading version 4 overrides migrates Feishu tenant domains to one wiki identity', async () => {
  const storageKey = 'deduped-history-title-overrides';
  const migrationKey = 'deduped-history-title-overrides-migration';
  const token = 'M1Cew0iYaiH9jfkeD5XcXEuZn3d';
  const renameUrl = `https://my.feishu.cn/wiki/${token}`;
  const values = {
    [migrationKey]: 4,
    [storageKey]: {
      [renameUrl]: {
        title: '大模型知识面试一本通',
        targetUrl: renameUrl,
        updatedAt: 200
      }
    }
  };
  globalThis.chrome = createStorageChrome(values);

  try {
    const overrides = await loadTitleOverrides();
    const canonicalKey = `https://feishu.cn/wiki/${token}`;

    assert.deepEqual([...overrides], [[canonicalKey, {
      title: '大模型知识面试一本通',
      targetUrl: renameUrl,
      updatedAt: 200
    }]]);
    assert.equal(values[migrationKey], 5);
    assert.deepEqual(Object.keys(values[storageKey]), [canonicalKey]);
  } finally {
    delete globalThis.chrome;
  }
});

test('legacy pinned tab URLs migrate to one stable page key', () => {
  assert.deepEqual(
    [...normalizePinnedPageKeys([
      'https://example.com/docs/abc12345/tools',
      'https://example.com/docs/abc12345/settings'
    ])],
    ['https://example.com/docs/abc12345']
  );
});

test('captured title records normalize valid titles and discard malformed entries', () => {
  assert.deepEqual(
    [...normalizeCapturedTitleMap({
      'https://example.com/a': { title: '  Final   title  ', updatedAt: 200 },
      'https://example.com/b': { title: '', updatedAt: 100 },
      '': { title: 'Missing URL', updatedAt: 300 }
    })],
    [['https://example.com/a', 'Final title']]
  );
});

test('captured title records strip invisible Unicode format controls', () => {
  assert.deepEqual(
    [...normalizeCapturedTitleMap({
      'https://example.com/a': {
        title: '\u2064\u200bAgent Node Replay 使用指南 - 飞书云文档',
        updatedAt: 200
      }
    })],
    [['https://example.com/a', 'Agent Node Replay 使用指南 - 飞书云文档']]
  );
});

test('captured page records preserve the final URL after redirects', () => {
  assert.deepEqual(
    [...normalizeCapturedPageMap({
      'https://cloud.example.com/legacy': {
        title: 'Release',
        resolvedUrl: 'https://cloud.example.com/final',
        updatedAt: 200
      }
    })],
    [['https://cloud.example.com/legacy', {
      title: 'Release',
      resolvedUrl: 'https://cloud.example.com/final'
    }]]
  );
});

test('captured title records skip storage updates when the title is unchanged', () => {
  const stored = {
    'https://example.com/doc/abc12345': {
      title: 'Final title',
      updatedAt: 100
    }
  };

  const unchanged = updateCapturedTitleRecords(
    stored,
    'https://example.com/doc/abc12345',
    'Final title',
    200
  );
  const renamed = updateCapturedTitleRecords(
    stored,
    'https://example.com/doc/abc12345',
    'Renamed title',
    200
  );

  assert.equal(unchanged.changed, false);
  assert.equal(unchanged.records.get('https://example.com/doc/abc12345').updatedAt, 100);
  assert.equal(renamed.changed, true);
  assert.deepEqual(renamed.records.get('https://example.com/doc/abc12345'), {
    title: 'Renamed title',
    updatedAt: 200
  });
});

test('captured navigation aliases are merged with one storage read and write', async () => {
  const existingUrl = 'https://example.com/existing';
  const firstAlias = 'https://example.com/redirect';
  const finalUrl = 'https://example.com/final';
  const values = {
    [CAPTURED_PAGE_TITLES_STORAGE_KEY]: {
      [existingUrl]: { title: 'Existing', updatedAt: 50 }
    }
  };
  let capturedReads = 0;
  let capturedWrites = 0;
  globalThis.chrome = createStorageChrome(values, {}, {
    onGet(key) {
      if (key === CAPTURED_PAGE_TITLES_STORAGE_KEY) capturedReads += 1;
    },
    onSet(nextValues) {
      if (nextValues[CAPTURED_PAGE_TITLES_STORAGE_KEY]) capturedWrites += 1;
    }
  });

  try {
    await saveCapturedPageTitles([
      { key: firstAlias, title: 'Final title', resolvedUrl: finalUrl, updatedAt: 100 },
      { key: finalUrl, title: 'Final title', resolvedUrl: finalUrl, updatedAt: 100 },
      { key: firstAlias, title: 'Latest title', resolvedUrl: finalUrl, updatedAt: 200 }
    ]);

    assert.equal(capturedReads, 1);
    assert.equal(capturedWrites, 1);
    assert.deepEqual(values[CAPTURED_PAGE_TITLES_STORAGE_KEY], {
      [firstAlias]: { title: 'Latest title', resolvedUrl: finalUrl, updatedAt: 200 },
      [finalUrl]: { title: 'Final title', resolvedUrl: finalUrl, updatedAt: 100 },
      [existingUrl]: { title: 'Existing', updatedAt: 50 }
    });
  } finally {
    delete globalThis.chrome;
  }
});

test('a stalled captured-title mutation does not block a title override save', async () => {
  const values = {};
  let releaseCapturedRead;
  let capturedReadStartedResolve;
  let titleOverrideWrittenResolve;
  const capturedReadStarted = new Promise((resolve) => {
    capturedReadStartedResolve = resolve;
  });
  const titleOverrideWritten = new Promise((resolve) => {
    titleOverrideWrittenResolve = resolve;
  });
  globalThis.chrome = createStorageChrome(values, {}, {
    handleGet(key, callback, areaValues) {
      if (key !== CAPTURED_PAGE_TITLES_STORAGE_KEY || releaseCapturedRead) return false;
      releaseCapturedRead = () => callback({ [key]: areaValues[key] });
      capturedReadStartedResolve();
      return true;
    },
    onSet(nextValues) {
      if (nextValues['deduped-history-title-overrides']) titleOverrideWrittenResolve();
    }
  });

  try {
    const capturedSave = saveCapturedPageTitles([{
      key: 'https://example.com/captured',
      title: 'Captured',
      updatedAt: 100
    }]);
    await capturedReadStarted;

    const renameSave = saveTitleOverride('https://example.com/docs/abc12345', 'Renamed', {
      targetUrl: 'https://example.com/docs/abc12345',
      updatedAt: 200
    });
    await Promise.race([
      titleOverrideWritten,
      new Promise((_, reject) => setTimeout(() => reject(new Error('rename save was blocked')), 500))
    ]);
    await renameSave;

    assert.equal(values['deduped-history-title-overrides']['https://example.com/docs/abc12345'].title, 'Renamed');
    releaseCapturedRead();
    releaseCapturedRead = null;
    await capturedSave;
  } finally {
    releaseCapturedRead?.();
    delete globalThis.chrome;
  }
});

test('concurrent title saves retain different pages and repeated page renames keep the latest one', async () => {
  const values = {};
  globalThis.chrome = createStorageChrome(values);

  try {
    await Promise.all([
      saveTitleOverride('https://example.com/docs/abc12345', 'Docs A', {
        targetUrl: 'https://example.com/docs/abc12345/tools',
        updatedAt: 100
      }),
      saveTitleOverride('https://example.com/docs/xyz98765', 'Docs B', {
        targetUrl: 'https://example.com/docs/xyz98765/tools',
        updatedAt: 100
      })
    ]);
    await saveTitleOverride('https://example.com/docs/abc12345', 'Docs A latest', {
      targetUrl: 'https://example.com/docs/abc12345/settings',
      updatedAt: 200
    });
    await saveTitleOverride('https://example.com/docs/abc12345', 'Stale request', {
      targetUrl: 'https://example.com/docs/abc12345/overview',
      updatedAt: 150
    });

    const overrides = await loadTitleOverrides();
    assert.equal(overrides.size, 2);
    assert.deepEqual(overrides.get('https://example.com/docs/abc12345'), {
      title: 'Docs A latest',
      targetUrl: 'https://example.com/docs/abc12345/settings',
      updatedAt: 200
    });
    assert.equal(overrides.get('https://example.com/docs/xyz98765').title, 'Docs B');
  } finally {
    delete globalThis.chrome;
  }
});

test('unpin removes active redirect aliases while pin writes only the canonical key', async () => {
  const values = {
    'deduped-history-pinned-urls': [
      'https://example.com/legacy-doc',
      'https://example.com/unrelated'
    ]
  };
  globalThis.chrome = createStorageChrome(values);

  try {
    const afterUnpin = await togglePinnedUrlKey(
      'https://example.com/final-doc',
      false,
      ['https://example.com/legacy-doc']
    );
    assert.deepEqual([...afterUnpin], ['https://example.com/unrelated']);

    const afterPin = await togglePinnedUrlKey('https://example.com/final-doc', true, [
      'https://example.com/legacy-doc'
    ]);
    assert.deepEqual([...afterPin], [
      'https://example.com/unrelated',
      'https://example.com/final-doc'
    ]);
  } finally {
    delete globalThis.chrome;
  }
});

function createStorageChrome(values, sessionValues = {}, hooks = {}) {
  const createArea = (areaValues) => ({
    get(key, callback) {
      hooks.onGet?.(key);
      if (hooks.handleGet?.(key, callback, areaValues)) return;
      setTimeout(() => callback({ [key]: areaValues[key] }), 0);
    },
    set(nextValues, callback) {
      hooks.onSet?.(nextValues);
      setTimeout(() => {
        Object.assign(areaValues, structuredClone(nextValues));
        callback();
      }, 0);
    },
    remove(key, callback) {
      setTimeout(() => {
        delete areaValues[key];
        callback();
      }, 0);
    }
  });

  return {
    runtime: {},
    storage: {
      local: createArea(values),
      session: createArea(sessionValues)
    }
  };
}
