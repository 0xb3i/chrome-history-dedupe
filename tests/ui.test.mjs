import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const historyHtml = readText('../history.html');
const popupHtml = readText('../popup.html');
const renameHtml = readText('../rename.html');
const historyPageJs = readText('../src/history-page.js');
const historyDataJs = readText('../src/history-data.js');
const historyIndexDeriveJs = readText('../src/history-index/derive.js');
const historyIndexServiceJs = readText('../src/history-index/service.js');
const historyIndexStoreJs = readText('../src/history-index/store.js');
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

test('history surfaces show the loaded extension version', () => {
  for (const html of [historyHtml, popupHtml]) {
    assert.equal(html.includes('id="app-version"'), true);
    assert.equal(html.includes('class="version-badge"'), true);
  }

  assert.equal(historyPageJs.includes('chrome?.runtime?.getManifest?.()?.version'), true);
  assert.equal(historyPageJs.includes('appVersion.textContent = `v${version}`;'), true);
});

test('background index dedupes by stable page family before the page filters', () => {
  assert.equal(historyPageJs.includes("querySelector('#mode')"), false);
  assert.equal(historyPageJs.includes('modeSelect'), false);
  assert.equal(historyIndexDeriveJs.includes("dedupeHistoryItems(renamedItems, 'normalized-url')"), true);
  assert.equal(historyIndexDeriveJs.includes("dedupeHistoryItems(urlItems, 'page-family')"), true);
  assert.equal(historyPageJs.includes('historyIndexStore.loadRange'), true);
  assert.equal(historyPageJs.includes('filterHistoryItemsByQuery(pageItems, String(query'), true);
});

test('history page filters committed indexes locally without accessing Chrome history', () => {
  assert.equal(historyIndexDeriveJs.includes('applyCapturedTitlesToItems'), true);
  assert.equal(historyIndexDeriveJs.includes('applyTitleOverridesToItems'), true);
  assert.equal(historyPageJs.includes('filterHistoryItemsByQuery(pageItems, String(query'), true);
  assert.equal(historyPageJs.includes('chrome?.history'), false);
  assert.equal(historyPageJs.includes("from './history-data.js'"), false);
  assert.equal(historyPageJs.includes('scheduleSnapshotRender'), true);
});

test('only the latest asynchronous search may render results', () => {
  assert.equal(historyPageJs.includes('let latestSearchRequestId = 0;'), true);
  assert.equal(historyPageJs.includes('const searchRequestId = ++latestSearchRequestId;'), true);
  assert.equal(historyPageJs.includes('if (searchRequestId !== latestSearchRequestId)'), true);
  assert.equal(historyPageJs.includes('isLatestSearchRequest(searchRequestId)'), true);
});

test('typing does not trigger a search until the form is submitted', () => {
  assert.equal(historyPageJs.includes('SEARCH_INPUT_DEBOUNCE_MS'), false);
  assert.equal(historyPageJs.includes("queryInput.addEventListener('input'"), false);
  assert.equal(historyPageJs.includes('scheduleSearchFromInput'), false);
  assert.equal(historyPageJs.includes('clearScheduledInputSearch'), false);
});

test('background captures final tab titles for current and future tabs', () => {
  assert.equal(backgroundJs.includes('chrome?.tabs?.onUpdated?.addListener'), true);
  assert.equal(backgroundJs.includes('captureOpenTabTitles();'), true);
  assert.equal(backgroundJs.includes('saveCapturedPageTitle'), true);
  assert.equal(backgroundJs.includes('getHistoryItemCapturedTitleKey'), true);
  assert.equal(backgroundJs.includes('changeInfo?.title'), true);
  assert.equal(backgroundJs.includes('navigationTracker.update'), true);
  assert.equal(backgroundJs.includes('navigationUrls'), true);
});

test('background incrementally updates the persistent index when history changes', () => {
  assert.equal(backgroundJs.includes('history?.onVisited?.addListener'), true);
  assert.equal(backgroundJs.includes('history?.onVisitRemoved?.addListener'), true);
  assert.equal(backgroundJs.includes('historyIndexService.handleVisited(item)'), true);
  assert.equal(backgroundJs.includes('historyIndexService.handleRemoved(details)'), true);
  assert.equal(historyIndexServiceJs.includes('store.applyRawMutation'), true);
});

test('history page reads atomic IndexedDB generations and never performs API refreshes', () => {
  assert.equal(historyDataJs.includes('getVisits'), false);
  assert.equal(historyPageJs.includes('historyIndexStore.loadRange'), true);
  assert.equal(historyPageJs.includes('HISTORY_INDEX_ENSURE_MESSAGE'), true);
  assert.equal(historyPageJs.includes('saveLastSearchSnapshot'), false);
  assert.equal(historyPageJs.includes('searchChromeHistory'), false);
  assert.equal(historyPageJs.includes('async function init() {\n  setLoading();'), false);
  assert.equal(historyPageJs.includes("form.addEventListener('submit'"), true);
  assert.equal(historyPageJs.includes('hasPageItemsSnapshot && pageItemsRange === requestedRange'), true);
  assert.equal(historyPageJs.includes('createSearchSnapshotFromPageItems(pageItemsSnapshot'), true);
  assert.equal(historyIndexStoreJs.includes('activeGeneration'), true);
  assert.equal(historyIndexStoreJs.includes('committedRevision'), true);
});

test('renamed pages remain visible outside the selected time window', () => {
  assert.equal(historyIndexDeriveJs.includes('appendTimeExemptRenamedItems(windowItems, titleOverrides, {'), true);
  assert.equal(historyIndexDeriveJs.includes('allHistoryItems: items'), true);
  assert.equal(historyDataJs.includes('existingPageKeys.has(pageKey)'), true);
  assert.equal(historyDataJs.includes('renamedPageKeys.has(pageKey)'), true);
  assert.equal(backgroundJs.includes('historyIndexService.rebuildDerived'), true);
});

test('history surfaces do not expose a max results control', () => {
  for (const html of [historyHtml, popupHtml]) {
    assert.equal(html.includes('id="max-results"'), false);
    assert.equal(html.includes('<span>上限</span>'), false);
  }

  assert.equal(historyPageJs.includes('maxResultsInput'), false);
  assert.equal(historyDataJs.includes('DEFAULT_HISTORY_PAGE_SIZE = 10000'), true);
  assert.equal(historyDataJs.includes('while (true)'), true);
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

test('grouped results keep rounded corners filled over page content', () => {
  const css = readText('../src/styles.css');

  assert.match(css, /\.results \{[\s\S]*?border-radius: var\(--radius\);/);
  assert.match(css, /\.results \{[\s\S]*?background: var\(--surface\);/);
  assert.match(css, /\.results \{[\s\S]*?overflow: hidden;/);
  assert.match(css, /\.result-group \{[\s\S]*?background: var\(--surface\);/);
  assert.match(css, /\.result-group \{[\s\S]*?overflow: hidden;/);
  assert.match(css, /\.result-group:first-child \{[\s\S]*?border-top-left-radius: var\(--radius\);/);
  assert.match(css, /\.result-group:first-child \{[\s\S]*?border-top-right-radius: var\(--radius\);/);
  assert.match(css, /\.result-group:last-child \{[\s\S]*?border-bottom-left-radius: var\(--radius\);/);
  assert.match(css, /\.result-group:last-child \{[\s\S]*?border-bottom-right-radius: var\(--radius\);/);
});

test('flat popup results clip row backgrounds inside the rounded border', () => {
  const css = readText('../src/styles.css');

  assert.match(css, /\.popup-results \{[^}]*overflow: hidden;/);
  assert.match(css, /\.popup-results > \.result-item:first-child \{[^}]*border-top-left-radius: inherit;/);
  assert.match(css, /\.popup-results > \.result-item:first-child \{[^}]*border-top-right-radius: inherit;/);
  assert.match(css, /\.popup-results > \.result-item:last-child \{[^}]*border-bottom-left-radius: inherit;/);
  assert.match(css, /\.popup-results > \.result-item:last-child \{[^}]*border-bottom-right-radius: inherit;/);
});

test('result metadata omits merge count and shortens dates for the current year', () => {
  assert.equal(historyPageJs.includes('合并 ${item.dedupeCount} 条'), false);
  assert.equal(historyPageJs.includes('currentYearDateFormatter'), true);
  assert.equal(historyPageJs.includes('otherYearDateFormatter'), true);
  assert.equal(historyPageJs.includes("date.getFullYear() === new Date().getFullYear()"), true);
  assert.equal(historyPageJs.includes('createTag(`${visitCount} 次访问`)'), true);
  assert.equal(historyPageJs.includes('至少 ${visitCount} 次访问'), false);
});

test('popup search controls stay on one row despite mobile media rules', () => {
  const css = readText('../src/styles.css');

  assert.equal(css.includes('width: 620px;'), true);
  assert.equal(css.includes('max-height: 760px;'), true);
  assert.equal(css.includes('max-height: none;'), true);
  assert.equal(css.includes('grid-template-columns: minmax(260px, 520px) minmax(120px, 142px) auto;'), true);
  assert.equal(css.includes('justify-content: start;'), true);
  assert.equal(css.includes('.controls .field-wide'), true);
  assert.equal(css.includes('.popup-body .popup-controls'), true);
  assert.equal(css.includes('grid-template-columns: minmax(180px, 1fr) 96px auto;'), true);
  assert.match(css, /\.popup-controls \{[\s\S]*?padding: 8px;/);
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

test('full history controls stack above later animated content while the range menu is open', () => {
  const css = readText('../src/styles.css');

  assert.match(css, /\.controls \{[^}]*position: relative;/);
  assert.match(css, /\.controls \{[^}]*z-index: 30;/);
});

test('search clear control follows Ant-style flat allowClear affordance', () => {
  const css = readText('../src/styles.css');

  assert.equal(historyHtml.includes('input id="query" type="search"'), true);
  assert.equal(popupHtml.includes('input id="query" type="search"'), true);
  assert.equal(css.includes('.field input[type="search"]::-webkit-search-cancel-button'), true);
  assert.match(css, /\.field input\[type="search"\] \{\s+padding-right: 11px;\s+\}/);
  assert.equal(css.includes('-webkit-appearance: none;'), true);
  assert.equal(css.includes('width: 14px;'), true);
  assert.equal(css.includes('height: 14px;'), true);
  assert.equal(css.includes('background: rgba(0, 0, 0, 0.25);'), true);
  assert.equal(css.includes('background: rgba(0, 0, 0, 0.45);'), true);
  assert.equal(css.includes("viewBox='64 64 896 896'"), true);
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
  assert.equal(historyPageJs.includes('togglePinnedUrlKey'), true);
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
  assert.equal(historyPageJs.includes('void rememberCurrentSearchState();'), true);
  assert.equal(historyPageJs.includes('await rememberCurrentSearchState();'), false);
});

test('popup selects the restored query when opened from the shortcut', () => {
  assert.equal(popupHtml.includes('class="popup-body"'), true);
  assert.equal(historyPageJs.includes('selectQueryInputOnPopupOpen();'), true);
  assert.equal(historyPageJs.includes("document.body.classList.contains('popup-body')"), true);
  assert.equal(historyPageJs.includes('queryInput.focus();'), true);
  assert.equal(historyPageJs.includes('queryInput.select();'), true);
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
  assert.equal(historyPageJs.includes('saveTitleOverride'), true);
  assert.equal(historyPageJs.includes('saveTitleOverridesForKeys'), false);
  assert.equal(historyPageJs.includes('deleteTitleOverrides'), true);
  assert.equal(historyPageJs.includes('还原原名'), true);
  assert.equal(
    historyIndexDeriveJs.includes('applyTitleOverridesToItems(capturedTitleItems, titleOverrides)'),
    true
  );
  assert.equal(historyPageJs.includes('createRenameDialog'), true);
  assert.equal(historyPageJs.includes('globalThis.prompt'), false);
  assert.equal(css.includes('.item-action-button'), true);
  assert.equal(css.includes('.rename-dialog::backdrop'), true);
});

test('renaming a merged result stores its target URL and restore clears all family keys', () => {
  assert.equal(historyPageJs.includes('getRenameDialogTitleOverrideKey()'), true);
  assert.equal(historyPageJs.includes('getRenameDialogTitleOverrideKeys()'), true);
  assert.equal(historyPageJs.includes('targetUrl: renameDialogItem.url'), true);
  assert.equal(historyPageJs.includes('deleteTitleOverrides(getRenameDialogTitleOverrideKeys())'), true);
});

test('renamed results show a compact text tag without row-level decoration', () => {
  const css = readText('../src/styles.css');

  assert.match(
    historyPageJs,
    /titleRow\.append\(title\);\s*if \(item\.isTitleRenamed\) \{\s*titleRow\.append\(createRenamedTag\(\)\);/
  );
  assert.equal(historyPageJs.includes("tag.className = 'renamed-tag';"), true);
  assert.equal(historyPageJs.includes("tag.textContent = '已重命名';"), true);
  assert.equal(historyPageJs.includes("tag.title = '当前显示的是自定义网页名';"), true);
  assert.equal(historyPageJs.includes("row.classList.add('result-item-renamed');"), false);
  assert.equal(css.includes('.result-item-renamed'), false);
  assert.equal(css.includes('background: rgba(24, 128, 56'), false);
  assert.match(css, /\.renamed-tag \{[\s\S]*?background: var\(--accent-tint\);/);
  assert.match(css, /\.renamed-tag \{[\s\S]*?color: var\(--accent-strong\);/);
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

test('minimal summary metric only changes presentation and never bypasses safe dedupe', () => {
  const css = readText('../src/styles.css');

  assert.equal(historyPageJs.includes("const MINIMAL_DEDUPE_MODE = 'minimal-service';"), false);
  assert.equal(historyPageJs.includes('let showMinimalMode = false;'), true);
  assert.equal(historyPageJs.includes('createMinimalModeMetric'), true);
  assert.equal(historyPageJs.includes('showMinimalMode = !showMinimalMode;'), true);
  assert.equal(historyPageJs.includes('dedupeHistoryItems(titleDedupedItems, MINIMAL_DEDUPE_MODE)'), false);
  assert.equal(
    historyIndexDeriveJs.includes("prepareHistoryItemsForSearch(dedupeHistoryItems(urlItems, 'page-family'))"),
    true
  );
  assert.equal(historyPageJs.includes("document.body.classList.toggle('minimal-mode', showMinimalMode)"), true);
  assert.equal(historyPageJs.includes('syncMinimalModePresentation(metric);'), true);
  assert.match(css, /\.minimal-mode \.result-url \{[\s\S]*?display: none;/);
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

test('live-title refresh action and background workflow are not exposed', () => {
  for (const source of [historyPageJs, backgroundJs]) {
    assert.equal(source.includes('刷新标题'), false);
    assert.equal(source.includes('deduped-history:refresh-live-titles'), false);
    assert.equal(source.includes('deduped-history:title-refresh-progress'), false);
    assert.equal(source.includes('getUniqueRefreshableHistoryUrls'), false);
  }
});

test('group toggles and result rows do not accidentally select text', () => {
  const css = readText('../src/styles.css');

  assert.match(css, /\.result-group-summary \{[\s\S]*?user-select: none;/);
  assert.match(css, /\.result-item \{[\s\S]*?user-select: none;/);
});

test('long result titles clip before action buttons', () => {
  const css = readText('../src/styles.css');

  assert.match(css, /\.result-item \{[\s\S]*?grid-template-columns: minmax\(0, 1fr\) auto;/);
  assert.match(css, /\.result-content \{[\s\S]*?min-width: 0;/);
  assert.match(css, /\.result-title-row \{[\s\S]*?display: flex;/);
  assert.match(css, /\.result-title-row \{[\s\S]*?min-width: 0;/);
  assert.match(css, /\.result-title \{[\s\S]*?display: block;/);
  assert.match(css, /\.result-title \{[\s\S]*?flex: 0 1 auto;/);
  assert.match(css, /\.result-title \{[\s\S]*?max-width: 100%;/);
  assert.match(css, /\.result-title \{[\s\S]*?overflow: hidden;/);
  assert.match(css, /\.result-title \{[\s\S]*?text-overflow: ellipsis;/);
  assert.match(css, /\.result-title \{[\s\S]*?white-space: nowrap;/);
  assert.match(css, /\.renamed-tag \{[\s\S]*?flex: 0 0 auto;/);
});

test('renamed-pages filter renders bare result items without domain groups', () => {
  assert.equal(historyPageJs.includes('renderFlatResults'), true);
  assert.equal(historyPageJs.includes('currentGroups = showRenamedOnly ? [] : groupedItems;'), true);
  assert.equal(historyPageJs.includes('currentFlatItems = showRenamedOnly ? sortItemsByDisplayName(visibleItems) : [];'), true);
  assert.equal(historyPageJs.includes('renderFlatResults(applyPinnedStateToItems(currentFlatItems, pinnedUrlKeys));'), true);
  assert.equal(historyPageJs.includes('fragment.append(createResultItem(item));'), true);
  assert.equal(historyPageJs.includes('applyPinnedStateToItems'), true);
});

test('renamed-pages filter sorts bare results by display name', () => {
  assert.equal(historyPageJs.includes('compareDisplayNames,'), true);
  assert.equal(historyPageJs.includes('function sortItemsByDisplayName(items)'), true);
  assert.equal(historyPageJs.includes('compareDisplayNames(getItemDisplayName(left), getItemDisplayName(right))'), true);
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
  assert.equal(historyPageJs.includes('compareDisplayNames(getGroupDisplayName(left), getGroupDisplayName(right))'), true);
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

test('rename success uses an Ant-style floating message while errors stay inline', () => {
  const css = readText('../src/styles.css');

  assert.equal(renameHtml.indexOf('id="rename-status"') < renameHtml.indexOf('class="rename-actions"'), true);
  assert.equal(renamePageJs.includes("showSuccessMessage('保存成功')"), true);
  assert.equal(renamePageJs.includes("showSuccessMessage('已还原原名')"), true);
  assert.equal(renamePageJs.includes("element.className = 'rename-message';"), true);
  assert.equal(renamePageJs.includes("globalThis.setTimeout(closeWindow, 1200)"), true);
  assert.match(css, /\.rename-status \{[\s\S]*?color: var\(--danger\);/);
  assert.match(css, /\.rename-status:empty \{[\s\S]*?display: none;/);
  assert.match(css, /\.rename-message \{[\s\S]*?position: fixed;[\s\S]*?top: 16px;/);
  assert.match(css, /\.rename-message-icon \{[\s\S]*?color: var\(--success\);/);
});

test('rename shortcut falls back to a popup centered over the active browser window', () => {
  assert.equal(backgroundJs.includes('chrome.windows.get(windowId'), true);
  assert.equal(backgroundJs.includes('createRenameWindow(draft.id, tab.windowId)'), true);
  assert.equal(backgroundJs.includes('const placement = await getCenteredWindowPlacement(windowId);'), true);
  assert.equal(backgroundJs.includes('const left = getCenteredCoordinate'), true);
  assert.equal(backgroundJs.includes('return { left, top };'), true);
  assert.equal(backgroundJs.includes('...placement,'), true);
});

test('rename shortcut prefers an inline dialog on the active page before using a popup', () => {
  assert.equal(backgroundJs.includes('if (await openInlineRenameDialog(tab, draft))'), true);
  assert.equal(backgroundJs.includes("const INLINE_RENAME_SCRIPT = 'src/rename-overlay.js';"), true);
  assert.equal(backgroundJs.includes('chrome.scripting.executeScript'), true);
  assert.equal(backgroundJs.includes('chrome.tabs.sendMessage'), true);
  assert.equal(backgroundJs.includes('saveInlineRename'), true);
  assert.equal(backgroundJs.includes('restoreInlineRename'), true);
  assert.equal(backgroundJs.includes('await saveRenameDraft(draft);'), true);
  assert.equal(backgroundJs.includes('await createRenameWindow(draft.id, tab.windowId);'), true);
  assert.equal(
    backgroundJs.indexOf('openInlineRenameDialog(tab, draft)') <
      backgroundJs.indexOf('createRenameWindow(draft.id, tab.windowId)'),
    true
  );
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
  assert.equal(renameOverlayJs.includes("showSuccessMessage(shadow, overlay, '保存成功')"), true);
  assert.equal(renameOverlayJs.includes("showSuccessMessage(shadow, overlay, '已还原原名')"), true);
  assert.equal(renameOverlayJs.includes("globalThis.setTimeout(close, 1200)"), true);
  assert.equal(renameOverlayJs.includes('color: #389e0d;'), true);
  assert.equal(renameOverlayJs.includes('restoreButton.dataset.restoreAvailable'), true);
});

test('inline rename input isolates keystrokes from host page shortcuts', () => {
  assert.equal(renameOverlayJs.includes("window.addEventListener('keydown', protectRenameKeystroke, true)"), true);
  assert.equal(renameOverlayJs.includes('event.composedPath().includes(host)'), true);
  assert.equal(renameOverlayJs.includes('event.stopImmediatePropagation()'), true);
  assert.equal(renameOverlayJs.includes("window.removeEventListener('keydown', protectRenameKeystroke, true)"), true);
});

test('inline rename dialog hides the current URL to keep the dialog focused', () => {
  assert.equal(renameOverlayJs.includes("url.className = 'url';"), false);
  assert.equal(renameOverlayJs.includes('url.textContent = draft.url'), false);
  assert.equal(renameOverlayJs.includes('panel.append(title, field, status, actions);'), true);
});

function readText(relativePath) {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8');
}
