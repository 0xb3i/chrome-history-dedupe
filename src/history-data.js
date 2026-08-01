import { getPageIdentityKey } from './page-identity.js';

export const DEFAULT_HISTORY_PAGE_SIZE = 10000;
export const DEFAULT_HISTORY_SNAPSHOT_CACHE_MS = 5 * 60 * 1000;

export function createHistorySnapshotLoader(options = {}) {
  const searchHistory = options.searchHistory ?? searchChromeHistory;
  const now = options.now ?? Date.now;
  const apiOptions = options.apiOptions ?? options;
  const cacheTtlMs = normalizeNonNegativeNumber(
    options.cacheTtlMs,
    DEFAULT_HISTORY_SNAPSHOT_CACHE_MS
  );
  const tasks = new Map();
  const snapshots = new Map();
  let generation = 0;

  const load = (rangeKey, startTime, text = '') => {
      const cachedSnapshot = snapshots.get(rangeKey);
      const currentTime = now();

      if (cachedSnapshot && currentTime - cachedSnapshot.loadedAt <= cacheTtlMs) {
        return Promise.resolve(cachedSnapshot.items);
      }

      const currentTask = tasks.get(rangeKey);
      if (currentTask) {
        return currentTask;
      }

      const endTime = currentTime;
      const taskGeneration = generation;
      const task = Promise.resolve()
        .then(() => searchHistory({ text, startTime, endTime }, apiOptions))
        .then((items) => {
          if (taskGeneration !== generation) {
            return load(rangeKey, startTime, text);
          }
          snapshots.set(rangeKey, { items, loadedAt: now() });
          return items;
        });
      tasks.set(rangeKey, task);

      const clearTask = () => {
        if (tasks.get(rangeKey) === task) {
          tasks.delete(rangeKey);
        }
      };
      void task.then(clearTask, clearTask);
      return task;
  };

  return {
    load,
    invalidate(rangeKey) {
      generation += 1;
      tasks.clear();
      if (rangeKey === undefined) {
        snapshots.clear();
        return;
      }

      snapshots.delete(rangeKey);
    }
  };
}

export function getTimeExemptRenameLookupTexts(items, titleOverrides) {
  const windowItems = Array.isArray(items) ? items : [];
  const overrides = titleOverrides instanceof Map
    ? titleOverrides
    : new Map(Object.entries(titleOverrides ?? {}));
  const existingPageKeys = new Set(
    windowItems.map((item) => getPageIdentityKey(item?.url)).filter(Boolean)
  );
  const lookupTexts = new Set();

  for (const [storedKey, record] of overrides) {
    const targetUrl = String(record?.targetUrl ?? '').trim();
    const pageKey = getPageIdentityKey(targetUrl) || String(storedKey ?? '').trim();

    if (!targetUrl || !pageKey || existingPageKeys.has(pageKey)) {
      continue;
    }

    lookupTexts.add(getHistoryLookupText(targetUrl));
  }

  return [...lookupTexts].filter(Boolean).sort();
}

/**
 * Read every matching Chrome history item by moving an end-time cursor backwards.
 * `maxResults` is the page size, not a limit on the combined result.
 */
export async function searchChromeHistory(query = {}, options = {}) {
  const { historyApi, runtimeApi } = resolveChromeApis(options);

  if (typeof historyApi?.search !== 'function') {
    throw new Error('Chrome history API unavailable');
  }

  const maxResults = normalizePositiveInteger(
    options.maxResults ?? query.maxResults,
    DEFAULT_HISTORY_PAGE_SIZE
  );
  const baseQuery = {
    text: '',
    ...query
  };
  delete baseQuery.maxResults;

  const startTime = toFiniteNumber(baseQuery.startTime);
  let cursorEndTime = toFiniteNumber(baseQuery.endTime);
  let pageSize = maxResults;

  if (startTime !== undefined && cursorEndTime !== undefined && cursorEndTime < startTime) {
    return [];
  }

  const itemsByUrl = new Map();

  while (true) {
    const pageQuery = {
      ...baseQuery,
      maxResults: pageSize
    };

    if (cursorEndTime !== undefined) {
      pageQuery.endTime = cursorEndTime;
    }

    const page = await searchHistoryPage(historyApi, runtimeApi, pageQuery);

    for (const item of page) {
      const url = String(item?.url ?? '');

      if (!itemsByUrl.has(url)) {
        itemsByUrl.set(url, item);
      }
    }

    if (page.length < pageSize) {
      break;
    }

    const oldestTime = getOldestVisitTime(page);

    if (oldestTime === undefined) {
      break;
    }

    if (oldestTime < (startTime ?? 0)) {
      break;
    }

    if (cursorEndTime !== undefined && oldestTime >= cursorEndTime) {
      if (oldestTime > cursorEndTime || pageSize >= Number.MAX_SAFE_INTEGER) {
        break;
      }

      // A full page can end inside a large same-timestamp group. Retry the
      // inclusive boundary with a larger page instead of skipping that group.
      pageSize = Math.min(Number.MAX_SAFE_INTEGER, pageSize * 2);
      continue;
    }

    cursorEndTime = oldestTime;
    pageSize = maxResults;
  }

  return [...itemsByUrl.values()];
}

/**
 * Add renamed pages that are absent from the selected time window.
 * Renames are not bookmarks: a page is restored only while at least one URL
 * with the same page identity still exists in Chrome's all-time history.
 */
export function appendTimeExemptRenamedItems(items, titleOverrides, options = {}) {
  const windowItems = Array.isArray(items) ? items : [];
  const allHistoryItems = Array.isArray(options.allHistoryItems)
    ? options.allHistoryItems
    : windowItems;
  const overrides = titleOverrides instanceof Map
    ? titleOverrides
    : new Map(Object.entries(titleOverrides ?? {}));
  const existingPageKeys = new Set(
    windowItems.map((item) => getPageIdentityKey(item?.url)).filter(Boolean)
  );
  const renamedPageKeys = new Set();

  for (const [storedKey, record] of overrides) {
    const targetUrl = String(record?.targetUrl ?? '').trim();
    const pageKey = getPageIdentityKey(targetUrl) || String(storedKey ?? '').trim();

    if (!pageKey || existingPageKeys.has(pageKey)) {
      continue;
    }

    renamedPageKeys.add(pageKey);
  }

  if (renamedPageKeys.size === 0) {
    return windowItems;
  }

  const restoredItems = allHistoryItems.filter((item) => {
    const pageKey = getPageIdentityKey(item?.url);
    return renamedPageKeys.has(pageKey) && !existingPageKeys.has(pageKey);
  });

  return restoredItems.length > 0 ? [...windowItems, ...restoredItems] : windowItems;
}

function resolveChromeApis(options) {
  const chromeApi = options.chromeApi ?? globalThis.chrome;

  return {
    historyApi: options.historyApi ?? chromeApi?.history,
    runtimeApi: options.runtimeApi ?? chromeApi?.runtime
  };
}

function searchHistoryPage(historyApi, runtimeApi, query) {
  return new Promise((resolve, reject) => {
    historyApi.search(query, (items) => {
      const lastError = runtimeApi?.lastError;

      if (lastError) {
        reject(createChromeApiError(lastError, 'Chrome history search failed'));
        return;
      }

      resolve(Array.isArray(items) ? items : []);
    });
  });
}

function getOldestVisitTime(items) {
  let oldestTime;

  for (const item of items) {
    const visitTime = toFiniteNumber(item?.lastVisitTime);

    if (visitTime !== undefined && (oldestTime === undefined || visitTime < oldestTime)) {
      oldestTime = visitTime;
    }
  }

  return oldestTime;
}

function getHistoryLookupText(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return /^https?:$/.test(url.protocol) ? url.hostname : rawUrl;
  } catch {
    return rawUrl;
  }
}

function normalizePositiveInteger(value, fallback) {
  const numericValue = Number(value);

  if (!Number.isFinite(numericValue) || numericValue <= 0) {
    return fallback;
  }

  return Math.max(1, Math.floor(numericValue));
}

function normalizeNonNegativeNumber(value, fallback) {
  if (value === undefined) {
    return fallback;
  }

  const numericValue = Number(value);
  return Number.isFinite(numericValue) && numericValue >= 0 ? numericValue : fallback;
}

function toFiniteNumber(value) {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }

  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : undefined;
}

function createChromeApiError(lastError, fallbackMessage) {
  const message = typeof lastError?.message === 'string' && lastError.message
    ? lastError.message
    : fallbackMessage;
  return new Error(message);
}
