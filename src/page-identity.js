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

const RESOURCE_ID_QUERY_PARAM_NAMES = new Map([
  ['appid', 'app_id'],
  ['baseid', 'base_id'],
  ['id', 'id'],
  ['nodeid', 'node_id'],
  ['projectid', 'project_id'],
  ['qualifiedname', 'qualified_name'],
  ['resourceid', 'resource_id'],
  ['serverid', 'server_id'],
  ['storyid', 'story_id'],
  ['taskid', 'task_id'],
  ['workitemid', 'work_item_id']
]);

const HASH_ROUTE_PATTERN = /^#!?\//;
const STATEFUL_ROUTE_SEGMENTS = new Set([
  'keyword_search'
]);
export function normalizeUrlKey(rawUrl) {
  const rawValue = String(rawUrl ?? '');

  try {
    const url = new URL(rawValue);
    normalizeUrlSurface(url);

    if (!isHashRoute(url.hash)) {
      url.hash = '';
    }

    return url.href;
  } catch {
    return rawValue;
  }
}

export function getPageIdentityKey(rawUrl) {
  const rawValue = String(rawUrl ?? '');

  try {
    const url = new URL(rawValue);

    if (!/^https?:$/.test(url.protocol)) {
      return normalizeUrlKey(rawValue);
    }

    if (isHashRoute(url.hash)) {
      return getHashRouteIdentityKey(url);
    }

    return getUrlPageIdentityKey(url);
  } catch {
    return rawValue;
  }
}

export function getStableResourceIdentityKey(rawUrl) {
  return getResourceIdentityKey(rawUrl, 'first');
}

export function getLegacyResourceIdentityKey(rawUrl) {
  return getResourceIdentityKey(rawUrl, 'last');
}

function getUrlPageIdentityKey(inputUrl) {
  const url = new URL(inputUrl.href);
  url.hash = '';
  normalizeUrlSurface(url);

  if (isStatefulRoute(url.pathname)) {
    url.search = '';
    return url.href;
  }

  const resourcePath = getResourcePath(url, 'first');
  const resourceQuery = resourcePath.hasResourceId ? '' : getResourceQuery(url);
  const port = url.port ? `:${url.port}` : '';
  const origin = `${url.protocol}//${url.hostname.toLowerCase()}${port}`;
  const path = resourcePath.hasResourceId ? resourcePath.value : (url.pathname || '/');
  return `${origin}${path}${resourceQuery}`;
}

function isStatefulRoute(pathname) {
  const segments = String(pathname ?? '')
    .split('/')
    .map((segment) => safeDecodeUrlPath(segment).trim().toLowerCase())
    .filter(Boolean);
  return STATEFUL_ROUTE_SEGMENTS.has(segments.at(-1));
}

function getHashRouteIdentityKey(inputUrl) {
  const url = new URL(inputUrl.href);
  const rawRoute = url.hash.slice(1);
  const hasBang = rawRoute.startsWith('!');
  const routeValue = hasBang ? rawRoute.slice(1) : rawRoute;
  const routeUrl = new URL(routeValue, 'https://hash-route.invalid');
  const routeIdentity = getUrlPageIdentityKey(routeUrl);
  const routeSuffix = routeIdentity.slice('https://hash-route.invalid'.length);

  url.hash = '';
  const shellIdentity = getUrlPageIdentityKey(url);

  return `${shellIdentity}#${hasBang ? '!' : ''}${routeSuffix}`;
}

function getResourceIdentityKey(rawUrl, position) {
  try {
    const url = new URL(rawUrl);

    if (!/^https?:$/.test(url.protocol)) {
      return '';
    }

    if (isHashRoute(url.hash)) {
      const rawRoute = url.hash.slice(1).replace(/^!/, '');
      const routeUrl = new URL(rawRoute, 'https://hash-route.invalid');
      const routeResourceKey = getResourceIdentityFromUrl(routeUrl, position);

      if (!routeResourceKey) {
        return '';
      }

      const routeSuffix = routeResourceKey.slice('https://hash-route.invalid'.length);
      url.hash = '';
      const shellIdentity = getUrlPageIdentityKey(url);
      return `${shellIdentity}#${routeSuffix}`;
    }

    return getResourceIdentityFromUrl(url, position);
  } catch {
    return '';
  }
}

function getResourceIdentityFromUrl(inputUrl, position) {
  const url = new URL(inputUrl.href);
  normalizeUrlSurface(url);
  const resourcePath = getResourcePath(url, position);
  const resourceQuery = resourcePath.hasResourceId && position === 'first'
    ? ''
    : getResourceQuery(url);

  if (!resourcePath.hasResourceId && !resourceQuery) {
    return '';
  }

  const port = url.port ? `:${url.port}` : '';
  const origin = `${url.protocol}//${url.hostname.toLowerCase()}${port}`;
  const path = resourcePath.hasResourceId ? resourcePath.value : (url.pathname || '/');
  return `${origin}${path}${resourceQuery}`;
}

function getResourcePath(url, position) {
  const segments = url.pathname
    .split('/')
    .map((segment) => safeDecodeUrlPath(segment).trim())
    .filter(Boolean);
  const resourceIdIndexes = [];

  for (let index = 0; index < segments.length; index += 1) {
    if (isResourceIdPathSegment(segments[index])) {
      resourceIdIndexes.push(index);
    }
  }

  if (resourceIdIndexes.length === 0) {
    return {
      value: url.pathname || '/',
      hasResourceId: false
    };
  }

  const resourceIdIndex = position === 'first'
    ? resourceIdIndexes[0]
    : resourceIdIndexes.at(-1);
  const identitySegments = position === 'first'
    ? segments.slice(0, resourceIdIndex + 1)
    : segments;

  return {
    value: `/${identitySegments.map(encodePathSegment).join('/')}`,
    hasResourceId: true
  };
}

function getResourceQuery(url) {
  const entries = [];

  for (const [key, value] of url.searchParams.entries()) {
    const canonicalKey = getResourceIdQueryParamName(key);

    if (canonicalKey && value.trim()) {
      entries.push([canonicalKey, value]);
    }
  }

  entries.sort((left, right) => (
    left[0].localeCompare(right[0]) || left[1].localeCompare(right[1])
  ));
  const params = new URLSearchParams(entries);
  const query = params.toString();
  return query ? `?${query}` : '';
}

function getResourceIdQueryParamName(key) {
  const normalizedKey = String(key).trim().toLowerCase().replace(/[-_]/g, '');
  return RESOURCE_ID_QUERY_PARAM_NAMES.get(normalizedKey) || '';
}

function normalizeUrlSurface(url) {
  removeTrackingParams(url);
  trimTrailingPathSlash(url);
  url.searchParams.sort();
}

function removeTrackingParams(url) {
  for (const key of [...url.searchParams.keys()]) {
    const normalizedKey = key.toLowerCase();

    if (normalizedKey.startsWith('utm_') || TRACKING_PARAMS.has(normalizedKey)) {
      url.searchParams.delete(key);
    }
  }
}

function isHashRoute(hash) {
  return HASH_ROUTE_PATTERN.test(String(hash ?? ''));
}

function isResourceIdPathSegment(segment) {
  const normalizedSegment = String(segment).toLowerCase();

  if (/^[0-9]{5,}$/.test(normalizedSegment)) {
    return !isCalendarDateSegment(normalizedSegment);
  }

  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(normalizedSegment)) {
    return true;
  }

  return /^(?=.*[a-z])(?=.*\d)[a-z0-9_-]{6,}$/.test(normalizedSegment);
}

function isCalendarDateSegment(segment) {
  if (!/^\d{8}$/.test(segment)) {
    return false;
  }

  const year = Number(segment.slice(0, 4));
  const month = Number(segment.slice(4, 6));
  const day = Number(segment.slice(6, 8));
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day;
}

function trimTrailingPathSlash(url) {
  if (url.pathname !== '/' && url.pathname.endsWith('/')) {
    url.pathname = url.pathname.replace(/\/+$/, '');
  }
}

function safeDecodeUrlPath(value) {
  try {
    return decodeURI(value);
  } catch {
    return value;
  }
}

function encodePathSegment(segment) {
  return encodeURIComponent(segment).replace(/%2F/gi, '/');
}
