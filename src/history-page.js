import {
  applyPinnedStateToGroups,
  formatHistoryUrlForGroup,
  getHistoryItemPinKey,
  getHistoryItemTitleOverrideKey,
  groupHistoryItems
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

import { createSearchState } from './search-state.js';
import { createRenameSession } from './rename-session.js';
import { createHistoryPageInitializer } from './history-page-init.js';
import { describeLinkDifferences, groupItemsByDisplayTitle } from './result-presentation.js';

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
const renameSession = createRenameSession();
const groupRenameSession = createRenameSession();
const renameDialog = createRenameDialog();
const groupRenameDialog = createGroupRenameDialog();
let currentGroups = [];
let rangeDropdown = null;
let pinnedUrlKeys = new Set();
let groupNameOverrides = new Map();
let titleOverrides = new Map();
let isInitialized = false;
let showRenamedOnly = false;
let showMinimalMode = false;
let searchSnapshot = null;
let snapshotRenderTimer = null;
const expandedTitleGroups = new Set();
const searchState = createSearchState({
  loadIndex: () => historyIndexStore.loadRange('all'),
  ensureIndex: async () => {
    const response = await requestHistoryIndex(HISTORY_INDEX_ENSURE_MESSAGE);
    if (!response?.ok) throw new Error(response?.error || '历史索引尚未就绪。');
  },
  onChange(snapshot) {
    searchSnapshot = snapshot;
    renderHistorySnapshot();
  }
});

const pageInitializer = createHistoryPageInitializer({
  initialSearch: { query: queryInput.value, range: rangeSelect.value },
  load: async () => {
    const [pinnedKeys, groupNames, titles, lastSearchState] = await Promise.all([
      loadPinnedUrlKeys(), loadGroupNameOverrides(), loadTitleOverrides(), loadLastSearchState()
    ]);
    return { pinnedKeys, groupNames, titles, lastSearchState };
  },
  apply(preferences) {
    pinnedUrlKeys = preferences.pinnedKeys;
    groupNameOverrides = preferences.groupNames;
    titleOverrides = preferences.titles;
    showRenamedOnly = Boolean(preferences.lastSearchState?.showRenamedOnly);
    showMinimalMode = Boolean(preferences.lastSearchState?.showMinimalMode);
    syncMinimalModePresentation();
    isInitialized = true;
    addStorageChangeListener();
    addHistoryIndexUpdateListener();
    searchState.setTitleOverrides(titleOverrides);
  },
  restore(state) {
    queryInput.value = state.query || '';
    setRangeSelectValue(state.range);
    selectQueryInputOnPopupOpen();
  },
  search: (query, range) => searchState.search(query, range)
});

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
queryInput.addEventListener('input', () => pageInitializer.markEdited());
rangeSelect.addEventListener('change', () => {
  pageInitializer.markEdited();
  syncRangeSelect();
});
setupRangeSelect();
form.addEventListener('submit', (event) => {
  event.preventDefault();
  runSearch();
});
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
    await pageInitializer.initialize();

    void requestHistoryIndex(HISTORY_INDEX_ENSURE_MESSAGE).catch(() => {});
  } catch (error) {
    renderError(error);
  }
}

async function runSearch() {
  pageInitializer.markSubmitted();
  expandedTitleGroups.clear();
  const query = queryInput.value;
  const range = rangeSelect.value;
  setLoading();
  void rememberCurrentSearchState({ query, range });
  try {
    await searchState.search(query, range);
  } catch (error) {
    renderError(error);
  }
}

function renderHistorySnapshot() {
  if (snapshotRenderTimer !== null) {
    clearTimeout(snapshotRenderTimer);
    snapshotRenderTimer = null;
  }
  if (!searchSnapshot) return;
  const { query, matchedItems } = searchSnapshot;
  const visibleItems = showRenamedOnly ? matchedItems.filter((item) => item.isTitleRenamed) : matchedItems;
  currentGroups = applyGroupNameOverridesToGroups(groupHistoryItems(visibleItems));
  renderSummary();
  renderResults(applyPinnedStateToGroups(currentGroups, pinnedUrlKeys), { expandAll: Boolean(query) });
  setStatus(showRenamedOnly ? `${visibleItems.length} 条已重命名` : `${visibleItems.length} 条`);
}

function scheduleSnapshotRender() {
  if (!searchSnapshot) {
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
  button.setAttribute('aria-label', '时间筛选');
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
  menu.setAttribute('aria-label', '时间筛选');

  const options = [...rangeSelect.options].map((selectOption) => {
    const option = document.createElement('button');
    option.className = 'range-combobox-option';
    option.type = 'button';
    option.textContent = selectOption.textContent;
    option.dataset.value = selectOption.value;
    option.setAttribute('role', 'option');
    option.addEventListener('click', () => {
      rangeSelect.value = selectOption.value;
      rangeSelect.dispatchEvent(new Event('change', { bubbles: true }));
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
  rangeSelect.tabIndex = -1;
  rangeSelect.setAttribute('aria-hidden', 'true');
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
  rangeDropdown.button.setAttribute('aria-label', `时间筛选：${selectedLabel}`);

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

async function rememberCurrentSearchState(state = searchSnapshot) {
  try {
    await saveLastSearchState({
      query: state?.query ?? queryInput.value,
      range: state?.range ?? rangeSelect.value,
      showRenamedOnly,
      showMinimalMode
    });
  } catch {
    // Remembering the last search is helpful, but it should never block searching.
  }
}

function renderSummary() {
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

  for (const entry of groupItemsByDisplayTitle(group.items)) {
    list.append(entry.kind === 'title-group'
      ? createTitleGroupItem(entry, group.key)
      : createResultItem(entry.item, group.key, { distinguishUrl: entry.distinguishUrl }));
  }

  details.append(header, list);
  row.append(details);
  return row;
}

function createTitleGroupItem(entry, groupKey) {
  const comparison = describeLinkDifferences(entry.items);
  const row = document.createElement('li');
  row.className = 'title-group';
  const details = document.createElement('details');
  details.className = 'title-group-details';
  details.open = expandedTitleGroups.has(entry.key);
  details.addEventListener('toggle', () => {
    if (!details.isConnected) return;
    if (details.open) expandedTitleGroups.add(entry.key);
    else expandedTitleGroups.delete(entry.key);
  });
  const header = document.createElement('summary');
  header.className = 'result-item title-group-summary';
  const content = document.createElement('div');
  content.className = 'result-content';
  const title = document.createElement('a');
  title.className = 'result-title';
  title.textContent = entry.title;
  title.href = entry.items[0].url;
  title.target = '_blank';
  title.rel = 'noreferrer';
  title.title = `打开常用链接：${entry.items[0].url}`;
  title.addEventListener('click', (event) => event.stopPropagation());
  content.append(title, createResultMeta(entry, { aggregate: true }));
  const differenceSummary = document.createElement('div');
  differenceSummary.className = 'link-difference-summary';
  differenceSummary.textContent = comparison.summary;
  differenceSummary.title = comparison.summary;
  content.append(differenceSummary);
  const count = document.createElement('span');
  count.className = 'title-group-count';
  count.textContent = `${entry.items.length} 个链接`;
  count.title = '展开或收起其他链接';
  header.append(content, count);
  const list = document.createElement('ol');
  list.className = 'title-group-list';
  const shared = document.createElement('div');
  shared.className = 'link-shared-address';
  shared.textContent = comparison.sharedAddress ? `${comparison.sharedLabel}：${comparison.sharedAddress}` : '各链接地址不同';
  shared.title = shared.textContent;
  entry.items.forEach((item, index) => list.append(createResultItem(item, groupKey, {
    variant: comparison.variants[index], preferred: index === 0
  })));
  details.append(header, shared, list);
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
      groupRenameSession.close();
    },
    onSubmit: saveGroupRenameDialogName
  });
}

function createResultItem(item, groupKey, { distinguishUrl = false, variant = null, preferred = false } = {}) {
  const row = document.createElement('li');
  row.className = variant ? 'result-item result-variant' : 'result-item';
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
  title.className = variant ? 'result-title result-variant-link' : 'result-title';
  title.href = item.url;
  title.target = '_blank';
  title.rel = 'noreferrer';
  if (variant) {
    title.setAttribute('aria-label', `打开${preferred ? '常用' : ''}链接：${variant.differences.map((diff) => `${diff.label} ${diff.value}`).join('；') || '地址相同'}`);
    for (const diff of variant.differences.slice(0, 2)) {
      const chip = document.createElement('span');
      chip.className = 'link-difference';
      const label = document.createElement('span');
      label.className = 'link-difference-label';
      label.textContent = diff.label;
      const value = document.createElement('span');
      value.className = 'link-difference-value';
      value.textContent = diff.value;
      chip.append(label, value);
      title.append(chip);
    }
    if (!variant.differences.length) title.textContent = '地址相同';
  } else {
    title.textContent = item.title || item.url || '(无标题)';
  }

  titleRow.append(title);
  if (preferred) {
    const tag = document.createElement('span');
    tag.className = 'preferred-link-tag';
    tag.textContent = '常用';
    tag.title = '点击分组标题时打开此链接';
    titleRow.append(tag);
  }
  if (item.isTitleRenamed) {
    titleRow.append(createRenamedTag());
  }
  if (variant) {
    const inspect = document.createElement('button');
    inspect.className = 'link-details-button';
    inspect.type = 'button';
    inspect.textContent = variant.differences.length > 2 ? `详情 +${variant.differences.length - 2}` : '详情';
    inspect.setAttribute('aria-label', '查看链接差异与完整地址');
    inspect.setAttribute('aria-haspopup', 'dialog');
    inspect.addEventListener('click', () => openLinkDetails(item, variant));
    actions.append(inspect);
  }
  actions.append(createRenameButton(item), createPinButton(item));

  content.append(titleRow);
  if (!variant) {
    const url = document.createElement('div');
    url.className = distinguishUrl ? 'result-url result-url-required' : 'result-url';
    url.title = item.url || '';
    url.textContent = distinguishUrl ? item.url : formatHistoryUrlForGroup(item, groupKey);
    content.append(url);
  }
  content.append(createResultMeta(item));
  row.append(content, actions);
  return row;
}

function openLinkDetails(item, variant) {
  const dialog = document.createElement('dialog');
  dialog.className = 'link-details-dialog';
  dialog.setAttribute('aria-label', '链接详情');
  const heading = document.createElement('h2');
  heading.textContent = '链接详情';
  const title = document.createElement('p');
  title.className = 'link-details-title';
  title.textContent = item.title;
  const fields = document.createElement('dl');
  for (const diff of variant.differences) {
    const label = document.createElement('dt');
    label.textContent = `${diff.name} · ${diff.value}`;
    const value = document.createElement('dd');
    value.textContent = diff.detail;
    fields.append(label, value);
  }
  const urlLabel = document.createElement('dt');
  urlLabel.textContent = '完整地址';
  const url = document.createElement('dd');
  url.textContent = item.url;
  fields.append(urlLabel, url);
  const close = document.createElement('button');
  close.className = 'secondary-button';
  close.type = 'button';
  close.textContent = '关闭';
  close.autofocus = true;
  close.addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  dialog.append(heading, title, fields, close);
  document.body.append(dialog);
  dialog.showModal();
}

function createResultMeta(item, { aggregate = false } = {}) {
  const meta = document.createElement('div');
  meta.className = 'result-meta';
  const visitCount = item.totalVisitCount ?? item.visitCount ?? 0;
  meta.append(
    createTag(formatVisitTime(item.lastVisitTime)),
    createTag(`${aggregate ? '合计 ' : ''}${visitCount} 次访问`)
  );
  return meta;
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
      renameSession.close();
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
    saveButton,
    cancelButton,
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
  metric.disabled = currentGroups.length === 0;
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
  expandedTitleGroups.clear();
  for (const details of results.querySelectorAll('details[open]')) {
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
  renameSession.open(item);
  renameDialog.input.value = item.title || item.url || '';
  renameDialog.url.textContent = item.url || '';
  renameDialog.status.textContent = '';
  renameDialog.canRestore = Boolean(item.isTitleRenamed);
  setRenamePending(renameDialog, false);

  openRenameDialog(renameDialog);
}

async function saveRenameDialogTitle() {
  const title = getRenameDialogInputValue(renameDialog);
  if (!title) {
    renameDialog.status.textContent = '标题不能为空。';
    renameDialog.input.focus();
    return;
  }
  await runRenameOperation(renameSession, renameDialog, (item) =>
    saveTitleOverride(item.titleOverrideKey || getHistoryItemTitleOverrideKey(item), title, { targetUrl: item.url }),
    closeRenameDialog);
}

async function restoreRenameDialogOriginalTitle() {
  await runRenameOperation(renameSession, renameDialog, (item) => deleteTitleOverrides([
    ...(item.titleOverrideKeys ?? []), item.titleOverrideKey || getHistoryItemTitleOverrideKey(item)
  ]), closeRenameDialog);
}

function setRenamePending(dialog, pending) {
  dialog.input.disabled = pending;
  dialog.saveButton.disabled = pending;
  dialog.restoreButton.disabled = pending || !dialog.canRestore;
  if (pending) dialog.status.textContent = '';
}

function runRenameOperation(session, dialog, operation, close) {
  return session.run(operation, {
    pending: (value) => setRenamePending(dialog, value),
    success: close,
    error: (error) => { dialog.status.textContent = error.message || '操作失败。'; }
  });
}

function renameGroup(group) {
  groupRenameSession.open(group);
  groupRenameDialog.input.value = group.label || group.key || '';
  groupRenameDialog.key.textContent = group.originalLabel || group.key || '';
  groupRenameDialog.status.textContent = '';
  groupRenameDialog.canRestore = Boolean(group.isGroupRenamed);
  setRenamePending(groupRenameDialog, false);

  openRenameDialog(groupRenameDialog);
}

async function saveGroupRenameDialogName() {
  const name = getRenameDialogInputValue(groupRenameDialog);
  if (!name) {
    groupRenameDialog.status.textContent = '分组名不能为空。';
    groupRenameDialog.input.focus();
    return;
  }
  await runRenameOperation(groupRenameSession, groupRenameDialog,
    (group) => saveGroupNameOverride(group.key, name), closeGroupRenameDialog);
}

async function restoreGroupOriginalName() {
  await runRenameOperation(groupRenameSession, groupRenameDialog,
    (group) => deleteGroupNameOverride(group.key), closeGroupRenameDialog);
}

function closeGroupRenameDialog() {
  groupRenameSession.close();
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
  renameSession.close();
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
      renderResults(applyPinnedStateToGroups(currentGroups, pinnedUrlKeys), { preserveOpenState: true });
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
      searchState.setTitleOverrides(titleOverrides);
    }
  });
}

function addHistoryIndexUpdateListener() {
  globalThis.chrome?.runtime?.onMessage?.addListener((message) => {
    if (message?.type === HISTORY_INDEX_UPDATED_MESSAGE) {
      void searchState.refresh(message.revision).catch((error) => { setStatus(error.message || '刷新失败'); });
    }
    return false;
  });
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
