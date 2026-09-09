export const DEFAULT_HISTORY_PAGE_SIZE = 10000;

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
