import assert from 'node:assert/strict';
import test from 'node:test';

import {
  appendTimeExemptRenamedItems,
  DEFAULT_HISTORY_PAGE_SIZE,
  searchChromeHistory
} from '../src/history-data.js';

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
