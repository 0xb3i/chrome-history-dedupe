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

// Presentation only: never use these summaries to merge identities or choose URLs.
export function describeLinkDifferences(items) {
  const parsed = items.map((item) => {
    try { return new URL(item.url); } catch { return null; }
  });
  const fields = [];
  const addField = (label, values, { name = label, secret = false, display = (value) => value } = {}) => {
    const keys = values.map((value) => JSON.stringify(value));
    const distinct = [...new Set(keys)];
    if (distinct.length < 2) return;
    const present = distinct.filter((key) => key !== 'null');
    fields.push({ label, name, values, keys, present, secret, display });
  };

  let sharedAddress = '';
  let sharedLabel = '共同地址';
  if (parsed.length && parsed.every(Boolean)) {
    const first = parsed[0];
    const paths = parsed.map((url) => url.pathname.split('/'));
    const commonEnd = paths[0].findIndex((segment, index) =>
      paths.some((segments) => segments[index] !== segment));
    const common = paths[0].slice(0, commonEnd < 0 ? paths[0].length : commonEnd).join('/');
    const samePath = parsed.every((url) => url.pathname === first.pathname);
    const sameOrigin = parsed.every((url) => url.origin === first.origin);
    const sharedHost = parsed.every((url) => url.hostname === first.hostname) ? first.hostname : '';
    sharedAddress = `${sameOrigin && first.origin !== 'null' ? first.origin : sharedHost}${samePath ? first.pathname : common + '/…'}`;
    sharedLabel = samePath && sameOrigin ? '共同地址' : '共同路径';
    addField('协议', parsed.map((url) => url.protocol));
    addField('主机', parsed.map((url) => url.host));
    addField('用户信息', parsed.map((url) => url.username || url.password
      ? [url.username, url.password] : null), { secret: true });
    addField('路径', parsed.map((url) => url.pathname), {
      display: (value) => decodeDisplay(common && !samePath && value !== common ? `…${value.slice(common.length)}` : value)
    });
    const params = new Set(parsed.flatMap((url) => [...url.searchParams.keys()]));
    for (const key of params) {
      const secret = /(?:token|password|passwd|secret|credential|authorization|session|api[-_]?key)/i.test(key);
      addField(secret ? '登录凭证' : key || '空参数名',
        parsed.map((url) => url.searchParams.has(key) ? url.searchParams.getAll(key) : null),
        { name: `参数 ${key || '（空名称）'}`, secret });
    }
    addField('页面片段', parsed.map((url) => url.hash || null), { display: decodeDisplay });
  }

  // Preserve differences in encoding, ordering, or unparseable URLs too.
  const signatures = new Map();
  const ambiguous = items.some((item, index) => {
    const signature = JSON.stringify(fields.map((field) => field.keys[index]));
    if (signatures.has(signature)) return signatures.get(signature) !== item.url;
    signatures.set(signature, item.url);
    return false;
  });
  if (ambiguous) addField('地址写法', items.map((item) => item.url), { secret: true });

  const credentials = fields.filter((field) => field.label === '登录凭证');
  if (credentials.length > 1) credentials.forEach((field) => { field.label = field.name; });
  for (const field of fields) {
    const displayKeys = new Map();
    field.entries = field.values.map((value, index) => {
      const detail = value === null ? '未携带' : Array.isArray(value)
        ? value.map((part) => part === '' ? '（空值）' : part).join(' / ') : value;
      const display = value === null ? '无' : field.secret
        ? `值 ${field.present.indexOf(field.keys[index]) + 1}`
        : field.display(detail);
      if (!displayKeys.has(display)) displayKeys.set(display, new Set());
      displayKeys.get(display).add(field.keys[index]);
      return { detail, display };
    });
    field.entries.forEach((entry, index) => {
      const ordinal = field.present.indexOf(field.keys[index]) + 1;
      entry.value = entry.display.length > 40
        ? `${entry.display.slice(0, 18)}…${entry.display.slice(-8)} · 值 ${ordinal}`
        : displayKeys.get(entry.display).size > 1 && field.values[index] !== null
          ? `${entry.display} · 值 ${ordinal}` : entry.display;
    });
  }

  return {
    sharedAddress,
    sharedLabel,
    summary: fields.length ? `差异：${[...new Set(fields.map((field) => field.label))].join('、')}` : '地址相同',
    variants: items.map((_, index) => ({
      differences: fields.map((field) => ({
        label: field.label,
        name: field.name,
        value: field.entries[index].value,
        detail: field.entries[index].detail
      }))
    }))
  };
}

function decodeDisplay(value) {
  try { return decodeURIComponent(value); } catch { return value; }
}
