import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';

const source = await readFile(new URL('../src/theme.js', import.meta.url), 'utf8');
const executable = source.replaceAll('export ', '');
const key = 'history-ui-color';

function createTheme({ cached, cacheUnavailable = false } = {}) {
  const { document } = parseHTML('<!doctype html><html><body></body></html>');
  const cache = new Map(cached ? [[key, cached]] : []);
  const pending = [];
  const listeners = [];
  const writes = [];
  const chrome = {
    runtime: {},
    storage: {
      local: {
        get(_key, callback) { pending.push(callback); },
        set(values) { writes.push(values); }
      },
      onChanged: { addListener(listener) { listeners.push(listener); } }
    }
  };
  const context = vm.createContext({
    chrome,
    localStorage: {
      getItem(name) { if (cacheUnavailable) throw new Error('Unavailable'); return cache.get(name) ?? null; },
      setItem(name, value) { if (cacheUnavailable) throw new Error('Unavailable'); cache.set(name, value); }
    }
  });
  vm.runInContext(executable, context);
  return {
    document, cache, writes, listeners, ...context,
    respond(saved, error) {
      chrome.runtime.lastError = error;
      pending.shift()(saved);
      delete chrome.runtime.lastError;
    },
    change(value, area = 'local') {
      for (const listener of listeners) listener({ [key]: { newValue: value } }, area);
    }
  };
}

test('saved theme reconciles cache and notifies controls immediately and after loading', () => {
  const page = createTheme({ cached: 'orange' });
  const seen = [];
  page.applySavedTheme(page.document, { onChange: (value) => seen.push(value) });
  assert.equal(page.document.documentElement.dataset.themeColor, 'orange');
  page.respond({ [key]: 'green' });
  assert.equal(page.document.documentElement.dataset.themeColor, 'green');
  assert.equal(page.cache.get(key), 'green');
  assert.deepEqual(seen, ['orange', 'green']);
});

test('late initial read cannot override a theme selected before storage responds', () => {
  const page = createTheme();
  page.applySavedTheme(page.document);
  page.saveTheme(page.document, 'orange');
  page.respond({ [key]: 'blue' });
  assert.equal(page.document.documentElement.dataset.themeColor, 'orange');
  assert.equal(page.cache.get(key), 'orange');
  assert.equal(page.writes[0][key], 'orange');
});

test('storage changes supersede an initial read and update the next-open cache', () => {
  const page = createTheme({ cached: 'orange' });
  page.applySavedTheme(page.document);
  page.change('neutral', 'sync');
  assert.equal(page.document.documentElement.dataset.themeColor, 'orange');
  page.change('green');
  page.respond({ [key]: 'orange' });
  assert.equal(page.document.documentElement.dataset.themeColor, 'green');
  assert.equal(page.cache.get(key), 'green');
});

test('pages forwarding their own theme events also reject stale initial reads', () => {
  const page = createTheme();
  page.applySavedTheme(page.document, { watch: false });
  assert.equal(page.listeners.length, 0);
  page.applyTheme(page.document, 'neutral');
  page.respond({ [key]: 'blue' });
  assert.equal(page.document.documentElement.dataset.themeColor, 'neutral');
});

test('missing or removed saved theme resets a stale cache to the default', () => {
  const page = createTheme({ cached: 'orange' });
  const seen = [];
  page.applySavedTheme(page.document, { onChange: (value) => seen.push(value) });
  page.respond({});
  assert.equal(page.document.documentElement.dataset.themeColor, 'blue');
  page.change('green');
  page.change(undefined);
  assert.equal(page.document.documentElement.dataset.themeColor, 'blue');
  assert.equal(page.cache.get(key), 'blue');
  assert.deepEqual(seen, ['orange', 'blue', 'green', 'blue']);
});

test('failed reads preserve the current theme and unavailable cache does not block storage', () => {
  const page = createTheme({ cached: 'orange' });
  page.applySavedTheme(page.document);
  page.respond(undefined, { message: 'Unavailable' });
  assert.equal(page.document.documentElement.dataset.themeColor, 'orange');
  const withoutCache = createTheme({ cacheUnavailable: true });
  withoutCache.applySavedTheme(withoutCache.document);
  withoutCache.respond({ [key]: 'green' });
  assert.equal(withoutCache.document.documentElement.dataset.themeColor, 'green');
});

test('unknown theme values never change the page or persist a selection', () => {
  const page = createTheme();
  page.applySavedTheme(page.document);
  assert.equal(page.applyTheme(page.document, 'invalid'), false);
  page.saveTheme(page.document, 'invalid');
  page.saveTheme(page.document, undefined);
  assert.equal(page.document.documentElement.dataset.themeColor, 'blue');
  assert.equal(page.writes.length, 0);
});
