import { prepareHistoryItemsForSearch } from '../history-utils.js';

// Project annotations over immutable all-time facts in both UI and background.
export function projectPageItems(items, titleOverrides = new Map()) {
  return prepareHistoryItemsForSearch(items.map((item) => {
    const defaultUrl = item.defaultUrl ?? item.url;
    const defaultTitle = item.defaultTitle ?? item.title;
    const keys = [...new Set([item.dedupeKey, ...(item.titleOverrideKeys ?? [])].filter(Boolean))];
    const candidates = keys
      .map((key) => ({ key, record: titleOverrides.get(key) }))
      .filter(({ record }) => record?.title)
      .sort((left, right) => Number(right.record.updatedAt ?? 0) - Number(left.record.updatedAt ?? 0) ||
        left.key.localeCompare(right.key));
    const override = candidates[0]?.record;
    const { renameUpdatedAt: _renameUpdatedAt, normalizedSearchTitles: _search, ...base } = item;
    return {
      ...base, defaultUrl, defaultTitle,
      url: override?.targetUrl || defaultUrl,
      title: override?.title || defaultTitle,
      originalTitle: defaultTitle,
      titleOverrideKey: item.dedupeKey,
      titleOverrideKeys: keys,
      isTitleRenamed: Boolean(override),
      ...(override ? { renameUpdatedAt: override.updatedAt } : {})
    };
  }));
}
