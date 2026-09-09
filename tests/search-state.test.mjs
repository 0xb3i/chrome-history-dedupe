import assert from 'node:assert/strict';
import test from 'node:test';

import { buildHistoryIndex } from '../src/history-index/derive.js';
import { createSearchState } from '../src/search-state.js';

const NOW = Date.UTC(2026, 8, 8, 12);
const DAY = 24 * 60 * 60 * 1000;
const rawItems = [
  { url: 'https://example.com/alpha', title: 'Alpha handbook', lastVisitTime: NOW - DAY / 2, visitCount: 4 },
  { url: 'https://example.com/beta', title: 'Beta handbook', lastVisitTime: NOW - DAY / 2, visitCount: 2 }
];

test('the latest submitted search owns its query and slow initial result', async () => {
  const first = deferred();
  const second = deferred();
  const pages = await buildPages(rawItems);
  const changes = [];
  const reads = [first, second];
  const state = createSearchState({
    loadIndex: () => reads.shift().promise,
    ensureIndex: async () => {}, onChange: (value) => changes.push(value)
  });
  const initial = state.search('Alpha');
  const submitted = state.search('Beta');
  second.resolve({ revision: 2, pageItems: pages });
  await submitted;
  first.resolve({ revision: 1, pageItems: pages });
  await initial;
  assert.equal(state.snapshot.query, 'Beta');
  assert.equal(state.snapshot.revision, 2);
  assert.deepEqual(state.snapshot.matchedItems.map((item) => item.title), ['Beta handbook']);
  assert.equal(changes.length, 1);
});

test('a slow initial load cannot roll back an index already supplied by a newer refresh', async () => {
  const first = deferred();
  const refreshed = deferred();
  const pages = await buildPages(rawItems);
  const reads = [first, refreshed];
  const changes = [];
  const state = createSearchState({
    loadIndex: () => reads.shift().promise,
    ensureIndex: async () => {}, onChange: (value) => changes.push(value)
  });
  const initial = state.search('Alpha');
  const refresh = state.refresh(2);
  refreshed.resolve({ revision: 2, pageItems: pages });
  await refresh;
  first.resolve({ revision: 1, pageItems: pages });
  await initial;
  assert.equal(state.snapshot.revision, 2);
  assert.equal(changes.some((snapshot) => snapshot.revision === 1), false);
});

test('an in-flight refresh projects the higher revision through the latest submitted query', async () => {
  const slowRefresh = deferred();
  const pages = await buildPages(rawItems);
  let readCount = 0;
  const state = createSearchState({
    loadIndex: () => ++readCount === 1 ? { revision: 1, pageItems: pages } : slowRefresh.promise,
    ensureIndex: async () => {}, onChange: () => {}
  });
  await state.search('Alpha');
  const refresh = state.refresh(2);
  await state.search('Beta');
  slowRefresh.resolve({ revision: 2, pageItems: pages });
  await refresh;
  assert.equal(state.snapshot.revision, 2);
  assert.deepEqual(state.snapshot.matchedItems.map((item) => item.title), ['Beta handbook']);
  assert.equal(state.snapshot.query, 'Beta');
});

test('out-of-order background refreshes cannot replace a higher revision', async () => {
  const older = deferred();
  const newer = deferred();
  const pages = await buildPages(rawItems);
  const reads = [{ revision: 1, pageItems: pages }, older.promise, newer.promise];
  const state = createSearchState({
    loadIndex: () => reads.shift(), ensureIndex: async () => {}, onChange: () => {}
  });
  await state.search('');
  const oldRefresh = state.refresh(2);
  const newRefresh = state.refresh(3);
  newer.resolve({ revision: 3, pageItems: pages });
  await newRefresh;
  const committed = state.snapshot;
  older.resolve({ revision: 2, pageItems: pages });
  await oldRefresh;
  assert.equal(state.snapshot, committed);
  assert.equal(state.snapshot.revision, 3);
});

test('renaming immediately rebuilds searchable titles and restoring removes the custom alias', async () => {
  const pages = await buildPages(rawItems);
  let reads = 0;
  const state = createSearchState({
    loadIndex: async () => { reads += 1; return { revision: 1, pageItems: pages }; },
    ensureIndex: async () => {}, onChange: () => {}
  });
  await state.search('Zebra workspace');
  assert.equal(state.snapshot.matchedItems.length, 0);
  const alpha = pages.find((item) => item.title === 'Alpha handbook');
  state.setTitleOverrides(new Map([[alpha.dedupeKey, {
    title: 'Zebra workspace', targetUrl: alpha.url, updatedAt: NOW
  }]]));
  assert.deepEqual(state.snapshot.matchedItems.map((item) => item.title), ['Zebra workspace']);
  state.setTitleOverrides(new Map());
  assert.equal(state.snapshot.matchedItems.length, 0);
  await state.search('Alpha handbook');
  assert.deepEqual(state.snapshot.matchedItems.map((item) => item.title), ['Alpha handbook']);
  assert.equal(reads, 1);
});

test('reopening overlays saved renames onto immutable facts and restoring selects the original representative', async () => {
  const historical = {
    url: 'https://cloud.bytedance.net/tae/mcp_server/abc12345/tools', title: 'Original handbook',
    lastVisitTime: NOW - 40 * DAY, visitCount: 100
  };
  const recent = {
    url: 'https://cloud.bytedance.net/tae/mcp_server/abc12345/inspector', title: 'Recent handbook',
    lastVisitTime: NOW - DAY / 2, visitCount: 1
  };
  const persisted = structuredClone(await buildPages([historical, recent]));
  const originalFacts = structuredClone(persisted);
  const overrides = new Map([[persisted[0].dedupeKey, {
    title: 'Saved custom alias', targetUrl: recent.url, updatedAt: NOW
  }]]);
  const openState = () => createSearchState({
    loadIndex: async () => ({ revision: 1, pageItems: persisted }),
    ensureIndex: async () => {}, onChange: () => {}
  });
  const first = openState();
  await first.search('Saved custom alias');
  assert.equal(first.snapshot.matchedItems.length, 0);
  first.setTitleOverrides(overrides);
  assert.equal(first.snapshot.matchedItems[0].url, recent.url);

  const reopened = openState();
  reopened.setTitleOverrides(overrides);
  await reopened.search('Saved custom alias');
  assert.equal(reopened.snapshot.matchedItems[0].title, 'Saved custom alias');
  assert.equal(reopened.snapshot.matchedItems[0].url, recent.url);
  reopened.setTitleOverrides(new Map());
  assert.equal(reopened.snapshot.matchedItems.length, 0);
  await reopened.search(historical.title);
  const restored = reopened.snapshot.matchedItems[0];
  assert.equal(restored.url, historical.url);
  assert.equal(restored.title, historical.title);
  assert.equal(restored.isTitleRenamed, false);
  assert.equal('renameUpdatedAt' in restored, false);
  assert.deepEqual(persisted, originalFacts);
});

test('search includes old resources and preserves each resource representative and lifetime totals', async () => {
  const historical = {
    url: 'https://cloud.bytedance.net/tae/mcp_server/abc12345/tools', title: 'Original handbook',
    lastVisitTime: NOW - 40 * DAY, visitCount: 100
  };
  const recent = {
    url: 'https://cloud.bytedance.net/tae/mcp_server/abc12345/inspector', title: 'Recent handbook',
    lastVisitTime: NOW - DAY / 2, visitCount: 1
  };
  const oldOnly = {
    url: 'https://example.com/old', title: 'Old handbook',
    lastVisitTime: NOW - 40 * DAY, visitCount: 5
  };
  const indexes = await buildHistoryIndex([historical, recent, oldOnly], {
    capturedPageTitles: capturedTitles([historical, recent, oldOnly]),
    yieldControl: async () => {}
  });
  const all = indexes.get('all').find((item) => item.url === historical.url);
  const state = createSearchState({
    loadIndex: async () => ({ revision: 1, pageItems: indexes.get('all') }),
    ensureIndex: async () => {}, onChange: () => {}
  });
  await state.search('');
  const matches = state.snapshot.matchedItems;
  assert.equal(matches.length, 2);
  const resource = matches.find((item) => item.url === historical.url);
  assert.deepEqual(resource, all);
  assert.equal(resource.totalVisitCount, 101);
  assert.equal(resource.dedupeCount, 2);
  assert.equal(resource.title, historical.title);
  assert.ok(matches.some((item) => item.url === oldOnly.url));
  await state.search('Old handbook');
  assert.deepEqual(state.snapshot.matchedItems.map((item) => item.url), [oldOnly.url]);
  assert.equal(indexes.get('all').length, 2);
});

test('renaming and restoring old resources keep them visible without reviving deleted resources', async () => {
  const old = { ...rawItems[0], lastVisitTime: NOW - 40 * DAY };
  const pages = await buildPages([old, rawItems[1]]);
  const state = createSearchState({
    loadIndex: async () => ({ revision: 1, pageItems: pages }),
    ensureIndex: async () => {}, onChange: () => {}
  });
  await state.search('');
  assert.equal(state.snapshot.matchedItems.length, 2);
  assert.ok(state.snapshot.matchedItems.some((item) => item.url === old.url));
  const oldPage = pages.find((item) => item.url === old.url);
  state.setTitleOverrides(new Map([
    [oldPage.dedupeKey, { title: 'Long-term handbook', targetUrl: old.url, updatedAt: NOW }],
    ['https://example.com/missing', { title: 'Deleted resource', targetUrl: 'https://example.com/missing', updatedAt: NOW }]
  ]));
  assert.equal(state.snapshot.pageItemCount, 2);
  assert.equal(state.snapshot.matchedItems.some((item) => item.title === 'Long-term handbook'), true);
  assert.equal(state.snapshot.matchedItems.some((item) => item.title === 'Deleted resource'), false);
  state.setTitleOverrides(new Map());
  assert.equal(state.snapshot.pageItemCount, 2);
  assert.ok(state.snapshot.matchedItems.some((item) => item.url === old.url && item.title === old.title));
});

test('each time filter includes its boundary, excludes older resources, and reuses the full index', async () => {
  const ages = [0, 1, 7, 30, 90, 365];
  const pages = await buildPages(ages.flatMap((age) => [
    { url: `https://example.com/age-${age}`, title: 'Handbook', lastVisitTime: NOW - age * DAY },
    { url: `https://example.com/before-${age}`, title: 'Handbook', lastVisitTime: NOW - age * DAY - 1 }
  ]));
  let reads = 0;
  const state = createSearchState({
    loadIndex: async () => { reads += 1; return { revision: 1, pageItems: pages }; },
    ensureIndex: async () => {}, onChange: () => {}, now: () => NOW
  });
  for (const [range, days] of [['day', 1], ['week', 7], ['month', 30], ['quarter', 90], ['all', Infinity]]) {
    await state.search('Handbook', range);
    assert.equal(state.snapshot.range, range);
    assert.deepEqual(state.snapshot.matchedItems.map((item) => item.url).sort(),
      pages.filter((item) => item.lastVisitTime >= NOW - days * DAY).map((item) => item.url).sort());
  }
  assert.equal(reads, 1);
});

test('time filtering preserves the full resource representative and lifetime visit totals', async () => {
  const historical = {
    url: 'https://cloud.bytedance.net/tae/mcp_server/abc12345/tools', title: 'Original handbook',
    lastVisitTime: NOW - 40 * DAY, visitCount: 100
  };
  const recent = {
    url: 'https://cloud.bytedance.net/tae/mcp_server/abc12345/inspector', title: 'Recent handbook',
    lastVisitTime: NOW - DAY / 2, visitCount: 1
  };
  const pages = await buildPages([historical, recent]);
  const state = createSearchState({
    loadIndex: () => ({ revision: 1, pageItems: pages }),
    ensureIndex: async () => {}, onChange: () => {}, now: () => NOW
  });
  await state.search('Recent', 'day');
  assert.equal(state.snapshot.matchedItems.length, 1);
  assert.equal(state.snapshot.matchedItems[0].url, historical.url);
  assert.equal(state.snapshot.matchedItems[0].totalVisitCount, 101);
});

test('renamed historical resources bypass the time filter until restored or deleted', async () => {
  const old = { ...rawItems[0], lastVisitTime: NOW - 365 * DAY };
  let pages = await buildPages([old]);
  const state = createSearchState({
    loadIndex: () => ({ revision: pages.length ? 1 : 2, pageItems: pages }),
    ensureIndex: async () => {}, onChange: () => {}, now: () => NOW
  });
  await state.search('', 'week');
  assert.equal(state.snapshot.matchedItems.length, 0);
  const overrides = new Map([[pages[0].dedupeKey, {
    title: 'Saved handbook', targetUrl: old.url, updatedAt: NOW
  }]]);
  state.setTitleOverrides(overrides);
  assert.equal(state.snapshot.matchedItems[0].title, 'Saved handbook');
  state.setTitleOverrides(new Map());
  assert.equal(state.snapshot.matchedItems.length, 0);
  state.setTitleOverrides(overrides);
  pages = [];
  await state.refresh(2);
  assert.equal(state.snapshot.matchedItems.length, 0);
});

test('a slow refresh respects the latest submitted time filter', async () => {
  const refreshIndex = deferred();
  const pages = await buildPages([{ ...rawItems[0], lastVisitTime: NOW - 20 * DAY }]);
  let reads = 0;
  const state = createSearchState({
    loadIndex: () => ++reads === 1 ? { revision: 1, pageItems: pages } : refreshIndex.promise,
    ensureIndex: async () => {}, onChange: () => {}, now: () => NOW
  });
  await state.search('Alpha', 'all');
  const refresh = state.refresh(2);
  await state.search('Alpha', 'week');
  refreshIndex.resolve({ revision: 2, pageItems: pages });
  await refresh;
  assert.equal(state.snapshot.range, 'week');
  assert.equal(state.snapshot.matchedItems.length, 0);
});

async function buildPages(items) {
  const indexes = await buildHistoryIndex(items, {
    capturedPageTitles: capturedTitles(items), yieldControl: async () => {}
  });
  return indexes.get('all');
}

function capturedTitles(items) {
  return new Map(items.map((item) => [item.url, { title: item.title }]));
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
