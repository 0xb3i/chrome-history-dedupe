import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const historyHtml = readText('../history.html');
const popupHtml = readText('../popup.html');
const renameHtml = readText('../rename.html');
const historyPageJs = readText('../src/history-page.js');
const backgroundJs = readText('../src/background.js');
const renamePageJs = readText('../src/rename-page.js');
const renameOverlayJs = readText('../src/rename-overlay.js');

test('history surfaces do not expose a dedupe mode selector', () => {
  for (const html of [historyHtml, popupHtml]) {
    assert.equal(html.includes('id="mode"'), false);
    assert.equal(html.includes('<span>去重</span>'), false);
    assert.equal(html.includes('完整 URL'), false);
  }
});

test('history page script uses a fixed page title dedupe mode', () => {
  assert.equal(historyPageJs.includes("querySelector('#mode')"), false);
  assert.equal(historyPageJs.includes('modeSelect'), false);
  assert.equal(historyPageJs.includes("const DEDUPE_MODE = 'page-title';"), true);
  assert.equal(historyPageJs.includes('dedupeHistoryItems(visibleItems, DEDUPE_MODE)'), true);
});

test('history page filters queries locally after applying renamed titles', () => {
  assert.equal(historyPageJs.includes("text: '',"), true);
  assert.equal(historyPageJs.includes('filterHistoryItemsByQuery(renamedItems, query)'), true);
  assert.equal(historyPageJs.includes('dedupeHistoryItems(visibleItems, DEDUPE_MODE)'), true);
});

test('history page rewrites visit counts to the selected time window', () => {
  assert.equal(historyPageJs.includes('const VISIT_COUNT_CONCURRENCY = 32;'), true);
  assert.equal(historyPageJs.includes('const startTime = getStartTime(rangeSelect.value);'), true);
  assert.equal(historyPageJs.includes('const endTime = Date.now();'), true);
  assert.equal(historyPageJs.includes('applyVisitCountsForWindow(rawItems, startTime, endTime)'), true);
  assert.equal(historyPageJs.includes('chrome.history.getVisits({ url }'), true);
  assert.equal(historyPageJs.includes('visitTime >= startTime && visitTime <= endTime'), true);
  assert.equal(historyPageJs.includes('visitCount: windowVisitCount'), true);
  assert.equal(historyPageJs.includes('mapWithConcurrency(items, VISIT_COUNT_CONCURRENCY'), true);
});

test('history surfaces do not expose a max results control', () => {
  for (const html of [historyHtml, popupHtml]) {
    assert.equal(html.includes('id="max-results"'), false);
    assert.equal(html.includes('<span>上限</span>'), false);
  }

  assert.equal(historyPageJs.includes('maxResultsInput'), false);
  assert.equal(historyPageJs.includes('const MAX_RESULTS = 10000;'), true);
});

test('shortcut settings open through tabs API instead of a chrome URL link', () => {
  assert.equal(historyHtml.includes('href="chrome://extensions/shortcuts"'), false);
  assert.equal(historyHtml.includes('id="shortcut-settings"'), true);
  assert.equal(historyPageJs.includes("querySelector('#shortcut-settings')"), true);
  assert.equal(historyPageJs.includes("chrome://extensions/shortcuts"), true);
  assert.equal(historyPageJs.includes('chrome?.tabs?.create'), true);
});

test('popup keeps result metadata visible and truncates long URLs', () => {
  const css = readText('../src/styles.css');

  assert.equal(css.includes('.popup-results .result-meta {\n  display: none;'), false);
  assert.equal(css.includes('.popup-results .result-url'), true);
  assert.equal(historyPageJs.includes('formatHistoryUrlForGroup'), true);
  assert.equal(historyPageJs.includes('createResultItem(item, group.key)'), true);
  assert.equal(css.includes('text-overflow: ellipsis;'), true);
  assert.equal(css.includes('white-space: nowrap;'), true);
});

test('result metadata uses bare text below normal-weight titles', () => {
  const css = readText('../src/styles.css');

  assert.equal(css.includes('font-size: 14px;'), true);
  assert.equal(css.includes('font-weight: 400;'), true);
  assert.equal(css.includes('font-size: 12px;'), true);
  assert.equal(css.includes('gap: 4px;'), true);
  assert.equal(css.includes('.tag + .tag::before'), true);
  assert.equal(css.includes('border-radius: 12px;'), false);
  assert.equal(css.includes('background: var(--surface-muted);'), false);
});

test('bare result rows have dividers for scannable separation', () => {
  const css = readText('../src/styles.css');

  assert.equal(css.includes('.results > .result-item + .result-item'), true);
  assert.equal(css.includes('border-top: 1px solid var(--line);'), true);
  assert.equal(css.includes('padding: 13px 16px 11px;'), true);
  assert.equal(css.includes('padding: 13px 12px 11px;'), true);
});

test('result metadata omits merge count and shortens dates for the current year', () => {
  assert.equal(historyPageJs.includes('合并 ${item.dedupeCount} 条'), false);
  assert.equal(historyPageJs.includes('currentYearDateFormatter'), true);
  assert.equal(historyPageJs.includes('otherYearDateFormatter'), true);
  assert.equal(historyPageJs.includes("date.getFullYear() === new Date().getFullYear()"), true);
});

test('popup search controls stay on one row despite mobile media rules', () => {
  const css = readText('../src/styles.css');

  assert.equal(css.includes('width: 620px;'), true);
  assert.equal(css.includes('max-height: 760px;'), true);
  assert.equal(css.includes('max-height: none;'), true);
  assert.equal(css.includes('overflow: visible;'), true);
  assert.equal(css.includes('grid-template-columns: minmax(260px, 520px) minmax(120px, 142px) auto;'), true);
  assert.equal(css.includes('justify-content: start;'), true);
  assert.equal(css.includes('.controls .field-wide'), true);
  assert.equal(css.includes('.popup-body .popup-controls'), true);
  assert.equal(css.includes('grid-template-columns: minmax(180px, 1fr) 96px auto;'), true);
  assert.equal(css.includes('.popup-body .popup-controls .field-wide'), true);
  assert.equal(css.includes('.popup-body .popup-controls .primary-button'), true);
});

test('range select uses a custom left-shifted chevron', () => {
  const css = readText('../src/styles.css');

  assert.equal(css.includes('.field select {'), true);
  assert.equal(css.includes('appearance: none;'), true);
  assert.equal(css.includes('background-image: url("data:image/svg+xml'), true);
  assert.equal(css.includes('background-position: calc(100% - 11px) 50%;'), true);
  assert.equal(css.includes('padding-right: 32px;'), true);
});

test('status count line is hidden because summary actions carry the controls', () => {
  const css = readText('../src/styles.css');

  assert.equal(css.includes('.status-line'), true);
  assert.equal(css.includes('display: none;'), true);
  assert.equal(historyPageJs.includes("createMetric('读取'"), false);
  assert.equal(historyPageJs.includes("createMetric('显示'"), false);
  assert.equal(historyPageJs.includes("createMetric('分组'"), false);
});

test('history page script supports persistent pin controls', () => {
  assert.equal(historyPageJs.includes('PINNED_URLS_STORAGE_KEY'), true);
  assert.equal(historyPageJs.includes('loadPinnedUrlKeys'), true);
  assert.equal(historyPageJs.includes('savePinnedUrlKeys'), true);
  assert.equal(historyPageJs.includes('createPinButton'), true);
  assert.equal(historyPageJs.includes('aria-pressed'), true);
});

test('history groups do not open the first group by default', () => {
  assert.equal(historyPageJs.includes('index === 0'), false);
  assert.equal(historyPageJs.includes('options.expandAll || (openGroupKeys ? openGroupKeys.has(group.key) : false)'), true);
  assert.equal(historyPageJs.includes('preserveOpenState'), true);
});

test('search query expands grouped results automatically', () => {
  assert.equal(historyPageJs.includes('expandAll: Boolean(query)'), true);
});

test('history search surfaces restore and remember the last search state', () => {
  assert.equal(historyPageJs.includes('loadLastSearchState'), true);
  assert.equal(historyPageJs.includes('saveLastSearchState'), true);
  assert.equal(historyPageJs.includes('applyLastSearchState(lastSearchState)'), true);
  assert.equal(historyPageJs.includes('queryInput.value = state.query ||'), true);
  assert.equal(historyPageJs.includes('setRangeSelectValue(state.range)'), true);
  assert.equal(historyPageJs.includes('showRenamedOnly = Boolean(state.showRenamedOnly)'), true);
  assert.equal(historyPageJs.includes('showMinimalMode = Boolean(state.showMinimalMode)'), true);
  assert.equal(historyPageJs.includes('rememberCurrentSearchState'), true);
});

test('pin controls render as icon-only buttons with accessible labels', () => {
  const css = readText('../src/styles.css');

  assert.equal(historyPageJs.includes('createPinIcon'), true);
  assert.equal(historyPageJs.includes('const label = getPinButtonLabel(item);'), true);
  assert.equal(historyPageJs.includes('button.title = label;'), true);
  assert.equal(historyPageJs.includes("button.setAttribute('aria-label', label);"), true);
  assert.equal(
    historyPageJs.includes("button.textContent = item.isPinned ? '取消置顶' : '置顶';"),
    false
  );
  assert.equal(css.includes('.item-action-button svg'), true);
  assert.equal(css.includes('width: 26px;'), true);
});

test('pinned results rely on pin affordances instead of a metadata tag', () => {
  assert.equal(historyPageJs.includes("createTag('已置顶')"), false);
  assert.equal(historyPageJs.includes("row.classList.add('result-item-pinned');"), true);
  assert.equal(historyPageJs.includes('button.setAttribute(\'aria-pressed\', String(Boolean(item.isPinned)))'), true);
});

test('history results expose an icon-only rename control', () => {
  const css = readText('../src/styles.css');

  assert.equal(historyPageJs.includes('createRenameButton'), true);
  assert.equal(historyPageJs.includes('createEditIcon'), true);
  assert.equal(historyPageJs.includes("button.title = '修改网页名';"), true);
  assert.equal(historyPageJs.includes("button.setAttribute('aria-label', '修改网页名');"), true);
  assert.equal(historyPageJs.includes('saveTitleOverride'), true);
  assert.equal(historyPageJs.includes('saveTitleOverridesForKeys'), true);
  assert.equal(historyPageJs.includes('deleteTitleOverrides'), true);
  assert.equal(historyPageJs.includes('还原原名'), true);
  assert.equal(
    historyPageJs.includes('applyTitleOverridesToItems(itemsWithWindowVisitCounts, titleOverrides)'),
    true
  );
  assert.equal(historyPageJs.includes('createRenameDialog'), true);
  assert.equal(historyPageJs.includes('globalThis.prompt'), false);
  assert.equal(css.includes('.item-action-button'), true);
  assert.equal(css.includes('.rename-dialog::backdrop'), true);
});

test('renamed results carry no row-level decoration', () => {
  const css = readText('../src/styles.css');

  assert.equal(historyPageJs.includes("createTag('已重命名')"), false);
  assert.equal(historyPageJs.includes("row.classList.add('result-item-renamed');"), false);
  assert.equal(css.includes('.result-item-renamed'), false);
  assert.equal(css.includes('background: rgba(24, 128, 56'), false);
});

test('rename summary metric toggles a renamed-pages filter', () => {
  const css = readText('../src/styles.css');

  assert.equal(historyPageJs.includes('let showRenamedOnly = false;'), true);
  assert.equal(historyPageJs.includes('let currentFlatItems = [];'), true);
  assert.equal(historyPageJs.includes('createRenameMetric'), true);
  assert.equal(historyPageJs.includes('matchedItems.filter((item) => item.isTitleRenamed)'), true);
  assert.equal(historyPageJs.includes("metric.setAttribute('aria-pressed', String(showRenamedOnly));"), true);
  assert.equal(historyPageJs.includes('showRenamedOnly = !showRenamedOnly;'), true);
  assert.equal(historyPageJs.includes('metricValue.textContent = String(titleOverrides.size);'), false);
  assert.equal(historyPageJs.includes('metric.disabled = titleOverrides.size === 0 && !showRenamedOnly;'), false);
  assert.equal(css.includes('.metric-button[aria-pressed="true"]'), true);
});

test('minimal summary metric toggles service-level compaction', () => {
  assert.equal(historyPageJs.includes("const MINIMAL_DEDUPE_MODE = 'minimal-service';"), true);
  assert.equal(historyPageJs.includes('let showMinimalMode = false;'), true);
  assert.equal(historyPageJs.includes('createMinimalModeMetric'), true);
  assert.equal(historyPageJs.includes('showMinimalMode = !showMinimalMode;'), true);
  assert.equal(historyPageJs.includes('dedupeHistoryItems(titleDedupedItems, MINIMAL_DEDUPE_MODE)'), true);
  assert.equal(historyPageJs.includes('if (!showMinimalMode) {'), true);
  assert.equal(historyPageJs.includes("metricLabel.textContent = '极简';"), true);
  assert.equal(historyPageJs.includes("metricValue.textContent = showMinimalMode ? 'On' : 'Off';"), false);
});

test('summary exposes a collapse-all grouped-results action', () => {
  assert.equal(historyPageJs.includes('createCollapseMetric'), true);
  assert.equal(historyPageJs.includes("metricLabel.textContent = '折叠';"), true);
  assert.equal(historyPageJs.includes("metric.title = '折叠所有分组';"), true);
  assert.equal(historyPageJs.includes('metric.disabled = showRenamedOnly || currentGroups.length === 0;'), true);
  assert.equal(historyPageJs.includes('collapseAllGroups();'), true);
  assert.equal(historyPageJs.includes("results.querySelectorAll('.result-group-details[open]')"), true);
  assert.equal(historyPageJs.includes('details.open = false;'), true);
});

test('renamed-pages filter renders bare result items without domain groups', () => {
  assert.equal(historyPageJs.includes('renderFlatResults'), true);
  assert.equal(historyPageJs.includes('currentGroups = showRenamedOnly ? [] : groupedItems;'), true);
  assert.equal(historyPageJs.includes('currentFlatItems = showRenamedOnly ? sortItemsByDisplayName(dedupedItems) : [];'), true);
  assert.equal(historyPageJs.includes('renderFlatResults(applyPinnedStateToItems(currentFlatItems, pinnedUrlKeys));'), true);
  assert.equal(historyPageJs.includes('results.append(createResultItem(item));'), true);
  assert.equal(historyPageJs.includes('applyPinnedStateToItems'), true);
});

test('renamed-pages filter sorts bare results by display name', () => {
  assert.equal(historyPageJs.includes("const nameCollator = new Intl.Collator('zh-CN'"), true);
  assert.equal(historyPageJs.includes('function sortItemsByDisplayName(items)'), true);
  assert.equal(historyPageJs.includes('nameCollator.compare(getItemDisplayName(left), getItemDisplayName(right))'), true);
  assert.equal(historyPageJs.includes('function getItemDisplayName(item)'), true);
});

test('domain groups can be renamed and restored', () => {
  assert.equal(historyPageJs.includes('GROUP_NAME_OVERRIDES_STORAGE_KEY'), true);
  assert.equal(historyPageJs.includes('loadGroupNameOverrides'), true);
  assert.equal(historyPageJs.includes('saveGroupNameOverride'), true);
  assert.equal(historyPageJs.includes('deleteGroupNameOverride'), true);
  assert.equal(historyPageJs.includes('createGroupRenameButton'), true);
  assert.equal(historyPageJs.includes("button.title = '修改分组名';"), true);
  assert.equal(historyPageJs.includes("event.stopPropagation();"), true);
  assert.equal(historyPageJs.includes('createGroupRenameDialog'), true);
  assert.equal(historyPageJs.includes("title: '修改分组名'"), true);
  assert.equal(historyPageJs.includes("fieldLabel: '分组名'"), true);
  assert.equal(historyPageJs.includes('restoreGroupOriginalName'), true);
  assert.equal(historyPageJs.includes('applyGroupNameOverridesToGroups'), true);
  assert.equal(historyPageJs.includes('Number(right.isGroupRenamed) - Number(left.isGroupRenamed)'), true);
  assert.equal(historyPageJs.includes('nameCollator.compare(getGroupDisplayName(left), getGroupDisplayName(right))'), true);
  assert.equal(historyPageJs.includes('function getGroupDisplayName(group)'), true);
  assert.equal(historyPageJs.includes('left.originalIndex - right.originalIndex'), true);
});

test('rename shortcut has a focused extension window surface', () => {
  assert.equal(renameHtml.includes('id="rename-form"'), true);
  assert.equal(renameHtml.includes('id="rename-title"'), true);
  assert.equal(renameHtml.includes('id="restore-button"'), true);
  assert.equal(renamePageJs.includes('loadRenameDraft'), true);
  assert.equal(renamePageJs.includes('saveTitleOverride'), true);
  assert.equal(renamePageJs.includes('deleteTitleOverrides'), true);
  assert.equal(backgroundJs.includes("const RENAME_CURRENT_PAGE_COMMAND = 'rename-current-page';"), true);
  assert.equal(backgroundJs.includes('chrome.windows.create'), true);
});

test('rename shortcut popup is centered over the active browser window', () => {
  assert.equal(backgroundJs.includes('chrome.windows.get(windowId'), true);
  assert.equal(backgroundJs.includes('createRenameWindow(draft.id, tab.windowId)'), true);
  assert.equal(backgroundJs.includes('const placement = await getCenteredWindowPlacement(windowId);'), true);
  assert.equal(backgroundJs.includes('const left = getCenteredCoordinate'), true);
  assert.equal(backgroundJs.includes('return { left, top };'), true);
  assert.equal(backgroundJs.includes('...placement,'), true);
});

test('rename shortcut uses an inline dialog inside fullscreen browser windows', () => {
  assert.equal(backgroundJs.includes("window?.state === 'fullscreen'"), true);
  assert.equal(backgroundJs.includes('openInlineRenameDialog(tab, draft)'), true);
  assert.equal(backgroundJs.includes("const INLINE_RENAME_SCRIPT = 'src/rename-overlay.js';"), true);
  assert.equal(backgroundJs.includes('chrome.scripting.executeScript'), true);
  assert.equal(backgroundJs.includes('chrome.tabs.sendMessage'), true);
  assert.equal(backgroundJs.includes('saveInlineRename'), true);
  assert.equal(backgroundJs.includes('restoreInlineRename'), true);
  assert.equal(backgroundJs.includes('await saveRenameDraft(draft);'), true);
  assert.equal(backgroundJs.includes('await createRenameWindow(draft.id, tab.windowId);'), true);
});

test('inline rename dialog can save, restore, cancel, and close with Escape', () => {
  assert.equal(renameOverlayJs.includes('deduped-history:init-inline-rename'), true);
  assert.equal(renameOverlayJs.includes('deduped-history:save-inline-rename'), true);
  assert.equal(renameOverlayJs.includes('deduped-history:restore-inline-rename'), true);
  assert.equal(renameOverlayJs.includes("host.attachShadow({ mode: 'open' })"), true);
  assert.equal(renameOverlayJs.includes("saveButton.textContent = '保存';"), true);
  assert.equal(renameOverlayJs.includes("restoreButton.textContent = '还原原名';"), true);
  assert.equal(renameOverlayJs.includes("cancelButton.textContent = '取消';"), true);
  assert.equal(renameOverlayJs.includes("event.key === 'Escape'"), true);
});

test('inline rename dialog hides the current URL to keep the dialog focused', () => {
  assert.equal(renameOverlayJs.includes("url.className = 'url';"), false);
  assert.equal(renameOverlayJs.includes('url.textContent = draft.url'), false);
  assert.equal(renameOverlayJs.includes('panel.append(title, field, status, actions);'), true);
});

function readText(relativePath) {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8');
}
