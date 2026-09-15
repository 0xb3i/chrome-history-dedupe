import { filterHistoryItemsByQuery, getHistoryRangeStartTime, normalizeSearchRange } from './history-utils.js';
import { projectPageItems } from './history-index/project.js';

export function createSearchState({ loadIndex, ensureIndex, onChange, now = Date.now }) {
  let requestId = 0;
  let index = null;
  let query = '';
  let range = 'all';
  let titleOverrides = new Map();
  let snapshot = null;
  let projectedItems = null;

  function updateSnapshot() {
    if (!index) return;
    projectedItems ??= projectPageItems(index.pageItems, titleOverrides);
    const startTime = getHistoryRangeStartTime(range, now());
    const rangeItems = range === 'all' ? projectedItems : projectedItems.filter(
      (item) => item.isTitleRenamed || Number(item.lastVisitTime ?? 0) >= startTime
    );
    snapshot = {
      query, range, rangeStartTime: startTime, revision: index.revision,
      pageItemCount: rangeItems.length,
      matchedItems: filterHistoryItemsByQuery(rangeItems, query)
    };
    onChange(snapshot);
  }

  async function readIndex() {
    const loaded = await loadIndex();
    if (loaded) return loaded;
    await ensureIndex();
    const ensured = await loadIndex();
    if (!ensured) throw new Error('历史索引尚未就绪，请稍后重试。');
    return ensured;
  }

  return {
    get snapshot() { return snapshot; },
    async search(nextQuery, nextRange = 'all') {
      const token = ++requestId;
      query = String(nextQuery ?? '').trim();
      range = normalizeSearchRange(nextRange);
      try {
        const loaded = index ?? await readIndex();
        if (token !== requestId) return;
        if (!index || Number(loaded.revision) > Number(index.revision)) {
          index = loaded;
          projectedItems = null;
        }
        updateSnapshot();
      } catch (error) {
        if (token === requestId) throw error;
      }
    },
    async refresh(revision) {
      if (index && Number(revision) <= Number(index.revision)) return;
      const loaded = await readIndex();
      if (index && Number(loaded.revision) <= Number(index.revision)) return;
      index = loaded;
      projectedItems = null;
      updateSnapshot();
    },
    setTitleOverrides(overrides) {
      titleOverrides = overrides;
      projectedItems = null;
      updateSnapshot();
    }
  };
}
