import {
  getPageIdentityKey,
  normalizeUrlKey
} from './page-identity.js';

const DEFAULT_MODE = 'normalized-url';
const LOCAL_FILE_GROUP_KEY = '本地文件';
const HAN_KEYWORD_PATTERN = /^\p{Script=Han}{3,}$/u;
const MAX_HAN_SUBSEQUENCE_SKIPS = 4;
const DEFAULT_COOPERATIVE_BATCH_SIZE = 1000;
const HISTORY_RANGE_DAYS = { day: 1, week: 7, month: 30, quarter: 90, all: 0 };

export function normalizeSearchRange(range) {
  return Object.hasOwn(HISTORY_RANGE_DAYS, range) ? range : 'all';
}

export function getHistoryRangeStartTime(range, now = Date.now()) {
  const days = HISTORY_RANGE_DAYS[normalizeSearchRange(range)];
  return days ? now - days * 24 * 60 * 60 * 1000 : 0;
}

export function normalizeHistoryKey(item, mode = DEFAULT_MODE) {
  const rawUrl = String(item?.dedupeUrl || item?.url || '');
  return mode === 'page-family' ? getPageIdentityKey(rawUrl) : normalizeUrlKey(rawUrl);
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
  const preferred = pickPreferredItem(current, item);
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
      titleOverrideKeys: [...accumulator.titleOverrideKeys],
      totalVisitCount: accumulator.totalVisitCount
    }
  )).sort((left, right) => {
    return compareHistoryItems(left, right);
  });
}

export function groupHistoryItems(items) {
  return sortHistoryGroups(collectHistoryGroups(items));
}

// All presentations use the same item order, and a group's best member decides
// its rank. Aggregate group traffic remains metadata, never a second ranking rule.
function sortHistoryGroups(groups) {
  return groups.map((group) => ({
    ...group,
    items: [...group.items].sort(compareHistoryItems)
  })).sort((left, right) => (
    compareHistoryItems(left.items[0], right.items[0]) || left.key.localeCompare(right.key)
  ));
}

function collectHistoryGroups(items) {
  const buckets = new Map();

  for (const item of items) {
    const key = getGroupKey(item);
    const current = buckets.get(key);

    if (!current) {
      buckets.set(key, {
        key,
        label: key,
        items: [item],
        itemCount: 1,
        lastVisitTime: getVisitTime(item),
        totalVisitCount: getTotalVisitCount(item)
      });
      continue;
    }

    current.items.push(item);
    current.itemCount += 1;
    current.lastVisitTime = Math.max(current.lastVisitTime, getVisitTime(item));
    current.totalVisitCount += getTotalVisitCount(item);
  }

  return [...buckets.values()];
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
  const exactCapturedValue = titles.get(titleKey);
  const capturedValue = exactCapturedValue ??
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
      title: ''
    };
  }

  return {
    ...item,
    historyTitle,
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

  return items.filter((item) => {
    const normalizedValues = getPreparedSearchTitles(item);
    const searchableText = normalizedValues.join(' ');
    return queryKeywords.every((keyword) => (
      searchableText.includes(keyword) ||
      normalizedValues.some((value) => matchesBoundedHanSubsequence(
        value,
        keyword
      ))
    ));
  });
}

export function prepareHistoryItemsForSearch(items) {
  return items.map((item) => ({
    ...item,
    normalizedSearchTitles: getItemSearchableTitles(item).map(normalizeSearchText)
  }));
}

function getPreparedSearchTitles(item) {
  return Array.isArray(item?.normalizedSearchTitles)
    ? item.normalizedSearchTitles
    : getItemSearchableTitles(item).map(normalizeSearchText);
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

export function applyPinnedStateToGroups(groups, pinnedKeys = new Set()) {
  const pinOrders = createPinOrders(pinnedKeys);
  return sortHistoryGroups(groups.map((group) => {
    const items = group.items.map((item) => {
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
        pinOrder
      };
    });
    return { ...group, items, pinnedCount: items.filter((item) => item.isPinned).length };
  }));
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
    titleOverrideKeys: metadata.titleOverrideKeys,
    totalVisitCount: metadata.totalVisitCount
  };
}

function getItemTitleOverrideKeys(item) {
  const keys = Array.isArray(item?.titleOverrideKeys) ? item.titleOverrideKeys : [];
  const key = item?.titleOverrideKey || getHistoryItemTitleOverrideKey(item);
  return mergeStringValues(keys, [key, getPageIdentityKey(item?.url)]);
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
  return mergeStringValues(titles, [item?.title, item?.historyTitle])
    .filter((title) => !isUrlLikeSearchTitle(title));
}

function isUrlLikeSearchTitle(value) {
  const title = String(value ?? '').trim();
  return /^(?:https?|file):\/\//i.test(title) || /^www\./i.test(title);
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

// One ranking contract for candidates, members and groups in every display mode.
function compareHistoryItems(left, right) {
  const byPin = Number(Boolean(right?.isPinned)) - Number(Boolean(left?.isPinned));
  const byPinOrder = (left?.isPinned ? left.pinOrder ?? Infinity : Infinity) -
    (right?.isPinned ? right.pinOrder ?? Infinity : Infinity);
  const byRename = Number(Boolean(right?.isTitleRenamed)) - Number(Boolean(left?.isTitleRenamed));
  const byCount = getTotalVisitCount(right) - getTotalVisitCount(left);
  const byTime = getVisitTime(right) - getVisitTime(left);
  const leftKey = String(left?.dedupeKey ?? left?.url ?? '');
  const rightKey = String(right?.dedupeKey ?? right?.url ?? '');
  return byPin || byPinOrder || byRename || byCount || byTime || leftKey.localeCompare(rightKey);
}

function getGroupKey(item) {
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
