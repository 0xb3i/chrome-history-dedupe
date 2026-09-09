import { searchChromeHistory } from '../history-data.js';
import { loadCapturedPageTitles } from '../storage.js';
import { buildHistoryIndex, HISTORY_INDEX_ALGORITHM_VERSION } from './derive.js';

const DEFAULT_EVENT_BATCH_MS = 100;
const DEFAULT_FULL_SYNC_MAX_AGE_MS = 60 * 60 * 1000;

export function createHistoryIndexService(options = {}) {
  const store = options.store;
  const searchHistory = options.searchHistory ?? searchChromeHistory;
  const loadCapturedTitles = options.loadCapturedPageTitles ?? loadCapturedPageTitles;
  const now = options.now ?? Date.now;
  const notifyUpdated = options.notifyUpdated ?? (() => {});
  const eventBatchMs = Number(options.eventBatchMs ?? DEFAULT_EVENT_BATCH_MS);
  const fullSyncMaxAgeMs = Number(options.fullSyncMaxAgeMs ?? DEFAULT_FULL_SYNC_MAX_AGE_MS);
  let operationQueue = Promise.resolve();
  let calibrationPromise = null;
  let flushLoopPromise = null;
  let flushTimer = null;
  let pendingClear = false;
  let pendingDerivedRebuild = false;
  const pendingUpserts = new Map();
  const pendingDeletes = new Set();
  let pendingWaiters = [];

  if (!store) throw new Error('History index store is required');

  const enqueue = (operation) => {
    const result = operationQueue.then(operation, operation);
    operationQueue = result.catch(() => {});
    return result;
  };

  const rebuildFromRaw = async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const [{ items, rawRevision }, capturedPageTitles] = await Promise.all([
        store.loadRawSnapshot(),
        loadCapturedTitles()
      ]);
      const indexes = await buildHistoryIndex(items, {
        capturedPageTitles,
        yieldControl: options.yieldControl
      });
      const committed = await store.commitRangeIndexes(indexes, rawRevision, { builtAt: now() });
      if (committed) {
        await notifyUpdated(committed);
        return committed;
      }
    }
    throw new Error('History changed continuously while building the index');
  };

  const calibrate = () => {
    if (calibrationPromise) return calibrationPromise;
    calibrationPromise = enqueue(async () => {
      const syncTime = now();
      const items = await searchHistory({ text: '', startTime: 0, endTime: syncTime });
      await store.replaceRawItems(items, { fullSyncAt: syncTime });
      return rebuildFromRaw();
    }).finally(() => {
      calibrationPromise = null;
    });
    return calibrationPromise;
  };

  const hasPendingWork = () => (
    pendingClear ||
    pendingUpserts.size > 0 ||
    pendingDeletes.size > 0 ||
    pendingDerivedRebuild
  );

  const takePendingBatch = () => {
    const batch = {
      clear: pendingClear,
      upserts: [...pendingUpserts.values()],
      deletes: [...pendingDeletes],
      rebuildDerived: pendingDerivedRebuild,
      waiters: pendingWaiters
    };
    pendingClear = false;
    pendingDerivedRebuild = false;
    pendingUpserts.clear();
    pendingDeletes.clear();
    pendingWaiters = [];
    return batch;
  };

  const flushPending = () => {
    if (flushTimer !== null) {
      globalThis.clearTimeout(flushTimer);
      flushTimer = null;
    }

    if (flushLoopPromise) {
      return flushLoopPromise;
    }

    if (!hasPendingWork()) {
      const waiters = pendingWaiters;
      pendingWaiters = [];
      waiters.forEach(({ resolve }) => resolve(null));
      return Promise.resolve(null);
    }

    const result = enqueue(async () => {
      let lastResult = null;
      let lastError = null;

      while (hasPendingWork()) {
        const { clear, upserts, deletes, waiters } = takePendingBatch();

        try {
          if (clear || upserts.length > 0 || deletes.length > 0) {
            await store.applyRawMutation({ clear, upserts, deletes });
          }
          lastResult = await rebuildFromRaw();
          lastError = null;
          waiters.forEach(({ resolve }) => resolve(lastResult));
        } catch (error) {
          lastError = error;
          waiters.forEach(({ reject }) => reject(error));
        }
      }

      if (lastError) throw lastError;
      return lastResult;
    });
    flushLoopPromise = result.finally(() => {
      flushLoopPromise = null;
      if (hasPendingWork()) void flushPending().catch(() => {});
    });
    return flushLoopPromise;
  };

  const scheduleFlush = (options = {}) => new Promise((resolve, reject) => {
    pendingWaiters.push({ resolve, reject });
    if (options.immediate || eventBatchMs <= 0) {
      void flushPending().catch(() => {});
      return;
    }
    if (flushTimer !== null) globalThis.clearTimeout(flushTimer);
    flushTimer = globalThis.setTimeout(
      () => void flushPending().catch(() => {}),
      eventBatchMs
    );
  });

  return {
    async ensureReady() {
      const state = await store.getState();
      const isReady = Boolean(state.activeGeneration) &&
        state.algorithmVersion === HISTORY_INDEX_ALGORITHM_VERSION;
      if (!isReady) return calibrate();
      if (now() - state.lastFullSyncAt > fullSyncMaxAgeMs) void calibrate().catch(() => {});
      if (state.indexedRawRevision !== state.rawRevision) {
        pendingDerivedRebuild = true;
        void scheduleFlush().catch(() => {});
      }
      return state;
    },

    calibrate,

    handleVisited(item) {
      const url = String(item?.url ?? '');
      if (!url) return Promise.resolve(null);
      pendingDeletes.delete(url);
      pendingUpserts.set(url, item);
      return scheduleFlush();
    },

    handleRemoved(details = {}) {
      if (details.allHistory) {
        pendingClear = true;
        pendingUpserts.clear();
        pendingDeletes.clear();
      } else {
        for (const url of details.urls ?? []) {
          pendingUpserts.delete(url);
          pendingDeletes.add(url);
        }
      }
      return scheduleFlush();
    },

    rebuildDerived(options = {}) {
      pendingDerivedRebuild = true;
      return scheduleFlush(options);
    },

    flushPending
  };
}
