const TRACKING_PARAMS = new Set([
  'dclid',
  'fbclid',
  'gclid',
  'igshid',
  'mc_cid',
  'mc_eid',
  'msclkid',
  'twclid',
  'yclid'
]);

const DEFAULT_MODE = 'normalized-url';
const LOCAL_FILE_GROUP_KEY = '本地文件';
const DISPLAY_NAME_COLLATOR = new Intl.Collator('zh-CN', {
  numeric: true,
  sensitivity: 'base'
});
const RESOURCE_ID_QUERY_PARAMS = new Set([
  'app_id',
  'base_id',
  'id',
  'node_id',
  'project_id',
  'qualified_name',
  'qualifiedname',
  'resource_id',
  'server_id',
  'story_id',
  'task_id',
  'work_item_id'
]);

export function normalizeHistoryKey(item, mode = DEFAULT_MODE) {
  const rawUrl = String(item?.dedupeUrl || item?.url || '');

  if (mode === 'page-title') {
    const originalTitleKey = normalizeSearchText(item?.identityTitle);
    const resourceKey = getStableResourceKey(rawUrl) ||
      getPageRouteKey(rawUrl) ||
      normalizeHistoryKey(item, 'normalized-url');
    return originalTitleKey ? `${originalTitleKey}\n${resourceKey}` : resourceKey;
  }

  if (mode === 'exact-url') {
    return rawUrl;
  }

  try {
    const url = new URL(rawUrl);

    if (mode === 'domain') {
      return url.hostname.toLowerCase();
    }

    if (mode === 'minimal-service') {
      return normalizeMinimalServiceKey(url);
    }

    url.hash = '';
    removeTrackingParams(url);
    trimTrailingPathSlash(url);

    return url.href;
  } catch {
    return rawUrl;
  }
}

export function dedupeHistoryItems(items, mode = DEFAULT_MODE) {
  const buckets = new Map();

  for (const item of items) {
    const dedupeKey = normalizeHistoryKey(item, mode);
    const entries = buckets.get(dedupeKey);

    if (!entries) {
      buckets.set(dedupeKey, [
        decorateItem(item, dedupeKey, 1, getTotalVisitCount(item), getItemTitleOverrideKeys(item))
      ]);
      continue;
    }

    const targetIndex = findMergeTargetIndex(entries, item);

    if (targetIndex < 0) {
      entries.push(
        decorateItem(item, dedupeKey, 1, getTotalVisitCount(item), getItemTitleOverrideKeys(item))
      );
      continue;
    }

    const current = entries[targetIndex];
    const preferred = pickPreferredItem(current, item, mode);
    const titleOverrideKeys = mergeTitleOverrideKeys(current, item);
    entries[targetIndex] = decorateItem(
      preferred,
      dedupeKey,
      current.dedupeCount + 1,
      current.totalVisitCount + getTotalVisitCount(item),
      titleOverrideKeys
    );
  }

  return [...buckets.values()].flat().sort((left, right) => {
    const byTime = getVisitTime(right) - getVisitTime(left);
    return byTime || left.dedupeKey.localeCompare(right.dedupeKey);
  });
}

export function groupHistoryItems(items, mode = 'domain') {
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

  return [...buckets.values()]
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
  return normalizeHistoryKey({ url: item?.url }, 'normalized-url');
}

export function getHistoryItemTitleOverrideKey(item) {
  return normalizeHistoryKey({ url: item?.url }, 'normalized-url');
}

export function getHistoryItemCapturedTitleKey(item) {
  const rawUrl = String(item?.url ?? '');
  return getStableResourceKey(rawUrl) || normalizeHistoryKey({ url: rawUrl }, 'normalized-url');
}

export function applyTitleOverridesToItems(items, titleOverrides = new Map()) {
  const overrides = titleOverrides instanceof Map
    ? titleOverrides
    : new Map(Object.entries(titleOverrides ?? {}));

  return items.map((item) => {
    const titleOverrideKey = getHistoryItemTitleOverrideKey(item);
    const overrideTitle = getUsableOverrideTitle(overrides.get(titleOverrideKey));

    if (!overrideTitle) {
      return {
        ...item,
        titleOverrideKey,
        isTitleRenamed: false
      };
    }

    return {
      ...item,
      originalTitle: item?.title ?? '',
      title: overrideTitle,
      titleOverrideKey,
      isTitleRenamed: true
    };
  });
}

export function applyCapturedTitlesToItems(items, capturedTitles = new Map()) {
  const titles = capturedTitles instanceof Map
    ? capturedTitles
    : new Map(Object.entries(capturedTitles ?? {}));

  return items.map((item) => {
    const titleKey = getHistoryItemCapturedTitleKey(item);
    const capturedPage = normalizeCapturedPageValue(titles.get(titleKey));
    const capturedTitle = getUsableOverrideTitle(capturedPage.title);
    const resolvedUrl = getUsableUrl(capturedPage.resolvedUrl);
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
  });
}

export function filterHistoryItemsByQuery(items, query) {
  const queryKeywords = normalizeSearchText(query).split(' ').filter(Boolean);

  if (queryKeywords.length === 0) {
    return items;
  }

  const searchesUrl = isUrlSearchQuery(query);

  return items.filter((item) => {
    const searchableText = normalizeSearchText(
      searchesUrl ? item?.url : item?.title
    );
    return queryKeywords.every((keyword) => searchableText.includes(keyword));
  });
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
      const pinKey = getHistoryItemPinKey(item);
      const pinOrder = pinOrders.get(pinKey);

      return {
        ...item,
        pinKey,
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
      const pinKey = getHistoryItemPinKey(item);
      return { ...item, pinKey, isPinned: normalizedPinnedKeys.has(pinKey) };
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

function decorateItem(item, dedupeKey, dedupeCount, totalVisitCount, titleOverrideKeys) {
  return {
    ...item,
    dedupeKey,
    dedupeCount,
    totalVisitCount,
    titleOverrideKeys
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

function findMergeTargetIndex(entries, candidate) {
  const candidateRenameKey = getManualRenameKey(candidate);

  if (candidateRenameKey) {
    const sameRenameIndex = entries.findIndex((entry) => getManualRenameKey(entry) === candidateRenameKey);

    if (sameRenameIndex >= 0) {
      return sameRenameIndex;
    }

    const unrenamedIndex = entries.findIndex((entry) => !getManualRenameKey(entry));

    if (unrenamedIndex >= 0) {
      return unrenamedIndex;
    }

    return -1;
  }

  const unrenamedIndex = entries.findIndex((entry) => !getManualRenameKey(entry));
  return unrenamedIndex >= 0 ? unrenamedIndex : 0;
}

function getManualRenameKey(item) {
  if (!item?.isTitleRenamed) {
    return '';
  }

  return item?.titleOverrideKey || getHistoryItemTitleOverrideKey(item);
}

function removeTrackingParams(url) {
  for (const key of [...url.searchParams.keys()]) {
    const normalizedKey = key.toLowerCase();

    if (normalizedKey.startsWith('utm_') || TRACKING_PARAMS.has(normalizedKey)) {
      url.searchParams.delete(key);
    }
  }

  url.searchParams.sort();
}

function trimTrailingPathSlash(url) {
  if (url.pathname !== '/' && url.pathname.endsWith('/')) {
    url.pathname = url.pathname.replace(/\/+$/, '');
  }
}

function normalizeMinimalServiceKey(url) {
  const normalizedUrl = new URL(url.href);
  normalizedUrl.hash = '';
  removeTrackingParams(normalizedUrl);
  trimTrailingPathSlash(normalizedUrl);

  const resourcePath = getMinimalServicePath(normalizedUrl);
  const resourceQuery = getMinimalServiceQuery(normalizedUrl);
  const port = normalizedUrl.port ? `:${normalizedUrl.port}` : '';

  if (resourcePath.isMinimal || resourceQuery) {
    return `${normalizedUrl.protocol}//${normalizedUrl.hostname.toLowerCase()}${port}${resourcePath.value}${resourceQuery}`;
  }

  return normalizedUrl.href;
}

function getStableResourceKey(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const port = url.port ? `:${url.port}` : '';
    const origin = `${url.protocol}//${url.hostname.toLowerCase()}${port}`;
    const resourcePath = getMinimalServicePath(url);

    if (resourcePath.hasResourceId) {
      return `${origin}${resourcePath.value}`;
    }

    const resourceQuery = getMinimalServiceQuery(url);
    if (resourceQuery) {
      return `${origin}${url.pathname || '/'}${resourceQuery}`;
    }

    return '';
  } catch {
    return '';
  }
}

function getPageRouteKey(rawUrl) {
  try {
    const url = new URL(rawUrl);
    url.hash = '';
    url.search = '';
    trimTrailingPathSlash(url);
    return url.href;
  } catch {
    return '';
  }
}

function getMinimalServicePath(url) {
  const segments = url.pathname
    .split('/')
    .map((segment) => safeDecodeUrlPath(segment).trim())
    .filter(Boolean);

  const resourceIdIndex = segments.findIndex(isResourceIdPathSegment);

  if (resourceIdIndex >= 0) {
    return {
      value: `/${segments.slice(0, resourceIdIndex + 1).map(encodePathSegment).join('/')}`,
      hasResourceId: true,
      isMinimal: resourceIdIndex < segments.length - 1 || Boolean(url.search)
    };
  }

  return {
    value: url.pathname || '/',
    hasResourceId: false,
    isMinimal: false
  };
}

function getMinimalServiceQuery(url) {
  const params = new URLSearchParams();

  for (const [key, value] of url.searchParams.entries()) {
    if (RESOURCE_ID_QUERY_PARAMS.has(key.toLowerCase()) && value.trim()) {
      params.append(key, value);
    }
  }

  params.sort();
  const query = params.toString();
  return query ? `?${query}` : '';
}

function isResourceIdPathSegment(segment) {
  const normalizedSegment = segment.toLowerCase();

  if (/^[0-9]{5,}$/.test(normalizedSegment)) {
    return true;
  }

  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(normalizedSegment)) {
    return true;
  }

  return /^(?=.*[a-z])(?=.*\d)[a-z0-9_-]{6,}$/.test(normalizedSegment);
}

function encodePathSegment(segment) {
  return encodeURIComponent(segment).replace(/%2F/gi, '/');
}

function getVisitTime(item) {
  return Number(item?.lastVisitTime ?? 0);
}

function getVisitCount(item) {
  return Number(item?.visitCount ?? 0);
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

function safeDecodeUrlPath(value) {
  try {
    return decodeURI(value);
  } catch {
    return value;
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

function pickPreferredItem(current, candidate, mode = DEFAULT_MODE) {
  if (Boolean(candidate?.isTitleRenamed) !== Boolean(current?.isTitleRenamed)) {
    return candidate?.isTitleRenamed ? candidate : current;
  }

  const currentVisits = getVisitCount(current);
  const candidateVisits = getVisitCount(candidate);

  if (candidateVisits !== currentVisits) {
    return candidateVisits > currentVisits ? candidate : current;
  }

  return getVisitTime(candidate) > getVisitTime(current) ? candidate : current;
}
