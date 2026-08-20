import {
  applyCapturedTitlesToItems,
  applyCapturedTitlesToItemsCooperatively,
  applyTitleOverridesToItems,
  applyTitleOverridesToItemsCooperatively,
  dedupeHistoryItems,
  dedupeHistoryItemsCooperatively,
  prepareHistoryItemsForSearch,
  prepareHistoryItemsForSearchCooperatively
} from '../history-utils.js';
import {
  appendTimeExemptRenamedItemsCooperatively
} from '../history-data.js';

export const HISTORY_INDEX_ALGORITHM_VERSION = 2;
export const HISTORY_INDEX_RANGES = ['day', 'week', 'month', 'quarter', 'all'];

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_INDEX_BUILD_BATCH_SIZE = 1000;

export async function buildHistoryRangeIndexes(rawItems, options = {}) {
  const items = Array.isArray(rawItems) ? rawItems : [];
  const now = Number(options.now ?? Date.now());
  const titleOverrides = options.titleOverrides ?? new Map();
  const capturedPageTitles = options.capturedPageTitles ?? new Map();
  const yieldControl = options.yieldControl ?? defaultYieldControl;
  const batchSize = normalizeBatchSize(options.batchSize);
  const indexes = new Map();
  const capturedItems = await applyCapturedTitlesToItemsCooperatively(
    items,
    capturedPageTitles,
    { batchSize, yieldControl }
  );

  for (const range of HISTORY_INDEX_RANGES) {
    const startTime = getHistoryRangeStartTime(range, now);
    const windowItems = range === 'all'
      ? capturedItems
      : await filterHistoryItemsByStartTime(capturedItems, startTime, { batchSize, yieldControl });
    const rangeItems = await appendTimeExemptRenamedItemsCooperatively(
      windowItems,
      titleOverrides,
      { allHistoryItems: capturedItems, batchSize, yieldControl }
    );
    indexes.set(range, await createPreparedPageItemsFromCapturedCooperatively(
      rangeItems,
      titleOverrides,
      { batchSize, yieldControl }
    ));
  }

  return indexes;
}

export async function createPreparedPageItemsCooperatively(
  items,
  capturedPageTitles,
  titleOverrides,
  options = {}
) {
  const cooperativeOptions = {
    batchSize: normalizeBatchSize(options.batchSize),
    yieldControl: options.yieldControl ?? defaultYieldControl
  };
  const capturedTitleItems = await applyCapturedTitlesToItemsCooperatively(
    items,
    capturedPageTitles,
    cooperativeOptions
  );
  return createPreparedPageItemsFromCapturedCooperatively(
    capturedTitleItems,
    titleOverrides,
    cooperativeOptions
  );
}

async function createPreparedPageItemsFromCapturedCooperatively(
  capturedTitleItems,
  titleOverrides,
  cooperativeOptions
) {
  const renamedItems = await applyTitleOverridesToItemsCooperatively(
    capturedTitleItems,
    titleOverrides,
    cooperativeOptions
  );
  const urlItems = await dedupeHistoryItemsCooperatively(
    renamedItems,
    'normalized-url',
    cooperativeOptions
  );
  const pageItems = await dedupeHistoryItemsCooperatively(
    urlItems,
    'page-family',
    cooperativeOptions
  );
  return prepareHistoryItemsForSearchCooperatively(pageItems, cooperativeOptions);
}

async function filterHistoryItemsByStartTime(items, startTime, options) {
  const filteredItems = [];

  for (let start = 0; start < items.length; start += options.batchSize) {
    const batch = items.slice(start, start + options.batchSize);
    filteredItems.push(...batch.filter(
      (item) => Number(item?.lastVisitTime ?? 0) >= startTime
    ));
    await options.yieldControl();
  }

  return filteredItems;
}

function normalizeBatchSize(value) {
  const batchSize = Number(value ?? DEFAULT_INDEX_BUILD_BATCH_SIZE);
  return Number.isInteger(batchSize) && batchSize > 0
    ? batchSize
    : DEFAULT_INDEX_BUILD_BATCH_SIZE;
}

export function createPreparedPageItems(items, capturedPageTitles, titleOverrides) {
  const capturedTitleItems = applyCapturedTitlesToItems(items, capturedPageTitles);
  const renamedItems = applyTitleOverridesToItems(capturedTitleItems, titleOverrides);
  const urlItems = dedupeHistoryItems(renamedItems, 'normalized-url');
  return prepareHistoryItemsForSearch(dedupeHistoryItems(urlItems, 'page-family'));
}

export function getHistoryRangeStartTime(range, now = Date.now()) {
  if (range === 'day') return now - DAY_MS;
  if (range === 'week') return now - 7 * DAY_MS;
  if (range === 'month') return now - 30 * DAY_MS;
  if (range === 'quarter') return now - 90 * DAY_MS;
  return 0;
}

function defaultYieldControl() {
  return new Promise((resolve) => globalThis.setTimeout(resolve, 0));
}
