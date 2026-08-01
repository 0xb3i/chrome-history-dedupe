import assert from 'node:assert/strict';
import test from 'node:test';

import {
  appendTimeExemptRenamedItems,
  createHistorySnapshotLoader,
  DEFAULT_HISTORY_PAGE_SIZE,
  DEFAULT_HISTORY_SNAPSHOT_CACHE_MS,
  getTimeExemptRenameLookupTexts,
  searchChromeHistory
} from '../src/history-data.js';

test('renamed-page lookups group missing pages by hostname and skip pages in the window', () => {
  const result = getTimeExemptRenameLookupTexts(
    [historyItem('https://present.example.com/docs/abc12345', 900)],
    new Map([
      ['https://present.example.com/docs/abc12345', {
        targetUrl: 'https://present.example.com/docs/abc12345?tab=details',
        title: '已存在'
      }],
      ['https://missing.example.com/docs/first123', {
        targetUrl: 'https://missing.example.com/docs/first123?tab=details',
        title: '缺失一'
      }],
      ['https://missing.example.com/docs/second456', {
        targetUrl: 'https://missing.example.com/docs/second456?tab=details',
        title: '缺失二'
      }]
    ])
  );

  assert.deepEqual(result, ['missing.example.com']);
});

test('renamed pages outside the selected time window are restored from real visits', async () => {
  const oldUrl = 'https://example.com/docs/old';
  const oldItem = historyItem(oldUrl, 300, 3);
  const result = await appendTimeExemptRenamedItems(
    [historyItem('https://example.com/recent', 900, 2)],
    new Map([[
      oldUrl,
      { title: '长期文档', targetUrl: oldUrl, updatedAt: 500 }
    ]]),
    { allHistoryItems: [oldItem] }
  );

  assert.equal(result.length, 2);
  assert.equal(result[1], oldItem);
});

test('renamed pages already represented in the window are not loaded or duplicated', async () => {
  const windowItem = historyItem(
    'https://example.com/report?activeTab=summary&timestamp=100',
    900,
    2
  );
  const windowItems = [windowItem];
  const result = await appendTimeExemptRenamedItems(
    windowItems,
    new Map([[
      'https://example.com/report',
      {
        title: '报告',
        targetUrl: 'https://example.com/report?activeTab=details&timestamp=200',
        updatedAt: 500
      }
    ]]),
    { allHistoryItems: [windowItem] }
  );

  assert.equal(result, windowItems);
});

test('renamed pages are restored through another URL alias with the same page identity', async () => {
  const storedTarget = 'https://example.com/report/abc12345/overview';
  const existingAlias = 'https://example.com/report/abc12345/settings?tab=members';
  const aliasItem = historyItem(existingAlias, 300, 4);
  const result = await appendTimeExemptRenamedItems(
    [],
    new Map([[
      'https://example.com/report/abc12345',
      { title: '长期报告', targetUrl: storedTarget, updatedAt: 500 }
    ]]),
    { allHistoryItems: [aliasItem] }
  );

  assert.deepEqual(result.map((item) => item.url), [existingAlias]);
  assert.equal(result[0], aliasItem);
});

test('renamed pages deleted from all-time history are not restored', async () => {
  const deletedUrl = 'https://example.com/deleted';
  const result = await appendTimeExemptRenamedItems(
    [],
    new Map([[deletedUrl, { title: '已删除', targetUrl: deletedUrl, updatedAt: 100 }]]),
    { allHistoryItems: [] }
  );

  assert.deepEqual(result, []);
});

test('snapshot loader shares in-flight work, caches ranges, and supports invalidation', async () => {
  const resolvers = [];
  let searchCalls = 0;
  const loader = createHistorySnapshotLoader({
    now: () => 500,
    searchHistory(query) {
      searchCalls += 1;
      assert.deepEqual(query, { text: '', startTime: 100, endTime: 500 });
      return new Promise((resolve) => resolvers.push(resolve));
    }
  });

  const first = loader.load('week', 100);
  const second = loader.load('week', 100);
  assert.equal(first, second);
  await Promise.resolve();
  assert.equal(searchCalls, 1);

  resolvers.shift()([historyItem('https://example.com/a', 300)]);
  await Promise.all([first, second]);

  const third = loader.load('week', 100);
  assert.equal(DEFAULT_HISTORY_SNAPSHOT_CACHE_MS, 5 * 60 * 1000);
  assert.equal(searchCalls, 1);
  assert.equal((await third)[0].url, 'https://example.com/a');

  loader.invalidate('week');
  const fourth = loader.load('week', 100);
  await Promise.resolve();
  assert.equal(searchCalls, 2);
  resolvers.shift()([]);
  await fourth;
});

test('snapshot invalidation prevents an in-flight history request from restoring stale data', async () => {
  const resolvers = [];
  let searchCalls = 0;
  const loader = createHistorySnapshotLoader({
    now: () => 500,
    searchHistory() {
      searchCalls += 1;
      return new Promise((resolve) => resolvers.push(resolve));
    }
  });

  const staleLoad = loader.load('week', 100);
  await Promise.resolve();
  loader.invalidate();
  const freshLoad = loader.load('week', 100);
  await Promise.resolve();
  assert.equal(searchCalls, 2);
  resolvers.shift()([historyItem('https://example.com/stale', 200)]);
  resolvers.shift()([historyItem('https://example.com/fresh', 300)]);

  assert.deepEqual((await staleLoad).map((item) => item.url), ['https://example.com/fresh']);
  assert.deepEqual((await freshLoad).map((item) => item.url), ['https://example.com/fresh']);
  assert.deepEqual(
    (await loader.load('week', 100)).map((item) => item.url),
    ['https://example.com/fresh']
  );
  assert.equal(searchCalls, 2);
});

test('history search paginates with an endTime cursor and deduplicates URLs', async () => {
  const queries = [];
  const pages = [
    [
      historyItem('https://example.com/a', 1000),
      historyItem('https://example.com/b', 900),
      historyItem('https://example.com/c', 800)
    ],
    [
      historyItem('https://example.com/b', 700),
      historyItem('https://example.com/d', 700),
      historyItem('https://example.com/e', 600)
    ],
    [historyItem('https://example.com/f', 500)]
  ];
  const historyApi = {
    search(query, callback) {
      queries.push(query);
      callback(pages.shift());
    }
  };

  const result = await searchChromeHistory(
    { text: 'docs', startTime: 100, endTime: 1200 },
    { historyApi, runtimeApi: {}, maxResults: 3 }
  );

  assert.deepEqual(
    result.map((item) => item.url),
    [
      'https://example.com/a',
      'https://example.com/b',
      'https://example.com/c',
      'https://example.com/d',
      'https://example.com/e',
      'https://example.com/f'
    ]
  );
  assert.equal(queries[0].endTime, 1200);
  assert.equal(queries[1].endTime, 800);
  assert.equal(queries[2].endTime, 600);
  assert.equal(queries.every((query) => query.maxResults === 3), true);
  assert.equal(result[1].lastVisitTime, 900);
});

test('history search treats query maxResults as page size and defaults to 10000', async () => {
  const explicitQueries = [];
  const defaultQueries = [];
  const historyApi = {
    search(query, callback) {
      explicitQueries.push(query);
      callback([]);
    }
  };

  await searchChromeHistory({ text: '', maxResults: 7 }, { historyApi, runtimeApi: {} });
  await searchChromeHistory(
    { text: '' },
    {
      historyApi: {
        search(query, callback) {
          defaultQueries.push(query);
          callback([]);
        }
      },
      runtimeApi: {}
    }
  );

  assert.equal(DEFAULT_HISTORY_PAGE_SIZE, 10000);
  assert.equal(explicitQueries[0].maxResults, 7);
  assert.equal(defaultQueries[0].maxResults, 10000);
});

test('history search verifies an inclusive startTime boundary without looping', async () => {
  let searchCalls = 0;
  const items = [
    historyItem('https://example.com/a', 200),
    historyItem('https://example.com/b', 100)
  ];
  const result = await searchChromeHistory(
    { text: '', startTime: 100, endTime: 500 },
    {
      maxResults: 2,
      runtimeApi: {},
      historyApi: {
        search(query, callback) {
          searchCalls += 1;
          callback(items.filter((item) => item.lastVisitTime <= query.endTime));
        }
      }
    }
  );

  assert.equal(searchCalls, 2);
  assert.equal(result.length, 2);
});

test('history search returns immediately for an inverted time range', async () => {
  let searchCalls = 0;
  const result = await searchChromeHistory(
    { text: '', startTime: 500, endTime: 100 },
    {
      historyApi: {
        search() {
          searchCalls += 1;
        }
      }
    }
  );

  assert.deepEqual(result, []);
  assert.equal(searchCalls, 0);
});

test('history search expands a full same-timestamp boundary before stopping', async () => {
  let searchCalls = 0;
  const repeatedPage = [
    historyItem('https://example.com/a', 500),
    historyItem('https://example.com/b', 500)
  ];
  const result = await searchChromeHistory(
    { text: '', startTime: 1, endTime: 1000 },
    {
      maxResults: 2,
      runtimeApi: {},
      historyApi: {
        search(_query, callback) {
          searchCalls += 1;
          callback(repeatedPage);
        }
      }
    }
  );

  assert.equal(searchCalls, 3);
  assert.equal(result.length, 2);
});

test('history search stops safely when a full page has no usable visit time', async () => {
  let searchCalls = 0;
  const result = await searchChromeHistory(
    { text: '' },
    {
      maxResults: 2,
      runtimeApi: {},
      historyApi: {
        search(_query, callback) {
          searchCalls += 1;
          callback([
            { url: 'https://example.com/a' },
            { url: 'https://example.com/b', lastVisitTime: Number.NaN }
          ]);
        }
      }
    }
  );

  assert.equal(searchCalls, 1);
  assert.equal(result.length, 2);
});

test('history pagination does not skip fractional timestamps below a page boundary', async () => {
  const allItems = [
    historyItem('https://example.com/a', 1000),
    historyItem('https://example.com/b', 900),
    historyItem('https://example.com/c', 800.9),
    historyItem('https://example.com/d', 800.5),
    historyItem('https://example.com/e', 700)
  ];
  const result = await searchChromeHistory(
    { text: '', startTime: 1, endTime: 1200 },
    {
      maxResults: 3,
      runtimeApi: {},
      historyApi: {
        search(query, callback) {
          callback(
            allItems
              .filter((item) => item.lastVisitTime <= query.endTime)
              .slice(0, query.maxResults)
          );
        }
      }
    }
  );

  assert.deepEqual(result.map((item) => item.url), allItems.map((item) => item.url));
});

test('history search surfaces chrome.runtime.lastError', async () => {
  const runtimeApi = {};
  const historyApi = {
    search(_query, callback) {
      runtimeApi.lastError = { message: 'History database unavailable' };
      callback([]);
      delete runtimeApi.lastError;
    }
  };

  await assert.rejects(
    searchChromeHistory({ text: '' }, { historyApi, runtimeApi }),
    /History database unavailable/
  );
});

function historyItem(url, lastVisitTime, visitCount = 1) {
  return {
    url,
    title: url,
    lastVisitTime,
    visitCount
  };
}
