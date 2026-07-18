import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyVisitCountsForWindow,
  createHistorySnapshotLoader,
  DEFAULT_HISTORY_PAGE_SIZE,
  DEFAULT_VISIT_COUNT_CONCURRENCY,
  searchChromeHistory
} from '../src/history-data.js';

test('snapshot loader shares one in-flight history request per range and retries after completion', async () => {
  const resolvers = [];
  let searchCalls = 0;
  let countCalls = 0;
  const loader = createHistorySnapshotLoader({
    now: () => 500,
    searchHistory(query) {
      searchCalls += 1;
      assert.deepEqual(query, { text: '', startTime: 100, endTime: 500 });
      return new Promise((resolve) => resolvers.push(resolve));
    },
    applyVisitCounts(items) {
      countCalls += 1;
      return items;
    }
  });

  const first = loader.load('week', 100);
  const second = loader.load('week', 100);
  assert.equal(first, second);
  await Promise.resolve();
  assert.equal(searchCalls, 1);

  resolvers.shift()([historyItem('https://example.com/a', 300)]);
  await Promise.all([first, second]);
  assert.equal(countCalls, 1);

  const third = loader.load('week', 100);
  await Promise.resolve();
  assert.equal(searchCalls, 2);
  resolvers.shift()([]);
  await third;
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

test('all-time visit counts are retained without calling getVisits', async () => {
  const items = [historyItem('https://example.com/a', 100, 17)];
  let getVisitsCalls = 0;
  const result = await applyVisitCountsForWindow(items, 0, 1000, {
    historyApi: {
      getVisits() {
        getVisitsCalls += 1;
      }
    }
  });

  assert.equal(result, items);
  assert.equal(result[0].visitCount, 17);
  assert.equal(getVisitsCalls, 0);
});

test('visit counts use inclusive window boundaries and preserve result order', async () => {
  const items = [
    historyItem('https://example.com/a', 500, 10),
    historyItem('https://example.com/b', 400, 20),
    historyItem('https://example.com/c', 300, 30)
  ];
  const visitsByUrl = new Map([
    [items[0].url, [{ visitTime: 99 }, { visitTime: 100 }, { visitTime: 200 }, { visitTime: 201 }]],
    [items[1].url, [{ visitTime: 150 }]],
    [items[2].url, []]
  ]);
  let activeRequests = 0;
  let peakRequests = 0;
  const historyApi = {
    getVisits({ url }, callback) {
      activeRequests += 1;
      peakRequests = Math.max(peakRequests, activeRequests);
      setTimeout(() => {
        activeRequests -= 1;
        callback(visitsByUrl.get(url));
      }, url.endsWith('/a') ? 10 : 1);
    }
  };

  const result = await applyVisitCountsForWindow(items, 100, 200, {
    historyApi,
    runtimeApi: {},
    concurrency: 2
  });

  assert.equal(DEFAULT_VISIT_COUNT_CONCURRENCY, 32);
  assert.equal(peakRequests, 2);
  assert.deepEqual(result.map((item) => item.url), items.map((item) => item.url));
  assert.deepEqual(result.map((item) => item.visitCount), [2, 1, 0]);
});

test('a getVisits failure marks only the affected count unreliable without mixing all-time totals', async () => {
  const runtimeApi = {};
  const goodItem = historyItem('https://example.com/good', 500, 10);
  const failedItem = historyItem('https://example.com/failed', 400, 20);
  const missingUrlItem = { title: 'Missing URL', visitCount: 30 };
  const historyApi = {
    getVisits({ url }, callback) {
      if (url === failedItem.url) {
        runtimeApi.lastError = { message: 'Could not read this URL' };
        callback([]);
        delete runtimeApi.lastError;
        return;
      }

      callback([{ visitTime: 150 }]);
    }
  };

  const result = await applyVisitCountsForWindow(
    [goodItem, failedItem, missingUrlItem],
    100,
    200,
    { historyApi, runtimeApi }
  );

  assert.notEqual(result[0], goodItem);
  assert.equal(result[0].visitCount, 1);
  assert.notEqual(result[1], failedItem);
  assert.equal(result[1].visitCount, 0);
  assert.equal(result[1].allTimeVisitCount, 20);
  assert.equal(result[1].visitCountReliable, false);
  assert.equal(result[2], missingUrlItem);
});

test('duplicate URLs share one getVisits request', async () => {
  const items = [
    historyItem('https://example.com/shared', 500, 10),
    historyItem('https://example.com/shared', 400, 20)
  ];
  let getVisitsCalls = 0;
  const result = await applyVisitCountsForWindow(items, 100, 200, {
    runtimeApi: {},
    historyApi: {
      getVisits(_details, callback) {
        getVisitsCalls += 1;
        setTimeout(() => callback([{ visitTime: 150 }]), 1);
      }
    }
  });

  assert.equal(getVisitsCalls, 1);
  assert.deepEqual(result.map((item) => item.visitCount), [1, 1]);
});

test('a synchronous getVisits error marks the count unreliable', async () => {
  const item = historyItem('https://example.com/a', 500, 10);
  const result = await applyVisitCountsForWindow([item], 100, 200, {
    historyApi: {
      getVisits() {
        throw new Error('Unexpected API failure');
      }
    }
  });

  assert.equal(result[0].visitCount, 0);
  assert.equal(result[0].allTimeVisitCount, 10);
  assert.equal(result[0].visitCountReliable, false);
});

function historyItem(url, lastVisitTime, visitCount = 1) {
  return {
    url,
    title: url,
    lastVisitTime,
    visitCount
  };
}
