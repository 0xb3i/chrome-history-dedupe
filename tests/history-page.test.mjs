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
      runtime: { getManifest: () => ({ version: 'test' }), sendMessage: (_message, callback) => callback({ ok: true }),
        onMessage: { addListener: (listener) => listeners.runtime.push(listener) } },
      storage: { onChanged: { addListener: (listener) => listeners.storage.push(listener) } }
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
    document, one, all, opened, writes, writeViews, listeners,
    titles: () => all('#results a.result-title').map((link) => link.textContent),
    fire,
    expandTitleGroups() {
      for (const details of all('.title-group-details')) {
        details.open = true;
        fire(details, 'toggle');
      }
    },
    input(value, properties = {}) { one('#query').value = value; fire(one('#query'), 'input', properties); },
    async changeSort(value) {
      one('#sort-order').focus();
      one('#sort-order').value = value;
      fire(one('#sort-order'), 'change');
      await settle();
    },
    async flush() {
      const pending = [...timers.values()];
      timers.clear();
      for (const callback of pending) callback();
      await settle();
    },
    async changeRange(value) {
      one('.range-combobox-button').click();
      one(`.range-combobox-option[data-value="${value}"]`).click();
      await settle();
    },
    button(text, root = document) { return [...root.querySelectorAll('button')].find((button) => button.textContent === text); }
  };
}

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
  assert.equal(page.one('.result-match').textContent, '曾用名：达人复盘');
  assert.equal(page.one('.result-match mark').textContent, '达人');
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

test('full page time and renamed filters apply immediately to flat results', async () => {
  const old = pageItem('旧资料', 'old', { lastVisitTime: now - 100 * day });
  const renamed = pageItem('原来的名称', 'renamed', { lastVisitTime: now - 100 * day });
  const page = await createPage({ file: 'history.html', items: [pageItem('近期页面', 'recent'), old, renamed],
    titles: new Map([[renamed.dedupeKey, { title: '已整理资料', targetUrl: renamed.url, updatedAt: now }]]) });
  assert.equal(page.all('.result-group').length, 0);
  await page.changeRange('day');
  assert.deepEqual(new Set(page.titles()), new Set(['近期页面', '已整理资料']));
  assert.equal(page.one('.retained-note').textContent, '跨时间保留');
  page.button('仅已命名').click();
  await settle();
  assert.deepEqual(page.titles(), ['已整理资料']);
  assert.equal(page.button('仅已命名').getAttribute('aria-pressed'), 'true');
});

test('full history defaults to all-time chronology with local date headings and separate same-title links', async () => {
  const morning = new Date(2026, 8, 15, 9).getTime();
  const priorDay = new Date(2026, 8, 14, 23).getTime();
  const old = pageItem('旧资料', 'old', { lastVisitTime: priorDay, totalVisitCount: 900 });
  const middleUrl = 'https://other.example.com/interleaved';
  const items = [old,
    pageItem('同名资料', 'latest', { lastVisitTime: morning + 3600000 }),
    pageItem('其他站点', '', { url: middleUrl, dedupeKey: middleUrl, lastVisitTime: morning }),
    pageItem('同名资料', 'earlier', { lastVisitTime: priorDay + 1000 })];
  const readViews = [];
  const page = await createPage({ file: 'history.html', items,
    titles: new Map([[old.dedupeKey, { title: '已整理资料', targetUrl: old.url, updatedAt: now }]]),
    loadPreferences: async (view) => { readViews.push(view); return null; }
  });
  const urls = () => page.all('.history-result .result-title').map((link) => link.href);
  const expected = [items[1].url, items[2].url, items[3].url, old.url];
  assert.deepEqual(readViews, ['history']);
  assert.equal(page.one('#range').value, 'all');
  assert.equal(page.one('#sort-order').value, 'recent');
  assert.deepEqual(urls(), expected);
  assert.equal(page.all('#results details').length, 0);
  assert.equal(page.one('.view-collapse-button'), null);
  assert.deepEqual(page.all('.history-visit-time').map((time) => time.getAttribute('datetime')),
    [morning + 3600000, morning, priorDay + 1000, priorDay].map((value) => new Date(value).toISOString()));
  const formatter = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'full' });
  assert.deepEqual(page.all('.history-day h2').map((heading) => heading.textContent),
    [formatter.format(morning), formatter.format(priorDay)]);
  page.listeners.storage[0]({ [imports.PINNED_URLS_STORAGE_KEY]: { newValue: [old.url] } }, 'local');
  assert.deepEqual(urls(), expected);
  assert.equal(page.all('.history-result .result-item-pinned').length, 0);
  assert.equal(page.all('.history-result.result-item-pinned').length, 1);
  for (const row of page.all('.history-result')) {
    assert.ok(row.querySelector('.rename-button'));
    assert.ok(row.querySelector('.pin-button'));
    assert.ok(row.querySelector('.result-host'));
  }
  page.one('.history-result .result-host').click();
  assert.ok(page.one('dialog[open]'));
  page.input('同名');
  await page.flush();
  assert.equal(page.writes.at(-1).sortOrder, 'recent');
  assert.equal(page.writeViews.at(-1), 'history');
  assert.deepEqual(urls(), [items[1].url, items[3].url]);
});

test('full history paginates individual links, keeps date headers unique and resets after filtering', async () => {
  const items = Array.from({ length: 55 }, (_, index) => pageItem('同名页面', `entry-${index}`, {
    lastVisitTime: new Date(2026, 8, 15, 12).getTime() - index * 1000
  }));
  const page = await createPage({ file: 'history.html', items, saved: null });
  assert.equal(page.all('.history-result').length, 50);
  assert.equal(page.all('.history-day').length, 1);
  assert.equal(page.one('.title-group'), null);
  page.button('显示更多（剩余 5 项）').click();
  assert.equal(page.all('.history-result').length, 55);
  assert.equal(page.all('.history-day').length, 1);
  assert.equal(page.document.activeElement.href, items[50].url);
  assert.equal(page.one('.results-more'), null);
  await page.changeSort('name');
  assert.equal(page.all('.history-result').length, 50);
  assert.equal(page.all('.history-day').length, 0);
  await page.changeSort('recent');
  assert.equal(page.all('.history-day').length, 1);
});

test('sorting controls order both pages, preserve pins, and apply to refreshed data', async () => {
  const items = [
    pageItem('项目 C', 'c', { totalVisitCount: 30, lastVisitTime: now - 3 * day }),
    pageItem('项目 A', 'a', { totalVisitCount: 10, lastVisitTime: now }),
    pageItem('项目 B', 'b', { totalVisitCount: 20, lastVisitTime: now - day })
  ];
  for (const file of ['popup.html', 'history.html']) {
    let index = { revision: 1, pageItems: items };
    const page = await createPage({ file, saved: { query: '项目', range: 'all' }, loadIndex: async () => index });
    const fields = [...page.one('#search-form').children];
    assert.equal(fields[1].querySelector('#range'), page.one('#range'));
    assert.equal(fields[2].querySelector('#sort-order'), page.one('#sort-order'));
    assert.equal(page.one('#summary #sort-order'), null);
    assert.deepEqual(page.titles(), file === 'popup.html' ? ['项目 C', '项目 B', '项目 A'] : ['项目 A', '项目 B', '项目 C']);
    await page.changeSort('recent');
    assert.deepEqual(page.titles(), ['项目 A', '项目 B', '项目 C']);
    await page.changeSort('visits');
    assert.deepEqual(page.titles(), ['项目 C', '项目 B', '项目 A']);
    await page.changeSort('name');
    assert.deepEqual(page.titles(), ['项目 A', '项目 B', '项目 C']);
    assert.equal(page.writes.at(-1).sortOrder, 'name');
    assert.equal(page.document.activeElement, page.one('#sort-order'));
    page.listeners.storage[0]({ [imports.PINNED_URLS_STORAGE_KEY]: { newValue: [items[2].url] } }, 'local');
    assert.deepEqual(page.titles(), ['项目 B', '项目 A', '项目 C']);
    await page.changeSort('recent');
    index = { revision: 2, pageItems: [{ ...items[0], lastVisitTime: now + day }, ...items.slice(1)] };
    page.listeners.runtime[0]({ type: imports.HISTORY_INDEX_UPDATED_MESSAGE, revision: 2 });
    await settle();
    assert.deepEqual(page.titles(), file === 'popup.html' ? ['项目 B', '项目 C', '项目 A'] : ['项目 C', '项目 A', '项目 B']);
    assert.equal(page.one('#sort-order').value, 'recent');
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

test('sorting same-title links changes their expanded order while keeping the representative URL', async () => {
  const items = [pageItem('项目', 'popular', { totalVisitCount: 10, lastVisitTime: now - day }),
    pageItem('项目', 'recent', { totalVisitCount: 1, lastVisitTime: now })];
  const page = await createPage({ items });
  await page.changeSort('recent');
  page.expandTitleGroups();
  assert.deepEqual(page.all('.result-variant-link').map((link) => link.href), [items[1].url, items[0].url]);
  assert.equal(page.one('.title-group-summary a').href, items[0].url);
  await page.changeSort('visits');
  page.expandTitleGroups();
  assert.deepEqual(page.all('.result-variant-link').map((link) => link.href), items.map((item) => item.url));
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
  assert.equal(badges[0].title, '编译平台（build.example.com）');
  assert.equal(badges[0].getAttribute('aria-label'), '所属分组：编译平台（build.example.com）');
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
  page.button('仅已命名').click();
  await settle();
  assert.equal(page.titles().length, 0);
  page.button('清除筛选').click();
  await settle();
  assert.deepEqual(page.titles(), ['旧资料']);
  page.input('没有这样的标题');
  await page.flush();
  page.button('清空关键词').click();
  await settle();
  assert.equal(page.one('#query').value, '');
  assert.deepEqual(page.titles(), ['旧资料']);
});

test('same-title choices expose the distinguishing parameter while preserving addresses and actions', async () => {
  const base = pageItem('达人周会', 'wiki/weekly', { totalVisitCount: 8 });
  const variantUrl = `${base.url}?disposable_login_token=${'abcdef'.repeat(80)}&lang=zh`;
  const variant = { ...base, dedupeKey: variantUrl, url: variantUrl, totalVisitCount: 1 };
  const page = await createPage({ items: [base, variant] });
  const group = page.one('.title-group-details');
  assert.equal(group.open, false);
  assert.equal(group.children.length, 2);
  assert.equal(group.querySelector('.title-group-count').textContent, '2 个链接');
  assert.equal(group.querySelector('summary a').href, base.url);
  assert.equal(group.querySelector('.result-meta').textContent.includes('合计 9 次访问'), true);
  assert.equal(page.all('.result-variant').length, 0);
  page.expandTitleGroups();
  const rows = page.all('.result-variant');
  assert.equal(rows.length, 2);
  for (const [index, row] of rows.entries()) {
    const url = [base.url, variantUrl][index];
    const link = row.querySelector('a');
    assert.equal(link.textContent, index === 0 ? 'lang：未指定' : 'lang：zh');
    assert.ok(link.title.startsWith(`${url}\n最近访问：`));
    assert.equal(link.href, url);
    assert.equal(row.querySelector('.result-variant-time'), null);
    assert.equal(row.querySelector('.result-variant-visits').textContent, `${index === 0 ? 8 : 1} 次访问`);
    assert.equal(row.querySelector('.result-meta'), null);
    assert.equal(row.querySelectorAll('button').length, 2);
    assert.ok(row.querySelector('.rename-button'));
    assert.ok(row.querySelector('.pin-button'));
    link.click();
  }
  assert.deepEqual(page.opened, [base.url, variantUrl]);
  assert.equal(group.textContent.includes('abcdef'), false);
  assert.equal(group.textContent.includes('差异'), false);
  assert.equal(group.textContent.includes('详情'), false);
  const checkbox = page.one('.view-option input');
  checkbox.checked = true;
  page.fire(checkbox, 'change');
  assert.deepEqual(page.all('.result-variant-link').map((link) => link.textContent), ['lang：未指定', 'lang：zh']);
});

test('merge request choices show destination names instead of the repeated repository path', async () => {
  const base = 'https://code.byted.org/data/example/merge_requests/335';
  const urls = [base, `${base}/diffs`, `${base}/commits`];
  const page = await createPage({ items: urls.map((url, index) => pageItem('feat: model !335', '', {
    url, dedupeKey: url, totalVisitCount: 3 - index
  })) });
  page.expandTitleGroups();
  assert.deepEqual(page.all('.result-choice-label').map((label) => label.textContent), ['概览', '文件变更', '提交记录']);
  assert.equal(page.one('.title-group-list').textContent.includes('/data/example'), false);
  assert.equal(page.one('.result-choice-context'), null);
  page.all('.result-variant-link').forEach((link) => link.click());
  assert.deepEqual(page.opened, urls);
});

test('expanded links show usage order and the group title opens the most visited search match', async () => {
  const lessUsed = pageItem('同名页面', 'overview', {
    totalVisitCount: 1, searchableTitles: ['同名页面', '目标'], lastVisitTime: now
  });
  const mostUsed = pageItem('同名页面', 'diffs', {
    totalVisitCount: 20, searchableTitles: ['同名页面', '目标内容'], lastVisitTime: now - day
  });
  const older = pageItem('同名页面', 'commits', {
    totalVisitCount: 20, searchableTitles: ['同名页面', '目标内容'], lastVisitTime: now - 2 * day
  });
  const page = await createPage({ items: [lessUsed, older, mostUsed], saved: { query: '目标', range: 'all' } });
  page.expandTitleGroups();
  assert.deepEqual(page.all('.result-variant-link').map((link) => link.href), [mostUsed.url, older.url, lessUsed.url]);
  assert.deepEqual(page.all('.result-variant-visits').map((count) => count.textContent),
    ['20 次访问', '20 次访问', '1 次访问']);
  const header = page.one('.title-group-summary');
  assert.ok(header.querySelector('.result-meta').textContent.includes('合计 41 次访问'));
  assert.equal(header.querySelector('.result-match').textContent, '曾用名：目标');
  assert.equal(header.querySelector('a').href, mostUsed.url);
  assert.equal(header.querySelector('a').target, '_blank');
});

test('choices retain long distinguishing values and add context only to ambiguous paths', async () => {
  const id = 'resource-'.repeat(30);
  const page = await createPage({ items: [
    pageItem('平台', `app/models/${id}?view=usage`, { totalVisitCount: 3 }),
    pageItem('平台', `app/models/${id}?view=cost`, { totalVisitCount: 2 }),
    pageItem('平台', 'app/dashboard', { totalVisitCount: 1 })
  ] });
  page.expandTitleGroups();
  assert.deepEqual(page.all('.result-choice-label').map((label) => label.textContent),
    [`models/${id}`, `models/${id}`, 'dashboard']);
  assert.deepEqual(page.all('.result-choice-context').map((context) => context.textContent), ['view：usage', 'view：cost']);
});

test('large collapsed title groups defer link DOM and append bounded pages, retaining expansion on refresh', async () => {
  const items = Array.from({ length: 5000 }, (_, index) => pageItem('平台', `app?id=${index}`, {
    totalVisitCount: 5000 - index
  }));
  const page = await createPage({ items });
  assert.equal(page.all('#results .result-item').length, 1);
  assert.ok(page.all('#results *').length < 30);
  assert.equal(page.one('.title-group-count').textContent, '5000 个链接');
  assert.equal(page.one('.title-group-summary a').href, items[0].url);
  page.expandTitleGroups();
  assert.equal(page.all('.result-variant').length, 30);
  const firstLink = page.one('.result-variant-link');
  page.button('显示更多链接（剩余 4970 个）').click();
  assert.equal(page.all('.result-variant').length, 60);
  assert.equal(page.one('.result-variant-link'), firstLink);
  assert.equal(page.document.activeElement.href, items[30].url);
  page.listeners.storage[0]({ [imports.GROUP_NAME_OVERRIDES_STORAGE_KEY]: {
    newValue: { 'example.com': '平台服务' }
  } }, 'local');
  await page.flush();
  assert.equal(page.one('.title-group-details').open, true);
  assert.equal(page.all('.result-variant').length, 60);
  const details = page.one('.title-group-details');
  details.open = false;
  page.fire(details, 'toggle');
  page.expandTitleGroups();
  assert.equal(page.all('.result-variant').length, 60);
  page.input('app');
  await page.flush();
  assert.equal(page.all('.result-variant').length, 0);
});

test('small title groups load all remaining links and never duplicate rows on toggle', async () => {
  const page = await createPage({ items: Array.from({ length: 35 }, (_, index) => pageItem('平台', `app?id=${index}`)) });
  page.expandTitleGroups();
  assert.equal(page.all('.result-variant').length, 30);
  page.button('显示更多链接（剩余 5 个）').click();
  assert.equal(page.all('.result-variant').length, 35);
  assert.equal(page.one('.title-group-list .results-more'), null);
  page.expandTitleGroups();
  assert.equal(page.all('.result-variant').length, 35);
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

test('late preferences preserve a user search and display preferences chosen after the first results arrive', async () => {
  const preferences = deferred();
  const page = await createPage({ items: [pageItem('当前页面', 'current')], loadPreferences: () => preferences.promise });
  page.input('当前');
  await page.flush();
  assert.deepEqual(page.titles(), ['当前页面']);
  page.button('仅已命名').click();
  await settle();
  const checkbox = page.one('.view-option input');
  checkbox.checked = true;
  page.fire(checkbox, 'change');
  await page.changeSort('name');
  preferences.resolve({ query: '旧查询', range: 'day', showRenamedOnly: false, showMinimalMode: false, sortOrder: 'visits' });
  await settle();
  assert.equal(page.one('#query').value, '当前');
  assert.equal(page.button('仅已命名').getAttribute('aria-pressed'), 'true');
  assert.equal(page.document.body.classList.contains('minimal-mode'), true);
  assert.equal(page.writes.at(-1).query, '当前');
  assert.equal(page.writes.at(-1).showRenamedOnly, true);
  assert.equal(page.writes.at(-1).showMinimalMode, true);
  assert.equal(page.one('#sort-order').value, 'name');
  assert.equal(page.writes.at(-1).sortOrder, 'name');
});

test('initial preference failure offers a retry that initializes and searches successfully', async () => {
  let loads = 0;
  const page = await createPage({ items: [pageItem('恢复后的页面', 'recovered')], loadPreferences: async () => {
    if (++loads === 1) throw new Error('偏好读取失败');
    return { query: '', range: 'all' };
  } });
  assert.match(page.one('#empty-state').textContent, /偏好读取失败/);
  assert.equal(page.one('#empty-state').hidden, false);
  page.button('重试').click();
  await settle();
  assert.deepEqual(page.titles(), ['恢复后的页面']);
  assert.equal(page.one('#empty-state').hidden, true);
  assert.equal(page.listeners.storage.length, 1);
  assert.equal(page.listeners.runtime.length, 1);
});
