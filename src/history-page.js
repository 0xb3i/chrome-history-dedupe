import {
  applyPinnedStateToGroups,
  applyPinnedStateToItemsByName,
  applyTitleOverridesToItems,
  compareDisplayNames,
  filterHistoryItemsByQuery,
  formatHistoryUrlForGroup,
  getHistoryItemPinKey,
  getHistoryItemTitleOverrideKey,
  groupHistoryItems,
  groupHistoryItemsByCandidateRank
} from './history-utils.js';
import {
  deleteGroupNameOverride,
  deleteTitleOverrides,
  GROUP_NAME_OVERRIDES_STORAGE_KEY,
  loadGroupNameOverrides,
  loadLastSearchState,
  loadPinnedUrlKeys,
  loadTitleOverrides,
  normalizePageTitleOverrideMap,
  normalizePinnedPageKeys,
  normalizeTitleOverrideMap,
  PINNED_URLS_STORAGE_KEY,
  saveGroupNameOverride,
  saveLastSearchState,
  saveTitleOverride,
  TITLE_OVERRIDES_STORAGE_KEY,
  togglePinnedUrlKey
} from './storage.js';
import { createHistoryIndexStore } from './history-index/store.js';
import {
  HISTORY_INDEX_ENSURE_MESSAGE,
  HISTORY_INDEX_UPDATED_MESSAGE
} from './history-index/protocol.js';

const SNAPSHOT_RENDER_DEBOUNCE_MS = 50;
const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const historyIndexStore = createHistoryIndexStore();

const form = document.querySelector('#search-form');
const queryInput = document.querySelector('#query');
const rangeSelect = document.querySelector('#range');
const shortcutSettingsButton = document.querySelector('#shortcut-settings');
const statusPill = document.querySelector('#status-pill');
const summary = document.querySelector('#summary');
const results = document.querySelector('#results');
const emptyState = document.querySelector('#empty-state');
const appVersion = document.querySelector('#app-version');
const renameDialog = createRenameDialog();
const groupRenameDialog = createGroupRenameDialog();
let rangeDropdown = null;
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
let latestSearchRequestId = 0;
let pageItemsSnapshot = [];
let committedPageItemsSnapshot = [];
let pageItemsRange = '';
let hasPageItemsSnapshot = false;
let searchSnapshot = null;
let loadedIndexRevision = 0;
let snapshotRenderTimer = null;

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
form.addEventListener('submit', (event) => {
  event.preventDefault();
  runSearch();
});
setupRangeSelect();
shortcutSettingsButton?.addEventListener('click', () => {
  globalThis.chrome?.tabs?.create?.({ url: 'chrome://extensions/shortcuts' });
});
document.body.append(renameDialog.element);
document.body.append(groupRenameDialog.element);
renderRuntimeVersion();

init();

function renderRuntimeVersion() {
  const version = globalThis.chrome?.runtime?.getManifest?.()?.version;

  if (!appVersion || !version) {
    return;
  }

  appVersion.textContent = `v${version}`;
  appVersion.title = `当前扩展版本 v${version}`;
}

async function init() {
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
    selectQueryInputOnPopupOpen();
    isInitialized = true;
    addStorageChangeListener();
    addHistoryIndexUpdateListener();
    const cachedIndex = await historyIndexStore.loadRange(rangeSelect.value);

    if (cachedIndex) applyLoadedRangeIndex(cachedIndex, rangeSelect.value);
    else await loadRangeIndexWithBackgroundEnsure(rangeSelect.value);

    void requestHistoryIndex(HISTORY_INDEX_ENSURE_MESSAGE).catch(() => {});
  } catch (error) {
    renderError(error);
  }
}

async function runSearch() {
  const searchRequestId = ++latestSearchRequestId;
  const requestedQuery = queryInput.value;
  const requestedRange = rangeSelect.value;

  try {
    void rememberCurrentSearchState();
    if (hasPageItemsSnapshot && pageItemsRange === requestedRange) {
      setLoading();
      searchSnapshot = createSearchSnapshotFromPageItems(pageItemsSnapshot, requestedQuery);
      renderHistorySnapshot();
      return;
    }

    setLoading();
    const loadedIndex = await historyIndexStore.loadRange(requestedRange) ??
      await loadRangeIndexWithBackgroundEnsure(requestedRange, { apply: false });

    if (!isLatestSearchRequest(searchRequestId)) {
      return;
    }

    applyLoadedRangeIndex(loadedIndex, requestedRange, requestedQuery);
  } catch (error) {
    if (isLatestSearchRequest(searchRequestId)) {
      renderError(error);
    }
  }
}

async function loadRangeIndexWithBackgroundEnsure(range, options = {}) {
  const response = await requestHistoryIndex(HISTORY_INDEX_ENSURE_MESSAGE);
  if (!response?.ok) throw new Error(response?.error || '历史索引尚未就绪。');
  const loadedIndex = await historyIndexStore.loadRange(range);
  if (!loadedIndex) throw new Error('历史索引尚未就绪，请稍后重试。');
  if (options.apply !== false) applyLoadedRangeIndex(loadedIndex, range);
  return loadedIndex;
}

function applyLoadedRangeIndex(index, range, query = queryInput.value) {
  committedPageItemsSnapshot = index.pageItems;
  pageItemsSnapshot = applyLatestTitleOverrides(committedPageItemsSnapshot);
  pageItemsRange = range;
  hasPageItemsSnapshot = true;
  loadedIndexRevision = Number(index.revision ?? loadedIndexRevision);
  searchSnapshot = createSearchSnapshotFromPageItems(pageItemsSnapshot, query);
  renderHistorySnapshot();
}

function applyLatestTitleOverrides(items) {
  const baseItems = items.map((item) => {
    if (!item?.isTitleRenamed) return item;
    const { renameUpdatedAt: _renameUpdatedAt, ...baseItem } = item;
    return {
      ...baseItem,
      title: item.originalTitle || item.url || '',
      isTitleRenamed: false
    };
  });
  return applyTitleOverridesToItems(baseItems, titleOverrides);
}

function renderHistorySnapshot() {
  if (snapshotRenderTimer !== null) {
    clearTimeout(snapshotRenderTimer);
    snapshotRenderTimer = null;
  }

  const query = queryInput.value.trim();
  const snapshot = searchSnapshot ?? createSearchSnapshotFromPageItems(pageItemsSnapshot, query);
  const matchedItems = snapshot.matchedItems;
  const visibleItems = showRenamedOnly
    ? matchedItems.filter((item) => item.isTitleRenamed)
    : matchedItems;
  const baseGroups = query
    ? groupHistoryItemsByCandidateRank(visibleItems, 'domain')
    : groupHistoryItems(visibleItems, 'domain');
  const groupedItems = applyGroupNameOverridesToGroups(baseGroups);

  currentGroups = showRenamedOnly ? [] : groupedItems;
  currentFlatItems = showRenamedOnly ? sortItemsByDisplayName(visibleItems) : [];
  renderSummary(snapshot.pageItemCount, visibleItems.length, groupedItems.length);

  if (showRenamedOnly) {
    renderFlatResults(applyPinnedStateToItems(currentFlatItems, pinnedUrlKeys));
  } else {
    renderResults(applyPinnedStateToGroups(groupedItems, pinnedUrlKeys), {
      expandAll: Boolean(query)
    });
  }

  setStatus(showRenamedOnly ? `${visibleItems.length} 条已重命名` : `${visibleItems.length} 条`);
}

function createSearchSnapshotFromPageItems(pageItems, query) {
  return {
    pageItemCount: pageItems.length,
    matchedItems: filterHistoryItemsByQuery(pageItems, String(query ?? '').trim())
  };
}

function scheduleSnapshotRender() {
  if (!hasPageItemsSnapshot) {
    return;
  }

  if (snapshotRenderTimer !== null) {
    clearTimeout(snapshotRenderTimer);
  }

  snapshotRenderTimer = setTimeout(() => {
    snapshotRenderTimer = null;
    renderHistorySnapshot();
  }, SNAPSHOT_RENDER_DEBOUNCE_MS);
}

function isLatestSearchRequest(searchRequestId) {
  if (searchRequestId !== latestSearchRequestId) {
    return false;
  }

  return true;
}

function applyLastSearchState(state) {
  if (!state) {
    return;
  }

  queryInput.value = state.query || '';
  setRangeSelectValue(state.range);
  showRenamedOnly = Boolean(state.showRenamedOnly);
  showMinimalMode = Boolean(state.showMinimalMode);
  syncMinimalModePresentation();
}

function selectQueryInputOnPopupOpen() {
  if (!document.body.classList.contains('popup-body')) {
    return;
  }

  queryInput.focus();
  queryInput.select();
}

function setRangeSelectValue(value) {
  if ([...rangeSelect.options].some((option) => option.value === value)) {
    rangeSelect.value = value;
    syncRangeSelect();
  }
}

function setupRangeSelect() {
  if (!rangeSelect) {
    return;
  }

  const wrapper = document.createElement('div');
  wrapper.className = 'range-combobox';

  const button = document.createElement('button');
  button.className = 'range-combobox-button';
  button.type = 'button';
  button.setAttribute('aria-haspopup', 'listbox');
  button.setAttribute('aria-expanded', 'false');

  const value = document.createElement('span');
  value.className = 'range-combobox-value';

  const arrow = document.createElement('span');
  arrow.className = 'range-combobox-arrow';
  arrow.setAttribute('aria-hidden', 'true');

  const menu = document.createElement('div');
  menu.className = 'range-combobox-menu';
  menu.hidden = true;
  menu.setAttribute('role', 'listbox');

  const options = [...rangeSelect.options].map((selectOption) => {
    const option = document.createElement('button');
    option.className = 'range-combobox-option';
    option.type = 'button';
    option.textContent = selectOption.textContent;
    option.dataset.value = selectOption.value;
    option.setAttribute('role', 'option');
    option.addEventListener('click', () => {
      rangeSelect.value = selectOption.value;
      syncRangeSelect();
      closeRangeSelect();
      button.focus();
    });
    option.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        focusRelativeRangeOption(option, event.key === 'ArrowDown' ? 1 : -1);
      } else if (event.key === 'Home' || event.key === 'End') {
        event.preventDefault();
        focusBoundaryRangeOption(event.key === 'Home' ? 'first' : 'last');
      } else if (event.key === 'Escape') {
        event.preventDefault();
        closeRangeSelect();
        button.focus();
      }
    });
    menu.append(option);
    return option;
  });

  button.append(value, arrow);
  wrapper.append(button, menu);
  rangeSelect.classList.add('native-select-hidden');
  rangeSelect.insertAdjacentElement('afterend', wrapper);
  rangeDropdown = { button, menu, options, value, wrapper };

  button.addEventListener('click', () => {
    if (menu.hidden) {
      openRangeSelect();
    } else {
      closeRangeSelect();
    }
  });
  button.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') {
      return;
    }

    event.preventDefault();
    openRangeSelect();
    focusSelectedRangeOption(event.key === 'ArrowDown' ? 1 : -1);
  });
  document.addEventListener('click', (event) => {
    if (!wrapper.contains(event.target)) {
      closeRangeSelect();
    }
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closeRangeSelect();
    }
  });
  syncRangeSelect();
}

function openRangeSelect() {
  if (!rangeDropdown) {
    return;
  }

  rangeDropdown.menu.hidden = false;
  rangeDropdown.button.setAttribute('aria-expanded', 'true');
}

function closeRangeSelect() {
  if (!rangeDropdown) {
    return;
  }

  rangeDropdown.menu.hidden = true;
  rangeDropdown.button.setAttribute('aria-expanded', 'false');
}

function syncRangeSelect() {
  if (!rangeDropdown) {
    return;
  }

  const selected = [...rangeSelect.options].find((option) => option.value === rangeSelect.value);
  const selectedLabel = selected?.textContent ?? '';
  rangeDropdown.value.textContent = selectedLabel;
  rangeDropdown.button.title = selectedLabel;

  for (const option of rangeDropdown.options) {
    const isSelected = option.dataset.value === rangeSelect.value;
    option.setAttribute('aria-selected', String(isSelected));
  }
}

function focusSelectedRangeOption(direction) {
  if (!rangeDropdown) {
    return;
  }

  const selectedIndex = rangeDropdown.options.findIndex(
    (option) => option.dataset.value === rangeSelect.value
  );
  const fallbackIndex = direction > 0 ? 0 : rangeDropdown.options.length - 1;
  rangeDropdown.options[selectedIndex >= 0 ? selectedIndex : fallbackIndex]?.focus();
}

function focusRelativeRangeOption(currentOption, direction) {
  if (!rangeDropdown) {
    return;
  }

  const currentIndex = rangeDropdown.options.indexOf(currentOption);
  const nextIndex = Math.min(
    rangeDropdown.options.length - 1,
    Math.max(0, currentIndex + direction)
  );
  rangeDropdown.options[nextIndex]?.focus();
}

function focusBoundaryRangeOption(boundary) {
  if (!rangeDropdown) {
    return;
  }

  const index = boundary === 'first' ? 0 : rangeDropdown.options.length - 1;
  rangeDropdown.options[index]?.focus();
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
  const fragment = document.createDocumentFragment();

  groups.forEach((group) => {
    const isOpen = options.expandAll || (openGroupKeys ? openGroupKeys.has(group.key) : false);
    fragment.append(createGroupItem(group, isOpen));
  });
  results.append(fragment);
}

function renderFlatResults(items) {
  results.replaceChildren();

  if (items.length === 0) {
    emptyState.hidden = false;
    emptyState.textContent = '没有匹配结果。';
    return;
  }

  emptyState.hidden = true;
  const fragment = document.createDocumentFragment();

  for (const item of items) {
    fragment.append(createResultItem(item));
  }
  results.append(fragment);
}

function applyPinnedStateToItems(items, pinnedKeys) {
  return applyPinnedStateToItemsByName(items, pinnedKeys);
}

function sortItemsByDisplayName(items) {
  return [...items].sort((left, right) => {
    const byName = compareDisplayNames(getItemDisplayName(left), getItemDisplayName(right));
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

  const content = document.createElement('div');
  content.className = 'result-content';

  const actions = document.createElement('div');
  actions.className = 'result-actions';

  const title = document.createElement('a');
  title.className = 'result-title';
  title.href = item.url;
  title.target = '_blank';
  title.rel = 'noreferrer';
  title.textContent = item.title || item.url || '(无标题)';

  titleRow.append(title);
  if (item.isTitleRenamed) {
    titleRow.append(createRenamedTag());
  }
  actions.append(createRenameButton(item), createPinButton(item));

  const meta = document.createElement('div');
  meta.className = 'result-meta';
  const visitCount = item.totalVisitCount ?? item.visitCount ?? 0;
  meta.append(
    createTag(formatVisitTime(item.lastVisitTime)),
    createTag(`${visitCount} 次访问`)
  );

  content.append(titleRow);
  const url = document.createElement('div');
  url.className = 'result-url';
  url.title = item.url || '';
  url.textContent = formatHistoryUrlForGroup(item, groupKey);
  content.append(url);
  content.append(meta);
  row.append(content, actions);
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
    rememberCurrentSearchState();
    scheduleSnapshotRender();
  });

  return metric;
}

function createMinimalModeMetric() {
  const metric = document.createElement('button');
  metric.className = 'metric metric-button minimal-mode-metric';
  metric.type = 'button';
  metric.setAttribute('aria-pressed', String(showMinimalMode));
  metric.title = showMinimalMode ? '关闭极简模式' : '开启极简模式';

  const metricLabel = document.createElement('span');
  metricLabel.textContent = '极简';

  metric.append(metricLabel);
  metric.addEventListener('click', () => {
    showMinimalMode = !showMinimalMode;
    syncMinimalModePresentation(metric);
    void rememberCurrentSearchState();
  });

  return metric;
}

function syncMinimalModePresentation(metric = null) {
  document.body.classList.toggle('minimal-mode', showMinimalMode);

  if (!metric) {
    return;
  }

  metric.setAttribute('aria-pressed', String(showMinimalMode));
  metric.title = showMinimalMode ? '关闭极简模式' : '开启极简模式';
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

function createRenamedTag() {
  const tag = document.createElement('span');
  tag.className = 'renamed-tag';
  tag.textContent = '已重命名';
  tag.title = '当前显示的是自定义网页名';
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
    await saveTitleOverride(getRenameDialogTitleOverrideKey(), normalizedTitle, {
      targetUrl: renameDialogItem.url
    });
    closeRenameDialog();
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
    closeRenameDialog();
  } catch (error) {
    renameDialog.status.textContent = error.message || '还原失败。';
  }
}

function getRenameDialogTitleOverrideKey() {
  if (!renameDialogItem) {
    return '';
  }

  return renameDialogItem.titleOverrideKey || getHistoryItemTitleOverrideKey(renameDialogItem);
}

function getRenameDialogTitleOverrideKeys() {
  if (!renameDialogItem) {
    return [];
  }

  return [
    ...(renameDialogItem.titleOverrideKeys ?? []),
    getRenameDialogTitleOverrideKey()
  ];
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
    scheduleSnapshotRender();
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
    scheduleSnapshotRender();
  } catch (error) {
    groupRenameDialog.status.textContent = error.message || '还原失败。';
  }
}

function closeGroupRenameDialog() {
  groupRenameDialogGroup = null;
  closeDialogElement(groupRenameDialog.element);
}

function applyGroupNameOverridesToGroups(groups) {
  return groups.map((group) => {
      const overrideLabel = groupNameOverrides.get(group.key);

      if (!overrideLabel) {
        return {
          ...group,
          originalLabel: group.label,
          isGroupRenamed: false
        };
      }

      return {
        ...group,
        originalLabel: group.label,
        label: overrideLabel,
        isGroupRenamed: true
      };
    });
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
  const shouldPin = !item.isPinned;

  try {
    pinnedUrlKeys = await togglePinnedUrlKey(
      pinKey,
      shouldPin,
      item.activePinKeys ?? item.pinKeys ?? []
    );
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
      pinnedUrlKeys = normalizePinnedPageKeys(changes[PINNED_URLS_STORAGE_KEY].newValue);
      if (showRenamedOnly) {
        renderFlatResults(applyPinnedStateToItems(currentFlatItems, pinnedUrlKeys));
      } else {
        renderResults(applyPinnedStateToGroups(currentGroups, pinnedUrlKeys), {
          preserveOpenState: true
        });
      }
    }

    if (changes[GROUP_NAME_OVERRIDES_STORAGE_KEY]) {
      groupNameOverrides = normalizeTitleOverrideMap(
        changes[GROUP_NAME_OVERRIDES_STORAGE_KEY].newValue
      );
      scheduleSnapshotRender();
    }

    if (changes[TITLE_OVERRIDES_STORAGE_KEY]) {
      titleOverrides = normalizePageTitleOverrideMap(
        changes[TITLE_OVERRIDES_STORAGE_KEY].newValue
      );
      pageItemsSnapshot = applyLatestTitleOverrides(committedPageItemsSnapshot);
      searchSnapshot = createSearchSnapshotFromPageItems(pageItemsSnapshot, queryInput.value);
      scheduleSnapshotRender();
    }
  });
}

function addHistoryIndexUpdateListener() {
  globalThis.chrome?.runtime?.onMessage?.addListener((message) => {
    if (
      message?.type !== HISTORY_INDEX_UPDATED_MESSAGE ||
      Number(message?.revision ?? 0) <= loadedIndexRevision
    ) {
      return false;
    }

    void reloadCurrentRangeIndex();
    return false;
  });
}

async function reloadCurrentRangeIndex() {
  const range = rangeSelect.value;
  const loadedIndex = await historyIndexStore.loadRange(range);
  if (!loadedIndex || Number(loadedIndex.revision ?? 0) <= loadedIndexRevision) return;
  applyLoadedRangeIndex(loadedIndex, range);
}

function requestHistoryIndex(type) {
  return new Promise((resolve, reject) => {
    if (!globalThis.chrome?.runtime?.sendMessage) {
      reject(new Error('扩展后台不可用。'));
      return;
    }
    globalThis.chrome.runtime.sendMessage({ type }, (response) => {
      const lastError = globalThis.chrome.runtime?.lastError;
      if (lastError) {
        reject(new Error(lastError.message));
        return;
      }
      resolve(response);
    });
  });
}

function formatGroupMeta(group) {
  const baseMeta = `${group.itemCount} 条 · ${formatVisitTime(group.lastVisitTime)}`;

  if (!group.pinnedCount) {
    return baseMeta;
  }

  return `${baseMeta} · 置顶 ${group.pinnedCount}`;
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
