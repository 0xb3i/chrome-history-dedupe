import { getPageIdentityKey } from './page-identity.js';

export const PINNED_URLS_STORAGE_KEY = 'deduped-history-pinned-urls';
export const TITLE_OVERRIDES_STORAGE_KEY = 'deduped-history-title-overrides';
export const GROUP_NAME_OVERRIDES_STORAGE_KEY = 'deduped-history-group-name-overrides';
export const RENAME_DRAFTS_STORAGE_KEY = 'deduped-history-rename-drafts';
export const LAST_SEARCH_STATE_STORAGE_KEY = 'deduped-history-last-search-state';
export const TITLE_OVERRIDES_MIGRATION_STORAGE_KEY = 'deduped-history-title-overrides-migration';
export const CAPTURED_PAGE_TITLES_STORAGE_KEY = 'deduped-history-captured-page-titles';

const RENAME_DRAFT_TTL_MS = 15 * 60 * 1000;
const MAX_CAPTURED_PAGE_TITLES = 5000;
const SEARCH_RANGE_VALUES = new Set(['day', 'week', 'month', 'quarter', 'all']);
const TITLE_OVERRIDES_MIGRATION_VERSION = 5;
const STORAGE_MUTATION_LOCK_NAME = 'deduped-history-storage-mutation';
const storageMutationQueues = new Map();

export async function loadPinnedUrlKeys() {
  const storedValue = await getStorageValue(PINNED_URLS_STORAGE_KEY, []);
  return normalizePinnedPageKeys(storedValue);
}

export async function savePinnedUrlKeys(keys) {
  await withStorageMutationLock(PINNED_URLS_STORAGE_KEY, async () => {
    await setStorageValue(PINNED_URLS_STORAGE_KEY, [...normalizePinnedPageKeys(keys)]);
  });
}

export async function togglePinnedUrlKey(key, shouldPin, relatedKeys = []) {
  const normalizedKey = normalizePageKey(key);
  const normalizedRelatedKeys = normalizePinnedPageKeys(relatedKeys);

  if (!normalizedKey) {
    return loadPinnedUrlKeys();
  }

  return withStorageMutationLock(PINNED_URLS_STORAGE_KEY, async () => {
    const keys = normalizePinnedPageKeys(
      await getStorageValue(PINNED_URLS_STORAGE_KEY, [])
    );

    if (shouldPin) {
      keys.add(normalizedKey);
    } else {
      keys.delete(normalizedKey);
      for (const relatedKey of normalizedRelatedKeys) {
        keys.delete(relatedKey);
      }
    }

    await setStorageValue(PINNED_URLS_STORAGE_KEY, [...keys]);
    return keys;
  });
}

export async function loadTitleOverrides() {
  const migrationVersion = Number(await getStorageValue(
    TITLE_OVERRIDES_MIGRATION_STORAGE_KEY,
    0
  ));

  if (migrationVersion >= TITLE_OVERRIDES_MIGRATION_VERSION) {
    return normalizePageTitleOverrideMap(
      await getStorageValue(TITLE_OVERRIDES_STORAGE_KEY, {})
    );
  }

  return withStorageMutationLock(TITLE_OVERRIDES_STORAGE_KEY, async () => {
    const currentVersion = Number(await getStorageValue(
      TITLE_OVERRIDES_MIGRATION_STORAGE_KEY,
      0
    ));
    const overrides = normalizePageTitleOverrideMap(
      await getStorageValue(TITLE_OVERRIDES_STORAGE_KEY, {})
    );

    if (currentVersion < TITLE_OVERRIDES_MIGRATION_VERSION) {
      await setStorageValues({
        [TITLE_OVERRIDES_STORAGE_KEY]: serializePageTitleOverrides(overrides),
        [TITLE_OVERRIDES_MIGRATION_STORAGE_KEY]: TITLE_OVERRIDES_MIGRATION_VERSION
      });
    }

    return overrides;
  });
}

export async function loadCapturedPageTitles() {
  const storedValue = await getStorageValue(CAPTURED_PAGE_TITLES_STORAGE_KEY, {});
  return normalizeCapturedPageMap(storedValue);
}

export async function saveCapturedPageTitle(key, title, options = {}) {
  return saveCapturedPageTitles([{ key, title, ...normalizeCapturedTitleSaveOptions(options) }]);
}

export async function saveCapturedPageTitles(entries) {
  const normalizedEntries = normalizeCapturedTitleSaveEntries(entries);

  if (normalizedEntries.length === 0) {
    return;
  }

  await withStorageMutationLock(CAPTURED_PAGE_TITLES_STORAGE_KEY, async () => {
    const storedValue = await getStorageValue(CAPTURED_PAGE_TITLES_STORAGE_KEY, {});
    const records = normalizeCapturedTitleRecords(storedValue);
    let changed = false;

    for (const entry of normalizedEntries) {
      const current = records.get(entry.key);
      const nextResolvedUrl = entry.resolvedUrl || current?.resolvedUrl || '';

      if (
        current?.title === entry.title &&
        (current?.resolvedUrl || '') === nextResolvedUrl
      ) {
        continue;
      }

      records.set(entry.key, {
        title: entry.title,
        updatedAt: entry.updatedAt,
        ...(nextResolvedUrl ? { resolvedUrl: nextResolvedUrl } : {})
      });
      changed = true;
    }

    if (!changed) {
      return;
    }

    const recentRecords = [...records]
      .sort(([, left], [, right]) => right.updatedAt - left.updatedAt)
      .slice(0, MAX_CAPTURED_PAGE_TITLES);
    await setStorageValue(CAPTURED_PAGE_TITLES_STORAGE_KEY, Object.fromEntries(recentRecords));
  });
}

export function updateCapturedTitleRecords(value, key, title, updatedAt, resolvedUrl) {
  const records = normalizeCapturedTitleRecords(value);
  const normalizedKey = normalizeStorageKey(key);
  const normalizedTitle = normalizeTitle(title);
  const normalizedUpdatedAt = Number(updatedAt);
  const normalizedResolvedUrl = normalizeStorageKey(resolvedUrl);
  const current = records.get(normalizedKey);
  const nextResolvedUrl = normalizedResolvedUrl || current?.resolvedUrl || '';

  if (
    !normalizedKey ||
    !normalizedTitle ||
    !Number.isFinite(normalizedUpdatedAt) ||
    (current?.title === normalizedTitle && (current?.resolvedUrl || '') === nextResolvedUrl)
  ) {
    return { records, changed: false };
  }

  records.set(normalizedKey, {
    title: normalizedTitle,
    updatedAt: normalizedUpdatedAt,
    ...(nextResolvedUrl ? { resolvedUrl: nextResolvedUrl } : {})
  });
  return { records, changed: true };
}

export async function loadGroupNameOverrides() {
  const storedValue = await getStorageValue(GROUP_NAME_OVERRIDES_STORAGE_KEY, {});
  return normalizeTitleOverrideMap(storedValue);
}

export async function loadLastSearchState() {
  const storedValue = await getStorageValue(LAST_SEARCH_STATE_STORAGE_KEY, null);
  return storedValue ? normalizeLastSearchState(storedValue) : null;
}

export async function saveLastSearchState(state) {
  await setStorageValue(LAST_SEARCH_STATE_STORAGE_KEY, normalizeLastSearchState(state));
}

export async function saveGroupNameOverride(key, name) {
  const normalizedKey = normalizeStorageKey(key);
  const normalizedName = normalizeTitle(name);

  if (!normalizedKey || !normalizedName) {
    throw new Error('Group rename requires a group key and name');
  }

  await withStorageMutationLock(GROUP_NAME_OVERRIDES_STORAGE_KEY, async () => {
    const overrides = normalizeTitleOverrideMap(
      await getStorageValue(GROUP_NAME_OVERRIDES_STORAGE_KEY, {})
    );
    overrides.set(normalizedKey, normalizedName);
    await saveGroupNameOverrides(overrides);
  });
}

export async function deleteGroupNameOverride(key) {
  const normalizedKey = normalizeStorageKey(key);

  if (!normalizedKey) {
    return;
  }

  await withStorageMutationLock(GROUP_NAME_OVERRIDES_STORAGE_KEY, async () => {
    const overrides = normalizeTitleOverrideMap(
      await getStorageValue(GROUP_NAME_OVERRIDES_STORAGE_KEY, {})
    );
    overrides.delete(normalizedKey);
    await saveGroupNameOverrides(overrides);
  });
}

export async function saveTitleOverride(key, title, options = {}) {
  const normalizedKey = normalizePageKey(key);
  const normalizedTitle = normalizeTitle(title);
  const normalizedTargetUrl = normalizeStorageKey(options?.targetUrl || options?.url || key);
  const hasExplicitUpdatedAt = options?.updatedAt !== undefined;
  const explicitUpdatedAt = Number(options?.updatedAt);

  if (
    !normalizedKey ||
    !normalizedTitle ||
    (hasExplicitUpdatedAt && !Number.isFinite(explicitUpdatedAt))
  ) {
    throw new Error('Title override requires a URL key and title');
  }

  await withStorageMutationLock(TITLE_OVERRIDES_STORAGE_KEY, async () => {
    const overrides = normalizePageTitleOverrideMap(
      await getStorageValue(TITLE_OVERRIDES_STORAGE_KEY, {})
    );
    const current = overrides.get(normalizedKey);
    const updatedAt = hasExplicitUpdatedAt
      ? explicitUpdatedAt
      : Math.max(Date.now(), Number(current?.updatedAt ?? 0) + 1);

    if (hasExplicitUpdatedAt && Number(current?.updatedAt ?? 0) > updatedAt) {
      return;
    }

    overrides.set(normalizedKey, {
      title: normalizedTitle,
      targetUrl: normalizedTargetUrl,
      updatedAt
    });
    await setStorageValues({
      [TITLE_OVERRIDES_STORAGE_KEY]: serializePageTitleOverrides(overrides),
      [TITLE_OVERRIDES_MIGRATION_STORAGE_KEY]: TITLE_OVERRIDES_MIGRATION_VERSION
    });
  });
}

export async function deleteTitleOverrides(keys) {
  const normalizedKeys = normalizeStringSet(keys);

  if (normalizedKeys.size === 0) {
    return;
  }

  await withStorageMutationLock(TITLE_OVERRIDES_STORAGE_KEY, async () => {
    const overrides = normalizePageTitleOverrideMap(
      await getStorageValue(TITLE_OVERRIDES_STORAGE_KEY, {})
    );

    for (const normalizedKey of normalizedKeys) {
      overrides.delete(normalizedKey);
      overrides.delete(normalizePageKey(normalizedKey));
    }

    await setStorageValues({
      [TITLE_OVERRIDES_STORAGE_KEY]: serializePageTitleOverrides(overrides),
      [TITLE_OVERRIDES_MIGRATION_STORAGE_KEY]: TITLE_OVERRIDES_MIGRATION_VERSION
    });
  });
}

export async function saveRenameDraft(draft) {
  const normalizedDraft = normalizeRenameDraft(draft);

  if (!normalizedDraft) {
    throw new Error('Rename draft requires an id, URL key, and URL');
  }

  await withStorageMutationLock(RENAME_DRAFTS_STORAGE_KEY, async () => {
    const drafts = await loadRenameDrafts();
    drafts.set(normalizedDraft.id, normalizedDraft);
    await saveRenameDrafts(pruneRenameDrafts(drafts));
  });
}

export async function loadRenameDraft(id) {
  const drafts = await loadRenameDrafts();
  return drafts.get(normalizeStorageKey(id));
}

export async function deleteRenameDraft(id) {
  await withStorageMutationLock(RENAME_DRAFTS_STORAGE_KEY, async () => {
    const drafts = await loadRenameDrafts();
    drafts.delete(normalizeStorageKey(id));
    await saveRenameDrafts(drafts);
  });
}

export function normalizeStringSet(value) {
  const values = value instanceof Set ? [...value] : value;

  if (!Array.isArray(values)) {
    return new Set();
  }

  return new Set(values.map(normalizeStorageKey).filter(Boolean));
}

export function normalizePinnedPageKeys(value) {
  return new Set(
    [...normalizeStringSet(value)].map(normalizePageKey).filter(Boolean)
  );
}

export function normalizeTitleOverrideMap(value) {
  const entries = value instanceof Map ? [...value.entries()] : Object.entries(value ?? {});
  const overrides = new Map();

  for (const [key, title] of entries) {
    const normalizedKey = normalizeStorageKey(key);
    const normalizedTitle = normalizeTitle(title);

    if (normalizedKey && normalizedTitle) {
      overrides.set(normalizedKey, normalizedTitle);
    }
  }

  return overrides;
}

export function normalizePageTitleOverrideMap(value) {
  const entries = value instanceof Map ? [...value.entries()] : Object.entries(value ?? {});
  const overrides = new Map();

  entries.forEach(([storedKey, storedRecord], sourceOrder) => {
    const normalizedStoredKey = normalizeStorageKey(storedKey);
    const record = normalizePageTitleOverrideRecord(storedRecord, normalizedStoredKey);

    if (!normalizedStoredKey || !record) {
      return;
    }

    const isStructuredRecord = storedRecord && typeof storedRecord === 'object';
    const pageKey = normalizePageKey(
      isStructuredRecord ? normalizedStoredKey : (record.targetUrl || normalizedStoredKey)
    );
    if (!pageKey) {
      return;
    }

    const current = overrides.get(pageKey);
    const candidate = { ...record, sourceOrder };
    if (!current || comparePageTitleOverrideRecords(candidate, current) > 0) {
      overrides.set(pageKey, candidate);
    }
  });

  return new Map(
    [...overrides].map(([key, { sourceOrder, ...record }]) => [key, record])
  );
}

export function normalizeCapturedTitleMap(value) {
  return new Map(
    [...normalizeCapturedTitleRecords(value)].map(([key, record]) => [key, record.title])
  );
}

export function normalizeCapturedPageMap(value) {
  return new Map(
    [...normalizeCapturedTitleRecords(value)].map(([key, record]) => [
      key,
      {
        title: record.title,
        ...(record.resolvedUrl ? { resolvedUrl: record.resolvedUrl } : {})
      }
    ])
  );
}

export function normalizeLastSearchState(value) {
  const query = normalizeTitle(value?.query);
  const range = normalizeSearchRange(value?.range);
  const showRenamedOnly = Boolean(value?.showRenamedOnly);
  const showMinimalMode = Boolean(value?.showMinimalMode);

  return {
    query,
    range,
    showRenamedOnly,
    showMinimalMode
  };
}

async function loadRenameDrafts() {
  const storedValue = await getStorageValue(RENAME_DRAFTS_STORAGE_KEY, {});
  const entries = Object.entries(storedValue ?? {});
  const drafts = new Map();

  for (const [id, draft] of entries) {
    const normalizedDraft = normalizeRenameDraft({ ...draft, id });

    if (normalizedDraft) {
      drafts.set(normalizedDraft.id, normalizedDraft);
    }
  }

  return pruneRenameDrafts(drafts);
}

async function saveGroupNameOverrides(overrides) {
  await setStorageValue(GROUP_NAME_OVERRIDES_STORAGE_KEY, Object.fromEntries(overrides));
}

async function saveRenameDrafts(drafts) {
  await setStorageValue(RENAME_DRAFTS_STORAGE_KEY, Object.fromEntries(drafts));
}

function pruneRenameDrafts(drafts) {
  const now = Date.now();
  const freshDrafts = new Map();

  for (const [id, draft] of drafts) {
    if (now - draft.createdAt <= RENAME_DRAFT_TTL_MS) {
      freshDrafts.set(id, draft);
    }
  }

  return freshDrafts;
}

function normalizeRenameDraft(draft) {
  const id = normalizeStorageKey(draft?.id);
  const titleOverrideKey = normalizeStorageKey(draft?.titleOverrideKey);
  const url = normalizeStorageKey(draft?.url);
  const currentTitle = normalizeTitle(draft?.currentTitle || draft?.url);
  const originalTitle = normalizeTitle(draft?.originalTitle || draft?.currentTitle || draft?.url);
  const createdAt = Number(draft?.createdAt || Date.now());

  if (!id || !titleOverrideKey || !url || !Number.isFinite(createdAt)) {
    return null;
  }

  return {
    id,
    titleOverrideKey,
    url,
    currentTitle,
    originalTitle,
    createdAt
  };
}

function normalizeCapturedTitleRecords(value) {
  const entries = value instanceof Map ? [...value.entries()] : Object.entries(value ?? {});
  const records = new Map();

  for (const [key, record] of entries) {
    const normalizedKey = normalizeStorageKey(key);
    const normalizedTitle = normalizeTitle(typeof record === 'string' ? record : record?.title);
    const updatedAt = typeof record === 'string' ? 0 : Number(record?.updatedAt);
    const resolvedUrl = normalizeStorageKey(record?.resolvedUrl);

    if (normalizedKey && normalizedTitle && Number.isFinite(updatedAt)) {
      records.set(normalizedKey, {
        title: normalizedTitle,
        updatedAt,
        ...(resolvedUrl ? { resolvedUrl } : {})
      });
    }
  }

  return records;
}

function normalizeCapturedTitleSaveOptions(options) {
  const value = typeof options === 'number' ? { updatedAt: options } : (options ?? {});
  return {
    resolvedUrl: value.resolvedUrl,
    updatedAt: value.updatedAt
  };
}

function normalizeCapturedTitleSaveEntries(entries) {
  const normalizedByKey = new Map();

  for (const entry of Array.isArray(entries) ? entries : []) {
    const key = normalizeStorageKey(entry?.key);
    const title = normalizeTitle(entry?.title);
    const resolvedUrl = normalizeStorageKey(entry?.resolvedUrl);
    const updatedAt = Number(entry?.updatedAt ?? Date.now());

    if (!key || !title || !Number.isFinite(updatedAt)) {
      continue;
    }

    const current = normalizedByKey.get(key);
    if (!current || updatedAt >= current.updatedAt) {
      normalizedByKey.set(key, {
        key,
        title,
        resolvedUrl,
        updatedAt
      });
    }
  }

  return [...normalizedByKey.values()];
}

function normalizePageTitleOverrideRecord(value, fallbackTargetUrl) {
  const normalizedTitle = normalizeTitle(
    typeof value === 'string' ? value : value?.title
  );
  const targetUrl = normalizeStorageKey(
    typeof value === 'string' ? fallbackTargetUrl : (value?.targetUrl || fallbackTargetUrl)
  );
  const updatedAtValue = typeof value === 'string' ? 0 : Number(value?.updatedAt ?? 0);

  if (!normalizedTitle || !targetUrl || !Number.isFinite(updatedAtValue)) {
    return null;
  }

  return {
    title: normalizedTitle,
    targetUrl,
    updatedAt: updatedAtValue
  };
}

function comparePageTitleOverrideRecords(left, right) {
  const byUpdatedAt = left.updatedAt - right.updatedAt;
  return byUpdatedAt || left.sourceOrder - right.sourceOrder;
}

function serializePageTitleOverrides(overrides) {
  return Object.fromEntries(
    [...overrides].map(([key, record]) => [key, {
      title: record.title,
      targetUrl: record.targetUrl,
      updatedAt: record.updatedAt
    }])
  );
}

function normalizePageKey(value) {
  const normalizedValue = normalizeStorageKey(value);
  return normalizedValue ? getPageIdentityKey(normalizedValue) : '';
}

function normalizeStorageKey(value) {
  return String(value ?? '').trim();
}

function normalizeTitle(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/\p{Cf}+/gu, '')
    .trim()
    .replace(/\s+/g, ' ');
}

function normalizeSearchRange(value) {
  const normalizedRange = normalizeStorageKey(value);
  return SEARCH_RANGE_VALUES.has(normalizedRange) ? normalizedRange : 'month';
}

async function getStorageValue(key, fallbackValue) {
  const storageArea = getChromeStorageArea();

  if (storageArea) {
    const storedItems = await chromeStorageGet(storageArea, key);
    const value = storedItems[key];

    if (value !== undefined) {
      return value;
    }
  }

  return readLegacyStorageValue(key, fallbackValue);
}

async function setStorageValue(key, value) {
  await setStorageValues({ [key]: value });
}

async function setStorageValues(values) {
  const storageArea = getChromeStorageArea();

  if (storageArea) {
    await chromeStorageSet(storageArea, values);
    return;
  }

  for (const [key, value] of Object.entries(values)) {
    writeLegacyStorageValue(key, value);
  }
}

function withStorageMutationLock(scope, callback) {
  const normalizedScope = normalizeStorageKey(scope) || 'default';

  if (globalThis.navigator?.locks?.request) {
    return globalThis.navigator.locks.request(
      `${STORAGE_MUTATION_LOCK_NAME}:${normalizedScope}`,
      { mode: 'exclusive' },
      callback
    );
  }

  const queue = storageMutationQueues.get(normalizedScope) ?? Promise.resolve();
  const task = queue.then(callback, callback);
  const settledTask = task.then(() => undefined, () => undefined);
  storageMutationQueues.set(normalizedScope, settledTask);
  void settledTask.then(() => {
    if (storageMutationQueues.get(normalizedScope) === settledTask) {
      storageMutationQueues.delete(normalizedScope);
    }
  });
  return task;
}

function getChromeStorageArea() {
  return globalThis.chrome?.storage?.local;
}

function chromeStorageGet(storageArea, key) {
  return new Promise((resolve, reject) => {
    storageArea.get(key, (items) => {
      const lastError = globalThis.chrome?.runtime?.lastError;

      if (lastError) {
        reject(new Error(lastError.message));
        return;
      }

      resolve(items ?? {});
    });
  });
}

function chromeStorageSet(storageArea, value) {
  return new Promise((resolve, reject) => {
    storageArea.set(value, () => {
      const lastError = globalThis.chrome?.runtime?.lastError;

      if (lastError) {
        reject(new Error(lastError.message));
        return;
      }

      resolve();
    });
  });
}

function readLegacyStorageValue(key, fallbackValue) {
  try {
    const rawValue = globalThis.localStorage?.getItem(key);
    return rawValue ? JSON.parse(rawValue) : fallbackValue;
  } catch {
    return fallbackValue;
  }
}

function writeLegacyStorageValue(key, value) {
  try {
    globalThis.localStorage?.setItem(key, JSON.stringify(value));
  } catch {
    // Storage failures are surfaced by callers through status text when useful.
  }
}
