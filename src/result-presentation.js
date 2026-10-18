export function formatRelativeVisitTime(value, now = Date.now()) {
  const time = Number(value);
  if (!Number.isFinite(time) || time <= 0) return '未知时间';
  const date = new Date(time);
  const today = new Date(now);
  const calendarDay = (day) => Date.UTC(day.getFullYear(), day.getMonth(), day.getDate());
  const days = (calendarDay(today) - calendarDay(date)) / 86400000;
  if (days === 0) return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date);
  if (days === 1) return '昨天';
  if (days > 1 && days < 7) return ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][date.getDay()];
  return new Intl.DateTimeFormat('zh-CN', {
    ...(date.getFullYear() !== today.getFullYear() ? { year: 'numeric' } : {}),
    month: 'numeric', day: 'numeric'
  }).format(date);
}

// Only the visible excerpt changes; search ranges and stored titles stay intact.
export function createHighlightedExcerpt(text, ranges = []) {
  const limit = 160;
  if (text.length <= limit || !ranges.length) return { text, ranges };
  let start = Math.max(0, ranges[0][0] - 24);
  let end = Math.min(text.length, start + limit);
  // Do not split UTF-16 surrogate pairs at excerpt boundaries.
  if (/[\uDC00-\uDFFF]/.test(text[start])) start++;
  if (end < text.length && /[\uDC00-\uDFFF]/.test(text[end])) end--;
  const prefix = start > 0 ? '…' : '';
  return {
    text: `${prefix}${text.slice(start, end)}${end < text.length ? '…' : ''}`,
    ranges: ranges.filter(([from, to]) => from < end && to > start)
      .map(([from, to]) => [Math.max(from, start) - start + prefix.length,
        Math.min(to, end) - start + prefix.length])
  };
}

// These buckets only compress the result list. Every member retains its own
// identity, URL, metadata and actions; a shared title never becomes a storage key.
export function groupItemsByDisplayTitle(items) {
  const rows = [];
  const buckets = new Map();
  const titleCounts = new Map();
  for (const item of items) {
    const title = String(item.title ?? '').trim();
    const key = displayTitleKey(item);
    if (title) titleCounts.set(key, (titleCounts.get(key) ?? 0) + 1);
    if (!title || item.isTitleRenamed || item.isPinned) {
      rows.push({ kind: 'item', item });
      continue;
    }
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { kind: 'title-group', key, title, items: [], lastVisitTime: 0, totalVisitCount: 0 };
      buckets.set(key, bucket);
      rows.push(bucket);
    }
    bucket.items.push(item);
    bucket.lastVisitTime = Math.max(bucket.lastVisitTime, Number(item.lastVisitTime ?? 0));
    bucket.totalVisitCount += Number(item.totalVisitCount ?? item.visitCount ?? 0);
  }
  return rows.map((row) => row.kind === 'title-group' && row.items.length === 1
    ? { kind: 'item', item: row.items[0] }
    : row).map((row) => row.kind === 'item' && titleCounts.get(displayTitleKey(row.item)) > 1
      ? { ...row, distinguishUrl: true }
      : row);
}

function displayTitleKey(item) {
  const title = String(item.title ?? '').trim().normalize('NFKC')
    .replace(/\p{Cf}/gu, '').replace(/\s+/g, ' ').toLowerCase();
  // Keep domain boundaries even if the caller supplies a mixed collection.
  let domain;
  try { domain = new URL(item.url).hostname; } catch { domain = String(item.url); }
  return JSON.stringify([domain, title]);
}

// Omit the shared origin, but keep each address's path, query and fragment.
// Display formatting never changes navigation targets or resource identity.
export function describeLinkChoices(items, { groupTitle = '' } = {}) {
  const urls = items.map((item) => {
    try { return new URL(item.url); } catch { return null; }
  });
  const sharedOrigin = urls.every(Boolean) && new Set(urls.map((url) => url.origin)).size === 1;
  const secrets = new Map();
  const hiddenValue = (value) => {
    if (!secrets.has(value)) secrets.set(value, secrets.size + 1);
    return `[隐藏${secrets.get(value)}]`;
  };
  const redactQuery = (text) => text.replace(/([?&])([^=&#]+)=([^&#]*)/g, (match, separator, key, value) => {
    let decodedKey;
    try { decodedKey = decodeURIComponent(key.replace(/\+/g, ' ')); } catch { decodedKey = key; }
    return /token|password|passwd|secret|credential|authorization|session|api[-_]?key/i.test(decodedKey)
      ? `${separator}${key}=${hiddenValue(value)}` : match;
  });
  return items.map((item, index) => {
    const url = urls[index];
    if (!url) return { label: String(item.url ?? ''), secondary: '' };
    let path;
    try { path = decodeURI(url.pathname); } catch { path = url.pathname; }
    const origin = sharedOrigin ? '' : url.origin;
    const credentials = url.username || url.password
      ? ` [凭证${hiddenValue(`${url.username}:${url.password}`)}]` : '';
    const address = `${origin}${path || '/'}`;
    const suffix = `${redactQuery(url.search)}${redactQuery(url.hash)}${credentials}`;
    const normalizeTitle = (value) => String(value ?? '').trim().normalize('NFKC').replace(/\s+/g, ' ').toLowerCase();
    const pageTitle = groupTitle ? [item.title, item.historyTitle, item.originalTitle, item.defaultTitle]
      .map((value) => String(value ?? '').trim())
      .find((value) => value && normalizeTitle(value) !== normalizeTitle(groupTitle) &&
        !/^(?:https?:\/\/|www\.|\/)/i.test(value) && value !== item.url) : '';
    return {
      label: pageTitle || address,
      secondary: pageTitle ? `${address}${suffix}` : suffix,
      ...(pageTitle ? { isPageTitle: true } : {})
    };
  });
}
