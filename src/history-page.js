import {
  applyPinnedStateToGroups,
  applyTitleOverridesToItems,
  dedupeHistoryItems,
  filterHistoryItemsByQuery,
  formatHistoryUrlForGroup,
  getHistoryItemPinKey,
  getHistoryItemTitleOverrideKey,
  groupHistoryItems
} from './history-utils.js';
import {
  GROUP_NAME_OVERRIDES_STORAGE_KEY,
  deleteGroupNameOverride,
  loadPinnedUrlKeys,
  loadGroupNameOverrides,
  loadLastSearchState,
  loadTitleOverrides,
  normalizeStringSet,
  normalizeTitleOverrideMap,
  PINNED_URLS_STORAGE_KEY,
  deleteTitleOverrides,
  saveGroupNameOverride,
  saveLastSearchState,
  savePinnedUrlKeys,
  saveTitleOverridesForKeys,
  TITLE_OVERRIDES_STORAGE_KEY
} from './storage.js';

const DEDUPE_MODE = 'page-title';
const MINIMAL_DEDUPE_MODE = 'minimal-service';
const MAX_RESULTS = 10000;
const VISIT_COUNT_CONCURRENCY = 32;
const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

const form = document.querySelector('#search-form');
const queryInput = document.querySelector('#query');
const rangeSelect = document.querySelector('#range');
const shortcutSettingsButton = document.querySelector('#shortcut-settings');
const statusPill = document.querySelector('#status-pill');
const summary = document.querySelector('#summary');
const results = document.querySelector('#results');
const emptyState = document.querySelector('#empty-state');
const renameDialog = createRenameDialog();
const groupRenameDialog = createGroupRenameDialog();
let currentGroups = [];
let currentFlatItems = [];
let pinnedUrlKeys = new Set();
let groupNameOverrides = new Map();
let titleOverrides = new Map();
let isInitialized = false;
let renameDialogItem = null;
let groupRenameDialogGroup = null;
let showRenamedOnly = false;
let showMinimalMode = false;

const currentYearDateFormatter = new Intl.DateTimeFormat('zh-CN', {
  month: 'long',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit'
});
const otherYearDateFormatter = new Intl.DateTimeFormat('zh-CN', {
  dateStyle: 'medium',
  timeStyle: 'short'
});
const nameCollator = new Intl.Collator('zh-CN', {
  numeric: true,
  sensitivity: 'base'
});

form.addEventListener('submit', (event) => {
  event.preventDefault();
  runSearch();
});
shortcutSettingsButton?.addEventListener('click', () => {
  globalThis.chrome?.tabs?.create?.({ url: 'chrome://extensions/shortcuts' });
});
document.body.append(renameDialog.element);
document.body.append(groupRenameDialog.element);

init();

async function init() {
  setLoading();

  try {
    const [loadedPinnedUrlKeys, loadedGroupNameOverrides, loadedTitleOverrides, lastSearchState] =
      await Promise.all([
        loadPinnedUrlKeys(),
        loadGroupNameOverrides(),
        loadTitleOverrides(),
        loadLastSearchState()
      ]);
    pinnedUrlKeys = loadedPinnedUrlKeys;
    groupNameOverrides = loadedGroupNameOverrides;
    titleOverrides = loadedTitleOverrides;
    applyLastSearchState(lastSearchState);
    isInitialized = true;
    addStorageChangeListener();
    await runSearch();
  } catch (error) {
    renderError(error);
  }
}

async function runSearch() {
  const query = queryInput.value.trim();

  setLoading();

  try {
    await rememberCurrentSearchState();
    const startTime = getStartTime(rangeSelect.value);
    const endTime = Date.now();
    const rawItems = await searchChromeHistory({
      text: '',
      startTime,
      endTime,
      maxResults: MAX_RESULTS
    });
    const itemsWithWindowVisitCounts = await applyVisitCountsForWindow(rawItems, startTime, endTime);
    const renamedItems = applyTitleOverridesToItems(itemsWithWindowVisitCounts, titleOverrides);
    const matchedItems = filterHistoryItemsByQuery(renamedItems, query);
    const visibleItems = showRenamedOnly
      ? matchedItems.filter((item) => item.isTitleRenamed)
      : matchedItems;
    const titleDedupedItems = dedupeHistoryItems(visibleItems, DEDUPE_MODE);
    const dedupedItems = showMinimalMode
      ? dedupeHistoryItems(titleDedupedItems, MINIMAL_DEDUPE_MODE)
      : titleDedupedItems;
    const groupedItems = applyGroupNameOverridesToGroups(groupHistoryItems(dedupedItems, 'domain'));

    currentGroups = showRenamedOnly ? [] : groupedItems;
    currentFlatItems = showRenamedOnly ? sortItemsByDisplayName(dedupedItems) : [];
    renderSummary(matchedItems.length, dedupedItems.length, groupedItems.length);
    if (showRenamedOnly) {
      renderFlatResults(applyPinnedStateToItems(currentFlatItems, pinnedUrlKeys));
    } else {
      renderResults(applyPinnedStateToGroups(groupedItems, pinnedUrlKeys), {
        expandAll: Boolean(query)
      });
    }
    setStatus(showRenamedOnly ? `${dedupedItems.length} 条已重命名` : `${dedupedItems.length} 条`);
  } catch (error) {
    renderError(error);
  }
}

function applyLastSearchState(state) {
  if (!state) {
    return;
  }

  queryInput.value = state.query || '';
  setRangeSelectValue(state.range);
  showRenamedOnly = Boolean(state.showRenamedOnly);
  showMinimalMode = Boolean(state.showMinimalMode);
}

function setRangeSelectValue(value) {
  if ([...rangeSelect.options].some((option) => option.value === value)) {
    rangeSelect.value = value;
  }
}

async function rememberCurrentSearchState() {
  try {
    await saveLastSearchState({
      query: queryInput.value,
      range: rangeSelect.value,
      showRenamedOnly,
      showMinimalMode
    });
  } catch {
    // Remembering the last search is helpful, but it should never block searching.
  }
}

function searchChromeHistory(query) {
  return new Promise((resolve, reject) => {
    if (!globalThis.chrome?.history?.search) {
      reject(new Error('Chrome history API unavailable'));
      return;
    }

    chrome.history.search(query, (items) => {
      const lastError = chrome.runtime?.lastError;

      if (lastError) {
        reject(new Error(lastError.message));
        return;
      }

      resolve(items ?? []);
    });
  });
}

async function applyVisitCountsForWindow(items, startTime, endTime) {
  if (startTime <= 0 || !globalThis.chrome?.history?.getVisits) {
    return items;
  }

  return mapWithConcurrency(items, VISIT_COUNT_CONCURRENCY, async (item) => {
    const windowVisitCount = await getVisitCountForWindow(item.url, startTime, endTime);

    if (windowVisitCount === undefined) {
      return item;
    }

    return {
      ...item,
      visitCount: windowVisitCount
    };
  });
}

function getVisitCountForWindow(url, startTime, endTime) {
  if (!url) {
    return Promise.resolve(undefined);
  }

  return new Promise((resolve) => {
    chrome.history.getVisits({ url }, (visits) => {
      const lastError = chrome.runtime?.lastError;

      if (lastError) {
        resolve(undefined);
        return;
      }

      resolve(
        (visits ?? []).filter((visit) => {
          const visitTime = Number(visit?.visitTime ?? 0);
          return visitTime >= startTime && visitTime <= endTime;
        }).length
      );
    });
  });
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  });

  await Promise.all(workers);
  return results;
}

function renderSummary(rawCount, dedupedCount, groupCount) {
  summary.replaceChildren(
    createRenameMetric(),
    createMinimalModeMetric(),
    createCollapseMetric()
  );
}

function renderResults(groups, options = {}) {
  const openGroupKeys = options.preserveOpenState ? getOpenGroupKeys() : null;
  results.replaceChildren();

  if (groups.length === 0) {
    emptyState.hidden = false;
    emptyState.textContent = '没有匹配结果。';
    return;
  }

  emptyState.hidden = true;

  groups.forEach((group) => {
    const isOpen = options.expandAll || (openGroupKeys ? openGroupKeys.has(group.key) : false);
    results.append(createGroupItem(group, isOpen));
  });
}

function renderFlatResults(items) {
  results.replaceChildren();

  if (items.length === 0) {
    emptyState.hidden = false;
    emptyState.textContent = '没有匹配结果。';
    return;
  }

  emptyState.hidden = true;

  for (const item of items) {
    results.append(createResultItem(item));
  }
}

function applyPinnedStateToItems(items, pinnedKeys) {
  const [group] = applyPinnedStateToGroups(
    [
      {
        key: 'renamed-pages',
        label: 'renamed-pages',
        items
      }
    ],
    pinnedKeys
  );

  return group?.items ?? [];
}

function sortItemsByDisplayName(items) {
  return [...items].sort((left, right) => {
    const byName = nameCollator.compare(getItemDisplayName(left), getItemDisplayName(right));
    const byTime = Number(right?.lastVisitTime ?? 0) - Number(left?.lastVisitTime ?? 0);
    return byName || byTime || String(left?.url ?? '').localeCompare(String(right?.url ?? ''));
  });
}

function getItemDisplayName(item) {
  return String(item?.title || item?.url || '').trim();
}

function createGroupItem(group, isOpen) {
  const row = document.createElement('li');
  row.className = 'result-group';

  const details = document.createElement('details');
  details.className = 'result-group-details';
  details.dataset.groupKey = group.key;
  details.open = isOpen;

  const header = document.createElement('summary');
  header.className = 'result-group-summary';

  const title = document.createElement('span');
  title.className = 'result-group-title';
  title.textContent = group.label;
  title.title = group.originalLabel || group.key;

  const meta = document.createElement('span');
  meta.className = 'result-group-meta';
  meta.textContent = formatGroupMeta(group);

  header.append(title, createGroupRenameButton(group), meta);

  const list = document.createElement('ol');
  list.className = 'result-group-list';

  for (const item of group.items) {
    list.append(createResultItem(item, group.key));
  }

  details.append(header, list);
  row.append(details);
  return row;
}

function createGroupRenameButton(group) {
  const button = document.createElement('button');
  button.className = 'item-action-button group-rename-button';
  button.type = 'button';
  button.title = '修改分组名';
  button.setAttribute('aria-label', '修改分组名');
  button.append(createEditIcon());
  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    renameGroup(group);
  });

  return button;
}

function createGroupRenameDialog() {
  return createRenameDialogShell({
    title: '修改分组名',
    fieldLabel: '分组名',
    extraKey: 'key',
    onCancel: closeGroupRenameDialog,
    onRestore: restoreGroupOriginalName,
    onDialogCancel: () => {
      groupRenameDialogGroup = null;
    },
    onSubmit: saveGroupRenameDialogName
  });
}

function createResultItem(item, groupKey) {
  const row = document.createElement('li');
  row.className = 'result-item';
  if (item.isPinned) {
    row.classList.add('result-item-pinned');
  }

  const titleRow = document.createElement('div');
  titleRow.className = 'result-title-row';

  const title = document.createElement('a');
  title.className = 'result-title';
  title.href = item.url;
  title.target = '_blank';
  title.rel = 'noreferrer';
  title.textContent = item.title || item.url || '(无标题)';

  titleRow.append(title, createRenameButton(item), createPinButton(item));

  const meta = document.createElement('div');
  meta.className = 'result-meta';
  meta.append(
    createTag(formatVisitTime(item.lastVisitTime)),
    createTag(`${item.totalVisitCount || item.visitCount || 0} 次访问`)
  );

  row.append(titleRow);
  if (!showMinimalMode) {
    const url = document.createElement('div');
    url.className = 'result-url';
    url.title = item.url || '';
    url.textContent = formatHistoryUrlForGroup(item, groupKey);
    row.append(url);
  }
  row.append(meta);
  return row;
}

function createRenameButton(item) {
  const button = document.createElement('button');
  button.className = 'item-action-button rename-button';
  button.type = 'button';
  button.title = '修改网页名';
  button.setAttribute('aria-label', '修改网页名');
  button.append(createEditIcon());
  button.addEventListener('click', () => {
    renameItem(item);
  });

  return button;
}

function createRenameDialog() {
  return createRenameDialogShell({
    title: '修改网页名',
    fieldLabel: '网页名',
    extraKey: 'url',
    showExtra: false,
    onCancel: closeRenameDialog,
    onRestore: restoreRenameDialogOriginalTitle,
    onDialogCancel: () => {
      renameDialogItem = null;
    },
    onSubmit: saveRenameDialogTitle
  });
}

function createRenameDialogShell({
  title: titleText,
  fieldLabel,
  extraKey,
  showExtra = true,
  onCancel,
  onRestore,
  onDialogCancel,
  onSubmit
}) {
  const element = document.createElement('dialog');
  element.className = 'rename-dialog';

  const formElement = document.createElement('form');
  formElement.className = 'rename-dialog-form';
  formElement.method = 'dialog';

  const header = document.createElement('header');
  header.className = 'rename-dialog-header';

  const title = document.createElement('h2');
  title.textContent = titleText;

  const extra = document.createElement('p');
  extra.className = 'rename-dialog-url';

  if (showExtra) {
    header.append(title, extra);
  } else {
    header.append(title);
  }

  const field = document.createElement('label');
  field.className = 'field';

  const label = document.createElement('span');
  label.textContent = fieldLabel;

  const input = document.createElement('input');
  input.type = 'text';
  input.autocomplete = 'off';

  field.append(label, input);

  const status = document.createElement('p');
  status.className = 'rename-dialog-status';
  status.setAttribute('role', 'status');

  const actions = document.createElement('div');
  actions.className = 'rename-dialog-actions';

  const cancelButton = document.createElement('button');
  cancelButton.className = 'secondary-button';
  cancelButton.type = 'button';
  cancelButton.textContent = '取消';

  const restoreButton = document.createElement('button');
  restoreButton.className = 'secondary-button';
  restoreButton.type = 'button';
  restoreButton.textContent = '还原原名';

  const saveButton = document.createElement('button');
  saveButton.className = 'primary-button';
  saveButton.type = 'submit';
  saveButton.textContent = '保存';

  actions.append(restoreButton, cancelButton, saveButton);
  formElement.append(header, field, status, actions);
  element.append(formElement);

  cancelButton.addEventListener('click', () => {
    onCancel();
  });

  restoreButton.addEventListener('click', () => {
    onRestore();
  });

  element.addEventListener('cancel', () => {
    onDialogCancel();
  });

  formElement.addEventListener('submit', (event) => {
    event.preventDefault();
    onSubmit();
  });

  return {
    element,
    input,
    [extraKey]: extra,
    restoreButton,
    status
  };
}

function createPinButton(item) {
  const label = getPinButtonLabel(item);
  const button = document.createElement('button');
  button.className = 'item-action-button pin-button';
  button.type = 'button';
  button.title = label;
  button.setAttribute('aria-pressed', String(Boolean(item.isPinned)));
  button.setAttribute('aria-label', label);
  button.append(createPinIcon());
  button.addEventListener('click', () => {
    togglePinnedItem(item);
  });

  return button;
}

function getPinButtonLabel(item) {
  return item.isPinned ? '取消置顶此网页' : '置顶此网页';
}

function createEditIcon() {
  const icon = createBaseIcon();

  for (const pathData of [
    'M12 20h9',
    'M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z'
  ]) {
    const path = document.createElementNS(SVG_NAMESPACE, 'path');
    path.setAttribute('d', pathData);
    icon.append(path);
  }

  return icon;
}

function createPinIcon() {
  const icon = createBaseIcon();

  for (const pathData of [
    'M12 17v5',
    'M9 10.8a2 2 0 0 1-1.1 1.8l-1.8.9A2 2 0 0 0 5 15.3V16h14v-.7a2 2 0 0 0-1.1-1.8l-1.8-.9a2 2 0 0 1-1.1-1.8V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z'
  ]) {
    const path = document.createElementNS(SVG_NAMESPACE, 'path');
    path.setAttribute('d', pathData);
    icon.append(path);
  }

  return icon;
}

function createBaseIcon() {
  const icon = document.createElementNS(SVG_NAMESPACE, 'svg');
  icon.setAttribute('aria-hidden', 'true');
  icon.setAttribute('focusable', 'false');
  icon.setAttribute('viewBox', '0 0 24 24');
  icon.setAttribute('fill', 'none');
  icon.setAttribute('stroke', 'currentColor');
  icon.setAttribute('stroke-linecap', 'round');
  icon.setAttribute('stroke-linejoin', 'round');
  return icon;
}

function createRenameMetric() {
  const metric = document.createElement('button');
  metric.className = 'metric metric-button';
  metric.type = 'button';
  metric.setAttribute('aria-pressed', String(showRenamedOnly));
  metric.title = showRenamedOnly ? '显示全部页面' : '只显示已重命名页面';

  const metricLabel = document.createElement('span');
  metricLabel.textContent = '重命名';

  metric.append(metricLabel);
  metric.addEventListener('click', () => {
    showRenamedOnly = !showRenamedOnly;
    runSearch();
  });

  return metric;
}

function createMinimalModeMetric() {
  const metric = document.createElement('button');
  metric.className = 'metric metric-button';
  metric.type = 'button';
  metric.setAttribute('aria-pressed', String(showMinimalMode));
  metric.title = showMinimalMode ? '关闭极简模式' : '开启极简模式';

  const metricLabel = document.createElement('span');
  metricLabel.textContent = '极简';

  metric.append(metricLabel);
  metric.addEventListener('click', () => {
    showMinimalMode = !showMinimalMode;
    runSearch();
  });

  return metric;
}

function createCollapseMetric() {
  const metric = document.createElement('button');
  metric.className = 'metric metric-button';
  metric.type = 'button';
  metric.disabled = showRenamedOnly || currentGroups.length === 0;
  metric.title = '折叠所有分组';

  const metricLabel = document.createElement('span');
  metricLabel.textContent = '折叠';

  metric.append(metricLabel);
  metric.addEventListener('click', () => {
    collapseAllGroups();
  });

  return metric;
}

function collapseAllGroups() {
  for (const details of results.querySelectorAll('.result-group-details[open]')) {
    details.open = false;
  }
}

function createTag(text) {
  const tag = document.createElement('span');
  tag.className = 'tag';
  tag.textContent = text;
  return tag;
}

function renderError(error) {
  currentGroups = [];
  currentFlatItems = [];
  results.replaceChildren();
  summary.replaceChildren();
  emptyState.hidden = false;
  emptyState.textContent = error.message;
  setStatus('错误');
}

function setLoading() {
  results.replaceChildren();
  summary.replaceChildren();
  emptyState.hidden = false;
  emptyState.textContent = '正在搜索...';
  setStatus('搜索中');
}

function setStatus(text) {
  statusPill.textContent = text;
}

function renameItem(item) {
  renameDialogItem = item;
  renameDialog.input.value = item.title || item.url || '';
  renameDialog.url.textContent = item.url || '';
  renameDialog.status.textContent = '';
  renameDialog.restoreButton.disabled = !item.isTitleRenamed;

  openRenameDialog(renameDialog);
}

async function saveRenameDialogTitle() {
  if (!renameDialogItem) {
    return;
  }

  const normalizedTitle = getRenameDialogInputValue(renameDialog);

  if (!normalizedTitle) {
    renameDialog.status.textContent = '标题不能为空。';
    renameDialog.input.focus();
    return;
  }

  try {
    await saveTitleOverridesForKeys(getRenameDialogTitleOverrideKeys(), normalizedTitle);
    titleOverrides = await loadTitleOverrides();
    closeRenameDialog();
    await runSearch();
  } catch (error) {
    renameDialog.status.textContent = error.message || '保存失败。';
  }
}

async function restoreRenameDialogOriginalTitle() {
  if (!renameDialogItem) {
    return;
  }

  const originalTitle = renameDialogItem.originalTitle || renameDialogItem.url || '';
  renameDialog.input.value = originalTitle;

  try {
    await deleteTitleOverrides(getRenameDialogTitleOverrideKeys());
    titleOverrides = await loadTitleOverrides();
    closeRenameDialog();
    await runSearch();
  } catch (error) {
    renameDialog.status.textContent = error.message || '还原失败。';
  }
}

function getRenameDialogTitleOverrideKeys() {
  if (!renameDialogItem) {
    return [];
  }

  if (Array.isArray(renameDialogItem.titleOverrideKeys) && renameDialogItem.titleOverrideKeys.length) {
    return renameDialogItem.titleOverrideKeys;
  }

  return [renameDialogItem.titleOverrideKey || getHistoryItemTitleOverrideKey(renameDialogItem)];
}

function renameGroup(group) {
  groupRenameDialogGroup = group;
  groupRenameDialog.input.value = group.label || group.key || '';
  groupRenameDialog.key.textContent = group.originalLabel || group.key || '';
  groupRenameDialog.status.textContent = '';
  groupRenameDialog.restoreButton.disabled = !group.isGroupRenamed;

  openRenameDialog(groupRenameDialog);
}

async function saveGroupRenameDialogName() {
  if (!groupRenameDialogGroup) {
    return;
  }

  const normalizedName = getRenameDialogInputValue(groupRenameDialog);

  if (!normalizedName) {
    groupRenameDialog.status.textContent = '分组名不能为空。';
    groupRenameDialog.input.focus();
    return;
  }

  try {
    await saveGroupNameOverride(groupRenameDialogGroup.key, normalizedName);
    groupNameOverrides = await loadGroupNameOverrides();
    closeGroupRenameDialog();
    await runSearch();
  } catch (error) {
    groupRenameDialog.status.textContent = error.message || '保存失败。';
  }
}

async function restoreGroupOriginalName() {
  if (!groupRenameDialogGroup) {
    return;
  }

  groupRenameDialog.input.value = groupRenameDialogGroup.originalLabel || groupRenameDialogGroup.key || '';

  try {
    await deleteGroupNameOverride(groupRenameDialogGroup.key);
    groupNameOverrides = await loadGroupNameOverrides();
    closeGroupRenameDialog();
    await runSearch();
  } catch (error) {
    groupRenameDialog.status.textContent = error.message || '还原失败。';
  }
}

function closeGroupRenameDialog() {
  groupRenameDialogGroup = null;
  closeDialogElement(groupRenameDialog.element);
}

function applyGroupNameOverridesToGroups(groups) {
  return groups
    .map((group, index) => {
      const overrideLabel = groupNameOverrides.get(group.key);

      if (!overrideLabel) {
        return {
          ...group,
          originalIndex: index,
          originalLabel: group.label,
          isGroupRenamed: false
        };
      }

      return {
        ...group,
        originalIndex: index,
        originalLabel: group.label,
        label: overrideLabel,
        isGroupRenamed: true
      };
    })
    .sort((left, right) => {
      const byRename = Number(right.isGroupRenamed) - Number(left.isGroupRenamed);
      const byName = nameCollator.compare(getGroupDisplayName(left), getGroupDisplayName(right));
      return byRename || byName || left.originalIndex - right.originalIndex;
    })
    .map((group) => {
      const { originalIndex, ...publicGroup } = group;
      return publicGroup;
    });
}

function getGroupDisplayName(group) {
  return String(group?.label || group?.key || '').trim();
}

function closeRenameDialog() {
  renameDialogItem = null;
  closeDialogElement(renameDialog.element);
}

function openRenameDialog(dialog) {
  if (typeof dialog.element.showModal === 'function') {
    dialog.element.showModal();
  } else {
    dialog.element.setAttribute('open', '');
  }

  dialog.input.focus();
  dialog.input.select();
}

function closeDialogElement(element) {
  if (typeof element.close === 'function') {
    element.close();
  } else {
    element.removeAttribute('open');
  }
}

function getRenameDialogInputValue(dialog) {
  return dialog.input.value.trim().replace(/\s+/g, ' ');
}

async function togglePinnedItem(item) {
  const pinKey = item.pinKey || getHistoryItemPinKey(item);

  if (pinnedUrlKeys.has(pinKey)) {
    pinnedUrlKeys.delete(pinKey);
  } else {
    pinnedUrlKeys.add(pinKey);
  }

  try {
    await savePinnedUrlKeys(pinnedUrlKeys);
    if (showRenamedOnly) {
      renderFlatResults(applyPinnedStateToItems(currentFlatItems, pinnedUrlKeys));
      return;
    }

    renderResults(applyPinnedStateToGroups(currentGroups, pinnedUrlKeys), {
      preserveOpenState: true
    });
  } catch {
    setStatus('置顶保存失败');
  }
}

function getOpenGroupKeys() {
  return new Set(
    [...results.querySelectorAll('.result-group-details[open]')]
      .map((details) => details.dataset.groupKey)
      .filter(Boolean)
  );
}

function addStorageChangeListener() {
  globalThis.chrome?.storage?.onChanged?.addListener((changes, areaName) => {
    if (!isInitialized || areaName !== 'local') {
      return;
    }

    if (changes[PINNED_URLS_STORAGE_KEY]) {
      pinnedUrlKeys = normalizeStringSet(changes[PINNED_URLS_STORAGE_KEY].newValue);
      if (showRenamedOnly) {
        renderFlatResults(applyPinnedStateToItems(currentFlatItems, pinnedUrlKeys));
      } else {
        renderResults(applyPinnedStateToGroups(currentGroups, pinnedUrlKeys), {
          preserveOpenState: true
        });
      }
    }

    if (changes[TITLE_OVERRIDES_STORAGE_KEY]) {
      titleOverrides = normalizeTitleOverrideMap(changes[TITLE_OVERRIDES_STORAGE_KEY].newValue);
      runSearch();
    }

    if (changes[GROUP_NAME_OVERRIDES_STORAGE_KEY]) {
      groupNameOverrides = normalizeTitleOverrideMap(
        changes[GROUP_NAME_OVERRIDES_STORAGE_KEY].newValue
      );
      runSearch();
    }
  });
}

function formatGroupMeta(group) {
  const baseMeta = `${group.itemCount} 条 · ${formatVisitTime(group.lastVisitTime)}`;

  if (!group.pinnedCount) {
    return baseMeta;
  }

  return `${baseMeta} · 置顶 ${group.pinnedCount}`;
}

function getStartTime(range) {
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;

  if (range === 'day') return now - day;
  if (range === 'week') return now - 7 * day;
  if (range === 'month') return now - 30 * day;
  if (range === 'quarter') return now - 90 * day;
  return 0;
}

function formatVisitTime(value) {
  const time = Number(value);

  if (!Number.isFinite(time) || time <= 0) {
    return '未知时间';
  }

  const date = new Date(time);
  const formatter = date.getFullYear() === new Date().getFullYear()
    ? currentYearDateFormatter
    : otherYearDateFormatter;

  return formatter.format(date);
}
