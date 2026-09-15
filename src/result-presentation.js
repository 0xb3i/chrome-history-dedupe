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

// Labels explain a choice within this group; they never change resource identity,
// navigation targets or ordering. Only fields needed to distinguish choices appear.
export function describeLinkChoices(items) {
  if (!items.length) return [];
  const urls = items.map((item) => {
    try { return new URL(item.url); } catch { return null; }
  });
  if (urls.some((url) => !url)) {
    return items.map((item) => ({ label: String(item.url ?? ''), secondary: '' }));
  }
  const paths = relativePaths(urls.map((url) => url.pathname));
  const hashPaths = urls.map((url) => url.hash.split('?')[0]);
  const pathVaries = new Set(urls.map((url) => url.pathname)).size > 1;
  const routeNames = mergeRequestNames(urls);
  const choices = urls.map((_, index) => ({
    label: pathVaries ? routeNames?.[index] || paths[index] || '页面入口' : '',
    secondary: ''
  }));
  for (const indices of matchingChoices(choices)) {
    const hashes = indices.map((index) => hashPaths[index]);
    if (new Set(hashes).size < 2) continue;
    const prefix = ['#!/', '#/'].find((candidate) => hashes.every((hash) => hash.startsWith(candidate)));
    const labels = prefix
      ? relativePaths(hashes.map((hash) => hash.slice(prefix.length - 1))).map((path) => `${prefix}${path}`)
      : hashes.map((hash) => decodeDisplay(hash) || '无锚点');
    indices.forEach((index, offset) => { choices[index].secondary = labels[offset]; });
  }

  const fields = [];
  const addField = (name, values, secret = false) => {
    if (new Set(values.map((value) => JSON.stringify(value))).size > 1) {
      fields.push({ name, values, secret });
    }
  };
  const addParams = (params, prefix = '') => {
    const keys = [...new Set(params.flatMap((param) => [...param.keys()]))];
    // Navigation controls and resource IDs are more useful than incidental state.
    const priority = (key) => ({ tab: 0, view: 1, page: 2, id: 3 })[key.toLowerCase()] ?? (isCredential(key) ? 5 : 4);
    keys.sort((a, b) => priority(a) - priority(b) || a.localeCompare(b));
    for (const key of keys) {
      addField(`${prefix}${key || '空参数名'}`,
        params.map((param) => param.has(key) ? param.getAll(key) : null), isCredential(key));
    }
  };
  addParams(urls.map((url) => url.searchParams));
  addParams(urls.map((url) => {
    const queryStart = url.hash.indexOf('?');
    return new URLSearchParams(queryStart < 0 ? '' : url.hash.slice(queryStart + 1));
  }), '片段参数 ');
  addField('协议', urls.map((url) => url.protocol.slice(0, -1)));
  addField('主机', urls.map((url) => url.host));
  addField('访问凭证', urls.map((url) => url.username || url.password ? [url.username, url.password] : null), true);
  // Decoding or a route name can hide differences in the original spelling.
  addField('路径', urls.map((url) => url.pathname));
  addField('锚点', hashPaths);

  for (const field of fields) {
    for (const indices of matchingChoices(choices)) {
      if (new Set(indices.map((index) => JSON.stringify(field.values[index]))).size < 2) continue;
      for (const index of indices) {
        const text = `${field.name}：${fieldValue(field, index)}`;
        choices[index].secondary = [choices[index].secondary, text].filter(Boolean).join('；');
      }
    }
  }
  // Equivalent encodings or parameter order may be the only remaining difference.
  // Explain that honestly, without exposing credential values or inventing tabs.
  for (const indices of matchingChoices(choices)) {
    const spellings = [...new Set(indices.map((index) => items[index].url))].sort();
    if (spellings.length < 2) continue;
    const spellingNumbers = new Map(spellings.map((value, index) => [value, index + 1]));
    for (const index of indices) {
      choices[index].secondary = [choices[index].secondary,
        `地址写法 ${spellingNumbers.get(items[index].url)}`].filter(Boolean).join('；');
    }
  }
  return choices.map((choice, index) => {
    if (choice.label) return choice;
    return { label: choice.secondary || routeNames?.[index] || paths[index] || '页面入口', secondary: '' };
  });
}

function relativePaths(paths) {
  const segments = paths.map((path) => path.split('/'));
  let common = 0;
  while (segments.every((parts) => common < parts.length && parts[common] === segments[0][common])) common++;
  return segments.map((parts) => decodeDisplay(parts.slice(common).join('/')));
}

function mergeRequestNames(urls) {
  const routes = urls.map((url) => /^(code\.byted\.org|gitlab\.com)$/.test(url.hostname)
    ? url.pathname.match(/^(.*\/merge_requests\/\d+)(\/.*)?$/) : null);
  if (routes.some((route) => !route) ||
    new Set(routes.map((route, index) => `${urls[index].origin}${route[1]}`)).size !== 1) return null;
  const names = new Map([['', '概览'], ['/', '概览'], ['/diffs', '文件变更'], ['/commits', '提交记录']]);
  return routes.map((route) => names.get(route[2] || '') || (route[2] || '').slice(1));
}

function matchingChoices(choices) {
  const groups = new Map();
  choices.forEach((choice, index) => {
    const key = JSON.stringify([choice.label, choice.secondary]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(index);
  });
  return [...groups.values()].filter((indices) => indices.length > 1);
}

function isCredential(key) {
  return /token|password|passwd|secret|credential|authorization|session|api[-_]?key/i.test(key);
}

function fieldValue(field, index) {
  const value = field.values[index];
  if (value === null) return '未指定';
  if (field.secret) {
    // Number a credential field once for the entire group, not once per row.
    field.valueNumbers ??= new Map(
      [...new Set(field.values.filter((entry) => entry !== null).map((entry) => JSON.stringify(entry)))]
        .sort().map((entry, offset) => [entry, offset + 1])
    );
    return `已隐藏 ${field.valueNumbers.get(JSON.stringify(value))}`;
  }
  if (Array.isArray(value)) {
    // JSON preserves repeated values and separates empty strings from missing keys.
    return value.length === 1 ? value[0] || '（空值）' : JSON.stringify(value);
  }
  return value || '（空值）';
}

function decodeDisplay(value) {
  try { return decodeURI(value); } catch { return value; }
}
