import { getPageIdentityKey } from './page-identity.js';

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

export async function appendTimeExemptRenamedItemsCooperatively(
  items,
  titleOverrides,
  options = {}
) {
  const windowItems = Array.isArray(items) ? items : [];
  const allHistoryItems = Array.isArray(options.allHistoryItems)
    ? options.allHistoryItems
    : windowItems;
  const overrides = titleOverrides instanceof Map
    ? titleOverrides
    : new Map(Object.entries(titleOverrides ?? {}));
  const batchSize = normalizePositiveInteger(options.batchSize, 1000);
  const yieldControl = options.yieldControl ?? defaultCooperativeYield;
  const existingPageKeys = new Set();

  for (let index = 0; index < windowItems.length; index += 1) {
    const pageKey = getPageIdentityKey(windowItems[index]?.url);
    if (pageKey) existingPageKeys.add(pageKey);
    if ((index + 1) % batchSize === 0) await yieldControl();
  }

  const renamedPageKeys = new Set();
  for (const [storedKey, record] of overrides) {
    const targetUrl = String(record?.targetUrl ?? '').trim();
    const pageKey = getPageIdentityKey(targetUrl) || String(storedKey ?? '').trim();
    if (pageKey && !existingPageKeys.has(pageKey)) renamedPageKeys.add(pageKey);
  }

  if (renamedPageKeys.size === 0) {
    return windowItems;
  }

  const restoredItems = [];
  for (let index = 0; index < allHistoryItems.length; index += 1) {
    const item = allHistoryItems[index];
    const pageKey = getPageIdentityKey(item?.url);
    if (renamedPageKeys.has(pageKey) && !existingPageKeys.has(pageKey)) {
      restoredItems.push(item);
    }
    if ((index + 1) % batchSize === 0) await yieldControl();
  }

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

function defaultCooperativeYield() {
  return new Promise((resolve) => globalThis.setTimeout(resolve, 0));
}
