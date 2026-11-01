import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';
import { createSelectControl } from '../src/select-control.js';

const html = await readFile(new URL('../options.html', import.meta.url), 'utf8');
const source = await readFile(new URL('../src/settings-page.js', import.meta.url), 'utf8');
const executable = source.replace(/import\s+\{[^}]+\}\s+from\s+'[^']+';/g, '');

function createPage({ unavailable = false, throws = false, initialTheme = 'blue' } = {}) {
  const { document, window } = parseHTML(html);
  Object.defineProperty(document, 'visibilityState', { configurable: true, writable: true, value: 'visible' });
  // linkedom omits browser focus tracking and the select value setter.
  Object.defineProperty(document, 'activeElement', { configurable: true, writable: true, value: null });
  window.HTMLElement.prototype.focus = function () {
    this.ownerDocument.activeElement = this;
    this.dispatchEvent(new window.Event('focusin', { bubbles: true }));
  };
  for (const select of document.querySelectorAll('select')) {
    Object.defineProperty(select, 'value', {
      configurable: true,
      get() { return [...this.options].find((option) => option.hasAttribute('selected'))?.value ?? this.options[0]?.value; },
      set(value) {
        for (const option of this.options) {
          if (option.value === value) option.setAttribute('selected', '');
          else option.removeAttribute('selected');
        }
      }
    });
  }
  const themeWrites = [];
  let themeChanged;
  const fire = (target, type, properties = {}) => {
    const event = new window.Event(type, { bubbles: true, cancelable: true });
    Object.assign(event, properties);
    target.dispatchEvent(event);
    return event;
  };
  const pending = [];
  const opened = [];
  const chrome = {
    runtime: { getManifest: () => ({ version: 'test' }) },
    commands: unavailable ? undefined : { getAll(callback) {
      if (throws) throw new Error('Unavailable');
      pending.push(callback);
    } },
    tabs: { create: ({ url }) => opened.push(url) }
  };
  vm.runInContext(executable, vm.createContext({
    document, window, chrome,
    createSelectControl,
    applySavedTheme(_document, { onChange }) {
      themeChanged = onChange;
      onChange(initialTheme);
    },
    saveTheme(target, value) {
      assert.equal(target, document);
      themeWrites.push(value);
    },
    initializeUserDataControls() {}
  }));
  const label = (name) => document.querySelector(`[data-shortcut-command="${name}"]`);
  return { document, window, opened, pending, label, themeWrites, fire,
    updateTheme(value) { themeChanged(value); },
    respond(index, commands, error) {
      chrome.runtime.lastError = error;
      pending[index](commands);
      delete chrome.runtime.lastError;
    }
  };
}

test('settings display actual Chrome bindings, including a custom Option+Z rename shortcut', () => {
  const page = createPage();
  assert.equal(page.label('rename-current-page').textContent, '正在读取…');
  page.respond(0, [
    { name: '_execute_action', shortcut: '⌥S' },
    { name: 'rename-current-page', shortcut: '⌥Z' }
  ]);
  assert.equal(page.label('_execute_action').querySelector('kbd').textContent, '⌥S');
  assert.equal(page.label('rename-current-page').querySelector('kbd').textContent, '⌥Z');
  page.document.querySelector('#shortcut-settings').click();
  assert.deepEqual(page.opened, ['chrome://extensions/shortcuts']);
});

test('returning to settings reloads bindings and late responses cannot restore an old shortcut', () => {
  const page = createPage();
  page.respond(0, [{ name: 'rename-current-page', shortcut: 'Alt+Z' }]);
  page.window.dispatchEvent(new page.window.Event('focus'));
  page.document.visibilityState = 'hidden';
  page.document.dispatchEvent(new page.window.Event('visibilitychange'));
  assert.equal(page.pending.length, 2);
  page.document.visibilityState = 'visible';
  page.document.dispatchEvent(new page.window.Event('visibilitychange'));
  page.respond(2, [{ name: 'rename-current-page', shortcut: 'Ctrl+Shift+R' }]);
  page.respond(1, [{ name: 'rename-current-page', shortcut: 'Alt+Z' }]);
  assert.equal(page.label('rename-current-page').textContent, 'Ctrl+Shift+R');
});

test('an unassigned shortcut differs from a command that Chrome did not report', () => {
  const page = createPage();
  page.respond(0, [{ name: 'rename-current-page', shortcut: '' }]);
  assert.equal(page.label('rename-current-page').textContent, '未设置');
  assert.equal(page.label('rename-current-page').querySelector('kbd'), null);
  assert.equal(page.label('_execute_action').textContent, '暂时无法读取');
});

test('read errors never show defaults as active bindings and a later focus can recover', () => {
  for (const options of [{ unavailable: true }, { throws: true }]) {
    const page = createPage(options);
    assert.equal(page.label('rename-current-page').textContent, '暂时无法读取');
  }
  const page = createPage();
  page.respond(0, undefined, { message: 'Read failed' });
  assert.equal(page.label('rename-current-page').textContent, '暂时无法读取');
  page.window.dispatchEvent(new page.window.Event('focus'));
  page.respond(1, [{ name: 'rename-current-page', shortcut: 'Alt+Z' }]);
  assert.equal(page.label('rename-current-page').textContent, 'Alt+Z');
});


test('settings theme chooser uses the shared menu and saves a selected theme once', () => {
  const page = createPage();
  const select = page.document.querySelector('#theme-color');
  const control = page.document.querySelector('[data-select-id="theme-color"]');
  assert.ok(control, 'theme setting is enhanced with the shared menu');
  assert.ok(select.classList.contains('native-select-hidden'));
  assert.equal(select.getAttribute('aria-hidden'), 'true');
  assert.equal(select.tabIndex, -1);
  const trigger = control.querySelector('.select-combobox-button');
  const menu = control.querySelector('[role="listbox"]');
  assert.equal(trigger.getAttribute('aria-label'), '主题色：蓝色');
  trigger.click();
  assert.equal(menu.hidden, false);
  control.querySelector('[data-value="orange"]').click();
  assert.equal(select.value, 'orange');
  assert.equal(trigger.getAttribute('aria-label'), '主题色：暖橙');
  assert.equal(control.querySelector('[aria-selected="true"]').dataset.value, 'orange');
  assert.deepEqual(page.themeWrites, ['orange']);
  assert.equal(menu.hidden, true);
  assert.equal(page.document.activeElement, trigger);
});

test('saved and externally changed themes update the chooser without saving them again', () => {
  const page = createPage({ initialTheme: 'green' });
  const control = page.document.querySelector('[data-select-id="theme-color"]');
  const trigger = control.querySelector('.select-combobox-button');
  assert.equal(trigger.getAttribute('aria-label'), '主题色：绿色');
  assert.equal(control.querySelector('[aria-selected="true"]').dataset.value, 'green');
  page.updateTheme('neutral');
  assert.equal(page.document.querySelector('#theme-color').value, 'neutral');
  assert.equal(trigger.getAttribute('aria-label'), '主题色：中性');
  assert.equal(control.querySelector('[aria-selected="true"]').dataset.value, 'neutral');
  page.updateTheme('blue');
  assert.equal(trigger.getAttribute('aria-label'), '主题色：蓝色');
  assert.deepEqual(page.themeWrites, []);
});

test('theme menu supports keyboard navigation, cancellation and outside dismissal', () => {
  const page = createPage({ initialTheme: 'orange' });
  const control = page.document.querySelector('[data-select-id="theme-color"]');
  const trigger = control.querySelector('.select-combobox-button');
  const menu = control.querySelector('[role="listbox"]');
  const key = (value) => page.fire(page.document.activeElement, 'keydown', { key: value });
  trigger.focus();
  assert.equal(key('ArrowDown').defaultPrevented, true);
  assert.equal(page.document.activeElement.dataset.value, 'orange');
  key('ArrowDown');
  assert.equal(page.document.activeElement.dataset.value, 'green');
  key('ArrowUp');
  assert.equal(page.document.activeElement.dataset.value, 'orange');
  key('End');
  assert.equal(page.document.activeElement.dataset.value, 'neutral');
  key('Home');
  assert.equal(page.document.activeElement.dataset.value, 'blue');
  assert.equal(key('Escape').defaultPrevented, true);
  assert.equal(menu.hidden, true);
  assert.equal(trigger.getAttribute('aria-expanded'), 'false');
  assert.equal(page.document.activeElement, trigger);
  assert.equal(page.document.querySelector('#theme-color').value, 'orange');
  assert.deepEqual(page.themeWrites, []);
  trigger.click();
  page.document.querySelector('h1').click();
  assert.equal(menu.hidden, true);
  trigger.click();
  page.document.querySelector('#shortcut-settings').focus();
  assert.equal(menu.hidden, true);
});
