import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildHistoryIndex,
  HISTORY_INDEX_ALGORITHM_VERSION
} from '../src/history-index/derive.js';
import { createHistoryIndexService } from '../src/history-index/service.js';

const NOW = Date.UTC(2026, 7, 1, 12);
const DAY = 24 * 60 * 60 * 1000;

test('one full facts index includes both recent and old resources', async () => {
  const recent = historyItem('https://example.com/recent', NOW - DAY, 2);
  const oldDocument = historyItem('https://example.com/docs/abc12345', NOW - 60 * DAY, 4);
  const oldPlain = historyItem('https://example.com/plain', NOW - 60 * DAY, 3);
  const indexes = await buildHistoryIndex([recent, oldDocument, oldPlain], {
    capturedPageTitles: new Map(),
    yieldControl: async () => {}
  });

  assert.deepEqual([...indexes.keys()], ['all']);
  assert.equal(indexes.get('all').length, 3);
  assert.ok(indexes.get('all').every((item) => !item.isTitleRenamed));
});

test('large index builds yield to shortcut tasks before completing', async () => {
  const items = Array.from({ length: 5000 }, (_, index) => historyItem(
    `https://example.com/docs/abc12345?utm_source=${index}`,
    NOW - index,
    1
  ));
  let buildCompleted = false;
  const build = buildHistoryIndex(items, {
    capturedPageTitles: new Map(),
    batchSize: 250
  }).finally(() => {
    buildCompleted = true;
  });

  const wasCompletedWhenShortcutTaskRan = await new Promise((resolve) => {
    setTimeout(() => resolve(buildCompleted), 0);
  });

  assert.equal(wasCompletedWhenShortcutTaskRan, false);
  const indexes = await build;
  assert.equal(indexes.get('all').length, 1);
  assert.equal(indexes.get('all')[0].dedupeCount, 5000);
});

test('cooperative index construction checkpoints within a large resource collection', async () => {
  const items = Array.from({ length: 1200 }, (_, index) => historyItem(
    `https://example.com/page/${index}`,
    NOW - index,
    1
  ));
  let yieldCount = 0;

  await buildHistoryIndex(items, {
    capturedPageTitles: new Map(),
    batchSize: 100,
    yieldControl: async () => {
      yieldCount += 1;
    }
  });

  assert.ok(yieldCount > 1);
});

test('ready persistent index never queries Chrome history', async () => {
  const store = createMemoryIndexStore([historyItem('https://example.com/ready', NOW)]);
  await seedReadyIndex(store);
  let searchCalls = 0;
  const service = createService(store, {
    searchHistory: async () => {
      searchCalls += 1;
      return [];
    },
    now: () => NOW
  });

  await service.ensureReady();
  assert.equal(searchCalls, 0);
  assert.equal((await store.loadRange('all')).pageItems.length, 1);
});

test('visited events replace raw URLs and rebuild without calling History API', async () => {
  const store = createMemoryIndexStore();
  let searchCalls = 0;
  const service = createService(store, {
    searchHistory: async () => {
      searchCalls += 1;
      return [];
    }
  });
  const url = 'https://example.com/repeated';

  await Promise.all([
    service.handleVisited(historyItem(url, NOW - 100, 1)),
    service.handleVisited(historyItem(url, NOW, 7))
  ]);

  assert.equal(searchCalls, 0);
  assert.equal((await store.loadRawSnapshot()).items.length, 1);
  assert.equal((await store.loadRange('all')).pageItems[0].totalVisitCount, 7);
});

test('history deletion atomically publishes an index without the removed URL', async () => {
  const removed = historyItem('https://example.com/removed', NOW, 2);
  const kept = historyItem('https://example.com/kept', NOW, 3);
  const store = createMemoryIndexStore([removed, kept]);
  await seedReadyIndex(store);
  const service = createService(store);

  await service.handleRemoved({ allHistory: false, urls: [removed.url] });

  assert.deepEqual(
    (await store.loadRange('all')).pageItems.map((item) => item.url),
    [kept.url]
  );
});

test('captured-title rebuild uses raw persistence and does not query Chrome history', async () => {
  const item = historyItem('https://example.com/docs/abc12345', NOW, 2);
  const store = createMemoryIndexStore([item]);
  await seedReadyIndex(store);
  let searchCalls = 0;
  let capturedPageTitles = new Map();
  const service = createService(store, {
    searchHistory: async () => {
      searchCalls += 1;
      return [];
    },
    loadCapturedPageTitles: async () => capturedPageTitles
  });
  capturedPageTitles = new Map([[
    item.url,
    { title: '大模型知识面试一本通' }
  ]]);

  await service.rebuildDerived({ immediate: true });

  assert.equal(searchCalls, 0);
  assert.equal((await store.loadRange('all')).pageItems[0].title, '大模型知识面试一本通');
  assert.equal((await store.loadRange('all')).pageItems[0].isTitleRenamed, false);
});

test('derived rebuilds triggered during an active build collapse into one latest trailing build', async () => {
  const item = historyItem('https://example.com/docs/abc12345', NOW, 2);
  const store = createMemoryIndexStore([item]);
  await seedReadyIndex(store);
  let releaseFirstBuild;
  let signalFirstBuildStarted;
  let loadCapturedCalls = 0;
  let capturedPageTitles = new Map([[
    item.url,
    { title: '首次捕获' }
  ]]);
  const firstBuildStarted = new Promise((resolve) => { signalFirstBuildStarted = resolve; });
  const firstBuildGate = new Promise((resolve) => { releaseFirstBuild = resolve; });
  const service = createService(store, {
    loadCapturedPageTitles: async () => {
      loadCapturedCalls += 1;
      const snapshot = capturedPageTitles;
      if (loadCapturedCalls === 1) {
        signalFirstBuildStarted();
        await firstBuildGate;
      }
      return snapshot;
    }
  });

  const firstBuild = service.rebuildDerived({ immediate: true });
  await firstBuildStarted;
  capturedPageTitles = new Map([[
    item.url,
    { title: '最新捕获' }
  ]]);
  const trailingRequests = Array.from(
    { length: 100 },
    () => service.rebuildDerived({ immediate: true })
  );
  releaseFirstBuild();
  await Promise.all([firstBuild, ...trailingRequests]);

  assert.equal(loadCapturedCalls, 2);
  assert.equal((await store.loadRange('all')).pageItems[0].title, '最新捕获');
});

test('background calibration keeps the committed generation readable until completion', async () => {
  const oldItem = historyItem('https://example.com/old', NOW, 1);
  const newItem = historyItem('https://example.com/new', NOW, 1);
  const store = createMemoryIndexStore([oldItem]);
  await seedReadyIndex(store);
  let resolveSearch;
  const service = createService(store, {
    searchHistory: () => new Promise((resolve) => { resolveSearch = resolve; })
  });

  const calibration = service.calibrate();
  await Promise.resolve();
  assert.deepEqual((await store.loadRange('all')).pageItems.map((item) => item.url), [oldItem.url]);
  resolveSearch([newItem]);
  await calibration;
  assert.deepEqual((await store.loadRange('all')).pageItems.map((item) => item.url), [newItem.url]);
});

test('events arriving during calibration are applied after the scanned generation', async () => {
  const scanned = historyItem('https://example.com/scanned', NOW - 100, 1);
  const visitedDuringScan = historyItem('https://example.com/during-scan', NOW, 2);
  const store = createMemoryIndexStore();
  let resolveSearch;
  const service = createService(store, {
    searchHistory: () => new Promise((resolve) => { resolveSearch = resolve; })
  });

  const calibration = service.calibrate();
  await Promise.resolve();
  const visit = service.handleVisited(visitedDuringScan);
  resolveSearch([scanned]);
  await Promise.all([calibration, visit]);

  assert.deepEqual(
    (await store.loadRange('all')).pageItems.map((item) => item.url).sort(),
    [scanned.url, visitedDuringScan.url].sort()
  );
});

test('failed generation commits leave the previous index readable', async () => {
  const oldItem = historyItem('https://example.com/old-generation', NOW, 1);
  const store = createMemoryIndexStore([oldItem]);
  await seedReadyIndex(store);
  const previous = await store.loadRange('all');
  const originalCommit = store.commitRangeIndexes;
  store.commitRangeIndexes = async () => {
    const error = new Error('quota exceeded');
    error.name = 'QuotaExceededError';
    throw error;
  };
  const service = createService(store);

  await assert.rejects(
    service.handleVisited(historyItem('https://example.com/new-generation', NOW, 2)),
    /quota exceeded/
  );

  assert.deepEqual(await store.loadRange('all'), previous);
  store.commitRangeIndexes = originalCommit;
});

function createService(store, options = {}) {
  return createHistoryIndexService({
    store,
    searchHistory: options.searchHistory ?? (async () => []),
    loadCapturedPageTitles: options.loadCapturedPageTitles ?? (async () => new Map()),
    now: options.now ?? (() => NOW),
    eventBatchMs: 0,
    yieldControl: async () => {}
  });
}

async function seedReadyIndex(store) {
  const { items, rawRevision } = await store.loadRawSnapshot();
  const indexes = await buildHistoryIndex(items, {
    capturedPageTitles: new Map(),
    yieldControl: async () => {}
  });
  await store.commitRangeIndexes(indexes, rawRevision, { builtAt: NOW });
}

function createMemoryIndexStore(initialItems = []) {
  const rawItems = new Map(initialItems.map((item) => [item.url, item]));
  const ranges = new Map();
  let state = {
    rawRevision: initialItems.length ? 1 : 0,
    indexedRawRevision: 0,
    committedRevision: 0,
    activeGeneration: '',
    algorithmVersion: 0,
    lastFullSyncAt: NOW,
    lastBuiltAt: 0
  };

  return {
    async getState() {
      return { ...state };
    },
    async loadRange(range) {
      const pageItems = ranges.get(range);
      return pageItems ? {
        revision: state.committedRevision,
        builtAt: state.lastBuiltAt,
        pageItems
      } : null;
    },
    async loadRawSnapshot() {
      return { rawRevision: state.rawRevision, items: [...rawItems.values()] };
    },
    async replaceRawItems(items, options = {}) {
      rawItems.clear();
      for (const item of items) rawItems.set(item.url, item);
      state.rawRevision += 1;
      state.lastFullSyncAt = options.fullSyncAt ?? state.lastFullSyncAt;
      return { ...state };
    },
    async applyRawMutation(mutation = {}) {
      if (mutation.clear) rawItems.clear();
      for (const url of mutation.deletes ?? []) rawItems.delete(url);
      for (const item of mutation.upserts ?? []) rawItems.set(item.url, item);
      state.rawRevision += 1;
      return { ...state };
    },
    async commitRangeIndexes(indexes, expectedRawRevision, options = {}) {
      if (state.rawRevision !== expectedRawRevision) return null;
      ranges.clear();
      for (const [range, items] of indexes) ranges.set(range, structuredClone(items));
      state = {
        ...state,
        activeGeneration: `generation-${state.committedRevision + 1}`,
        algorithmVersion: HISTORY_INDEX_ALGORITHM_VERSION,
        committedRevision: state.committedRevision + 1,
        indexedRawRevision: expectedRawRevision,
        lastBuiltAt: options.builtAt ?? NOW
      };
      return { generation: state.activeGeneration, revision: state.committedRevision };
    }
  };
}

function historyItem(url, lastVisitTime, visitCount = 1) {
  return { url, title: url, lastVisitTime, visitCount, typedCount: 0 };
}
