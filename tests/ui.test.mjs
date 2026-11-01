import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const optionsHtml = readText('../options.html');
const settingsPageJs = readText('../src/settings-page.js');
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
test('popup is the only search surface and settings live on the options page', () => {
  assert.match(popupHtml, /<script type="module" src="src\/history-page\.js"><\/script>/);
  assert.match(popupHtml, /href="src\/styles\.css"/);
  for (const id of ['search-form', 'query', 'range', 'results', 'summary', 'renamed-only', 'open-settings',
    'actions-panel', 'actions-list']) {
    assert.equal(popupHtml.match(new RegExp(`id="${id}"`, 'g'))?.length, 1, id);
  }
  assert.match(popupHtml, /input id="query" type="search"/);
  assert.match(popupHtml, /<span class="visually-hidden">时间筛选<\/span>/);
  for (const value of ['day', 'week', 'month', 'quarter', 'all']) {
    assert.match(popupHtml, new RegExp(`<option value="${value}"`));
  }
  assert.doesNotMatch(popupHtml, /history\.html/);
  for (const id of ['user-data-controls', 'export-user-data', 'import-user-data', 'user-data-file', 'user-data-status',
    'shortcut-settings', 'app-version', 'theme-color']) {
    assert.match(optionsHtml, new RegExp(`id="${id}"`), id);
  }
  assert.match(optionsHtml, /src="src\/settings-page\.js"/);
  assert.match(settingsPageJs, /chrome\?\.runtime\?\.getManifest\?\.\(\)\?\.version/);
  assert.ok(settingsPageJs.includes('chrome://extensions/shortcuts'));
  assert.ok(historyPageJs.includes("form.addEventListener('submit'"));
  assert.ok(historyPageJs.includes('openOptionsPage'));
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

test('popup is a launcher: search row, single-line results and a keyed action bar', () => {
  assert.match(popupHtml, /<div class="launcher-bar">[\s\S]*id="search-form"[\s\S]*id="view-options"/);
  assert.match(popupHtml, /<footer class="launcher-footer">\s*<section class="summary" id="summary"/);
  assert.doesNotMatch(popupHtml, /launcher-home|icons\/icon/);
  assert.match(popupHtml, /id="primary-key-hint"/);
  assert.match(popupHtml, /<kbd data-mod-key>/);
  assert.match(css, /\.popup-body \.popup-results \.result-item \.result-title,[^{]*\{[^}]*white-space: nowrap;/);
  assert.match(css, /\.actions-panel \{[^}]*position: absolute;/);
  assert.match(css, /\.popup-body \.rename-dialog-actions \.primary-button \{[^}]*background: var\(--accent\);/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*\.view-options-panel/);
});

test('extension icon renders from vector sources at every manifest size', () => {
  const manifest = JSON.parse(readText('../manifest.json'));
  for (const size of ['16', '32', '48', '128']) assert.equal(manifest.icons[size], `icons/cat-${size}.png`);
  assert.match(readText('../icons/cat.svg'), /viewBox="0 0 32 32"/);
});

test('popup has a fixed measurement width and vertical scrolling', () => {
  assert.match(popupHtml, /<html class="popup-root" lang="zh-CN">/);
  assert.match(css, /\.popup-root \{[^}]*width: 580px;[^}]*min-width: 580px;[^}]*overflow: hidden;/);
  assert.match(css, /\.popup-body \{[^}]*width: 580px;[^}]*max-height: 560px;[^}]*overflow-x: hidden;[^}]*overflow-y: hidden;/);
  assert.match(css, /\.popup-result-scroll \{[^}]*min-height: 0;[^}]*overflow-y: auto;/);
  assert.match(css, /\.controls \{[^}]*grid-template-columns: minmax\(0, 1fr\) auto;/);
  assert.match(css, /\.popup-controls \{[^}]*padding: 0;[^}]*border: 0;/);
  assert.match(css, /\.popup \{[^}]*padding: 36px 16px 12px;/);
  assert.doesNotMatch(css, /@media[^{}]*\{\s*\.shell\s*\{/);
});

test('result menu triggers and panels share their geometry and retain independent surface rules', () => {
  assert.match(css, /\.result-controls \.select-combobox \{[^}]*width: var\(--menu-control-width\);/);
  assert.match(css, /\.result-controls \.select-combobox-menu \{[^}]*width: var\(--menu-panel-width\);/);
  assert.match(css, /\.select-combobox-menu \{[^}]*position: absolute;[^}]*background: var\(--surface\);/);
  assert.match(css, /\.select-combobox-option \{[^}]*display: grid;/);
  assert.match(css, /\.summary \{[^}]*display: flex;/);
});

test('result rows keep dividers and clip long titles before action buttons', () => {
  assert.ok(css.includes('.results > li + li'));
  assert.ok(css.includes('border-top: 0;'));
  assert.match(css, /\.result-item \{[^}]*grid-template-columns: minmax\(0, 1fr\) auto;/);
  assert.match(css, /\.result-content \{[^}]*min-width: 0;/);
  assert.match(css, /\.result-title-row \{[^}]*display: flex;/);
  assert.match(css, /\.result-title \{[^}]*overflow: hidden;[^}]*text-overflow: ellipsis;[^}]*white-space: nowrap;/);
  assert.match(css, /\.result-title:has\(mark\),\s*\.result-match:has\(mark\) \{[^}]*display: -webkit-box;[^}]*-webkit-box-orient: vertical;[^}]*-webkit-line-clamp: 3;[^}]*overflow: hidden;/);
  assert.match(css, /\.result-state-icons \{[^}]*flex: 0 0 auto;/);
  assert.ok(css.includes('.popup-results .result-url'));
});

test('result containers keep rounded corners filled and clip row backgrounds', () => {
  assert.match(css, /\.results \{[^}]*background: var\(--surface\);/);
  assert.match(css, /\.results \{[^}]*border-radius: var\(--radius\);/);
  assert.match(css, /\.results \{[^}]*overflow: hidden;/);
  assert.match(css, /\.popup-results \{[^}]*overflow: hidden;/);
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

test('row actions live in the ⌘K panel rather than as buttons on each row', () => {
  assert.doesNotMatch(historyPageJs, /item-action-button/);
  for (const label of ['打开', '复制链接', '重命名网页', '只看此来源', '修改来源名称', '同名的其他链接']) {
    assert.ok(historyPageJs.includes(`'${label}'`), label);
  }
  assert.ok(css.includes('.rename-filter input:checked'));
  assert.match(css, /\.minimal-mode \.result-url \{[^}]*display: none;/);
});

test('theme palettes cover surfaces and content rather than only accent colors', () => {
  for (const theme of ['orange', 'green', 'neutral']) {
    const palette = css.match(new RegExp(`:root\\[data-theme-color="${theme}"\\] \\{([^}]+)\\}`))?.[1];
    assert.ok(palette, `${theme} palette exists`);
    for (const token of ['bg', 'canvas', 'surface-muted', 'surface-hover', 'text', 'muted',
      'subtle', 'line', 'line-card', 'line-soft', 'scroll-thumb', 'source-0', 'source-5', 'accent']) {
      assert.ok(palette.includes(`--${token}:`), `${theme} defines ${token}`);
    }
  }
  const popup = css.match(/\.popup-body \{([^}]+)\}/)?.[1];
  assert.ok(popup.includes('var(--bg)'));
  assert.ok(!popup.includes('gradient'));
  // The launcher must consume the palette, rather than hide it behind fixed
  // gray selection and yellow highlights. Its white canvas stays neutral.
  const surfaces = css.match(/\.popup-body,\s*\.rename-body,\s*\.settings-body \{([^}]+)\}/)?.[1];
  assert.match(surfaces, /--pop-bg: #ffffff;/);
  assert.match(surfaces, /--pop-selected: var\(--accent-tint\);/);
  assert.match(surfaces, /--pop-hover: var\(--surface-hover\);/);
  const highlight = css.match(/\.popup-body \.popup-results :is\(\.result-title, \.result-match\) mark \{([^}]+)\}/)?.[1];
  assert.match(highlight, /background: var\(--match-bg\);/);
  assert.match(highlight, /color: var\(--match-text\);/);
  assert.doesNotMatch(css, /background: #b3d7ff;/);
  // Theme names are controls, not swatches: their trigger stays neutral.
  const themeTrigger = css.match(/\.settings-body \.select-combobox-button \{([^}]+)\}/)?.[1];
  assert.match(themeTrigger, /color: var\(--pop-text\);/);
  assert.match(css, /\.native-select-hidden \{\s*display: none;/);
});

test('result state icons stay compact and result rows do not select text accidentally', () => {
  assert.ok(historyPageJs.includes("label.textContent = '已命名'"));
  assert.ok(!historyPageJs.includes('createNamedIcon'));
  assert.match(css, /\.result-state-icon \{[^}]*color: var\(--subtle\);/);
  assert.match(css, /\.result-state-icon svg \{[^}]*width: 12px;[^}]*height: 12px;/);
  assert.doesNotMatch(css, /\.result-item-renamed/);
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
  assert.ok(renameHtml.indexOf('id="rename-status"') < renameHtml.indexOf('class="rename-dialog-actions"'));
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
  assert.match(renameOverlayJs, /new URL\(draft\.url\)/);
  assert.ok(renameOverlayJs.includes('deduped-history:init-inline-rename'));
});

function readText(relativePath) {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8');
}
