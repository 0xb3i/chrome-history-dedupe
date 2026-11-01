import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';

const html = await readFile(new URL('../options.html', import.meta.url), 'utf8');
const source = await readFile(new URL('../src/settings-page.js', import.meta.url), 'utf8');
const executable = source.replace(/import\s+\{[^}]+\}\s+from\s+'[^']+';/g, '');

function createPage({ unavailable = false, throws = false } = {}) {
  const { document, window } = parseHTML(html);
  Object.defineProperty(document, 'visibilityState', { configurable: true, writable: true, value: 'visible' });
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
    applySavedTheme() {}, saveTheme() {}, initializeUserDataControls() {}
  }));
  const label = (name) => document.querySelector(`[data-shortcut-command="${name}"]`);
  return { document, window, opened, pending, label,
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
