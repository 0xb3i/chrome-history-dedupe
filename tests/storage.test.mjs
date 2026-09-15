import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CAPTURED_PAGE_TITLES_STORAGE_KEY,
  HISTORY_PAGE_SEARCH_STATE_STORAGE_KEY,
  LAST_SEARCH_STATE_STORAGE_KEY,
  loadLastSearchState,
  loadTitleOverrides,
  normalizeCapturedPageMap,
  normalizeLastSearchState,
  normalizePageTitleOverrideMap,
  normalizePinnedPageKeys,
  saveCapturedPageTitles,
  saveLastSearchState,
  saveTitleOverride,
  togglePinnedUrlKey
} from '../src/storage.js';

test('last search state normalizes query and display preferences and the selected time range', () => {
  assert.deepEqual(
    normalizeLastSearchState({
      query: '  MEEGO   story  ',
      range: 'week',
      sortOrder: 'recent',
      showRenamedOnly: true,
      showMinimalMode: true
    }),
    {
      query: 'MEEGO story',
      range: 'week',
      sortOrder: 'recent',
      showRenamedOnly: true,
      showMinimalMode: true
    }
  );
});

test('last search state defaults missing or invalid ranges to all history', () => {
  assert.deepEqual(normalizeLastSearchState({ query: 'MEEGO', range: 'forever' }), {
    query: 'MEEGO',
    range: 'all',
    sortOrder: 'default',
    showRenamedOnly: false,
    showMinimalMode: false
  });
});

test('loading and saving search preferences preserves the selected range', async () => {
  const values = { [LAST_SEARCH_STATE_STORAGE_KEY]: {
    query: 'Old handbook', range: 'day', showRenamedOnly: false, showMinimalMode: true
  } };
  globalThis.chrome = createStorageChrome(values);
  try {
    const loaded = await loadLastSearchState();
    assert.deepEqual(loaded, {
      query: 'Old handbook', range: 'day', sortOrder: 'default', showRenamedOnly: false, showMinimalMode: true
    });
    await saveLastSearchState({ ...loaded, range: 'week' });
    assert.deepEqual(values[LAST_SEARCH_STATE_STORAGE_KEY], { ...loaded, range: 'week' });
  } finally {
    delete globalThis.chrome;
  }
});

test('search sort preference survives storage round trips and invalid values use the default', async () => {
  const values = {};
  globalThis.chrome = createStorageChrome(values);
  try {
    for (const sortOrder of ['default', 'visits', 'recent', 'name']) {
      await saveLastSearchState({ query: 'agent', sortOrder });
      assert.equal((await loadLastSearchState()).sortOrder, sortOrder);
      assert.equal(values[LAST_SEARCH_STATE_STORAGE_KEY].sortOrder, sortOrder);
    }
    await saveLastSearchState({ sortOrder: 'unknown' });
    assert.equal((await loadLastSearchState()).sortOrder, 'default');
  } finally {
    delete globalThis.chrome;
  }
});

test('history page starts without search preferences even when the popup has saved state', async () => {
  const popupState = normalizeLastSearchState({ query: 'agent', range: 'week', sortOrder: 'visits' });
  const values = { [LAST_SEARCH_STATE_STORAGE_KEY]: popupState };
  globalThis.chrome = createStorageChrome(values);
  try {
    assert.equal(await loadLastSearchState('history'), null);
    assert.deepEqual(await loadLastSearchState(), popupState);
    assert.equal(values[HISTORY_PAGE_SEARCH_STATE_STORAGE_KEY], undefined);
  } finally {
    delete globalThis.chrome;
  }
});

test('history page and popup save independent queries, ranges, and sort preferences', async () => {
  const values = {};
  const popupState = normalizeLastSearchState({ query: 'agent', range: 'week', sortOrder: 'visits' });
  const historyState = normalizeLastSearchState({ query: 'handbook', range: 'all', sortOrder: 'recent' });
  globalThis.chrome = createStorageChrome(values);
  try {
    await saveLastSearchState(popupState);
    await saveLastSearchState(historyState, 'history');
    assert.deepEqual(await loadLastSearchState(), popupState);
    assert.deepEqual(await loadLastSearchState('popup'), popupState);
    assert.deepEqual(await loadLastSearchState('history'), historyState);
    assert.deepEqual(values[LAST_SEARCH_STATE_STORAGE_KEY], popupState);
    assert.deepEqual(values[HISTORY_PAGE_SEARCH_STATE_STORAGE_KEY], historyState);

    const updatedPopup = { ...popupState, query: 'notes', range: 'day', sortOrder: 'name' };
    await saveLastSearchState(updatedPopup, 'popup');
    assert.deepEqual(await loadLastSearchState(), updatedPopup);
    assert.deepEqual(await loadLastSearchState('history'), historyState);

    const updatedHistory = { ...historyState, query: '', range: 'month', sortOrder: 'visits' };
    await saveLastSearchState(updatedHistory, 'history');
    assert.deepEqual(await loadLastSearchState('history'), updatedHistory);
    assert.deepEqual(await loadLastSearchState(), updatedPopup);
  } finally {
    delete globalThis.chrome;
  }
});

test('legacy title overrides collapse by page identity without deleting unrelated same-name pages', () => {
  const migrated = normalizePageTitleOverrideMap(new Map([
    ['https://cloud-ttp-us.bytedance.net/tae/mcp_server/abc12345/tools', 'First name'],
    ['https://cloud-ttp-us.bytedance.net/tae/mcp_server/abc12345/inspector', 'Last stored name'],
    ['https://cloud-ttp-us.bytedance.net/tae/mcp_server/xyz98765/tools', 'Last stored name']
  ]));

  assert.deepEqual([...migrated], [
    ['https://cloud-ttp-us.bytedance.net/tae/mcp_server/abc12345', {
      title: 'Last stored name',
      targetUrl: 'https://cloud-ttp-us.bytedance.net/tae/mcp_server/abc12345/inspector',
      updatedAt: 0
    }],
    ['https://cloud-ttp-us.bytedance.net/tae/mcp_server/xyz98765', {
      title: 'Last stored name',
      targetUrl: 'https://cloud-ttp-us.bytedance.net/tae/mcp_server/xyz98765/tools',
      updatedAt: 0
    }]
  ]);
});

test('structured title overrides keep the most recently updated record per page', () => {
  const migrated = normalizePageTitleOverrideMap(new Map([
    ['https://cloud-ttp-us.bytedance.net/tae/mcp_server/abc12345/tools', {
      title: 'Newer name',
      targetUrl: 'https://cloud-ttp-us.bytedance.net/tae/mcp_server/abc12345/tools',
      updatedAt: 200
    }],
    ['https://cloud-ttp-us.bytedance.net/tae/mcp_server/abc12345/inspector', {
      title: 'Older name',
      targetUrl: 'https://cloud-ttp-us.bytedance.net/tae/mcp_server/abc12345/inspector',
      updatedAt: 100
    }]
  ]));

  assert.equal(migrated.size, 1);
  assert.equal(migrated.get('https://cloud-ttp-us.bytedance.net/tae/mcp_server/abc12345').title, 'Newer name');
});

test('unknown query-level renames and pins retain independent resource identity', () => {
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

  assert.equal(migrated.size, 2);
  assert.equal(migrated.get(firstUrl).title, '旧实例名');
  assert.equal(migrated.get(`${baseUrl}?keyword=109477584&searchType=content`).title, '最新实例名');
  assert.deepEqual(
    [...normalizePinnedPageKeys([firstUrl, latestUrl])],
    [firstUrl, `${baseUrl}?keyword=109477584&searchType=content`]
  );
});

test('loading version 3 overrides persists the latest page-identity migration', async () => {
  const storageKey = 'deduped-history-title-overrides';
  const migrationKey = 'deduped-history-title-overrides-migration';
  const baseUrl = 'https://example.com/projects/prj12345';
  const firstUrl = `${baseUrl}/tasks/task0001/overview`;
  const latestUrl = `${baseUrl}/tasks/task0002/inspector`;
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

    assert.equal(overrides.size, 2);
    assert.equal(overrides.get(firstUrl).title, '旧实例名');
    assert.equal(overrides.get(latestUrl).title, '最新实例名');
    assert.equal(values[migrationKey], 6);
    assert.deepEqual(Object.keys(values[storageKey]), [firstUrl, latestUrl]);
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
    assert.equal(values[migrationKey], 6);
    assert.deepEqual(Object.keys(values[storageKey]), [canonicalKey]);
  } finally {
    delete globalThis.chrome;
  }
});

test('version 5 broad keys migrate to their stored target and resolve collisions by update time', async () => {
  const storageKey = 'deduped-history-title-overrides';
  const migrationKey = 'deduped-history-title-overrides-migration';
  const broadKey = 'https://example.com/projects/prj12345';
  const targetUrl = `${broadKey}/tasks/task0002/overview`;
  const values = {
    [migrationKey]: 5,
    [storageKey]: {
      [broadKey]: { title: '用户保留的名称', targetUrl, updatedAt: 200 },
      [targetUrl]: { title: '较早的名称', targetUrl, updatedAt: 100 }
    }
  };
  globalThis.chrome = createStorageChrome(values);
  try {
    const overrides = await loadTitleOverrides();
    assert.deepEqual([...overrides], [[targetUrl, {
      title: '用户保留的名称', targetUrl, updatedAt: 200
    }]]);
    assert.equal(values[migrationKey], 6);
    assert.deepEqual(Object.keys(values[storageKey]), [targetUrl]);
    assert.deepEqual(await loadTitleOverrides(), overrides);
  } finally {
    delete globalThis.chrome;
  }
});

test('current-version reads and saves preserve a canonical redirect key distinct from its target', async () => {
  const storageKey = 'deduped-history-title-overrides';
  const canonicalKey = 'https://example.com/final';
  const record = { title: '保留名称', targetUrl: 'https://example.com/legacy', updatedAt: 200 };
  const values = {
    'deduped-history-title-overrides-migration': 6,
    [storageKey]: { [canonicalKey]: record }
  };
  globalThis.chrome = createStorageChrome(values);
  try {
    assert.deepEqual([...normalizePageTitleOverrideMap(values[storageKey])], [[canonicalKey, record]]);
    assert.deepEqual([...(await loadTitleOverrides())], [[canonicalKey, record]]);
    await saveTitleOverride('https://example.com/unrelated', '另一页');
    assert.deepEqual(values[storageKey][canonicalKey], record);
    assert.equal(values[storageKey][record.targetUrl], undefined);
  } finally {
    delete globalThis.chrome;
  }
});

test('saving before the first read migrates existing version 5 names before marking version 6', async () => {
  const storageKey = 'deduped-history-title-overrides';
  const oldKey = 'https://example.com/projects/prj12345';
  const targetUrl = `${oldKey}/tasks/task0002`;
  const record = { title: '原有名称', targetUrl, updatedAt: 200 };
  const values = {
    'deduped-history-title-overrides-migration': 5,
    [storageKey]: { [oldKey]: record }
  };
  globalThis.chrome = createStorageChrome(values);
  try {
    await saveTitleOverride('https://example.com/new', '新名称');
    assert.deepEqual(values[storageKey][targetUrl], record);
    assert.equal(values[storageKey][oldKey], undefined);
    assert.equal(values['deduped-history-title-overrides-migration'], 6);
  } finally {
    delete globalThis.chrome;
  }
});

test('legacy pinned tab URLs migrate to one stable page key', () => {
  assert.deepEqual(
    [...normalizePinnedPageKeys([
      'https://cloud-ttp-us.bytedance.net/tae/mcp_server/abc12345/tools',
      'https://cloud-ttp-us.bytedance.net/tae/mcp_server/abc12345/inspector'
    ])],
    ['https://cloud-ttp-us.bytedance.net/tae/mcp_server/abc12345']
  );
});

test('captured title records normalize valid titles and discard malformed entries', () => {
  assert.deepEqual(
    [...normalizeCapturedPageMap({
      'https://example.com/a': { title: '  Final   title  ', updatedAt: 200 },
      'https://example.com/b': { title: '', updatedAt: 100 },
      '': { title: 'Missing URL', updatedAt: 300 }
    })],
    [['https://example.com/a', { title: 'Final title' }]]
  );
});

test('captured title records strip invisible Unicode format controls', () => {
  assert.deepEqual(
    [...normalizeCapturedPageMap({
      'https://example.com/a': {
        title: '\u2064\u200bAgent Node Replay 使用指南 - 飞书云文档',
        updatedAt: 200
      }
    })],
    [['https://example.com/a', { title: 'Agent Node Replay 使用指南 - 飞书云文档' }]]
  );
});

test('captured page records preserve versioned redirect targets without exposing the storage marker', () => {
  assert.deepEqual(
    [...normalizeCapturedPageMap({
      'https://cloud.example.com/legacy': {
        title: 'Release',
        resolvedUrl: 'https://cloud.example.com/final',
        resolutionVersion: 1,
        updatedAt: 200
      }
    })],
    [['https://cloud.example.com/legacy', {
      title: 'Release',
      resolvedUrl: 'https://cloud.example.com/final'
    }]]
  );
});

test('unversioned captured redirects lose their relationship but retain their titles', () => {
  assert.deepEqual([...normalizeCapturedPageMap({
    'https://example.com/old-alias': {
      title: '保留捕获的标题', resolvedUrl: 'https://example.com/wrong-target', updatedAt: 100
    }
  })], [['https://example.com/old-alias', { title: '保留捕获的标题' }]]);
});

test('a newly verified redirect replaces an old unversioned relationship even with an unchanged title', async () => {
  const alias = 'https://example.com/alias';
  const finalUrl = 'https://example.com/final';
  const values = {
    [CAPTURED_PAGE_TITLES_STORAGE_KEY]: {
      [alias]: { title: '标题', resolvedUrl: finalUrl, updatedAt: 100 }
    }
  };
  let writes = 0;
  globalThis.chrome = createStorageChrome(values, {}, { onSet() { writes += 1; } });
  try {
    await saveCapturedPageTitles([{ key: alias, title: '标题', resolvedUrl: finalUrl, updatedAt: 200 }]);
    assert.deepEqual(values[CAPTURED_PAGE_TITLES_STORAGE_KEY][alias], {
      title: '标题', resolvedUrl: finalUrl, resolutionVersion: 1, updatedAt: 200
    });
    assert.deepEqual([...normalizeCapturedPageMap(values[CAPTURED_PAGE_TITLES_STORAGE_KEY])], [
      [alias, { title: '标题', resolvedUrl: finalUrl }]
    ]);
    await saveCapturedPageTitles([{ key: alias, title: '标题', resolvedUrl: finalUrl, updatedAt: 300 }]);
    assert.equal(writes, 1);
    assert.equal(values[CAPTURED_PAGE_TITLES_STORAGE_KEY][alias].updatedAt, 200);
  } finally {
    delete globalThis.chrome;
  }
});

test('batch title capture skips unchanged records and persists changed titles', async () => {
  const url = 'https://example.com/doc/abc12345';
  const values = { [CAPTURED_PAGE_TITLES_STORAGE_KEY]: {
    [url]: {
      title: 'Final title',
      updatedAt: 100
    }
  } };
  let writes = 0;
  globalThis.chrome = createStorageChrome(values, {}, {
    onSet() { writes += 1; }
  });
  try {
    await saveCapturedPageTitles([{ key: url, title: 'Final title', updatedAt: 200 }]);
    assert.equal(writes, 0);
    assert.equal(values[CAPTURED_PAGE_TITLES_STORAGE_KEY][url].updatedAt, 100);
    await saveCapturedPageTitles([{ key: url, title: 'Renamed title', updatedAt: 200 }]);
    assert.equal(writes, 1);
    assert.deepEqual(values[CAPTURED_PAGE_TITLES_STORAGE_KEY][url], {
      title: 'Renamed title', updatedAt: 200
    });
  } finally {
    delete globalThis.chrome;
  }
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
      [firstAlias]: { title: 'Latest title', resolvedUrl: finalUrl, resolutionVersion: 1, updatedAt: 200 },
      [finalUrl]: { title: 'Final title', resolvedUrl: finalUrl, resolutionVersion: 1, updatedAt: 100 },
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

    const renameSave = saveTitleOverride('https://cloud-ttp-us.bytedance.net/tae/mcp_server/abc12345', 'Renamed', {
      targetUrl: 'https://cloud-ttp-us.bytedance.net/tae/mcp_server/abc12345',
      updatedAt: 200
    });
    await Promise.race([
      titleOverrideWritten,
      new Promise((_, reject) => setTimeout(() => reject(new Error('rename save was blocked')), 500))
    ]);
    await renameSave;

    assert.equal(values['deduped-history-title-overrides']['https://cloud-ttp-us.bytedance.net/tae/mcp_server/abc12345'].title, 'Renamed');
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
      saveTitleOverride('https://cloud-ttp-us.bytedance.net/tae/mcp_server/abc12345', 'Docs A', {
        targetUrl: 'https://cloud-ttp-us.bytedance.net/tae/mcp_server/abc12345/tools',
        updatedAt: 100
      }),
      saveTitleOverride('https://cloud-ttp-us.bytedance.net/tae/mcp_server/xyz98765', 'Docs B', {
        targetUrl: 'https://cloud-ttp-us.bytedance.net/tae/mcp_server/xyz98765/tools',
        updatedAt: 100
      })
    ]);
    await saveTitleOverride('https://cloud-ttp-us.bytedance.net/tae/mcp_server/abc12345', 'Docs A latest', {
      targetUrl: 'https://cloud-ttp-us.bytedance.net/tae/mcp_server/abc12345/inspector',
      updatedAt: 200
    });
    await saveTitleOverride('https://cloud-ttp-us.bytedance.net/tae/mcp_server/abc12345', 'Stale request', {
      targetUrl: 'https://cloud-ttp-us.bytedance.net/tae/mcp_server/abc12345/overview',
      updatedAt: 150
    });

    const overrides = await loadTitleOverrides();
    assert.equal(overrides.size, 2);
    assert.deepEqual(overrides.get('https://cloud-ttp-us.bytedance.net/tae/mcp_server/abc12345'), {
      title: 'Docs A latest',
      targetUrl: 'https://cloud-ttp-us.bytedance.net/tae/mcp_server/abc12345/inspector',
      updatedAt: 200
    });
    assert.equal(overrides.get('https://cloud-ttp-us.bytedance.net/tae/mcp_server/xyz98765').title, 'Docs B');
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
