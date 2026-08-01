import {
  applyCapturedTitlesToItems,
  applyTitleOverridesToItems,
  dedupeHistoryItems,
  prepareHistoryItemsForSearch
} from '../history-utils.js';
import { appendTimeExemptRenamedItems } from '../history-data.js';

export const HISTORY_INDEX_ALGORITHM_VERSION = 1;
export const HISTORY_INDEX_RANGES = ['day', 'week', 'month', 'quarter', 'all'];

const DAY_MS = 24 * 60 * 60 * 1000;

export async function buildHistoryRangeIndexes(rawItems, options = {}) {
  const items = Array.isArray(rawItems) ? rawItems : [];
  const now = Number(options.now ?? Date.now());
  const titleOverrides = options.titleOverrides ?? new Map();
  const capturedPageTitles = options.capturedPageTitles ?? new Map();
  const yieldControl = options.yieldControl ?? defaultYieldControl;
  const indexes = new Map();

  for (const range of HISTORY_INDEX_RANGES) {
    const startTime = getHistoryRangeStartTime(range, now);
    const windowItems = range === 'all'
      ? items
      : items.filter((item) => Number(item?.lastVisitTime ?? 0) >= startTime);
    const rangeItems = appendTimeExemptRenamedItems(windowItems, titleOverrides, {
      allHistoryItems: items
    });
    indexes.set(range, createPreparedPageItems(
      rangeItems,
      capturedPageTitles,
      titleOverrides
    ));
    await yieldControl();
  }

  return indexes;
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
