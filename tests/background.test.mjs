import assert from 'node:assert/strict';
import test from 'node:test';
import { CAPTURED_PAGE_TITLES_STORAGE_KEY } from '../src/storage.js';
import { exportUserDataBackup } from '../src/user-data-backup.js';

test('background excludes incognito capture and rename without breaking normal tabs', async (t) => {
  const previousChrome = globalThis.chrome;
  const values = {};
  const listeners = {};
  const messages = [];
  const regular = { id: 1, url: 'https://example.com/public', title: '普通页面', incognito: false };
  const privateTab = { id: 2, url: 'https://example.com/private', title: '无痕页面', incognito: true };
  let tabs = [regular, privateTab];
  let injections = 0;
  let historySearches = 0;
  const event = (name) => ({ addListener(callback) { listeners[name] = callback; } });
  const settle = () => new Promise(setImmediate);
  globalThis.chrome = {
    runtime: {
      onStartup: event('startup'),
      onInstalled: event('installed')
    },
    history: {
      onVisited: event('visited'),
      onVisitRemoved: event('visit-removed'),
      search(_query, callback) { historySearches += 1; callback([]); }
    },
    tabs: {
      onUpdated: event('updated'),
      query(_query, callback) { callback(tabs); },
      sendMessage(_id, message, callback) { messages.push(message); callback({ ok: true }); }
    },
    commands: { onCommand: event('command') },
    scripting: { executeScript(_details, callback) { injections += 1; callback(); } },
    storage: { local: {
      get(key, callback) { callback({ [key]: values[key] }); },
      set(update, callback) { Object.assign(values, update); callback(); }
    } }
  };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => {
    t.mock.timers.reset();
    if (previousChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = previousChrome;
  });
  await import('../src/background.js');
  listeners.startup();
  await settle();
  assert.equal(historySearches, 0);
  listeners.installed();
  await settle();
  assert.equal(historySearches, 0);
  t.mock.timers.tick(100);
  await settle();
  assert.deepEqual(Object.keys(values[CAPTURED_PAGE_TITLES_STORAGE_KEY]), [regular.url]);

  listeners.updated(1, { title: '更新后的标题' }, regular);
  listeners.updated(2, { title: privateTab.title }, privateTab);
  t.mock.timers.tick(100);
  await settle();
  assert.deepEqual(Object.keys(values[CAPTURED_PAGE_TITLES_STORAGE_KEY]), [regular.url]);
  const backup = JSON.stringify(await exportUserDataBackup());
  assert.ok(backup.includes('更新后的标题'));
  assert.ok(!backup.includes(privateTab.title));
  assert.ok(!backup.includes(privateTab.url));

  tabs = [privateTab];
  listeners.command('rename-current-page');
  await settle();
  assert.equal(injections, 0);
  assert.equal(messages.length, 0);
  tabs = [regular];
  listeners.command('rename-current-page');
  await settle();
  assert.equal(injections, 1);
  assert.equal(messages[0].draft.url, regular.url);
});
