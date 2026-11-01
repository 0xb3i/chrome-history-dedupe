import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';
import { createLiveSearch } from '../src/live-search.js';

const pageUrl = new URL('../src/history-page.js', import.meta.url);
const source = await readFile(pageUrl, 'utf8');
const imports = {};
const importPattern = /import\s+\{([^}]+)\}\s+from\s+'([^']+)';/g;
for (const [, names, path] of source.matchAll(importPattern)) {
  const module = await import(new URL(path, pageUrl));
  for (const name of names.split(',').map((value) => value.trim()).filter(Boolean)) imports[name] = module[name];
}
const executable = source.replace(importPattern, '');
const now = Date.now();
const day = 24 * 60 * 60 * 1000;

function pageItem(title, path, extra = {}) {
  const url = `https://example.com/${path}`;
  return { dedupeKey: url, url, title, searchableTitles: [title],
    lastVisitTime: now, totalVisitCount: 1, ...extra };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

// linkedom supplies real DOM/event behavior; these adapters cover browser APIs it omits.
function completeDom(window, document) {
  Object.defineProperty(document, 'activeElement', { configurable: true, writable: true, value: null });
  const element = window.HTMLElement.prototype;
  element.focus = function () {
    this.ownerDocument.activeElement = this;
    this.dispatchEvent(new window.Event('focusin', { bubbles: true }));
  };
  element.showModal = function () { this.open = true; };
  element.close = function () {
    this.open = false;
    this.dispatchEvent(new window.Event('close'));
  };
  Object.defineProperty(element, 'open', { configurable: true,
    get() { return this.hasAttribute('open'); },
    set(value) { if (value) this.setAttribute('open', ''); else this.removeAttribute('open'); }
  });
  window.HTMLInputElement.prototype.select = function () {};
  Object.defineProperty(window.HTMLSelectElement.prototype, 'value', { configurable: true,
    get() { return [...this.options].find((option) => option.hasAttribute('selected'))?.value ?? this.options[0]?.value; },
    set(value) {
      for (const option of this.options) {
        if (option.value === value) option.setAttribute('selected', '');
        else option.removeAttribute('selected');
      }
    }
  });
}

async function createPage({ file = 'popup.html', items = [], titles = new Map(), groupNames = new Map(), saved = { query: '', range: 'all' },
  loadPreferences = async () => saved, loadIndex = async () => ({ revision: 1, pageItems: items }) } = {}) {
  const { window, document } = parseHTML(await readFile(new URL(`../${file}`, import.meta.url), 'utf8'));
  completeDom(window, document);
  const timers = new Map();
  let timerId = 0;
  const setTimer = (callback) => { timers.set(++timerId, callback); return timerId; };
  const clearTimer = (id) => timers.delete(id);
  const writes = [];
  const writeViews = [];
  const opened = [];
  const listeners = { storage: [], runtime: [] };
  const optionsOpened = [];
  const tabsCreated = [];
  document.addEventListener('click', (event) => {
    const link = event.target.closest?.('a');
    if (link) opened.push(link.href);
  });
  const context = vm.createContext({
    ...imports, document, window, Event: window.Event, Map, Set, URL, console,
    setTimeout: setTimer, clearTimeout: clearTimer,
    createLiveSearch: (options) => createLiveSearch({ ...options, setTimer, clearTimer }),
    createHistoryIndexStore: () => ({ loadRange: loadIndex }),
    loadPinnedUrlKeys: async () => new Set(),
    loadGroupNameOverrides: async () => groupNames,
    loadTitleOverrides: async () => titles,
    loadLastSearchState: loadPreferences,
    saveLastSearchState: async (state, view) => { writes.push(state); writeViews.push(view); },
    chrome: {
      runtime: { getURL: (path) => `chrome-extension://test-extension/${path}`,
        getManifest: () => ({ version: 'test' }), sendMessage: (_message, callback) => callback({ ok: true }),
        onMessage: { addListener: (listener) => listeners.runtime.push(listener) },
        openOptionsPage: () => optionsOpened.push(true) },
      storage: { onChanged: { addListener: (listener) => listeners.storage.push(listener) } },
      tabs: { create: ({ url }, callback) => { tabsCreated.push(url); callback?.(); } }
    }
  });
  vm.runInContext(executable, context, { filename: pageUrl.pathname });
  await settle();
  const one = (selector) => document.querySelector(selector);
  const all = (selector) => [...document.querySelectorAll(selector)];
  const fire = (target, type, properties = {}) => {
    const event = new window.Event(type, { bubbles: true, cancelable: true });
    Object.assign(event, properties);
    target.dispatchEvent(event);
    return event;
  };
  return {
    document, one, all, opened, writes, writeViews, listeners, optionsOpened, tabsCreated,
    titles: () => all('#results a.result-title').map((link) => link.textContent),
    fire,
    openActions(row) {
      row?.querySelector('a.result-title')?.focus();
      fire(document, 'keydown', { key: 'k', ctrlKey: true, metaKey: true });
      return [...document.querySelectorAll('#actions-list .actions-item')];
    },
    action(label) {
      return [...document.querySelectorAll('#actions-list .actions-item')]
        .find((item) => item.querySelector('.actions-item-label').textContent === label);
    },
    input(value, properties = {}) { one('#query').value = value; fire(one('#query'), 'input', properties); },
    async changeRenamedOnly(checked) {
      one('#renamed-only').checked = checked;
      fire(one('#renamed-only'), 'change');
      await settle();
    },
    async changeSort(value) {
      one('[data-select-id="sort-order"] .select-combobox-button').click();
      one(`[data-select-id="sort-order"] .select-combobox-option[data-value="${value}"]`).click();
      await settle();
    },
    async flush() {
      const pending = [...timers.values()];
      timers.clear();
      for (const callback of pending) callback();
      await settle();
    },
    async changeRange(value) {
      one('[data-select-id="range"] .select-combobox-button').click();
      one(`[data-select-id="range"] .select-combobox-option[data-value="${value}"]`).click();
      await settle();
    },
    button(text, root = document) { return [...root.querySelectorAll('button')].find((button) => button.textContent === text); }
  };
}

test('long callback titles and late historical matches stay compact with full tooltips and navigation', async () => {
  const callback = `login.example.com/api/oauth2/callback?session=${'x'.repeat(1600)}`;
  const alias = `${'历史内容'.repeat(100)}login 资料`;
  const items = [pageItem(callback, 'callback'),
    pageItem('当前名称', 'current', { searchableTitles: ['当前名称', alias] })];
  const page = await createPage({ items, saved: { query: 'login', range: 'all' } });
  const link = page.all('.result-title').find((link) => link.href === items[0].url);
  assert.ok(link.textContent.length <= 162);
  assert.ok(link.textContent.endsWith('…'));
  assert.equal(link.querySelector('mark').textContent, 'login');
  assert.ok(link.title.includes(callback));
  link.click();
  assert.deepEqual(page.opened, [items[0].url]);
  const aliased = page.all('.result-title').find((link) => link.href === items[1].url);
  assert.equal(page.one('.result-match'), null);
  assert.ok(aliased.title.endsWith(`曾用名：${alias}`));
  const grouped = await createPage({ items: [pageItem(callback, 'first'), pageItem(callback, 'second')],
    saved: { query: 'login', range: 'all' } });
  const title = grouped.one('.title-group .result-title');
  assert.ok(title.textContent.length <= 162);
  assert.ok(title.title.includes(callback));
});

test('real page updates after typing and IME commit, and renders title matches and historical names', async () => {
  const page = await createPage({ items: [
    pageItem('达人周会', 'weekly'),
    pageItem('增长计划', 'plan', { searchableTitles: ['增长计划', '达人复盘'] }),
    pageItem('购物清单', 'shopping')
  ] });
  assert.equal(page.titles().length, 3);
  page.input('达人');
  assert.equal(page.one('#results').getAttribute('aria-busy'), 'true');
  assert.equal(page.titles().length, 3);
  await page.flush();
  assert.deepEqual(page.titles(), ['达人周会', '增长计划']);
  assert.equal(page.one('.result-title mark').textContent, '达人');
  assert.equal(page.one('.result-match'), null);
  assert.match(page.all('.result-title')[1].title, /曾用名：达人复盘$/);
  assert.equal(page.one('#results').getAttribute('aria-busy'), 'false');
  page.fire(page.one('#query'), 'compositionstart');
  page.input('购物', { isComposing: true });
  await page.flush();
  assert.equal(page.titles().length, 2);
  page.fire(page.one('#query'), 'compositionend');
  await page.flush();
  assert.deepEqual(page.titles(), ['购物清单']);
});

test('popup flattens domains, reveals 30 more results, and restarts pagination for new search conditions', async () => {
  const items = Array.from({ length: 35 }, (_, index) => pageItem(`文档 ${index}`, `doc-${index}`));
  const page = await createPage({ items });
  assert.equal(page.one('.result-group'), null);
  assert.equal(page.titles().length, 30);
  assert.equal(page.all('.result-host').length, 30);
  page.button('显示更多（剩余 5 项）').click();
  assert.equal(page.titles().length, 35);
  assert.equal(page.one('.results-more'), null);
  page.input('文档');
  await page.flush();
  assert.equal(page.titles().length, 30);
  assert.ok(page.button('显示更多（剩余 5 项）'));
});

test('time and renamed filters apply immediately; renamed pages ignore the range without a label', async () => {
  const old = pageItem('旧资料', 'old', { lastVisitTime: now - 100 * day });
  const renamed = pageItem('原来的名称', 'renamed', { lastVisitTime: now - 100 * day });
  const page = await createPage({ items: [pageItem('近期页面', 'recent'), old, renamed],
    titles: new Map([[renamed.dedupeKey, { title: '已整理资料', targetUrl: renamed.url, updatedAt: now }]]) });
  assert.equal(page.all('.result-group').length, 0);
  await page.changeRange('day');
  assert.deepEqual(new Set(page.titles()), new Set(['近期页面', '已整理资料']));
  assert.equal(page.one('.retained-note'), null);
  assert.equal(page.document.body.textContent.includes('跨时间保留'), false);
  await page.changeRenamedOnly(true);
  await settle();
  assert.deepEqual(page.titles(), ['已整理资料']);
  assert.equal(page.one('#renamed-only').checked, true);
});

test('popup follows the theme saved on the settings page without changing results', async () => {
  const page = await createPage({ items: [pageItem('页面', 'entry')] });
  assert.equal(page.document.documentElement.dataset.themeColor, 'blue');
  const before = page.all('.result-title').map((link) => link.href);
  for (const listener of page.listeners.storage) listener({ 'history-ui-color': { newValue: 'green' } }, 'local');
  assert.equal(page.document.documentElement.dataset.themeColor, 'green');
  assert.deepEqual(page.all('.result-title').map((link) => link.href), before);
});

test('sorting controls order results, preserve pins, and apply to refreshed data', async () => {
  const items = [
    pageItem('项目 C', 'c', { totalVisitCount: 30, lastVisitTime: now - 3 * day }),
    pageItem('项目 A', 'a', { totalVisitCount: 10, lastVisitTime: now }),
    pageItem('项目 B', 'b', { totalVisitCount: 20, lastVisitTime: now - day })
  ];
  {
    let index = { revision: 1, pageItems: items };
    const page = await createPage({ saved: { query: '项目', range: 'all' }, loadIndex: async () => index });
    assert.equal(page.one('#search-form #range'), null);
    assert.equal(page.one('.filter-bar #range'), page.one('#range'));
    assert.equal(page.one('.filter-bar #renamed-only'), page.one('#renamed-only'));
    assert.equal(page.one('#result-controls #sort-order'), page.one('#sort-order'));
    assert.deepEqual(page.titles(), ['项目 C', '项目 B', '项目 A']);
    await page.changeSort('recent');
    assert.deepEqual(page.titles(), ['项目 A', '项目 B', '项目 C']);
    await page.changeSort('visits');
    assert.deepEqual(page.titles(), ['项目 C', '项目 B', '项目 A']);
    await page.changeSort('name');
    assert.deepEqual(page.titles(), ['项目 A', '项目 B', '项目 C']);
    assert.equal(page.writes.at(-1).sortOrder, 'name');
    assert.equal(page.document.activeElement, page.one('[data-select-id="sort-order"] .select-combobox-button'));
    page.listeners.storage[0]({ [imports.PINNED_URLS_STORAGE_KEY]: { newValue: [items[2].url] } }, 'local');
    assert.deepEqual(page.titles(), ['项目 B', '项目 A', '项目 C']);
    await page.changeSort('recent');
    index = { revision: 2, pageItems: [{ ...items[0], lastVisitTime: now + day }, ...items.slice(1)] };
    page.listeners.runtime[0]({ type: imports.HISTORY_INDEX_UPDATED_MESSAGE, revision: 2 });
    await settle();
    assert.deepEqual(page.titles(), ['项目 B', '项目 C', '项目 A']);
    assert.equal(page.one('#sort-order').value, 'recent');
  }
});

test('both filters use styled listboxes with saved labels, keyboard navigation and dismissal', async () => {
  {
    const page = await createPage({ items: [pageItem('页面', 'page')],
      saved: { query: '', range: 'week', sortOrder: 'name' } });
    const sort = page.one('[data-select-id="sort-order"]');
    const range = page.one('[data-select-id="range"]');
    const trigger = sort.querySelector('.select-combobox-button');
    const menu = sort.querySelector('[role="listbox"]');
    for (const id of ['range', 'sort-order']) {
      assert.equal(page.one(`#${id}`).getAttribute('aria-hidden'), 'true');
      assert.equal(page.one(`#${id}`).tabIndex, -1);
    }
    assert.equal(trigger.getAttribute('aria-label'), '排序方式：名称升序');
    assert.equal(trigger.getAttribute('aria-controls'), menu.id);
    assert.equal(range.querySelector('.select-combobox-value').textContent, '7 天');
    assert.doesNotMatch(menu.textContent, /↓/);
    assert.equal(sort.querySelector('[aria-selected="true"]').dataset.value, 'name');
    trigger.focus();
    page.fire(trigger, 'keydown', { key: 'ArrowDown' });
    assert.equal(menu.hidden, false);
    assert.equal(trigger.getAttribute('aria-expanded'), 'true');
    assert.equal(page.document.activeElement.dataset.value, 'name');
    page.fire(page.document.activeElement, 'keydown', { key: 'ArrowUp' });
    assert.equal(page.document.activeElement.dataset.value, 'recent');
    page.fire(page.document.activeElement, 'keydown', { key: 'Home' });
    assert.equal(page.document.activeElement.dataset.value, 'default');
    page.fire(page.document.activeElement, 'keydown', { key: 'End' });
    assert.equal(page.document.activeElement.dataset.value, 'name');
    page.fire(page.document.activeElement, 'keydown', { key: 'Escape' });
    assert.equal(menu.hidden, true);
    assert.equal(page.document.activeElement, trigger);
    assert.equal(page.writes.length, 0);
    trigger.click();
    sort.querySelector('[data-value="recent"]').click();
    await settle();
    assert.equal(menu.hidden, true);
    assert.equal(trigger.getAttribute('aria-label'), '排序方式：最近访问');
    assert.equal(page.writes.at(-1).sortOrder, 'recent');
    trigger.click();
    range.querySelector('.select-combobox-button').click();
    assert.equal(menu.hidden, true);
    assert.equal(range.querySelector('[role="listbox"]').hidden, false);
    page.one('#query').focus();
    assert.equal(range.querySelector('[role="listbox"]').hidden, true);
    trigger.click();
    page.one('#summary').click();
    assert.equal(menu.hidden, true);
  }
});

test('saved sort restores, changing it resets pagination without reloading data or submitting a draft', async () => {
  const items = Array.from({ length: 35 }, (_, index) => pageItem(`项目 ${index + 1}`, `page-${index}`, {
    lastVisitTime: now - index * day, totalVisitCount: index + 1
  }));
  let reads = 0;
  const page = await createPage({ saved: { query: '', range: 'all', sortOrder: 'recent' },
    loadIndex: async () => { reads++; return { revision: 1, pageItems: items }; }
  });
  assert.equal(page.one('#sort-order').value, 'recent');
  assert.equal(page.titles()[0], '项目 1');
  page.button('显示更多（剩余 5 项）').click();
  assert.equal(page.titles().length, 35);
  page.input('未提交');
  await page.changeSort('visits');
  assert.equal(page.titles().length, 30);
  assert.equal(page.titles()[0], '项目 35');
  assert.equal(page.one('#query').value, '未提交');
  assert.equal(page.writes.at(-1).query, '');
  assert.equal(page.writes.at(-1).sortOrder, 'visits');
  assert.equal(reads, 1);
  await page.changeSort('name');
  assert.deepEqual(page.titles().slice(0, 3), ['项目 1', '项目 2', '项目 3']);
});

test('source badges preserve tab ranking and keep group identity through filtering and group renaming', async () => {
  const item = (title, url, totalVisitCount) => pageItem(title, '', { url, dedupeKey: url, totalVisitCount });
  const page = await createPage({ items: [
    item('编译甲', 'https://build.example.com/a', 30),
    item('文档乙', 'https://docs.example.com/b', 20),
    item('编译丙', 'https://build.example.com/c', 10)
  ], groupNames: new Map([['build.example.com', '编译平台']]) });
  assert.deepEqual(page.titles(), ['编译甲', '文档乙', '编译丙']);
  assert.equal(page.one('.result-group'), null);
  const badges = page.all('.result-host');
  assert.deepEqual(badges.map((badge) => badge.textContent), ['编译平台', 'docs.example.com', '编译平台']);
  assert.equal(badges[0].title, '编译平台（build.example.com） · 点击筛选，右键修改分组名');
  assert.equal(badges[0].getAttribute('aria-label'), '筛选来源：编译平台');
  assert.equal(badges[0].tagName, 'BUTTON');
  page.fire(badges[0], 'contextmenu');
  const dialog = page.one('dialog[open]');
  assert.equal(dialog.querySelector('h2').textContent, '修改分组名');
  assert.equal(dialog.querySelector('input').value, '编译平台');
  assert.equal(dialog.querySelector('.rename-dialog-url').textContent, 'build.example.com');
  assert.equal(page.button('还原原名', dialog).disabled, false);
  page.button('取消', dialog).click();
  assert.equal(page.one('dialog[open]'), null);
  const tone = badges[0].dataset.sourceTone;
  assert.equal(badges[2].dataset.sourceTone, tone);
  page.input('编译');
  await page.flush();
  assert.deepEqual(page.titles(), ['编译甲', '编译丙']);
  assert.ok(page.all('.result-host').every((badge) => badge.dataset.sourceTone === tone));
  page.listeners.storage[0]({ [imports.GROUP_NAME_OVERRIDES_STORAGE_KEY]: {
    newValue: { 'build.example.com': '构建服务' }
  } }, 'local');
  await page.flush();
  assert.ok(page.all('.result-host').every((badge) => badge.textContent === '构建服务' && badge.dataset.sourceTone === tone));
});

test('empty states recover through all-time search, clearing renamed filter, and clearing the query', async () => {
  const page = await createPage({ items: [pageItem('旧资料', 'old', { lastVisitTime: now - 100 * day })] });
  await page.changeRange('day');
  assert.equal(page.titles().length, 0);
  assert.equal(page.one('#empty-state').hidden, false);
  page.button('搜索全部时间').click();
  await settle();
  assert.deepEqual(page.titles(), ['旧资料']);
  await page.changeRenamedOnly(true);
  await settle();
  assert.equal(page.titles().length, 0);
  page.button('清除筛选').click();
  await settle();
  assert.equal(page.one('#renamed-only').checked, false);
  assert.deepEqual(page.titles(), ['旧资料']);
  page.input('没有这样的标题');
  await page.flush();
  page.button('清空关键词').click();
  await settle();
  assert.equal(page.one('#query').value, '');
  assert.deepEqual(page.titles(), ['旧资料']);
});

test('input keys retain native behavior and submitting a search does not open a result', async () => {
  const page = await createPage({ items: [pageItem('甲文档', 'a'), pageItem('乙文档', 'b')] });
  const input = page.one('#query');
  page.input('乙');
  for (const key of ['ArrowDown', 'ArrowUp', 'Enter']) {
    assert.equal(page.fire(input, 'keydown', { key }).defaultPrevented, false);
  }
  page.fire(page.one('#search-form'), 'submit');
  await settle();
  assert.deepEqual(page.titles(), ['乙文档']);
  assert.deepEqual(page.opened, []);
  page.one('#results a.result-title').click();
  assert.deepEqual(page.opened, ['https://example.com/b']);
});

test('recency sort splits results into pinned, today, yesterday, this week and month sections', async () => {
  const at = (daysAgo, hour = 12) => { const date = new Date(); date.setDate(date.getDate() - daysAgo); date.setHours(hour, 0, 0, 0); return date.getTime(); };
  const items = [pageItem('今天的页面', 'today', { lastVisitTime: Math.min(at(0, 0) + 1000, now) }),
    pageItem('昨天的页面', 'yesterday', { lastVisitTime: at(1) }),
    pageItem('前天的页面', 'earlier', { lastVisitTime: at(2) }),
    pageItem('很早的页面', 'old', { lastVisitTime: at(40) })];
  const page = await createPage({ items });
  assert.equal(page.all('.result-section').length, 0);
  await page.changeSort('recent');
  const old = new Date(at(40));
  const month = old.getFullYear() === new Date().getFullYear()
    ? `${old.getMonth() + 1} 月` : `${old.getFullYear()} 年 ${old.getMonth() + 1} 月`;
  assert.deepEqual(page.all('.result-section').map((section) => section.textContent), ['今天', '昨天', '本周', month]);
  assert.deepEqual(page.titles(), ['今天的页面', '昨天的页面', '前天的页面', '很早的页面']);
  page.listeners.storage[0]({ [imports.PINNED_URLS_STORAGE_KEY]: { newValue: [items[3].url] } }, 'local');
  assert.equal(page.all('.result-section')[0].textContent, '已固定');
});

test('the filter panel only holds result filters and a settings link', async () => {
  const page = await createPage({ items: [pageItem('甲文档', 'a')] });
  const trigger = page.one('#view-options');
  const panel = page.one('#view-options-panel');
  assert.equal(panel.hidden, true);
  assert.ok(panel.querySelector('#renamed-only'));
  assert.ok(panel.querySelector('#sort-order'));
  for (const id of ['theme-color', 'rename-source', 'shortcut-settings']) assert.equal(page.one(`#${id}`), null, id);
  trigger.click();
  assert.equal(panel.hidden, false);
  page.fire(panel, 'keydown', { key: 'Escape' });
  assert.equal(panel.hidden, true);
  assert.equal(page.document.activeElement, trigger);
  page.one('#open-settings').click();
  assert.deepEqual(page.tabsCreated, ['chrome-extension://test-extension/options.html']);
});

test('popup rows keep the source beside the title and state and time in separate columns', async () => {
  const renamed = pageItem('原来的名称', 'renamed');
  const page = await createPage({ items: [pageItem('甲文档', 'a'), renamed],
    titles: new Map([[renamed.dedupeKey, { title: '整理后的名称', targetUrl: renamed.url, updatedAt: now }]]) });
  assert.equal(page.one('#results button.item-action-button'), null);
  assert.equal(page.one('#results .result-actions'), null);
  const row = page.all('.popup-results .result-item').find((item) => item.textContent.includes('整理后的名称'));
  const columns = [...row.querySelector('.result-content').children].map((child) => child.className.split(' ')[0]);
  assert.deepEqual(columns.filter((name) => name !== 'result-url'),
    ['result-title-row', 'result-state', 'result-meta']);
  assert.deepEqual([...row.querySelector('.result-title-row').children].map((child) => child.className.split(' ')[0]),
    ['result-title', 'result-host']);
  assert.equal(row.querySelector('.result-state .result-custom-label').textContent, '已命名');
  assert.match(row.querySelector('.result-time').title, /1 次访问/);
  assert.equal(row.querySelector('.result-host').dataset.initial, 'E');
  const hint = page.one('#primary-key-hint');
  assert.equal(hint.textContent, '选择↓');
  row.querySelector('a.result-title').focus();
  assert.equal(hint.textContent, '打开↵');
});

test('⌘K and right-click open the focused row\'s actions: open, copy, rename, pin, source', async () => {
  const items = [pageItem('甲文档', 'a', { totalVisitCount: 5 }),
    pageItem('乙文档', 'b', { url: 'https://docs.example.org/b', dedupeKey: 'b' })];
  const page = await createPage({ items });
  const panel = page.one('#actions-panel');
  assert.equal(panel.hidden, true);
  const second = page.all('.popup-results .result-item').find((row) => row.textContent.includes('乙文档'));
  const labels = page.openActions(second).map((item) => item.querySelector('.actions-item-label').textContent);
  assert.equal(panel.hidden, false);
  assert.equal(page.one('#actions-title').textContent, '乙文档');
  assert.deepEqual(labels, ['打开', '复制链接', '重命名网页…', '固定到顶部', '只看此来源', '修改来源名称…']);
  assert.equal(page.document.activeElement, page.action('打开'));
  page.fire(panel, 'keydown', { key: 'Escape' });
  assert.equal(panel.hidden, true);
  assert.equal(page.document.activeElement, second.querySelector('a.result-title'));

  page.openActions(second);
  page.action('修改来源名称…').click();
  const dialog = page.one('dialog[open]');
  assert.equal(dialog.querySelector('h2').textContent, '修改分组名');
  assert.equal(dialog.querySelector('input').value, 'docs.example.org');
  page.button('取消', dialog).click();

  page.fire(second, 'contextmenu');
  assert.equal(panel.hidden, false);
  page.action('重命名网页…').click();
  assert.equal(page.one('dialog[open]').getAttribute('aria-label'), '重命名网页');
  assert.equal(page.one('dialog[open] .rename-dialog-url').textContent, items[1].url);
  page.button('取消', page.one('dialog[open]')).click();

  page.openActions(second);
  page.action('只看此来源').click();
  assert.deepEqual(page.all('.result-title').map((link) => link.href), [items[1].url]);
  page.one('.source-filter-clear').click();

  page.openActions(page.one('.popup-results .result-item'));
  page.action('打开').click();
  assert.equal(page.tabsCreated.length, 1);
});

test('same-title links collapse to one row that opens the most visited link; others are listed by time in actions', async () => {
  const at = (hoursAgo) => now - hoursAgo * 3600000;
  const items = [pageItem('同名页面', 'overview', { totalVisitCount: 1, lastVisitTime: at(1) }),
    pageItem('同名页面', 'diffs', { totalVisitCount: 20, lastVisitTime: at(30) }),
    pageItem('同名页面', 'commits', { totalVisitCount: 4, lastVisitTime: at(5) })];
  const page = await createPage({ items });
  assert.equal(page.all('.popup-results .result-item').length, 1);
  const row = page.one('.title-group');
  assert.equal(row.querySelector('details'), null);
  assert.equal(row.querySelector('.title-group-count'), null);
  const title = row.querySelector('a.result-title');
  assert.equal(title.href, items[1].url);
  assert.match(title.title, /另有 2 个同名链接/);
  assert.match(row.querySelector('.result-time').title, /25 次访问/);

  page.openActions(row);
  const others = page.action('同名的其他链接');
  assert.equal(others.querySelector('.actions-item-detail').textContent, '2');
  others.click();
  assert.equal(page.one('#actions-title').textContent, '同名的其他链接（2）');
  assert.equal(page.one('#actions-back').hidden, false);
  const links = page.all('#actions-list .actions-item');
  assert.deepEqual(links.map((link) => link.title), [items[0].url, items[2].url]);
  assert.ok(links.every((link) => /次访问$/.test(link.querySelector('.actions-item-detail').textContent)));
  page.fire(page.document.activeElement, 'keydown', { key: 'F2' });
  assert.equal(page.one('dialog[open] .rename-dialog-url').textContent, items[0].url);
  page.button('取消', page.one('dialog[open]')).click();

  page.openActions(row);
  page.action('同名的其他链接').click();
  page.fire(page.one('#actions-panel'), 'keydown', { key: 'ArrowLeft' });
  assert.equal(page.one('#actions-title').textContent, '同名页面');
  page.action('同名的其他链接').click();
  page.all('#actions-list .actions-item')[1].click();
  assert.deepEqual(page.tabsCreated, [items[2].url]);
});

test('result navigation joins the page, preserves refresh focus, and leaves rename dialogs in control', async () => {
  const items = [pageItem('甲文档', 'a'), pageItem('乙文档', 'b')];
  let index = { revision: 1, pageItems: items };
  const page = await createPage({ items, loadIndex: async () => index });
  const query = page.one('#query');
  query.focus();
  assert.equal(page.fire(query, 'keydown', { key: 'ArrowDown' }).defaultPrevented, true);
  assert.equal(page.document.activeElement.href, items[0].url);
  page.fire(page.document.activeElement, 'keydown', { key: 'ArrowDown' });
  assert.equal(page.document.activeElement.href, items[1].url);
  index = { revision: 2, pageItems: [{ ...items[1], totalVisitCount: 5 }, items[0]] };
  page.one('.popup-result-scroll').scrollTop = 90;
  page.listeners.runtime[0]({ type: imports.HISTORY_INDEX_UPDATED_MESSAGE, revision: 2 });
  await settle();
  assert.equal(page.document.activeElement.href, items[1].url);
  assert.equal(page.document.activeElement.isConnected, true);
  assert.equal(page.one('.popup-result-scroll').scrollTop, 90);
  page.fire(page.document.activeElement, 'keydown', { key: 'Escape' });
  assert.equal(page.document.activeElement, query);
  page.openActions(page.one('.popup-results .result-item'));
  page.action('重命名网页…').click();
  const dialog = page.one('dialog[open]');
  assert.equal(dialog.getAttribute('aria-label'), '重命名网页');
  assert.deepEqual([...dialog.querySelector('.rename-primary-actions').children].map((button) => button.textContent),
    ['取消', '保存']);
  assert.equal(dialog.querySelector('.rename-dialog-url').textContent, items[1].url);
  assert.equal(page.fire(query, 'keydown', { key: 'ArrowDown' }).defaultPrevented, false);
});

test('compact presentation ignores removed display preferences', async () => {
  const items = [pageItem('文档', 'doc')];
  const fresh = await createPage({ items, saved: null });
  assert.equal(fresh.document.body.classList.contains('minimal-mode'), true);
  assert.equal(fresh.one('#show-url-path'), null);
  const existing = await createPage({ items, saved: { query: '', range: 'all', showMinimalMode: false } });
  assert.equal(existing.document.body.classList.contains('minimal-mode'), true);
  assert.equal(existing.one('#show-url-path'), null);
});

test('late preferences preserve a user search and display preferences chosen after the first results arrive', async () => {
  const preferences = deferred();
  const page = await createPage({ items: [pageItem('当前页面', 'current')], loadPreferences: () => preferences.promise });
  page.input('当前');
  await page.flush();
  assert.deepEqual(page.titles(), ['当前页面']);
  await page.changeRenamedOnly(true);
  await settle();
  await page.changeSort('name');
  preferences.resolve({ query: '旧查询', range: 'day', showRenamedOnly: false, showMinimalMode: false, sortOrder: 'visits' });
  await settle();
  assert.equal(page.one('#query').value, '当前');
  assert.equal(page.one('#renamed-only').checked, true);
  assert.equal(page.document.body.classList.contains('minimal-mode'), true);
  assert.equal(page.writes.at(-1).query, '当前');
  assert.equal(page.writes.at(-1).showRenamedOnly, true);
  assert.equal(page.one('#sort-order').value, 'name');
  assert.equal(page.writes.at(-1).sortOrder, 'name');
});

test('initial preference failure offers a retry that initializes and searches successfully', async () => {
  let loads = 0;
  const page = await createPage({ items: [pageItem('恢复后的页面', 'recovered')], loadPreferences: async () => {
    if (++loads === 1) throw new Error('偏好读取失败');
    return { query: '', range: 'all' };
  } });
  assert.match(page.one('#empty-state').textContent, /暂时无法读取历史记录，请重试/);
  assert.equal(page.one('#empty-state p').title, '偏好读取失败');
  assert.equal(page.one('#empty-state').hidden, false);
  page.button('重试').click();
  await settle();
  assert.deepEqual(page.titles(), ['恢复后的页面']);
  assert.equal(page.one('#empty-state').hidden, true);
  assert.equal(page.listeners.storage.length, 1);
  assert.equal(page.listeners.runtime.length, 1);
});


test('source icons use the extension favicon endpoint and fall back after image errors', async () => {
  const item = pageItem('页面', 'entry?q=one');
  const page = await createPage({ items: [item] });
  const icon = page.one('.result-source-icon');
  assert.ok(icon);
  const address = new URL(icon.src);
  assert.equal(address.pathname, '/_favicon/');
  assert.equal(address.searchParams.get('pageUrl'), item.url);
  assert.equal(address.searchParams.get('size'), '32');
  const host = icon.parentElement;
  assert.ok(host.classList.contains('has-source-icon'));
  page.fire(icon, 'error');
  assert.equal(host.querySelector('img'), null);
  assert.equal(host.classList.contains('has-source-icon'), false);
});


test('source filtering preserves search conditions and clearing restores other sites', async () => {
  {
    const items = [pageItem('页面甲', 'a'), pageItem('页面乙', 'b', { url: 'https://other.example/b', dedupeKey: 'other' })];
    const groupName = '项目资料与开发工具平台 / DocumentationAndDeveloperToolsForEveryTeam';
    const page = await createPage({ items, saved: { query: '页面', range: 'all' },
      groupNames: new Map([['example.com', groupName]]) });
    const title = page.one('.result-title');
    const host = title.nextElementSibling;
    assert.ok(host.classList.contains('result-host'));
    assert.equal(host.querySelector('.result-host-label').textContent, groupName);
    assert.equal(host.getAttribute('aria-label'), `筛选来源：${groupName}`);
    host.click();
    assert.deepEqual(page.all('.result-title').map((link) => link.href), [items[0].url]);
    assert.equal(page.one('#query').value, '页面');
    assert.equal(page.one('.source-filter-bar').hidden, false);
    assert.equal(page.one('.source-filter-caption').textContent, '来源：');
    assert.equal(page.one('.source-filter-name').textContent, groupName);
    assert.equal(page.one('.result-host-label').textContent, groupName);
    page.one('.source-filter-clear').click();
    assert.equal(page.all('.result-title').length, 2);
    assert.equal(page.one('.source-filter-bar').hidden, true);
  }
});
