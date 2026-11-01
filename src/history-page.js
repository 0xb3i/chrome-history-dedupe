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
import { createHighlightedExcerpt, formatRelativeVisitTime, groupItemsByDisplayTitle } from './result-presentation.js';
import { createLiveSearch } from './live-search.js';
import { createSelectControl } from './select-control.js';
import { createResultNavigation } from './result-navigation.js';
import { applySavedTheme, applyTheme, THEME_STORAGE_KEY } from './theme.js';

const SNAPSHOT_RENDER_DEBOUNCE_MS = 50;
const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const historyIndexStore = createHistoryIndexStore();

const form = document.querySelector('#search-form');
const queryInput = document.querySelector('#query');
const rangeSelect = document.querySelector('#range');
const renamedOnlyCheckbox = document.querySelector('#renamed-only');
const openSettingsButton = document.querySelector('#open-settings');
const actionsPanel = document.querySelector('#actions-panel');
const statusPill = document.querySelector('#status-pill');
const summary = document.querySelector('#summary');
const results = document.querySelector('#results');
const emptyState = document.querySelector('#empty-state');
const RESULT_PAGE_SIZE = 30;
const LINK_LIST_LIMIT = 50;
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
  isBlocked: () => Boolean(document.querySelector('dialog[open], .select-combobox-button[aria-expanded="true"], .view-options-trigger[aria-expanded="true"]'))
    || !actionsPanel?.hidden
});
let currentGroups = [];
let sourceFilter = null;
const sourceFilterBar = document.createElement('div');
sourceFilterBar.className = 'source-filter-bar';
sourceFilterBar.hidden = true;
(document.querySelector('.popup-result-scroll') ?? summary).before(sourceFilterBar);
let rangeDropdown = null;
let sortDropdown = null;
let pinnedUrlKeys = new Set();
let groupNameOverrides = new Map();
let titleOverrides = new Map();
let isInitialized = false;
let showRenamedOnly = false;
let sortOrder = 'default';
const editedDisplayPreferences = new Set();
let pendingSearchPreferences = null;
let searchSnapshot = null;
let snapshotRenderTimer = null;
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
      loadPinnedUrlKeys(), loadGroupNameOverrides(), loadTitleOverrides(), loadLastSearchState()
    ]);
    return { pinnedKeys, groupNames, titles, lastSearchState };
  },
  apply(preferences) {
    pinnedUrlKeys = preferences.pinnedKeys;
    groupNameOverrides = preferences.groupNames;
    titleOverrides = preferences.titles;
    if (!editedDisplayPreferences.has('renamed')) showRenamedOnly = Boolean(preferences.lastSearchState?.showRenamedOnly);
    if (!editedDisplayPreferences.has('sort')) {
      sortOrder = normalizeSortOrder(preferences.lastSearchState?.sortOrder);
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
applySavedTheme(document, { watch: false });
document.querySelector('#result-controls').append(createSortControl());
initializeViewOptions();
initializeRowActions();
initializePrimaryKeyHint();
renamedOnlyCheckbox.addEventListener('change', () => {
  showRenamedOnly = renamedOnlyCheckbox.checked;
  editedDisplayPreferences.add('renamed');
  liveSearch.change();
});
form.addEventListener('submit', (event) => {
  event.preventDefault();
  liveSearch.submit();
});
// Open the options page as a tab, then close the popup; openOptionsPage can be
// dropped when the popup closes before Chrome handles it.
openSettingsButton?.addEventListener('click', () => {
  const url = globalThis.chrome?.runtime?.getURL?.('options.html') ?? 'options.html';
  if (globalThis.chrome?.tabs?.create) globalThis.chrome.tabs.create({ url }, () => globalThis.close?.());
  else globalThis.chrome?.runtime?.openOptionsPage?.();
});
document.body.append(renameDialog.element);
document.body.append(groupRenameDialog.element);

init();

// The filter panel only shapes the result list: renamed-only and sort.
function initializeViewOptions() {
  const trigger = document.querySelector('#view-options');
  const panel = document.querySelector('#view-options-panel');
  if (!trigger || !panel) return;
  const setOpen = (open) => {
    panel.hidden = !open;
    trigger.setAttribute('aria-expanded', String(open));
  };
  trigger.addEventListener('click', () => setOpen(panel.hidden));
  panel.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    event.preventDefault();
    setOpen(false);
    trigger.focus();
  });
  for (const type of ['click', 'focusin']) document.addEventListener(type, (event) => {
    if (!panel.hidden && !panel.contains(event.target) && !trigger.contains(event.target)) setOpen(false);
  });
}

// Row actions (⌘K / Ctrl+K, or right-click a row) act on one page, as in
// Raycast's action panel. Same-title links live here instead of in the list.
const rowEntries = new WeakMap();
let lastFocusedResult = null;
document.addEventListener('focusin', (event) => {
  const row = event.target.closest?.('#results [data-navigation-key]');
  if (row) lastFocusedResult = row;
});

function initializeRowActions() {
  if (!actionsPanel) return;
  const isMac = /Mac|iPhone|iPad/.test(globalThis.navigator?.platform ?? '');
  document.querySelectorAll('[data-mod-key]').forEach((key) => { key.textContent = isMac ? '⌘' : 'Ctrl'; });
  const title = actionsPanel.querySelector('#actions-title');
  const list = actionsPanel.querySelector('#actions-list');
  const back = actionsPanel.querySelector('#actions-back');
  let returnFocus = null;
  let current = null;
  let activeRow = null;

  const close = ({ restoreFocus = true } = {}) => {
    if (actionsPanel.hidden) return;
    actionsPanel.hidden = true;
    current = null;
    activeRow?.classList.remove('result-item-actions-open');
    activeRow = null;
    if (restoreFocus) (returnFocus?.isConnected ? returnFocus : queryInput).focus();
  };
  const menuItem = (label, detail, run, { disabled = false } = {}) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'actions-item';
    button.setAttribute('role', 'menuitem');
    button.disabled = disabled;
    const text = document.createElement('span');
    text.className = 'actions-item-label';
    text.textContent = label;
    button.append(text);
    if (detail) {
      const extra = document.createElement('span');
      extra.className = 'actions-item-detail';
      extra.textContent = detail;
      button.append(extra);
    }
    button.addEventListener('click', run);
    return button;
  };
  // One item is active at a time, whether reached by arrow keys or the pointer.
  const activate = (item) => {
    if (!item) return;
    list.querySelector('.is-active')?.classList.remove('is-active');
    item.classList.add('is-active');
    item.focus();
  };
  const show = (heading, items, { nested = false } = {}) => {
    title.textContent = heading;
    back.hidden = !nested;
    list.replaceChildren(...items);
    activate(list.querySelector('.actions-item:not(:disabled)'));
  };
  list.addEventListener('pointermove', (event) => {
    const item = event.target.closest('.actions-item:not(:disabled)');
    if (item && !item.classList.contains('is-active')) activate(item);
  });
  const openLink = (url) => {
    close({ restoreFocus: false });
    if (globalThis.chrome?.tabs?.create) globalThis.chrome.tabs.create({ url });
    else globalThis.open?.(url, '_blank', 'noreferrer');
  };
  const showMain = () => {
    const { item, groupKey, members } = current;
    const label = groupNameOverrides.get(groupKey) || groupKey;
    const others = members.length - 1;
    show(item.title || item.url || '(无标题)', [
      menuItem('打开', '↵', () => openLink(item.url)),
      menuItem('复制链接', '', async () => {
        close();
        try {
          await globalThis.navigator?.clipboard?.writeText(item.url);
          setStatus('已复制链接');
        } catch { setStatus('复制失败，请重试。', { error: true }); }
      }),
      menuItem('重命名网页…', '', () => { close({ restoreFocus: false }); renameItem(item); }),
      menuItem(item.isPinned ? '取消固定' : '固定到顶部', '', () => { close(); togglePinnedItem(item); }),
      ...(others > 0 ? [menuItem('同名的其他链接', String(others), showLinks)] : []),
      menuItem('只看此来源', label, () => {
        close({ restoreFocus: false });
        sourceFilter = groupKey;
        renderHistorySnapshot();
        queryInput.focus();
      }),
      menuItem('修改来源名称…', '', () => {
        close({ restoreFocus: false });
        renameGroup({ key: groupKey, label, originalLabel: groupKey, isGroupRenamed: groupNameOverrides.has(groupKey) });
      })
    ]);
  };
  // Paths rarely mean anything to people; when each link was last visited does.
  function showLinks() {
    const { item, members } = current;
    const links = members.filter((member) => member !== item).sort(compareHistoryItemsByRecency).slice(0, LINK_LIST_LIMIT);
    show(`同名的其他链接（${members.length - 1}）`, links.map((link) => {
      const button = menuItem(formatVisitTime(link.lastVisitTime), `${link.totalVisitCount ?? link.visitCount ?? 0} 次访问`,
        () => openLink(link.url));
      button.title = link.url;
      button.addEventListener('keydown', (event) => {
        if (event.key !== 'F2') return;
        event.preventDefault();
        close({ restoreFocus: false });
        renameItem(link);
      });
      return button;
    }), { nested: true });
  }
  back.addEventListener('click', showMain);

  const open = (row) => {
    const entry = row && rowEntries.get(row);
    if (!entry) return;
    returnFocus = document.activeElement;
    current = entry;
    activeRow = row;
    row.classList.add('result-item-actions-open');
    actionsPanel.hidden = false;
    showMain();
  };
  const targetRow = () => (lastFocusedResult?.isConnected && results.contains(lastFocusedResult)
    ? lastFocusedResult : results.querySelector('[data-navigation-key]'));

  document.addEventListener('keydown', (event) => {
    if (event.key?.toLowerCase() !== 'k' || !(isMac ? event.metaKey : event.ctrlKey)
      || event.altKey || event.shiftKey || document.querySelector('dialog[open]')) return;
    event.preventDefault();
    if (actionsPanel.hidden) open(targetRow());
    else close();
  });
  results.addEventListener('contextmenu', (event) => {
    const row = event.target.closest('[data-navigation-key]');
    if (!row || !rowEntries.has(row)) return;
    event.preventDefault();
    row.querySelector('a.result-title')?.focus();
    open(row);
  });
  actionsPanel.addEventListener('keydown', (event) => {
    const items = [...list.querySelectorAll('.actions-item:not(:disabled)')];
    const index = items.indexOf(document.activeElement);
    if (event.key === 'Escape' || (event.key === 'ArrowLeft' && !back.hidden)) {
      event.preventDefault();
      event.stopPropagation();
      if (!back.hidden) showMain();
      else close();
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const next = event.key === 'ArrowDown' ? index + 1 : index - 1;
      activate(items[(next + items.length) % items.length]);
    }
  });
  // Items replace the list on click, so a click's target may already be detached
  // when it reaches the document; clicks inside the panel stop here instead.
  actionsPanel.addEventListener('click', (event) => event.stopPropagation());
  document.addEventListener('click', () => close({ restoreFocus: false }));
  document.addEventListener('focusin', (event) => {
    if (!actionsPanel.hidden && event.target.isConnected && !actionsPanel.contains(event.target)) close({ restoreFocus: false });
  });
}

// The action bar names what the next key does: ↓ selects from the query,
// ↵ opens once a result has focus.
function initializePrimaryKeyHint() {
  const hint = document.querySelector('#primary-key-hint');
  if (!hint) return;
  const [label, key] = hint.children;
  const sync = () => {
    const active = document.activeElement;
    const onResult = Boolean(active?.matches?.('a.result-title') && results.contains(active));
    label.textContent = onResult ? '打开' : '选择';
    key.textContent = onResult ? '↵' : '↓';
  };
  for (const type of ['focusin', 'keyup', 'click']) document.addEventListener(type, sync);
}

// Launcher rows use fixed columns for title, source, time and independent
// renamed/pinned indicators.
function arrangePopupRow(titleRow, meta, stateSlot) {
  const host = meta.querySelector('.result-host');
  if (host) meta.before(host);
  const time = meta.querySelector('.result-time');
  for (const state of titleRow.querySelectorAll('.result-state-icons, .result-custom-label')) stateSlot.append(state);
  meta.before(stateSlot);
  if (time) meta.prepend(time);
}

function createStateSlot() {
  const slot = document.createElement('span');
  slot.className = 'result-state';
  return slot;
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
    });
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
  const items = [...groupKeys.keys()].sort(getHistoryItemComparator(sortOrder));
  const entries = groupItemsByDisplayTitle(items);
  const fragment = document.createDocumentFragment();
  // Sorted by recency, the list reads as a timeline: pins, today, yesterday, this week, then months.
  let lastSection = null;
  for (const entry of entries.slice(0, resultLimit)) {
    const item = entry.item ?? entry.items[0];
    if (sortOrder === 'recent') {
      const section = item.isPinned ? '已固定' : formatVisitSection(item.lastVisitTime);
      if (section !== lastSection) {
        const heading = document.createElement('li');
        heading.className = 'result-section';
        heading.setAttribute('role', 'presentation');
        heading.textContent = section;
        fragment.append(heading);
        lastSection = section;
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
      [...results.children].filter((row) => !row.classList.contains('result-section'))[oldLimit]
        ?.querySelector('a.result-title')?.focus();
    });
    more.append(button);
    fragment.append(more);
  }
  results.append(fragment);
  resultNavigation.restore(navigationState);
}

function formatVisitSection(value, now = Date.now()) {
  const time = Number(value);
  if (!Number.isFinite(time) || time <= 0) return '更早';
  const date = new Date(time);
  const today = new Date(now);
  const calendarDay = (day) => Date.UTC(day.getFullYear(), day.getMonth(), day.getDate());
  const days = (calendarDay(today) - calendarDay(date)) / 86400000;
  if (days <= 0) return '今天';
  if (days === 1) return '昨天';
  if (days < 7) return '本周';
  return date.getFullYear() === today.getFullYear()
    ? `${date.getMonth() + 1} 月` : `${date.getFullYear()} 年 ${date.getMonth() + 1} 月`;
}

// Same-title links collapse into one row that opens the most visited link; the
// others are reachable from the row's actions.
function createTitleGroupItem(entry, groupKey) {
  const representative = entry.items.reduce((best, item) =>
    compareHistoryItemsByVisits(item, best) < 0 ? item : best);
  const row = createResultItem({
    ...representative,
    title: entry.title,
    searchMatch: entry.items[0].searchMatch,
    totalVisitCount: entry.totalVisitCount,
    lastVisitTime: entry.lastVisitTime
  }, groupKey, { members: entry.items, opens: representative });
  row.classList.add('title-group');
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

function createResultItem(item, groupKey, { distinguishUrl = false, members = [item], opens = item } = {}) {
  const row = document.createElement('li');
  row.className = 'result-item';
  row.dataset.navigationKey = opens.dedupeKey || opens.url;
  rowEntries.set(row, { item: opens, groupKey, members });
  if (item.isPinned) {
    row.classList.add('result-item-pinned');
  }

  const titleRow = document.createElement('div');
  titleRow.className = 'result-title-row';

  const content = document.createElement('div');
  content.className = 'result-content';

  const title = document.createElement('a');
  title.className = 'result-title';
  title.href = opens.url;
  title.target = '_blank';
  title.rel = 'noreferrer';
  appendHighlightedText(title, item.title || item.url || '(无标题)', item.searchMatch?.titleRanges);
  title.title = item.title && item.title !== opens.url ? `${item.title}\n${opens.url || ''}` : opens.url || '';
  if (members.length > 1) title.title += `\n另有 ${members.length - 1} 个同名链接，按 ⌘K 查看`;

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
    label.textContent = '已命名';
    label.title = '当前显示的是自定义网页名';
    titleRow.append(label);
  }

  content.append(titleRow);
  appendMatchReason(title, item);
  const url = document.createElement('div');
  url.className = distinguishUrl ? 'result-url result-url-required' : 'result-url';
  url.title = opens.url || '';
  url.textContent = distinguishUrl ? opens.url : formatHistoryUrlForGroup(opens, groupKey);
  content.append(url);
  const meta = createResultMeta(item, { groupKey });
  content.append(meta);
  arrangePopupRow(titleRow, meta, createStateSlot());
  row.append(content);
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

// Old names still match the search; they stay out of the row and appear only in
// the title tooltip so every result keeps to one line.
function appendMatchReason(title, item) {
  const aliases = item.searchMatch?.aliases ?? [];
  if (!aliases.length) return;
  title.title = `${title.title}\n曾用名：${aliases.map((alias) => alias.text).join('；')}`;
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
  host.dataset.initial = [...label.replace(/^www\./, '')][0]?.toUpperCase() ?? '';
  host.title = label === groupKey ? groupKey : `${label}（${groupKey}）`;
  host.type = 'button';
  host.title += ' · 点击筛选，右键修改分组名';
  host.setAttribute('aria-label', `筛选来源：${label}`);
  host.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    sourceFilter = groupKey;
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
  const visits = createTag(`${visitCount} 次访问`);
  visits.classList.add('result-visits');
  meta.append(visits);
  const time = createTag(formatRelativeVisitTime(item.lastVisitTime));
  time.classList.add('result-time');
  time.title = `${formatVisitTime(item.lastVisitTime)} · ${visitCount} 次访问`;
  meta.append(time);
  return meta;
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

function createPinIcon() {
  const icon = createBaseIcon();
  // Match the renamed tag: 16-unit canvas, 10.5-unit outline and 1.4-unit stroke.
  icon.setAttribute('viewBox', '0 0 16 16');
  icon.setAttribute('stroke-width', '1.4');

  for (const pathData of [
    'M8 9.75v3.5',
    'M5.75 7V5.25H5a1.25 1.25 0 0 1 0-2.5h6a1.25 1.25 0 0 1 0 2.5h-.75V7l3 2.75H2.75z'
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
    ['default', '综合排序'],
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

    if (changes[THEME_STORAGE_KEY]) applyTheme(document, changes[THEME_STORAGE_KEY].newValue);

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
