import {
  applyPinnedStateToGroups,
  compareHistoryItemsByVisits,
  compareHistoryItemsByRecency,
  formatHistoryUrlForGroup,
  getHistoryItemPinKey,
  getHistoryItemTitleOverrideKey,
  groupHistoryItems,
  getHistoryItemComparator,
  normalizeSortOrder
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
import { createHighlightedExcerpt, describeLinkChoices, formatRelativeVisitTime, groupItemsByDisplayTitle } from './result-presentation.js';
import { createLiveSearch } from './live-search.js';
import { createSelectControl } from './select-control.js';
import { initializeUserDataControls } from './user-data-controls.js';
import { createResultNavigation } from './result-navigation.js';

const SNAPSHOT_RENDER_DEBOUNCE_MS = 50;
const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const historyIndexStore = createHistoryIndexStore();

const form = document.querySelector('#search-form');
const queryInput = document.querySelector('#query');
const rangeSelect = document.querySelector('#range');
const renamedOnlyCheckbox = document.querySelector('#renamed-only');
const shortcutSettingsButton = document.querySelector('#shortcut-settings');
const statusPill = document.querySelector('#status-pill');
const summary = document.querySelector('#summary');
const results = document.querySelector('#results');
const emptyState = document.querySelector('#empty-state');
const appVersion = document.querySelector('#app-version');
const isPopup = document.body.classList.contains('popup-body');
const searchView = isPopup ? 'popup' : 'history';
const RESULT_PAGE_SIZE = isPopup ? 30 : 50;
const TITLE_GROUP_PAGE_SIZE = 8;
let resultLimit = RESULT_PAGE_SIZE;
let renderedConditions = '';
let searchPending = false;
const renameSession = createRenameSession();
const groupRenameSession = createRenameSession();
const renameDialog = createRenameDialog();
const groupRenameDialog = createGroupRenameDialog();
const resultNavigation = createResultNavigation({
  queryInput, results,
  scrollContainer: document.querySelector('.popup-result-scroll') || document.scrollingElement || document.documentElement,
  isBlocked: () => Boolean(document.querySelector('dialog[open], .select-combobox-button[aria-expanded="true"]'))
});
let currentGroups = [];
let sourceFilter = null;
const sourceFilterBar = document.createElement('div');
sourceFilterBar.className = 'source-filter-bar';
sourceFilterBar.hidden = true;
summary.before(sourceFilterBar);
let rangeDropdown = null;
let sortDropdown = null;
let pinnedUrlKeys = new Set();
let groupNameOverrides = new Map();
let titleOverrides = new Map();
let isInitialized = false;
let showRenamedOnly = false;
let sortOrder = isPopup ? 'default' : 'recent';
const editedDisplayPreferences = new Set();
let pendingSearchPreferences = null;
let searchSnapshot = null;
let snapshotRenderTimer = null;
const expandedTitleGroups = new Map();
const searchState = createSearchState({
  loadIndex: () => historyIndexStore.loadRange('all'),
  ensureIndex: async () => {
    const response = await requestHistoryIndex(HISTORY_INDEX_ENSURE_MESSAGE, {
      knownUnreadable: true
    });
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
      loadPinnedUrlKeys(), loadGroupNameOverrides(), loadTitleOverrides(), loadLastSearchState(searchView)
    ]);
    return { pinnedKeys, groupNames, titles, lastSearchState };
  },
  apply(preferences) {
    pinnedUrlKeys = preferences.pinnedKeys;
    groupNameOverrides = preferences.groupNames;
    titleOverrides = preferences.titles;
    if (!editedDisplayPreferences.has('renamed')) showRenamedOnly = Boolean(preferences.lastSearchState?.showRenamedOnly);
    if (!editedDisplayPreferences.has('sort')) {
      const savedSort = normalizeSortOrder(preferences.lastSearchState?.sortOrder);
      sortOrder = !isPopup && savedSort === 'default' ? 'recent' : savedSort;
    }
    document.querySelector('#sort-order').value = sortOrder;
    sortDropdown.sync();
    renamedOnlyCheckbox.checked = showRenamedOnly;
    if (!isInitialized) {
      addStorageChangeListener();
      addHistoryIndexUpdateListener();
    }
    isInitialized = true;
    searchState.setTitleOverrides(titleOverrides);
    if (pendingSearchPreferences) {
      void rememberCurrentSearchState(pendingSearchPreferences);
      pendingSearchPreferences = null;
    }
  },
  restore(state) {
    queryInput.value = state.query || '';
    setRangeSelectValue(state.range);
    selectQueryInputOnPopupOpen();
  },
  search: (query, range) => searchState.search(query, range)
});

const liveSearch = createLiveSearch({
  read: () => ({ query: queryInput.value, range: rangeSelect.value }),
  search: runSearch,
  markEdited: () => pageInitializer.markEdited(),
  markSubmitted: () => pageInitializer.markSubmitted(),
  onPending: () => {
    searchPending = true;
    results.setAttribute('aria-busy', 'true');
    setStatus('等待输入完成');
  }
});

const historyDayFormatter = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'full' });
const historyTimeFormatter = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
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
queryInput.addEventListener('input', (event) => liveSearch.input(event));
queryInput.addEventListener('compositionstart', () => liveSearch.compositionStart());
queryInput.addEventListener('compositionend', () => liveSearch.compositionEnd());
rangeSelect.addEventListener('change', () => liveSearch.change());
rangeDropdown = createSelectControl(rangeSelect, { label: '时间筛选' });
const themeSelect = document.querySelector('#theme-color');
if (themeSelect) {
  const colors = ['blue', 'orange', 'green', 'neutral'];
  try {
    const saved = globalThis.localStorage?.getItem('history-ui-color');
    if (colors.includes(saved)) themeSelect.value = saved;
  } catch { /* Theme switching remains available when persistence is unavailable. */ }
  document.documentElement.dataset.themeColor = themeSelect.value;
  const themeControl = createSelectControl(themeSelect, { label: '主题' });
  let themeEdited = false;
  globalThis.chrome?.storage?.local?.get?.('history-ui-color', (saved) => {
    if (themeEdited) return;
    if (colors.includes(saved?.['history-ui-color'])) {
      themeSelect.value = saved['history-ui-color'];
      document.documentElement.dataset.themeColor = themeSelect.value;
      themeControl.sync();
    } else {
      globalThis.chrome?.storage?.local?.set?.({ 'history-ui-color': themeSelect.value });
    }
  });
  themeSelect.addEventListener('change', () => {
    themeEdited = true;
    document.documentElement.dataset.themeColor = themeSelect.value;
    globalThis.chrome?.storage?.local?.set?.({ 'history-ui-color': themeSelect.value });
    try { globalThis.localStorage?.setItem('history-ui-color', themeSelect.value); } catch { /* Keep the selected theme for this page. */ }
  });
}

document.querySelector('#result-controls').append(createSortControl());
renamedOnlyCheckbox.addEventListener('change', () => {
  showRenamedOnly = renamedOnlyCheckbox.checked;
  editedDisplayPreferences.add('renamed');
  liveSearch.change();
});
form.addEventListener('submit', (event) => {
  event.preventDefault();
  liveSearch.submit();
});
shortcutSettingsButton?.addEventListener('click', () => {
  globalThis.chrome?.tabs?.create?.({ url: 'chrome://extensions/shortcuts' });
});
document.body.append(renameDialog.element);
document.body.append(groupRenameDialog.element);
renderRuntimeVersion();
initializeUserDataControls(document);

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
    setLoading('正在准备历史搜索…');
    await pageInitializer.initialize();
    if (!searchState.snapshot) await liveSearch.submit();

    void requestHistoryIndex(HISTORY_INDEX_ENSURE_MESSAGE).catch(() => {});
  } catch (error) {
    renderError(error, () => init());
  }
}

async function runSearch(query = queryInput.value, range = rangeSelect.value) {
  expandedTitleGroups.clear();
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
  const groups = groupHistoryItems(visibleItems, sortOrder);
  currentGroups = sourceFilter ? groups.filter((group) => group.key === sourceFilter) : groups;
  renderSourceFilter();
  const conditions = JSON.stringify([query, searchSnapshot.range, showRenamedOnly, sortOrder, sourceFilter]);
  if (conditions !== renderedConditions) resultLimit = RESULT_PAGE_SIZE;
  renderedConditions = conditions;
  searchPending = queryInput.value.trim() !== query || rangeSelect.value !== searchSnapshot.range;
  results.setAttribute('aria-busy', String(searchPending));
  renderSummary();
  renderResults(applyPinnedStateToGroups(currentGroups, pinnedUrlKeys, sortOrder));
  setStatus(searchPending ? '等待输入完成' : `${visibleItems.length} 条结果`);
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
    rangeDropdown.sync();
  }
}

async function rememberCurrentSearchState(state = searchSnapshot) {
  if (!isInitialized) {
    pendingSearchPreferences = {
      query: state?.query ?? queryInput.value,
      range: state?.range ?? rangeSelect.value
    };
    return;
  }
  try {
    await saveLastSearchState({
      query: state?.query ?? queryInput.value,
      range: state?.range ?? rangeSelect.value,
      showRenamedOnly,
      sortOrder
    }, searchView);
  } catch {
    // Remembering the last search is helpful, but it should never block searching.
  }
}

function renderSummary() {
  const count = summary.querySelector('.result-count');
  const total = currentGroups.reduce((total, group) => total + group.itemCount, 0);
  count.textContent = `${total.toLocaleString('zh-CN')} 条结果`;
  renamedOnlyCheckbox.checked = showRenamedOnly;
}

function renderResults(groups) {
  const navigationState = resultNavigation.capture();
  results.replaceChildren();
  if (groups.length === 0) {
    renderEmptyState();
    resultNavigation.restore(navigationState);
    return;
  }

  emptyState.hidden = true;
  const groupKeys = new Map(groups.flatMap((group) => group.items.map((item) => [item, group.key])));
  const compare = !isPopup && sortOrder === 'recent'
    ? compareHistoryItemsByRecency : getHistoryItemComparator(sortOrder);
  const items = [...groupKeys.keys()].sort(compare);
  // The full history view shows each resource in its actual chronological slot.
  const entries = isPopup ? groupItemsByDisplayTitle(items) : items.map((item) => ({ kind: 'item', item }));
  const fragment = document.createDocumentFragment();
  let lastDay = null;
  for (const entry of entries.slice(0, resultLimit)) {
    const item = entry.item ?? entry.items[0];
    if (!isPopup && sortOrder === 'recent') {
      const date = new Date(Number(item.lastVisitTime ?? 0));
      const day = Number(item.lastVisitTime) > 0 && Number.isFinite(date.getTime())
        ? historyDayFormatter.format(date)
        : '未知时间';
      if (day !== lastDay) {
        const divider = document.createElement('li');
        divider.className = 'history-day';
        const heading = document.createElement('h2');
        heading.textContent = day;
        divider.append(heading);
        fragment.append(divider);
        lastDay = day;
      }
    }
    const groupKey = groupKeys.get(item);
    fragment.append(entry.kind === 'title-group' ? createTitleGroupItem(entry, groupKey)
      : createResultItem(item, groupKey, { distinguishUrl: entry.distinguishUrl }));
  }
  if (entries.length > resultLimit) {
    const more = document.createElement('li');
    more.className = 'results-more';
    const button = document.createElement('button');
    button.className = 'secondary-button';
    button.type = 'button';
    button.textContent = `显示更多（剩余 ${entries.length - resultLimit} 项）`;
    button.addEventListener('click', () => {
      const oldLimit = resultLimit;
      resultLimit += RESULT_PAGE_SIZE;
      renderResults(groups);
      [...results.children].filter((row) => !row.classList.contains('history-day'))[oldLimit]
        ?.querySelector('a.result-title')?.focus();
    });
    more.append(button);
    fragment.append(more);
  }
  results.append(fragment);
  resultNavigation.restore(navigationState);
}

function createTitleGroupItem(entry, groupKey) {
  const representative = entry.items.reduce((best, item) =>
    compareHistoryItemsByVisits(item, best) < 0 ? item : best);
  const row = document.createElement('li');
  row.className = 'title-group';
  const details = document.createElement('details');
  details.className = 'title-group-details';
  details.open = expandedTitleGroups.has(entry.key);
  details.addEventListener('toggle', () => {
    if (!details.isConnected) return;
    header.setAttribute('aria-expanded', String(details.open));
    if (details.open) {
      populateLinks();
      expandedTitleGroups.set(entry.key, renderedCount);
    } else expandedTitleGroups.delete(entry.key);
  });
  const header = document.createElement('summary');
  header.className = 'result-item title-group-summary';
  header.dataset.navigationKey = representative.dedupeKey || representative.url;
  header.setAttribute('aria-label', `${entry.title}，展开或收起 ${entry.items.length} 个同名链接`);
  header.setAttribute('aria-expanded', String(details.open));
  const content = document.createElement('div');
  content.className = 'result-content';
  const title = document.createElement('a');
  title.className = 'result-title';
  appendHighlightedText(title, entry.title, entry.items[0].searchMatch?.titleRanges);
  title.href = representative.url;
  title.target = '_blank';
  title.rel = 'noreferrer';
  title.title = `${entry.title}\n打开访问最多的链接：${representative.url}`;
  title.addEventListener('click', (event) => event.stopPropagation());
  content.append(title, createResultMeta(entry, { groupKey }));
  appendMatchReason(content, entry.items[0]);
  const count = document.createElement('span');
  count.className = 'title-group-count';
  count.textContent = `${entry.items.length} 个链接`;
  count.title = '展开或收起其他链接';
  const controls = document.createElement('div');
  controls.className = 'title-group-tools';
  const actions = document.createElement('div');
  actions.className = 'result-actions';
  actions.append(createRenameButton(representative), createPinButton(representative));
  actions.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
  controls.append(actions, count);
  header.append(content, controls);
  const list = document.createElement('ol');
  list.className = 'title-group-list';
  let items;
  let choices;
  let renderedCount = 0;
  const more = document.createElement('li');
  more.className = 'results-more';
  const moreButton = document.createElement('button');
  moreButton.className = 'secondary-button';
  moreButton.type = 'button';
  more.append(moreButton);

  // A collapsed group can contain thousands of links. Defer both labels and
  // DOM creation until expansion, then append bounded pages without rebuilding.
  function populateLinks(limit = expandedTitleGroups.get(entry.key) || TITLE_GROUP_PAGE_SIZE) {
    items ??= [...entry.items].sort(sortOrder === 'default'
      ? compareHistoryItemsByVisits : getHistoryItemComparator(sortOrder));
    choices ??= describeLinkChoices(items, { groupTitle: entry.title });
    more.remove();
    const fragment = document.createDocumentFragment();
    const end = Math.min(limit, items.length);
    for (; renderedCount < end; renderedCount += 1) {
      const index = renderedCount;
      fragment.append(createResultItem(items[index], groupKey, { choice: choices[index] }));
    }
    list.append(fragment);
    if (renderedCount < items.length) {
      moreButton.textContent = `显示更多链接（剩余 ${items.length - renderedCount} 个）`;
      list.append(more);
    }

  }
  moreButton.addEventListener('click', () => {
    const oldCount = renderedCount;
    populateLinks(renderedCount + TITLE_GROUP_PAGE_SIZE);
    expandedTitleGroups.set(entry.key, renderedCount);
    list.children[oldCount]?.querySelector('a')?.focus();
  });
  details.append(header, list);
  if (details.open) populateLinks();
  row.append(details);
  return row;
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

function createResultItem(item, groupKey, { distinguishUrl = false, choice = null } = {}) {
  const variant = Boolean(choice);
  const row = document.createElement('li');
  row.className = variant ? 'result-item result-variant' : 'result-item';
  row.dataset.navigationKey = item.dedupeKey || item.url;
  if (!isPopup) {
    row.classList.add('history-result');
    const time = document.createElement('time');
    time.className = 'history-visit-time';
    const date = new Date(Number(item.lastVisitTime ?? 0));
    const valid = Number(item.lastVisitTime) > 0 && Number.isFinite(date.getTime());
    time.textContent = valid ? historyTimeFormatter.format(date) : '—';
    time.title = valid ? formatVisitTime(item.lastVisitTime) : '未知时间';
    if (valid) time.setAttribute('datetime', date.toISOString());
    row.append(time);
  }
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
  title.className = variant ? `result-title result-variant-link${choice.isPageTitle ? ' has-page-title' : ''}` : 'result-title';
  title.href = item.url;
  title.target = '_blank';
  title.rel = 'noreferrer';
  title.title = item.url || '';
  if (variant) {
    const label = document.createElement('span');
    label.className = 'result-choice-label';
    label.textContent = choice.label;
    title.append(label);
    if (choice.secondary) {
      const context = document.createElement('span');
      context.className = 'result-choice-context';
      context.textContent = choice.secondary;
      title.append(context);
    }
    title.setAttribute('aria-label', `${choice.label}${choice.secondary}，打开链接：${item.url}`);
  } else {
    appendHighlightedText(title, item.title || item.url || '(无标题)', item.searchMatch?.titleRanges);
    if (item.title && item.title !== item.url) title.title = `${item.title}\n${item.url || ''}`;
  }

  if (item.isPinned) {
    const states = document.createElement('span');
    states.className = 'result-state-icons';
    states.append(createResultStateIcon('已固定', createPinIcon()));
    titleRow.append(states);
  }
  titleRow.append(title);
  if (item.isTitleRenamed) {
    const label = document.createElement('span');
    label.className = 'result-custom-label';
    label.textContent = isPopup ? '已命名' : '自定义';
    label.title = '当前显示的是自定义网页名';
    titleRow.append(label);
  }
  actions.append(createRenameButton(item), createPinButton(item));

  content.append(titleRow);
  if (!variant) appendMatchReason(content, item);
  if (!variant) {
    const url = document.createElement('div');
    url.className = distinguishUrl ? 'result-url result-url-required' : 'result-url';
    url.title = item.url || '';
    url.textContent = distinguishUrl ? item.url : formatHistoryUrlForGroup(item, groupKey);
    content.append(url);
  }
  if (!variant) {
    content.append(createResultMeta(item, { groupKey }));
  }
  row.append(content);
  if (variant) {
    const stats = document.createElement('div');
    stats.className = 'result-variant-stats';
    const visits = document.createElement('span');
    visits.className = 'result-variant-visits';
    visits.textContent = `${item.totalVisitCount ?? item.visitCount ?? 0} 次访问`;
    visits.title = '累计访问次数';
    stats.append(visits);
    row.append(stats);
  }
  row.append(actions);
  return row;
}

function appendHighlightedText(element, text, ranges = []) {
  ({ text, ranges } = createHighlightedExcerpt(text, ranges));
  let offset = 0;
  for (const [start, end] of ranges) {
    element.append(document.createTextNode(text.slice(offset, start)));
    const mark = document.createElement('mark');
    mark.textContent = text.slice(start, end);
    element.append(mark);
    offset = end;
  }
  element.append(document.createTextNode(text.slice(offset)));
}

function appendMatchReason(content, item) {
  const aliases = item.searchMatch?.aliases ?? [];
  if (!aliases.length) return;
  const reason = document.createElement('div');
  reason.className = 'result-match';
  reason.title = aliases.map((alias) => alias.text).join('；');
  reason.append(document.createTextNode('曾用名：'));
  aliases.forEach((alias, index) => {
    if (index) reason.append(document.createTextNode('；'));
    appendHighlightedText(reason, alias.text, alias.ranges);
  });
  content.append(reason);
}

function renderSourceFilter() {
  sourceFilterBar.replaceChildren();
  sourceFilterBar.hidden = !sourceFilter;
  if (!sourceFilter) return;
  const label = groupNameOverrides.get(sourceFilter) || sourceFilter;
  const caption = document.createElement('span');
  caption.className = 'source-filter-caption';
  caption.textContent = '来源：';
  const name = document.createElement('span');
  name.className = 'source-filter-name';
  name.textContent = label;
  name.title = label;
  const clear = document.createElement('button');
  clear.type = 'button';
  clear.className = 'source-filter-clear';
  const icon = createBaseIcon();
  const path = document.createElementNS(SVG_NAMESPACE, 'path');
  path.setAttribute('d', 'M6 6l12 12M18 6L6 18');
  icon.append(path);
  clear.append(icon);
  clear.setAttribute('aria-label', `清除来源筛选：${label}`);
  clear.title = '清除来源筛选';
  clear.addEventListener('click', () => {
    sourceFilter = null;
    expandedTitleGroups.clear();
    renderHistorySnapshot();
    queryInput.focus();
  });
  sourceFilterBar.append(caption, name, clear);
}

function createResultHost(groupKey, pageUrl) {
  const host = document.createElement('button');
  host.className = 'result-host';
  const label = groupNameOverrides.get(groupKey) || groupKey;
  // Keep source colors stable across sorting, filtering and custom group names.
  let hash = 0;
  for (const character of groupKey) hash = (Math.imul(hash, 31) + character.codePointAt(0)) >>> 0;
  host.dataset.sourceTone = String(hash % 6);
  host.dataset.groupKey = groupKey;
  host.title = label === groupKey ? groupKey : `${label}（${groupKey}）`;
  host.type = 'button';
  host.title += ' · 点击筛选，右键修改分组名';
  host.setAttribute('aria-label', `筛选来源：${label}`);
  host.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    sourceFilter = groupKey;
    expandedTitleGroups.clear();
    renderHistorySnapshot();
    sourceFilterBar.querySelector('button')?.focus();
  });
  const editSource = (event) => {
    event.preventDefault();
    event.stopPropagation();
    renameGroup({ key: groupKey, label, originalLabel: groupKey, isGroupRenamed: groupNameOverrides.has(groupKey) });
  };
  host.addEventListener('contextmenu', editSource);
  host.addEventListener('keydown', (event) => {
    if (event.key === 'F2') editSource(event);
  });
  const text = document.createElement('span');
  text.className = 'result-host-label';
  text.textContent = label;
  if (pageUrl && globalThis.chrome?.runtime?.getURL) {
    const icon = document.createElement('img');
    icon.className = 'result-source-icon';
    icon.width = 14;
    icon.height = 14;
    icon.alt = '';
    icon.loading = 'lazy';
    const favicon = new URL(globalThis.chrome.runtime.getURL('_favicon/'));
    favicon.searchParams.set('pageUrl', pageUrl);
    favicon.searchParams.set('size', '32');
    icon.src = favicon.href;
    host.classList.add('has-source-icon');
    icon.addEventListener('error', () => {
      icon.remove();
      host.classList.remove('has-source-icon');
    }, { once: true });
    host.append(icon);
  }
  host.append(text);
  return host;
}

function createResultMeta(item, { groupKey = null } = {}) {
  const meta = document.createElement('div');
  meta.className = 'result-meta';
  const visitCount = item.totalVisitCount ?? item.visitCount ?? 0;
  if (groupKey) meta.append(createResultHost(groupKey, item.url || item.items?.[0]?.url));
  if (!isPopup && sortOrder !== 'recent') meta.append(createTag(formatVisitTime(item.lastVisitTime)));
  meta.append(createTag(`${visitCount} 次访问`));
  if (isPopup) {
    const time = createTag(formatRelativeVisitTime(item.lastVisitTime));
    time.title = formatVisitTime(item.lastVisitTime);
    meta.append(time);
  }
  if (item.isTitleRenamed && searchSnapshot?.range !== 'all' &&
    Number(item.lastVisitTime ?? 0) < searchSnapshot?.rangeStartTime) {
    const note = createTag('跨时间保留');
    note.classList.add('retained-note');
    note.title = '已命名页面不受时间筛选限制';
    meta.append(note);
  }
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
    title: '重命名网页',
    fieldLabel: '名称',
    extraKey: 'url',
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
  element.setAttribute('aria-label', titleText);

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
  restoreButton.className = 'secondary-button rename-restore';
  restoreButton.type = 'button';
  restoreButton.textContent = '还原原名';

  const saveButton = document.createElement('button');
  saveButton.className = 'primary-button';
  saveButton.type = 'submit';
  saveButton.textContent = '保存';

  const primaryActions = document.createElement('div');
  primaryActions.className = 'rename-primary-actions';
  primaryActions.append(cancelButton, saveButton);
  actions.append(restoreButton, primaryActions);
  formElement.append(header, field, status, actions);
  input.addEventListener('input', () => {
    saveButton.disabled = input.disabled || !input.value.trim() ||
      input.value.trim().replace(/\s+/g, ' ') === element.dataset.initialName;
  });
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

function createSortControl() {
  const label = document.createElement('label');
  label.className = 'field sort-control';
  const caption = document.createElement('span');
  caption.className = 'visually-hidden';
  caption.textContent = '排序方式';
  const select = document.createElement('select');
  select.id = 'sort-order';
  select.setAttribute('aria-label', '排序方式');
  for (const [value, text] of [
    ...(isPopup ? [['default', '综合排序']] : []),
    ['visits', '访问最多'],
    ['recent', '最近访问'],
    ['name', '名称升序']
  ]) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = text;
    select.append(option);
  }
  select.value = sortOrder;
  select.addEventListener('change', () => {
    sortOrder = normalizeSortOrder(select.value);
    editedDisplayPreferences.add('sort');
    expandedTitleGroups.clear();
    renderHistorySnapshot();
    void rememberCurrentSearchState();
  });
  label.append(caption, select);
  sortDropdown = createSelectControl(select, { label: '排序方式' });
  return label;
}

function createTag(text) {
  const tag = document.createElement('span');
  tag.className = 'tag';
  tag.textContent = text;
  return tag;
}

function createResultStateIcon(label, icon) {
  const tag = document.createElement('span');
  tag.className = 'result-state-icon';
  tag.title = label;
  tag.setAttribute('role', 'img');
  tag.setAttribute('aria-label', label);
  tag.append(icon);
  return tag;
}

function renderError(error, retry = () => liveSearch.submit()) {
  searchPending = false;
  results.setAttribute('aria-busy', 'false');
  currentGroups = [];
  results.replaceChildren();
  renderSummary();
  emptyState.hidden = false;
  emptyState.replaceChildren();
  const message = document.createElement('p');
  message.textContent = '暂时无法读取历史记录，请重试。';
  message.title = error.message || '读取历史记录失败';
  emptyState.append(message, createRecoveryButton('重试', retry));
  setStatus('错误');
}

function setLoading(message = '正在搜索…') {
  searchPending = true;
  results.setAttribute('aria-busy', 'true');
  if (!results.children.length) {
    emptyState.hidden = false;
    emptyState.textContent = message;
  }
  setStatus(message);
}

function setStatus(text, { error = false } = {}) {
  statusPill.textContent = text;
  statusPill.parentElement.classList.toggle('visually-hidden', !error);
  statusPill.parentElement.classList.toggle('status-error', error);
  if (searchPending) {
    const count = summary.querySelector('.result-count');
    if (count) count.textContent = text;
  }
}

function renderEmptyState() {
  emptyState.hidden = false;
  emptyState.replaceChildren();
  const heading = document.createElement('p');
  heading.className = 'empty-heading';
  const hasConditions = Boolean(sourceFilter || searchSnapshot?.query || showRenamedOnly || searchSnapshot?.range !== 'all');
  heading.textContent = hasConditions ? '没有找到匹配页面' : '暂无可显示的历史记录';
  const hint = document.createElement('p');
  hint.textContent = showRenamedOnly ? '当前仅显示已命名页面，可以清除筛选再试。'
    : searchSnapshot?.range !== 'all' ? '当前时间范围内没有结果，可以搜索全部时间。'
      : searchSnapshot?.query ? '试试更短的标题或曾用名。' : '浏览网页后，历史记录会自动出现在这里。';
  const actions = document.createElement('div');
  actions.className = 'empty-actions';
  if (searchSnapshot?.range !== 'all') actions.append(createRecoveryButton('搜索全部时间', () => {
    setRangeSelectValue('all');
    liveSearch.change();
  }));
  if (showRenamedOnly) actions.append(createRecoveryButton('清除筛选', () => {
    showRenamedOnly = false;
    renamedOnlyCheckbox.checked = false;
    editedDisplayPreferences.add('renamed');
    setRangeSelectValue('all');
    liveSearch.change();
  }));
  if (searchSnapshot?.query) actions.append(createRecoveryButton('清空关键词', () => {
    queryInput.value = '';
    liveSearch.change();
    queryInput.focus();
  }));
  emptyState.append(heading, hint, actions);
}

function createRecoveryButton(label, action) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'secondary-button';
  button.textContent = label;
  button.addEventListener('click', action);
  return button;
}

function renameItem(item) {
  renameSession.open(item);
  renameDialog.input.value = item.title || item.url || '';
  renameDialog.url.textContent = item.url || '';
  renameDialog.url.title = item.url || '';
  renameDialog.status.textContent = '';
  renameDialog.canRestore = Boolean(item.isTitleRenamed);
  renameDialog.element.dataset.initialName = renameDialog.input.value.trim().replace(/\s+/g, ' ');
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
  dialog.saveButton.disabled = pending || !dialog.input.value.trim() ||
    getRenameDialogInputValue(dialog) === dialog.element.dataset.initialName;
  dialog.restoreButton.disabled = pending || !dialog.canRestore;
  dialog.restoreButton.hidden = !dialog.canRestore;
  dialog.saveButton.textContent = pending ? '处理中…' : '保存';
  if (pending) dialog.status.textContent = '正在保存更改…';
}

function runRenameOperation(session, dialog, operation, close) {
  return session.run(operation, {
    pending: (value) => setRenamePending(dialog, value),
    success: () => {
      close();
      setStatus('更改已保存');
      statusPill.parentElement.classList.remove('visually-hidden');
      setTimeout(() => {
        if (statusPill.textContent === '更改已保存') statusPill.parentElement.classList.add('visually-hidden');
      }, 2000);
    },
    error: (error) => { dialog.status.textContent = error.message || '操作失败。'; }
  });
}

function renameGroup(group) {
  groupRenameSession.open(group);
  groupRenameDialog.input.value = group.label || group.key || '';
  groupRenameDialog.key.textContent = group.originalLabel || group.key || '';
  groupRenameDialog.status.textContent = '';
  groupRenameDialog.canRestore = Boolean(group.isGroupRenamed);
  groupRenameDialog.element.dataset.initialName = groupRenameDialog.input.value.trim().replace(/\s+/g, ' ');
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
    renderResults(applyPinnedStateToGroups(currentGroups, pinnedUrlKeys, sortOrder));
  } catch {
    setStatus('置顶保存失败，请重试。', { error: true });
  }
}

function addStorageChangeListener() {
  globalThis.chrome?.storage?.onChanged?.addListener((changes, areaName) => {
    if (!isInitialized || areaName !== 'local') {
      return;
    }

    if (changes[PINNED_URLS_STORAGE_KEY]) {
      pinnedUrlKeys = normalizePinnedPageKeys(changes[PINNED_URLS_STORAGE_KEY].newValue);
      renderResults(applyPinnedStateToGroups(currentGroups, pinnedUrlKeys, sortOrder));
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
      void searchState.refresh(message.revision).catch((error) => {
        setStatus(error.message || '刷新失败，请重新搜索。', { error: true });
      });
    }
    return false;
  });
}

function requestHistoryIndex(type, details = {}) {
  return new Promise((resolve, reject) => {
    if (!globalThis.chrome?.runtime?.sendMessage) {
      reject(new Error('扩展后台不可用。'));
      return;
    }
    globalThis.chrome.runtime.sendMessage({ type, ...details }, (response) => {
      const lastError = globalThis.chrome.runtime?.lastError;
      if (lastError) {
        reject(new Error(lastError.message));
        return;
      }
      resolve(response);
    });
  });
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
