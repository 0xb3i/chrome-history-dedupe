export const PINNED_URLS_STORAGE_KEY = 'deduped-history-pinned-urls';
export const TITLE_OVERRIDES_STORAGE_KEY = 'deduped-history-title-overrides';
export const GROUP_NAME_OVERRIDES_STORAGE_KEY = 'deduped-history-group-name-overrides';
export const RENAME_DRAFTS_STORAGE_KEY = 'deduped-history-rename-drafts';
export const LAST_SEARCH_STATE_STORAGE_KEY = 'deduped-history-last-search-state';

const RENAME_DRAFT_TTL_MS = 15 * 60 * 1000;
const SEARCH_RANGE_VALUES = new Set(['day', 'week', 'month', 'quarter', 'all']);

export async function loadPinnedUrlKeys() {
  const storedValue = await getStorageValue(PINNED_URLS_STORAGE_KEY, []);
  return normalizeStringSet(storedValue);
}

export async function savePinnedUrlKeys(keys) {
  await setStorageValue(PINNED_URLS_STORAGE_KEY, [...normalizeStringSet(keys)]);
}

export async function loadTitleOverrides() {
  const storedValue = await getStorageValue(TITLE_OVERRIDES_STORAGE_KEY, {});
  return normalizeTitleOverrideMap(storedValue);
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

  const overrides = await loadGroupNameOverrides();
  overrides.set(normalizedKey, normalizedName);
  await saveGroupNameOverrides(overrides);
}

export async function deleteGroupNameOverride(key) {
  const normalizedKey = normalizeStorageKey(key);

  if (!normalizedKey) {
    return;
  }

  const overrides = await loadGroupNameOverrides();
  overrides.delete(normalizedKey);
  await saveGroupNameOverrides(overrides);
}

export async function saveTitleOverride(key, title) {
  await saveTitleOverridesForKeys([key], title);
}

export async function saveTitleOverridesForKeys(keys, title) {
  const normalizedTitle = normalizeTitle(title);

  const normalizedKeys = normalizeStringSet(keys);

  if (normalizedKeys.size === 0 || !normalizedTitle) {
    throw new Error('Title override requires a URL key and title');
  }

  const overrides = await loadTitleOverrides();
  for (const normalizedKey of normalizedKeys) {
    overrides.set(normalizedKey, normalizedTitle);
  }
  await saveTitleOverrides(overrides);
}

export async function deleteTitleOverrides(keys) {
  const normalizedKeys = normalizeStringSet(keys);

  if (normalizedKeys.size === 0) {
    return;
  }

  const overrides = await loadTitleOverrides();
  for (const normalizedKey of normalizedKeys) {
    overrides.delete(normalizedKey);
  }
  await saveTitleOverrides(overrides);
}

export async function saveRenameDraft(draft) {
  const normalizedDraft = normalizeRenameDraft(draft);

  if (!normalizedDraft) {
    throw new Error('Rename draft requires an id, URL key, and URL');
  }

  const drafts = await loadRenameDrafts();
  drafts.set(normalizedDraft.id, normalizedDraft);
  await saveRenameDrafts(pruneRenameDrafts(drafts));
}

export async function loadRenameDraft(id) {
  const drafts = await loadRenameDrafts();
  return drafts.get(normalizeStorageKey(id));
}

export async function deleteRenameDraft(id) {
  const drafts = await loadRenameDrafts();
  drafts.delete(normalizeStorageKey(id));
  await saveRenameDrafts(drafts);
}

export function normalizeStringSet(value) {
  const values = value instanceof Set ? [...value] : value;

  if (!Array.isArray(values)) {
    return new Set();
  }

  return new Set(values.map(normalizeStorageKey).filter(Boolean));
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

async function saveTitleOverrides(overrides) {
  await setStorageValue(TITLE_OVERRIDES_STORAGE_KEY, Object.fromEntries(overrides));
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

function normalizeStorageKey(value) {
  return String(value ?? '').trim();
}

function normalizeTitle(value) {
  return String(value ?? '').trim().replace(/\s+/g, ' ');
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
  const storageArea = getChromeStorageArea();

  if (storageArea) {
    await chromeStorageSet(storageArea, { [key]: value });
    return;
  }

  writeLegacyStorageValue(key, value);
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
