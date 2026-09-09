import {
  applyCapturedTitlesToItemsCooperatively,
  dedupeHistoryItemsCooperatively
} from '../history-utils.js';
import { projectPageItems } from './project.js';

export const HISTORY_INDEX_ALGORITHM_VERSION = 8;
export const HISTORY_INDEX_RANGES = ['all'];

export async function buildHistoryIndex(rawItems, options = {}) {
  const batchSize = Number.isInteger(options.batchSize) && options.batchSize > 0
    ? options.batchSize : 1000;
  const yieldControl = options.yieldControl ?? defaultYieldControl;
  const cooperativeOptions = { batchSize, yieldControl };
  const capturedItems = await applyCapturedTitlesToItemsCooperatively(
    Array.isArray(rawItems) ? rawItems : [],
    options.capturedPageTitles ?? new Map(),
    cooperativeOptions
  );
  const urlItems = await dedupeHistoryItemsCooperatively(capturedItems, 'normalized-url', cooperativeOptions);
  const pageItems = await dedupeHistoryItemsCooperatively(urlItems, 'page-family', cooperativeOptions);
  const projectedItems = [];
  for (let start = 0; start < pageItems.length; start += batchSize) {
    projectedItems.push(...projectPageItems(pageItems.slice(start, start + batchSize)));
    await yieldControl();
  }

  // Persist the complete resource facts once for every foreground search.
  return new Map([['all', projectedItems]]);
}

function defaultYieldControl() {
  return new Promise((resolve) => globalThis.setTimeout(resolve, 0));
}
