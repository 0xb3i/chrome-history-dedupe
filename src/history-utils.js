import {
  getLegacyResourceIdentityKey,
  getPageIdentityKey,
  getStableResourceIdentityKey,
  normalizeUrlKey
} from './page-identity.js';

const DEFAULT_MODE = 'normalized-url';
const LOCAL_FILE_GROUP_KEY = '本地文件';
const DISPLAY_NAME_COLLATOR = new Intl.Collator('zh-CN', {
  numeric: true,
  sensitivity: 'base'
});
const HAN_KEYWORD_PATTERN = /^\p{Script=Han}{3,}$/u;
const MAX_HAN_SUBSEQUENCE_SKIPS = 4;
const DEFAULT_COOPERATIVE_BATCH_SIZE = 1000;
export function normalizeHistoryKey(item, mode = DEFAULT_MODE) {
  const rawUrl = String(item?.dedupeUrl || item?.url || '');

  if (mode === 'page-family' || mode === 'page-title' || mode === 'minimal-service') {
    return getPageIdentityKey(rawUrl);
  }

  if (mode === 'exact-url') {
    return rawUrl;
  }

  try {
    const url = new URL(rawUrl);

    if (mode === 'domain') {
      return url.hostname.toLowerCase();
    }

    return normalizeUrlKey(rawUrl);
  } catch {
    return rawUrl;
  }
}

export function dedupeHistoryItems(items, mode = DEFAULT_MODE) {
  const buckets = new Map();

  for (const item of items) {
    addHistoryItemToDedupeBuckets(buckets, item, mode);
  }

  return finalizeDedupeBuckets(buckets);
}

export async function dedupeHistoryItemsCooperatively(items, mode = DEFAULT_MODE, options = {}) {
  const buckets = new Map();
  const batchSize = getCooperativeBatchSize(options.batchSize);
  const yieldControl = options.yieldControl ?? defaultCooperativeYield;

  for (let index = 0; index < items.length; index += 1) {
    addHistoryItemToDedupeBuckets(buckets, items[index], mode);
    if ((index + 1) % batchSize === 0) await yieldControl();
  }

  await yieldControl();
  return finalizeDedupeBuckets(buckets);
}

function addHistoryItemToDedupeBuckets(buckets, item, mode) {
  const dedupeKey = normalizeHistoryKey(item, mode);
  const accumulator = buckets.get(dedupeKey);

  if (!accumulator) {
    buckets.set(dedupeKey, {
      dedupeKey,
      preferred: item,
      dedupeCount: getDedupeCount(item),
      lastVisitTime: getVisitTime(item),
      pinKeys: new Set(getItemPinKeys(item)),
      representativeLastVisitTime: getRepresentativeVisitTime(item),
      representativeVisitCount: getRepresentativeVisitCount(item),
      searchableTitles: new Set(getItemSearchableTitles(item)),
      searchableUrls: new Set(getItemSearchableUrls(item)),
      titleOverrideKeys: new Set(getItemTitleOverrideKeys(item)),
      totalVisitCount: getTotalVisitCount(item)
    });
    return;
  }

  const current = {
    ...accumulator.preferred,
    representativeLastVisitTime: accumulator.representativeLastVisitTime,
    representativeVisitCount: accumulator.representativeVisitCount,
    totalVisitCount: accumulator.totalVisitCount
  };
  const preferred = pickPreferredItem(current, item, mode);
  const isNormalizedUrlBucket = mode === 'normalized-url';
  if (preferred !== current) accumulator.preferred = preferred;
  accumulator.dedupeCount += getDedupeCount(item);
  accumulator.lastVisitTime = Math.max(accumulator.lastVisitTime, getVisitTime(item));
  addStringValues(accumulator.pinKeys, getItemPinKeys(item));
  accumulator.representativeLastVisitTime = isNormalizedUrlBucket
    ? Math.max(accumulator.representativeLastVisitTime, getRepresentativeVisitTime(item))
    : getRepresentativeVisitTime(preferred);
  accumulator.representativeVisitCount = isNormalizedUrlBucket
    ? accumulator.representativeVisitCount + getRepresentativeVisitCount(item)
    : getRepresentativeVisitCount(preferred);
  addStringValues(accumulator.searchableTitles, getItemSearchableTitles(item));
  addStringValues(accumulator.searchableUrls, getItemSearchableUrls(item));
  addStringValues(accumulator.titleOverrideKeys, getItemTitleOverrideKeys(item));
  accumulator.totalVisitCount += getTotalVisitCount(item);
}

function finalizeDedupeBuckets(buckets) {
  return [...buckets.values()].map((accumulator) => decorateItem(
    accumulator.preferred,
    accumulator.dedupeKey,
    {
      dedupeCount: accumulator.dedupeCount,
      lastVisitTime: accumulator.lastVisitTime,
      pinKeys: [...accumulator.pinKeys],
      representativeLastVisitTime: accumulator.representativeLastVisitTime,
      representativeVisitCount: accumulator.representativeVisitCount,
      searchableTitles: [...accumulator.searchableTitles],
      searchableUrls: [...accumulator.searchableUrls],
      titleOverrideKeys: [...accumulator.titleOverrideKeys],
      totalVisitCount: accumulator.totalVisitCount
    }
  )).sort((left, right) => {
    const byTime = getVisitTime(right) - getVisitTime(left);
    return byTime || left.dedupeKey.localeCompare(right.dedupeKey);
  });
}

export function groupHistoryItems(items, mode = 'domain') {
  return collectHistoryGroups(items, mode)
    .map((group) => ({
      ...group,
      items: [...group.items].sort((left, right) => {
        const byTime = getVisitTime(right) - getVisitTime(left);
        return byTime || String(left.url ?? '').localeCompare(String(right.url ?? ''));
      })
    }))
    .sort((left, right) => {
      const byCount = right.totalVisitCount - left.totalVisitCount;
      if (byCount) {
        return byCount;
      }

      const byTime = right.lastVisitTime - left.lastVisitTime;
      return byTime || left.key.localeCompare(right.key);
    });
}

export function groupHistoryItemsByCandidateRank(items, mode = 'domain') {
  return collectHistoryGroups(items, mode);
}

function collectHistoryGroups(items, mode) {
  const buckets = new Map();

  for (const item of items) {
    const key = getGroupKey(item, mode);
    const current = buckets.get(key);

    if (!current) {
      buckets.set(key, {
        key,
        label: key,
        items: [item],
        itemCount: 1,
        lastVisitTime: getVisitTime(item),
        totalVisitCount: getGroupVisitCount(item)
      });
      continue;
    }

    current.items.push(item);
    current.itemCount += 1;
    current.lastVisitTime = Math.max(current.lastVisitTime, getVisitTime(item));
    current.totalVisitCount += getGroupVisitCount(item);
  }

  return [...buckets.values()];
}

export function prioritizeRenamedHistoryItems(items) {
  return items
    .map((item, originalIndex) => ({
      item,
      originalIndex,
      hasRenamePriority: Boolean(item?.isTitleRenamed)
    }))
    .sort((left, right) => {
      const byRename = Number(right.hasRenamePriority) - Number(left.hasRenamePriority);
      return byRename || left.originalIndex - right.originalIndex;
    })
    .map(({ item }) => item);
}

export function formatHistoryUrlForGroup(item, groupKey) {
  const rawUrl = String(item?.url ?? '');

  if (!rawUrl) {
    return '';
  }

  try {
    const url = new URL(rawUrl);
    const normalizedGroupKey = String(groupKey ?? '').toLowerCase();

    if (url.protocol === 'file:' && (!groupKey || groupKey === LOCAL_FILE_GROUP_KEY)) {
      return safeDecodeUrlPath(`${url.pathname}${url.search}${url.hash}`);
    }

    if (url.hostname.toLowerCase() !== normalizedGroupKey) {
      return rawUrl;
    }

    return `${url.port ? `:${url.port}` : ''}${url.pathname || '/'}${url.search}${url.hash}`;
  } catch {
    return rawUrl;
  }
}

export function getHistoryItemPinKey(item) {
  return getPageIdentityKey(String(item?.dedupeUrl || item?.url || ''));
}

export function getHistoryItemTitleOverrideKey(item) {
  return getPageIdentityKey(String(item?.dedupeUrl || item?.url || ''));
}

export function getHistoryItemCapturedTitleKey(item) {
  return normalizeUrlKey(String(item?.url ?? ''));
}

export function applyTitleOverridesToItems(items, titleOverrides = new Map()) {
  const overrides = titleOverrides instanceof Map
    ? titleOverrides
    : new Map(Object.entries(titleOverrides ?? {}));
  const preparedItems = items.map((item) => ({
    ...item,
    titleOverrideKey: getHistoryItemTitleOverrideKey(item),
    isTitleRenamed: false
  }));
  const pageBuckets = new Map();

  preparedItems.forEach((item, index) => {
    const indexes = pageBuckets.get(item.titleOverrideKey) ?? [];
    indexes.push(index);
    pageBuckets.set(item.titleOverrideKey, indexes);
  });

  for (const [pageKey, indexes] of pageBuckets) {
    const overrideCandidates = collectTitleOverrideCandidates(
      preparedItems,
      indexes,
      overrides,
      pageKey
    );

    if (overrideCandidates.length === 0) {
      continue;
    }

    const selectedOverride = pickLatestTitleOverride(overrideCandidates);
    const targetIndex = pickTitleOverrideTargetIndex(
      preparedItems,
      indexes,
      selectedOverride.targetUrl
    );

    if (targetIndex < 0) {
      continue;
    }

    const item = preparedItems[targetIndex];
    preparedItems[targetIndex] = {
      ...item,
      originalTitle: item?.title ?? '',
      title: selectedOverride.title,
      titleOverrideKey: pageKey,
      titleOverrideKeys: mergeStringValues(
        [pageKey],
        overrideCandidates.map((candidate) => candidate.sourceKey)
      ),
      isTitleRenamed: true,
      renameUpdatedAt: selectedOverride.updatedAt
    };
  }

  return preparedItems;
}

export async function applyTitleOverridesToItemsCooperatively(
  items,
  titleOverrides = new Map(),
  options = {}
) {
  const overrides = titleOverrides instanceof Map
    ? titleOverrides
    : new Map(Object.entries(titleOverrides ?? {}));
  const batchSize = getCooperativeBatchSize(options.batchSize);
  const yieldControl = options.yieldControl ?? defaultCooperativeYield;
  const preparedItems = [];
  const pageBuckets = new Map();

  for (let index = 0; index < items.length; index += 1) {
    const item = {
      ...items[index],
      titleOverrideKey: getHistoryItemTitleOverrideKey(items[index]),
      isTitleRenamed: false
    };
    preparedItems.push(item);
    const indexes = pageBuckets.get(item.titleOverrideKey) ?? [];
    indexes.push(index);
    pageBuckets.set(item.titleOverrideKey, indexes);
    if ((index + 1) % batchSize === 0) await yieldControl();
  }

  let processedBucketCount = 0;
  for (const [pageKey, indexes] of pageBuckets) {
    const overrideCandidates = collectTitleOverrideCandidates(
      preparedItems,
      indexes,
      overrides,
      pageKey
    );

    if (overrideCandidates.length > 0) {
      const selectedOverride = pickLatestTitleOverride(overrideCandidates);
      const targetIndex = pickTitleOverrideTargetIndex(
        preparedItems,
        indexes,
        selectedOverride.targetUrl
      );

      if (targetIndex >= 0) {
        const item = preparedItems[targetIndex];
        preparedItems[targetIndex] = {
          ...item,
          originalTitle: item?.title ?? '',
          title: selectedOverride.title,
          titleOverrideKey: pageKey,
          titleOverrideKeys: mergeStringValues(
            [pageKey],
            overrideCandidates.map((candidate) => candidate.sourceKey)
          ),
          isTitleRenamed: true,
          renameUpdatedAt: selectedOverride.updatedAt
        };
      }
    }

    processedBucketCount += 1;
    if (processedBucketCount % batchSize === 0) await yieldControl();
  }

  return preparedItems;
}

export function applyCapturedTitlesToItems(items, capturedTitles = new Map()) {
  const context = createCapturedTitleContext(capturedTitles);
  return items.map((item) => applyCapturedTitleToItem(item, context));
}

function createCapturedTitleContext(capturedTitles) {
  const titles = capturedTitles instanceof Map
    ? capturedTitles
    : new Map(Object.entries(capturedTitles ?? {}));
  const titlesByPageIdentity = new Map();

  for (const [key, value] of titles) {
    const pageKey = getPageIdentityKey(key);
    if (pageKey && !titlesByPageIdentity.has(pageKey)) {
      titlesByPageIdentity.set(pageKey, value);
    }
  }

  return { titles, titlesByPageIdentity };
}

function applyCapturedTitleToItem(item, context) {
  const { titles, titlesByPageIdentity } = context;
  const titleKey = getHistoryItemCapturedTitleKey(item);
  const stableResourceKey = getStableResourceIdentityKey(item?.url);
  const legacyResourceKey = getLegacyResourceIdentityKey(item?.url);
  const fallbackKeys = mergeStringValues(
    [stableResourceKey],
    stableResourceKey === legacyResourceKey ? [legacyResourceKey] : [],
    [getPageIdentityKey(item?.url)]
  );
  const exactCapturedValue = titles.get(titleKey);
  const capturedValue = exactCapturedValue ??
    fallbackKeys.map((key) => titles.get(key)).find((value) => value !== undefined) ??
    titlesByPageIdentity.get(getPageIdentityKey(item?.url));
  const capturedPage = normalizeCapturedPageValue(capturedValue);
  const capturedTitle = getUsableOverrideTitle(capturedPage.title);
  const capturedResolvedUrl = getUsableUrl(capturedPage.resolvedUrl);
  const resolvedUrl = exactCapturedValue !== undefined ||
    getPageIdentityKey(capturedResolvedUrl) === getPageIdentityKey(item?.url)
    ? capturedResolvedUrl
    : '';
  const historyTitle = getUsableOverrideTitle(item?.title);

  if (!capturedTitle) {
    return {
      ...item,
      historyTitle,
      identityTitle: '',
      title: ''
    };
  }

  return {
    ...item,
    historyTitle,
    identityTitle: capturedTitle,
    title: capturedTitle,
    ...(resolvedUrl ? { dedupeUrl: resolvedUrl, resolvedUrl } : {})
  };
}

export async function applyCapturedTitlesToItemsCooperatively(
  items,
  capturedTitles = new Map(),
  options = {}
) {
  const batchSize = getCooperativeBatchSize(options.batchSize);
  const yieldControl = options.yieldControl ?? defaultCooperativeYield;
  const preparedItems = [];
  const context = createCapturedTitleContext(capturedTitles);

  for (let start = 0; start < items.length; start += batchSize) {
    preparedItems.push(...items
      .slice(start, start + batchSize)
      .map((item) => applyCapturedTitleToItem(item, context)));
    await yieldControl();
  }

  return preparedItems;
}

export function filterHistoryItemsByQuery(items, query) {
  const queryKeywords = normalizeSearchText(query).split(' ').filter(Boolean);

  if (queryKeywords.length === 0) {
    return items;
  }

  const searchesUrl = isUrlSearchQuery(query);

  return items.filter((item) => {
    const normalizedValues = getPreparedSearchValues(item, searchesUrl);
    const searchableText = normalizedValues.join(' ');
    return queryKeywords.every((keyword) => (
      searchableText.includes(keyword) ||
      (!searchesUrl && normalizedValues.some((value) => matchesBoundedHanSubsequence(
        value,
        keyword
      )))
    ));
  });
}

export function prepareHistoryItemsForSearch(items) {
  return items.map((item) => {
    const searchableUrls = getItemSearchableUrls(item);
    return {
      ...item,
      normalizedSearchTitles: getItemSearchableTitles(item).map(normalizeSearchText),
      normalizedPlainUrls: searchableUrls.map(getPlainUrlSearchText).map(normalizeSearchText),
      normalizedSearchUrls: searchableUrls.map(normalizeSearchText)
    };
  });
}

export async function prepareHistoryItemsForSearchCooperatively(items, options = {}) {
  const batchSize = getCooperativeBatchSize(options.batchSize);
  const yieldControl = options.yieldControl ?? defaultCooperativeYield;
  const preparedItems = [];

  for (let start = 0; start < items.length; start += batchSize) {
    preparedItems.push(...prepareHistoryItemsForSearch(items.slice(start, start + batchSize)));
    await yieldControl();
  }

  return preparedItems;
}

function getPreparedSearchValues(item, searchesUrl) {
  if (searchesUrl && Array.isArray(item?.normalizedSearchUrls)) {
    return item.normalizedSearchUrls;
  }

  if (
    !searchesUrl &&
    Array.isArray(item?.normalizedSearchTitles) &&
    Array.isArray(item?.normalizedPlainUrls)
  ) {
    return [...item.normalizedSearchTitles, ...item.normalizedPlainUrls];
  }

  const searchableUrls = getItemSearchableUrls(item);
  const searchableValues = searchesUrl
    ? searchableUrls
    : [...getItemSearchableTitles(item), ...searchableUrls.map(getPlainUrlSearchText)];
  return searchableValues.map(normalizeSearchText);
}

function matchesBoundedHanSubsequence(value, keyword) {
  if (!HAN_KEYWORD_PATTERN.test(keyword)) {
    return false;
  }

  for (let start = value.indexOf(keyword[0]); start >= 0; start = value.indexOf(keyword[0], start + 1)) {
    let valueIndex = start + 1;
    let keywordIndex = 1;
    let skippedCount = 0;

    while (valueIndex < value.length && keywordIndex < keyword.length) {
      if (value[valueIndex] === keyword[keywordIndex]) {
        keywordIndex += 1;
      } else {
        skippedCount += 1;
        if (skippedCount > MAX_HAN_SUBSEQUENCE_SKIPS) {
          break;
        }
      }
      valueIndex += 1;
    }

    if (keywordIndex === keyword.length) {
      return true;
    }
  }

  return false;
}

function isUrlSearchQuery(query) {
  const normalizedQuery = String(query ?? '').trim();
  return /:\/\//.test(normalizedQuery) ||
    /^www\./i.test(normalizedQuery) ||
    /^[^\s/]+\.[a-z]{2,}(?:[/:?#]|$)/i.test(normalizedQuery) ||
    normalizedQuery.startsWith('/');
}

export function applyPinnedStateToGroups(groups, pinnedKeys = new Set()) {
  const pinOrders = createPinOrders(pinnedKeys);

  return groups.map((group) => {
    const itemsWithPinState = group.items.map((item, index) => {
      const pinKeys = getItemPinKeys(item);
      const activePinKeys = pinKeys.filter((key) => pinOrders.has(key));
      const pinOrder = activePinKeys.length > 0
        ? Math.min(...activePinKeys.map((key) => pinOrders.get(key)))
        : undefined;

      return {
        ...item,
        pinKey: getHistoryItemPinKey(item) || pinKeys[0],
        pinKeys,
        activePinKeys,
        isPinned: pinOrder !== undefined,
        pinOrder,
        originalIndex: index
      };
    });

    const items = itemsWithPinState
      .sort((left, right) => {
        const byPin = Number(right.isPinned) - Number(left.isPinned);
        const byPinOrder = (left.pinOrder ?? Infinity) - (right.pinOrder ?? Infinity);
        const byRename = Number(right.isTitleRenamed) - Number(left.isTitleRenamed);
        return byPin || byPinOrder || byRename || left.originalIndex - right.originalIndex;
      })
      .map((item) => {
        const { originalIndex, pinOrder, ...publicItem } = item;
        return publicItem;
      });

    return {
      ...group,
      items,
      pinnedCount: items.filter((item) => item.isPinned).length
    };
  });
}

export function applyPinnedStateToItemsByName(items, pinnedKeys = new Set()) {
  const normalizedPinnedKeys = pinnedKeys instanceof Set
    ? pinnedKeys
    : new Set(pinnedKeys ?? []);

  return items
    .map((item) => {
      const pinKeys = getItemPinKeys(item);
      const activePinKeys = pinKeys.filter((key) => normalizedPinnedKeys.has(key));
      return {
        ...item,
        pinKey: getHistoryItemPinKey(item) || pinKeys[0],
        pinKeys,
        activePinKeys,
        isPinned: activePinKeys.length > 0
      };
    })
    .sort((left, right) => {
      const byPin = Number(right.isPinned) - Number(left.isPinned);
      const byName = compareDisplayNames(
        String(left?.title || left?.url || '').trim(),
        String(right?.title || right?.url || '').trim()
      );
      const byTime = Number(right?.lastVisitTime ?? 0) - Number(left?.lastVisitTime ?? 0);
      return byPin || byName || byTime || String(left?.url ?? '').localeCompare(String(right?.url ?? ''));
    });
}

export function compareDisplayNames(leftName, rightName) {
  const left = String(leftName ?? '').trim();
  const right = String(rightName ?? '').trim();
  const byScript = getDisplayNameScriptRank(left) - getDisplayNameScriptRank(right);
  return byScript || DISPLAY_NAME_COLLATOR.compare(left, right);
}

function getDisplayNameScriptRank(name) {
  const firstLetterOrNumber = String(name).match(/[\p{L}\p{N}]/u)?.[0] ?? '';

  if (/^[A-Za-z0-9]$/.test(firstLetterOrNumber)) {
    return 0;
  }

  if (/^\p{Script=Han}$/u.test(firstLetterOrNumber)) {
    return 1;
  }

  return 2;
}

function createPinOrders(pinnedKeys) {
  const orders = new Map();

  for (const key of pinnedKeys ?? []) {
    if (typeof key === 'string' && !orders.has(key)) {
      orders.set(key, orders.size);
    }
  }

  return orders;
}

function decorateItem(item, dedupeKey, metadata) {
  return {
    ...item,
    dedupeKey,
    dedupeCount: metadata.dedupeCount,
    lastVisitTime: metadata.lastVisitTime,
    pinKeys: metadata.pinKeys,
    representativeLastVisitTime: metadata.representativeLastVisitTime,
    representativeVisitCount: metadata.representativeVisitCount,
    searchableTitles: metadata.searchableTitles,
    searchableUrls: metadata.searchableUrls,
    titleOverrideKeys: metadata.titleOverrideKeys,
    totalVisitCount: metadata.totalVisitCount
  };
}

function mergeTitleOverrideKeys(...items) {
  const keys = new Set();

  for (const item of items) {
    for (const key of getItemTitleOverrideKeys(item)) {
      keys.add(key);
    }
  }

  return [...keys];
}

function getItemTitleOverrideKeys(item) {
  const keys = Array.isArray(item?.titleOverrideKeys) ? item.titleOverrideKeys : [];
  const key = item?.titleOverrideKey || getHistoryItemTitleOverrideKey(item);
  return [...new Set([...keys, key].filter(Boolean))];
}

function getItemPinKeys(item) {
  const keys = Array.isArray(item?.pinKeys) ? item.pinKeys : [];
  const resolvedKey = getHistoryItemPinKey(item);
  const originalKey = getPageIdentityKey(String(item?.url || ''));
  const key = item?.pinKey || resolvedKey || originalKey;
  return mergeStringValues(keys, [key, resolvedKey, originalKey]);
}

function getItemSearchableTitles(item) {
  const titles = Array.isArray(item?.searchableTitles) ? item.searchableTitles : [];
  return mergeStringValues(titles, [item?.title, item?.historyTitle]);
}

function getItemSearchableUrls(item) {
  const urls = Array.isArray(item?.searchableUrls) ? item.searchableUrls : [];
  return mergeStringValues(urls, [item?.url, item?.resolvedUrl, item?.dedupeUrl]);
}

function mergeStringValues(...collections) {
  const values = new Set();

  for (const collection of collections) {
    for (const value of collection ?? []) {
      const normalizedValue = String(value ?? '').trim();

      if (normalizedValue) {
        values.add(normalizedValue);
      }
    }
  }

  return [...values];
}

function addStringValues(target, values) {
  for (const value of values ?? []) {
    const normalizedValue = String(value ?? '').trim();
    if (normalizedValue) target.add(normalizedValue);
  }
}

function collectTitleOverrideCandidates(items, indexes, overrides, pageKey) {
  const candidates = [];
  const seenKeys = new Set();

  const addCandidate = (sourceKey, value, fallbackTargetUrl, sourceOrder) => {
    if (!sourceKey || seenKeys.has(sourceKey) || value === undefined) {
      return;
    }

    const record = normalizeTitleOverrideValue(value, fallbackTargetUrl);
    if (!record.title) {
      return;
    }

    seenKeys.add(sourceKey);
    candidates.push({ ...record, sourceKey, sourceOrder });
  };

  addCandidate(pageKey, overrides.get(pageKey), pageKey, Number.MAX_SAFE_INTEGER);

  indexes.forEach((index, sourceOrder) => {
    const item = items[index];
    const originalPageKey = getPageIdentityKey(item?.url);
    const exactKey = normalizeUrlKey(item?.url);
    addCandidate(originalPageKey, overrides.get(originalPageKey), item?.url, sourceOrder);
    addCandidate(exactKey, overrides.get(exactKey), item?.url, sourceOrder);
  });

  return candidates;
}

function normalizeTitleOverrideValue(value, fallbackTargetUrl) {
  if (value && typeof value === 'object') {
    return {
      title: getUsableOverrideTitle(value.title),
      targetUrl: String(value.targetUrl || fallbackTargetUrl || ''),
      updatedAt: Number.isFinite(Number(value.updatedAt)) ? Number(value.updatedAt) : 0
    };
  }

  return {
    title: getUsableOverrideTitle(value),
    targetUrl: String(fallbackTargetUrl || ''),
    updatedAt: 0
  };
}

function pickLatestTitleOverride(candidates) {
  return [...candidates].sort((left, right) => {
    const byUpdatedAt = right.updatedAt - left.updatedAt;
    return byUpdatedAt || left.sourceKey.localeCompare(right.sourceKey) ||
      left.targetUrl.localeCompare(right.targetUrl) || left.title.localeCompare(right.title);
  })[0];
}

function pickTitleOverrideTargetIndex(items, indexes, targetUrl) {
  const normalizedTargetUrl = normalizeUrlKey(targetUrl);
  const exactMatches = indexes.filter(
    (index) => normalizeUrlKey(items[index]?.url) === normalizedTargetUrl
  );
  const resolvedMatches = exactMatches.length > 0
    ? exactMatches
    : indexes.filter(
        (index) => normalizeUrlKey(items[index]?.dedupeUrl || items[index]?.resolvedUrl) === normalizedTargetUrl
      );
  const candidates = resolvedMatches.length > 0 ? resolvedMatches : indexes;

  return candidates.reduce((preferredIndex, index) => {
    if (preferredIndex < 0) {
      return index;
    }

    return pickPreferredItem(items[preferredIndex], items[index]) === items[index]
      ? index
      : preferredIndex;
  }, -1);
}

function getPlainUrlSearchText(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return `${url.hostname} ${safeDecodeUrlPath(url.pathname)}`;
  } catch {
    return rawUrl;
  }
}

function getDedupeCount(item) {
  const count = Number(item?.dedupeCount ?? 1);
  return Number.isFinite(count) && count > 0 ? count : 1;
}

function getRepresentativeVisitCount(item) {
  if (item?.representativeVisitCount !== undefined) {
    return Number(item.representativeVisitCount);
  }

  return Number(item?.totalVisitCount ?? item?.visitCount ?? 0);
}

function getRepresentativeVisitTime(item) {
  return Number(item?.representativeLastVisitTime ?? item?.lastVisitTime ?? 0);
}

function safeDecodeUrlPath(value) {
  try {
    return decodeURI(String(value ?? ''));
  } catch {
    return String(value ?? '');
  }
}

function getVisitTime(item) {
  return Number(item?.lastVisitTime ?? 0);
}

function getTotalVisitCount(item) {
  return Number(item?.totalVisitCount ?? item?.visitCount ?? 0);
}

function getGroupVisitCount(item) {
  return Number(item?.totalVisitCount ?? item?.visitCount ?? 0);
}

function getGroupKey(item, mode) {
  if (mode !== 'domain') {
    return normalizeHistoryKey(item, mode);
  }

  const rawUrl = String(item?.url ?? '');

  try {
    const url = new URL(rawUrl);

    if (url.protocol === 'file:') {
      return LOCAL_FILE_GROUP_KEY;
    }

    return url.hostname.toLowerCase() || rawUrl || '(unknown)';
  } catch {
    return rawUrl || '(unknown)';
  }
}

function getUsableOverrideTitle(title) {
  const normalized = String(title ?? '')
    .normalize('NFKC')
    .replace(/\p{Cf}+/gu, '')
    .trim()
    .replace(/\s+/g, ' ');
  return normalized || '';
}

function normalizeCapturedPageValue(value) {
  if (value && typeof value === 'object') {
    return {
      title: value.title,
      resolvedUrl: value.resolvedUrl
    };
  }

  return {
    title: value,
    resolvedUrl: ''
  };
}

function getUsableUrl(value) {
  const rawUrl = String(value ?? '').trim();

  if (!rawUrl) {
    return '';
  }

  try {
    return new URL(rawUrl).href;
  } catch {
    return '';
  }
}

function normalizeSearchText(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/\p{Cf}+/gu, '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function pickPreferredItem(current, candidate) {
  if (Boolean(candidate?.isTitleRenamed) !== Boolean(current?.isTitleRenamed)) {
    return candidate?.isTitleRenamed ? candidate : current;
  }

  const currentRenameTime = Number(current?.renameUpdatedAt ?? 0);
  const candidateRenameTime = Number(candidate?.renameUpdatedAt ?? 0);

  if (current?.isTitleRenamed && candidateRenameTime !== currentRenameTime) {
    return candidateRenameTime > currentRenameTime ? candidate : current;
  }

  const currentVisits = getRepresentativeVisitCount(current);
  const candidateVisits = getRepresentativeVisitCount(candidate);

  if (candidateVisits !== currentVisits) {
    return candidateVisits > currentVisits ? candidate : current;
  }

  const currentTime = getRepresentativeVisitTime(current);
  const candidateTime = getRepresentativeVisitTime(candidate);

  if (candidateTime !== currentTime) {
    return candidateTime > currentTime ? candidate : current;
  }

  const currentUrl = normalizeUrlKey(current?.url);
  const candidateUrl = normalizeUrlKey(candidate?.url);
  const byNormalizedUrl = candidateUrl.localeCompare(currentUrl);

  if (byNormalizedUrl !== 0) {
    return byNormalizedUrl < 0 ? candidate : current;
  }

  const currentRawIdentity = [current?.url, current?.title, current?.id]
    .map((value) => String(value ?? ''))
    .join('\n');
  const candidateRawIdentity = [candidate?.url, candidate?.title, candidate?.id]
    .map((value) => String(value ?? ''))
    .join('\n');
  return candidateRawIdentity.localeCompare(currentRawIdentity) < 0 ? candidate : current;
}

function getCooperativeBatchSize(value) {
  const batchSize = Number(value ?? DEFAULT_COOPERATIVE_BATCH_SIZE);
  return Number.isInteger(batchSize) && batchSize > 0
    ? batchSize
    : DEFAULT_COOPERATIVE_BATCH_SIZE;
}

function defaultCooperativeYield() {
  return new Promise((resolve) => globalThis.setTimeout(resolve, 0));
}
