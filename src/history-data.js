export const DEFAULT_HISTORY_PAGE_SIZE = 10000;
export const DEFAULT_VISIT_COUNT_CONCURRENCY = 32;

export function createHistorySnapshotLoader(options = {}) {
  const searchHistory = options.searchHistory ?? searchChromeHistory;
  const applyVisitCounts = options.applyVisitCounts ?? applyVisitCountsForWindow;
  const now = options.now ?? Date.now;
  const apiOptions = options.apiOptions ?? options;
  const tasks = new Map();

  return {
    load(rangeKey, startTime) {
      const currentTask = tasks.get(rangeKey);
      if (currentTask) {
        return currentTask;
      }

      const endTime = now();
      const task = Promise.resolve()
        .then(() => searchHistory({ text: '', startTime, endTime }, apiOptions))
        .then((items) => applyVisitCounts(items, startTime, endTime, apiOptions));
      tasks.set(rangeKey, task);

      const clearTask = () => {
        if (tasks.get(rangeKey) === task) {
          tasks.delete(rangeKey);
        }
      };
      void task.then(clearTask, clearTask);
      return task;
    }
  };
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
 * Replace each item's all-time visit count with the count inside a time window.
 * Individual getVisits failures leave the corresponding item untouched.
 */
export async function applyVisitCountsForWindow(items, startTime, endTime, options = {}) {
  if (!Array.isArray(items) || items.length === 0) {
    return Array.isArray(items) ? items : [];
  }

  const windowStartTime = toFiniteNumber(startTime);

  if (windowStartTime === undefined || windowStartTime <= 0) {
    return items;
  }

  const { historyApi, runtimeApi } = resolveChromeApis(options);

  if (typeof historyApi?.getVisits !== 'function') {
    return items;
  }

  const windowEndTime = toFiniteNumber(endTime) ?? Number.POSITIVE_INFINITY;
  const concurrency = normalizePositiveInteger(
    options.concurrency,
    DEFAULT_VISIT_COUNT_CONCURRENCY
  );
  const countRequests = new Map();

  return mapWithConcurrency(items, concurrency, async (item) => {
    const url = typeof item?.url === 'string' ? item.url : '';

    if (!url) {
      return item;
    }

    let countRequest = countRequests.get(url);

    if (!countRequest) {
      countRequest = getVisitCountForWindow(
        historyApi,
        runtimeApi,
        url,
        windowStartTime,
        windowEndTime
      );
      countRequests.set(url, countRequest);
    }

    try {
      const visitCount = await countRequest;
      return {
        ...item,
        visitCount,
        visitCountReliable: true
      };
    } catch {
      return {
        ...item,
        allTimeVisitCount: Number(item?.visitCount ?? 0),
        visitCount: 0,
        visitCountReliable: false
      };
    }
  });
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

function getVisitCountForWindow(historyApi, runtimeApi, url, startTime, endTime) {
  return new Promise((resolve, reject) => {
    historyApi.getVisits({ url }, (visits) => {
      const lastError = runtimeApi?.lastError;

      if (lastError) {
        reject(createChromeApiError(lastError, `Could not read visits for ${url}`));
        return;
      }

      const visitCount = (Array.isArray(visits) ? visits : []).reduce((count, visit) => {
        const visitTime = toFiniteNumber(visit?.visitTime);

        if (visitTime !== undefined && visitTime >= startTime && visitTime <= endTime) {
          return count + 1;
        }

        return count;
      }, 0);
      resolve(visitCount);
    });
  });
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;

  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await mapper(items[index], index);
      }
    }
  );

  await Promise.all(workers);
  return results;
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

function normalizePositiveInteger(value, fallback) {
  const numericValue = Number(value);

  if (!Number.isFinite(numericValue) || numericValue <= 0) {
    return fallback;
  }

  return Math.max(1, Math.floor(numericValue));
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
