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
const css = readText('../src/styles.css');

// Static surface and entry-point contracts only. Ordering, asynchronous results,
// rename sessions and index publication are tested through their public behavior
// in search-state, rename-session, history-index and history-index-store tests.
test('history and popup share the same search entry and visible controls', () => {
  for (const html of [historyHtml, popupHtml]) {
    assert.match(html, /<script type="module" src="src\/history-page\.js"><\/script>/);
    assert.match(html, /href="src\/styles\.css"/);
    for (const id of ['search-form', 'query', 'range', 'results', 'summary', 'app-version']) {
      assert.equal(html.match(new RegExp(`id="${id}"`, 'g'))?.length, 1, id);
    }
    assert.match(html, /input id="query" type="search"/);
    assert.doesNotMatch(html, /id="(?:mode|max-results)"/);
    assert.match(html, /class="version-badge"/);
    assert.doesNotMatch(html, /<span>范围<\/span>/);
    assert.match(html, /<span class="visually-hidden">时间筛选<\/span>/);
    for (const value of ['day', 'week', 'month', 'quarter', 'all']) {
      assert.match(html, new RegExp(`<option value="${value}"`));
    }
  }
  assert.match(historyPageJs, /chrome\?\.runtime\?\.getManifest\?\.\(\)\?\.version/);
});

test('the search form and shortcut settings have entry handlers', () => {
  assert.ok(historyPageJs.includes("form.addEventListener('submit'"));
  assert.match(historyHtml, /id="shortcut-settings"/);
  assert.doesNotMatch(historyHtml, /href="chrome:\/\/extensions\/shortcuts"/);
  assert.ok(historyPageJs.includes("querySelector('#shortcut-settings')"));
  assert.ok(historyPageJs.includes('chrome?.tabs?.create'));
  assert.ok(historyPageJs.includes('chrome://extensions/shortcuts'));
});

test('background wires browser events to navigation tracking and history maintenance', () => {
  for (const event of ['onBeforeNavigate', 'onCommitted', 'onErrorOccurred']) {
    assert.ok(backgroundJs.includes(`webNavigation?.${event}?.addListener`), event);
  }
  for (const event of ['onVisited', 'onVisitRemoved']) {
    assert.ok(backgroundJs.includes(`history?.${event}?.addListener`), event);
  }
  assert.ok(backgroundJs.includes('tabs?.onUpdated?.addListener'));
  assert.ok(backgroundJs.includes('saveCapturedPageTitles'));
  assert.ok(backgroundJs.includes('commands?.onCommand?.addListener'));
});

test('popup has a fixed measurement width and vertical scrolling', () => {
  assert.match(popupHtml, /<html class="popup-root" lang="zh-CN">/);
  assert.match(css, /\.popup-root \{[^}]*width: 580px;[^}]*min-width: 580px;[^}]*overflow: hidden;/);
  assert.match(css, /\.popup-body \{[^}]*width: 580px;[^}]*max-height: 560px;[^}]*overflow-x: hidden;[^}]*overflow-y: auto;/);
  assert.match(css, /\.controls \{[^}]*grid-template-columns: minmax\(0, 1fr\) 120px auto;/);
  assert.match(css, /\.popup-controls \{[^}]*padding: 8px;/);
});

test('result rows keep dividers and clip long titles before action buttons', () => {
  assert.ok(css.includes('.results > .result-item + .result-item'));
  assert.ok(css.includes('border-top: 1px solid var(--line);'));
  assert.match(css, /\.result-item \{[^}]*grid-template-columns: minmax\(0, 1fr\) auto;/);
  assert.match(css, /\.result-content \{[^}]*min-width: 0;/);
  assert.match(css, /\.result-title-row \{[^}]*display: flex;/);
  assert.match(css, /\.result-title \{[^}]*overflow: hidden;[^}]*text-overflow: ellipsis;[^}]*white-space: nowrap;/);
  assert.match(css, /\.renamed-tag \{[^}]*flex: 0 0 auto;/);
  assert.ok(css.includes('.popup-results .result-url'));
});

test('group containers keep rounded corners filled and clip row backgrounds', () => {
  assert.match(css, /\.results \{[^}]*background: var\(--surface\);/);
  assert.match(css, /\.results \{[^}]*border-radius: var\(--radius\);/);
  assert.match(css, /\.results \{[^}]*overflow: hidden;/);
  assert.match(css, /\.result-group \{[^}]*background: var\(--surface\);/);
  assert.match(css, /\.result-group \{[^}]*overflow: hidden;/);
  assert.match(css, /\.result-group:first-child \{[^}]*border-top-left-radius: var\(--radius\);/);
  assert.match(css, /\.result-group:last-child \{[^}]*border-bottom-right-radius: var\(--radius\);/);
  assert.match(css, /\.popup-results \{[^}]*overflow: hidden;/);
});

test('expanded same-title links use bounded comparison rows and an accessible detail dialog', () => {
  assert.ok(historyPageJs.includes('describeLinkDifferences(entry.items)'));
  assert.ok(historyPageJs.includes('title.href = item.url'));
  assert.ok(historyPageJs.includes("inspect.setAttribute('aria-haspopup', 'dialog')"));
  assert.ok(historyPageJs.includes("dialog.setAttribute('aria-label', '链接详情')"));
  assert.ok(historyPageJs.includes("dialog.addEventListener('close', () => dialog.remove()"));
  assert.doesNotMatch(historyPageJs, /title\.textContent = variant \? item\.url/);
  assert.match(css, /\.title-group-list > \.result-variant \{[^}]*height: 68px;/);
  assert.match(css, /\.result-variant \.result-content \{[^}]*grid-template-rows: 22px 18px;/);
  assert.match(css, /\.link-difference-label,\s*\.link-difference-value \{[^}]*text-overflow: ellipsis;[^}]*white-space: nowrap;/);
  assert.match(css, /\.link-details-dialog dd \{[^}]*white-space: pre-wrap;[^}]*overflow-wrap: anywhere;/);
});

test('search clear control uses the flat Ant allowClear affordance', () => {
  assert.ok(css.includes('.field input[type="search"]::-webkit-search-cancel-button'));
  assert.ok(css.includes('-webkit-appearance: none;'));
  assert.ok(css.includes('width: 14px;'));
  assert.ok(css.includes('height: 14px;'));
  assert.ok(css.includes('background: rgba(0, 0, 0, 0.25);'));
  assert.ok(css.includes('background: rgba(0, 0, 0, 0.45);'));
  assert.ok(css.includes("viewBox='64 64 896 896'"));
});

test('result actions expose icon labels and pressed-state affordances', () => {
  for (const label of ['修改网页名', '修改分组名']) {
    assert.ok(historyPageJs.includes(`button.title = '${label}'`));
  }
  assert.ok(historyPageJs.includes("button.setAttribute('aria-label', label)"));
  assert.ok(historyPageJs.includes('aria-pressed'));
  assert.ok(css.includes('.item-action-button svg'));
  assert.ok(css.includes('.metric-button[aria-pressed="true"]'));
  assert.match(css, /\.minimal-mode \.result-url \{[^}]*display: none;/);
});

test('renamed tags stay compact and result rows do not select text accidentally', () => {
  assert.ok(historyPageJs.includes("tag.textContent = '已重命名'"));
  assert.match(css, /\.renamed-tag \{[^}]*background: var\(--accent-tint\);/);
  assert.match(css, /\.renamed-tag \{[^}]*color: var\(--accent-strong\);/);
  assert.doesNotMatch(css, /\.result-item-renamed/);
  assert.match(css, /\.result-group-summary \{[^}]*user-select: none;/);
  assert.match(css, /\.result-item \{[^}]*user-select: none;/);
});

test('fallback rename window exposes its form and shared stylesheet', () => {
  for (const id of ['rename-form', 'rename-title', 'restore-button', 'cancel-button', 'rename-status']) {
    assert.ok(renameHtml.includes(`id="${id}"`), id);
  }
  assert.match(renameHtml, /src="src\/rename-page\.js"/);
  assert.match(renameHtml, /href="src\/styles\.css"/);
  assert.match(renameHtml, /id="rename-status"[^>]*role="alert"/);
  assert.ok(renamePageJs.includes('loadRenameDraft'));
  assert.ok(backgroundJs.includes('chrome.windows.create'));
});

test('rename errors are inline and success messages use floating Ant styling', () => {
  assert.ok(renameHtml.indexOf('id="rename-status"') < renameHtml.indexOf('class="rename-actions"'));
  assert.match(css, /\.rename-status \{[^}]*color: var\(--danger\);/);
  assert.match(css, /\.rename-status:empty \{[^}]*display: none;/);
  assert.match(css, /\.rename-message \{[^}]*position: fixed;[^}]*top: 16px;/);
  assert.match(css, /\.rename-message-icon \{[^}]*color: var\(--success\);/);
});

test('inline rename surface uses shadow DOM and labeled actions', () => {
  assert.ok(renameOverlayJs.includes("host.attachShadow({ mode: 'open' })"));
  for (const label of ['保存', '还原原名', '取消']) {
    assert.ok(renameOverlayJs.includes(`textContent = '${label}'`));
  }
  assert.doesNotMatch(renameOverlayJs, /url\.textContent = draft\.url/);
  assert.ok(renameOverlayJs.includes('deduped-history:init-inline-rename'));
});

function readText(relativePath) {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8');
}
