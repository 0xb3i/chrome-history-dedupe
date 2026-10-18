import assert from 'node:assert/strict';
import test from 'node:test';
import { parseHTML } from 'linkedom';
import { createResultNavigation } from '../src/result-navigation.js';

function setup(markup = '', options = {}) {
  const { document, window } = parseHTML(`<html><body><input id="query"><button id="outside">其他操作</button><ol id="results">${markup}</ol></body></html>`);
  Object.defineProperty(document, 'activeElement', { configurable: true, writable: true, value: document.body });
  window.HTMLElement.prototype.focus = function () {
    document.activeElement = this;
    this.dispatchEvent(new window.Event('focusin', { bubbles: true }));
  };
  const queryInput = document.querySelector('#query');
  const results = document.querySelector('#results');
  results.scrollTop = 0;
  const navigation = createResultNavigation({ queryInput, results, ...options });
  function fire(target, key, properties = {}) {
    const event = new window.Event('keydown', { bubbles: true, cancelable: true });
    Object.assign(event, { key, ...properties });
    target.dispatchEvent(event);
    return event;
  }
  function composition(type) { queryInput.dispatchEvent(new window.Event(type, { bubbles: true })); }
  const one = (selector) => document.querySelector(selector);
  return { document, queryInput, results, navigation, fire, composition, one };
}

const row = (key, title = key) => `<li data-navigation-key="${key}"><a class="result-title" href="/${key}">${title}</a><button class="rename-button">改名</button></li>`;

test('search and result arrows navigate visible titles while Enter preserves native links', () => {
  const page = setup(row('first') + row('second'));
  const { queryInput, document, fire, one } = page;
  const first = one('a[href="/first"]');
  const second = one('a[href="/second"]');
  queryInput.focus();
  assert.equal(fire(queryInput, 'ArrowDown').defaultPrevented, true);
  assert.equal(document.activeElement, first);
  fire(first, 'ArrowDown');
  assert.equal(document.activeElement, second);
  fire(second, 'ArrowDown');
  assert.equal(document.activeElement, second);
  assert.equal(fire(second, 'Enter').defaultPrevented, false);
  fire(second, 'ArrowUp');
  assert.equal(document.activeElement, first);
  fire(first, 'ArrowUp');
  assert.equal(document.activeElement, queryInput);
  first.focus();
  fire(first, 'Escape');
  assert.equal(document.activeElement, queryInput);
  const button = one('.rename-button');
  button.focus();
  assert.equal(fire(button, 'ArrowDown').defaultPrevented, false);
  assert.equal(document.activeElement, button);
});

test('collapsed groups retain summary titles but exclude hidden descendants until opened', () => {
  const page = setup(`<li><details><summary><a class="result-title" href="/group">分组</a></summary><ol>${row('child')}</ol></details></li>${row('hidden').replace('<li ', '<li hidden ')}${row('last')}`);
  page.queryInput.focus();
  page.fire(page.queryInput, 'ArrowDown');
  assert.equal(page.document.activeElement, page.one('a[href="/group"]'));
  page.fire(page.document.activeElement, 'ArrowDown');
  assert.equal(page.document.activeElement, page.one('a[href="/last"]'));
  page.one('details').setAttribute('open', '');
  page.one('a[href="/group"]').focus();
  page.fire(page.document.activeElement, 'ArrowDown');
  assert.equal(page.document.activeElement, page.one('a[href="/child"]'));
});

test('composition, modifiers, busy results and modal/menu state leave keyboard input untouched', () => {
  let blocked = false;
  const page = setup(row('first'), { isBlocked: () => blocked });
  page.queryInput.focus();
  for (const properties of [{ isComposing: true }, { keyCode: 229 }, { ctrlKey: true }, { altKey: true }, { metaKey: true }, { shiftKey: true }]) {
    assert.equal(page.fire(page.queryInput, 'ArrowDown', properties).defaultPrevented, false);
    assert.equal(page.document.activeElement, page.queryInput);
  }
  page.composition('compositionstart');
  assert.equal(page.fire(page.queryInput, 'ArrowDown').defaultPrevented, false);
  page.composition('compositionend');
  page.results.setAttribute('aria-busy', 'true');
  assert.equal(page.fire(page.queryInput, 'ArrowDown').defaultPrevented, false);
  page.results.setAttribute('aria-busy', 'false');
  blocked = true;
  assert.equal(page.fire(page.queryInput, 'ArrowDown').defaultPrevented, false);
  blocked = false;
  assert.equal(page.fire(page.queryInput, 'ArrowDown').defaultPrevented, true);
});

test('refresh restores the same resource action after sorting and preserves scroll position', () => {
  const page = setup(row('first') + row('second'));
  page.one('[data-navigation-key="second"] button').focus();
  page.results.scrollTop = 160;
  const snapshot = page.navigation.capture();
  page.results.innerHTML = row('second', '新名称') + row('first');
  page.document.activeElement = page.document.body;
  page.results.scrollTop = 0;
  assert.equal(page.navigation.restore(snapshot), true);
  assert.equal(page.document.activeElement, page.one('[data-navigation-key="second"] button'));
  assert.equal(page.results.scrollTop, 160);
});

test('refresh falls back to nearby visible title when the focused resource disappears', () => {
  const page = setup(row('first') + row('second') + row('third'));
  page.one('a[href="/second"]').focus();
  const snapshot = page.navigation.capture();
  page.results.innerHTML = row('first') + row('third');
  page.document.activeElement = page.document.body;
  assert.equal(page.navigation.restore(snapshot), true);
  assert.equal(page.document.activeElement, page.one('a[href="/third"]'));
  const emptySnapshot = page.navigation.capture();
  page.results.replaceChildren();
  page.document.activeElement = page.document.body;
  assert.equal(page.navigation.restore(emptySnapshot), true);
  assert.equal(page.document.activeElement, page.queryInput);
});

test('refresh never steals focus after the user moves it or when the original node survives', () => {
  const page = setup(row('first'));
  page.one('.result-title').focus();
  const snapshot = page.navigation.capture();
  assert.equal(page.navigation.restore(snapshot), false);
  page.results.innerHTML = row('first');
  page.one('#outside').focus();
  assert.equal(page.navigation.restore(snapshot), false);
  assert.equal(page.document.activeElement, page.one('#outside'));
  page.one('.result-title').focus();
  const next = page.navigation.capture();
  page.results.innerHTML = row('first');
  page.queryInput.focus();
  page.document.activeElement = page.document.body;
  assert.equal(page.navigation.restore(next), false);
});

test('empty result arrows remain native and destroy removes all event behavior', () => {
  const page = setup();
  page.queryInput.focus();
  assert.equal(page.fire(page.queryInput, 'ArrowDown').defaultPrevented, false);
  page.results.innerHTML = row('first');
  page.navigation.destroy();
  assert.equal(page.fire(page.queryInput, 'ArrowDown').defaultPrevented, false);
});

test('refresh preserves scroll without moving search or modal focus', () => {
  let blocked = false;
  const page = setup(row('first'), { isBlocked: () => blocked });
  page.queryInput.focus();
  page.results.scrollTop = 80;
  const snapshot = page.navigation.capture();
  page.results.innerHTML = row('second');
  page.results.scrollTop = 0;
  assert.equal(page.navigation.restore(snapshot), false);
  assert.equal(page.results.scrollTop, 80);
  assert.equal(page.document.activeElement, page.queryInput);
  page.one('.result-title').focus();
  const modalSnapshot = page.navigation.capture();
  page.results.innerHTML = row('second');
  blocked = true;
  page.document.activeElement = page.document.body;
  assert.equal(page.navigation.restore(modalSnapshot), false);
});
