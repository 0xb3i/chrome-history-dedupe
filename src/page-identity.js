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

// Resource rules are scoped to a known site and route. Unknown URL components
// stay in the identity: their spelling alone cannot prove that they are UI state.
const FEISHU_DOMAIN_ROOTS = ['feishu.cn', 'larksuite.com', 'larkoffice.com'];
const FEISHU_RESOURCE_ROUTE = /^\/(base|docs|docx|file|mindnotes|sheets|wiki)\/([A-Za-z0-9_-]+)\/?$/;
const FEISHU_PRESENTATION_PARAMS = new Set([
  'from', 'open_in_browser', 'create_from'
]);
const MCP_RESOURCE_ROUTE = /^(\/tae\/mcp_server\/[A-Za-z0-9_-]+)(?:\/(?:tools|inspector))?\/?$/;

export function normalizeUrlKey(rawUrl) {
  const rawValue = String(rawUrl ?? '');
  try {
    const url = new URL(rawValue);
    normalizeUrlSurface(url);
    return url.href;
  } catch {
    return rawValue;
  }
}

export function getPageIdentityKey(rawUrl) {
  const normalizedUrl = normalizeUrlKey(rawUrl);
  try {
    const url = new URL(normalizedUrl);
    if (!/^https?:$/.test(url.protocol)) return normalizedUrl;

    if (isGoogleSearchUrl(url)) {
      const query = url.searchParams.get('q')?.trim() ?? '';
      url.search = query ? new URLSearchParams([['q', query]]).toString() : '';
      url.hash = '';
      return url.href;
    }

    const feishuRoot = getDomainRoot(url.hostname, FEISHU_DOMAIN_ROOTS);
    const feishuRoute = url.pathname.match(FEISHU_RESOURCE_ROUTE);
    if (feishuRoot && !url.port && feishuRoute) {
      url.hostname = feishuRoot;
      url.pathname = `/${feishuRoute[1]}/${feishuRoute[2]}`;
      for (const key of FEISHU_PRESENTATION_PARAMS) url.searchParams.delete(key);
      // A sheet/base can use fragment state to identify a child resource.
      if (!['base', 'sheets'].includes(feishuRoute[1])) url.hash = '';
      return url.href;
    }

    if (isByteCloudHost(url.hostname)) {
      const resourcePath = url.pathname.match(MCP_RESOURCE_ROUTE)?.[1];
      if (resourcePath) {
        url.pathname = resourcePath;
        return url.href;
      }

      // Only normalize a hash router after recognizing the same business route.
      const hashRoute = url.hash.match(/^#(!?)(\/.*)$/);
      if (hashRoute) {
        const route = new URL(hashRoute[2], url.origin);
        const hashResourcePath = route.pathname.match(MCP_RESOURCE_ROUTE)?.[1];
        if (hashResourcePath && route.origin === url.origin) {
          normalizeUrlSurface(route);
          url.hash = `${hashRoute[1]}${hashResourcePath}${route.search}${route.hash}`;
        }
      }
    }
    return url.href;
  } catch {
    return normalizedUrl;
  }
}

function isGoogleSearchUrl(url) {
  return url.pathname === '/search' &&
    /(^|\.)google\.[a-z]{2,}(?:\.[a-z]{2,})?$/.test(url.hostname);
}

function getDomainRoot(hostname, roots) {
  return roots.find((root) => hostname === root || hostname.endsWith(`.${root}`));
}

function isByteCloudHost(hostname) {
  return Boolean(getDomainRoot(hostname, ['bytedance.net', 'byted.org'])) &&
    hostname.split('.')[0].startsWith('cloud');
}

function normalizeUrlSurface(url) {
  for (const key of [...url.searchParams.keys()]) {
    const normalizedKey = key.toLowerCase();
    if (normalizedKey.startsWith('utm_') || TRACKING_PARAMS.has(normalizedKey)) {
      url.searchParams.delete(key);
    }
  }
  url.searchParams.sort();
}
