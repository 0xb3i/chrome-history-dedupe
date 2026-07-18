import assert from 'node:assert/strict';
import test from 'node:test';

import {
  loadTitleOverrides,
  normalizeCapturedPageMap,
  normalizeCapturedTitleMap,
  normalizeLastSearchState,
  normalizePageTitleOverrideMap,
  normalizePinnedPageKeys,
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

test('loading version 2 overrides persists the query-level rename migration', async () => {
  const storageKey = 'deduped-history-title-overrides';
  const migrationKey = 'deduped-history-title-overrides-migration';
  const baseUrl = 'https://dataleap-va.tiktok-row.net/dorado/instance';
  const firstUrl = `${baseUrl}?_instanceD_=first`;
  const latestUrl = `${baseUrl}?searchType=content&keyword=109477584`;
  const values = {
    [migrationKey]: 2,
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
    assert.equal(values[migrationKey], 3);
    assert.deepEqual(Object.keys(values[storageKey]), [baseUrl]);
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

function createStorageChrome(values) {
  return {
    runtime: {},
    storage: {
      local: {
        get(key, callback) {
          setTimeout(() => callback({ [key]: values[key] }), 0);
        },
        set(nextValues, callback) {
          setTimeout(() => {
            Object.assign(values, structuredClone(nextValues));
            callback();
          }, 0);
        }
      }
    }
  };
}
