import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../src/rename-overlay.js', import.meta.url), 'utf8');
const draft = {
  titleOverrideKey: 'https://example.com/a',
  url: 'https://example.com/a',
  currentTitle: '页面 A',
  originalTitle: '原名',
  hasTitleOverride: true
};

test('reopening and canceling inline rename disposes every previous key listener', () => {
  const app = createOverlayHarness();
  app.open();
  app.open();
  app.open();
  assert.equal(app.root.children.length, 1);
  assert.equal(app.keyListeners.size, 1);
  app.escape();
  assert.equal(app.root.children.length, 0);
  assert.equal(app.keyListeners.size, 0);
});

test('saving uses the current draft and closes only its own session after success', async () => {
  const app = createOverlayHarness();
  app.open();
  app.panel.querySelector('input').value = '  新名字  ';
  app.panel.fire('submit');
  assert.equal(app.messages[0].message.title, '新名字');
  assert.equal(app.messages[0].message.url, draft.url);
  assert.equal(app.panel.querySelector('input').disabled, true);
  app.messages[0].respond({ ok: true });
  await flushPromises();
  assert.equal(app.timers.size, 1);
  app.runTimers();
  assert.equal(app.root.children.length, 0);
  assert.equal(app.keyListeners.size, 0);
});

test('reopening after success cancels the old close timer', async () => {
  const app = createOverlayHarness();
  app.open();
  app.panel.fire('submit');
  app.messages[0].respond({ ok: true });
  await flushPromises();
  assert.equal(app.timers.size, 1);
  app.open({ ...draft, currentTitle: '页面 B' });
  assert.equal(app.timers.size, 0);
  assert.equal(app.keyListeners.size, 1);
  app.runTimers();
  assert.equal(app.panel.querySelector('input').value, '页面 B');
});

for (const response of [{ ok: true }, { ok: false, error: '写入失败' }]) {
  test(`a disposed pending save cannot update the replacement overlay (${response.ok ? 'success' : 'error'})`, async () => {
    const app = createOverlayHarness();
    app.open();
    const oldHost = app.root.children[0];
    app.panel.fire('submit');
    app.open({ ...draft, currentTitle: '页面 B' });
    const oldChildrenCount = oldHost.shadow.children.length;
    app.messages[0].respond(response);
    await flushPromises();
    assert.equal(oldHost.shadow.children.length, oldChildrenCount);
    assert.equal(app.timers.size, 0);
    assert.equal(app.keyListeners.size, 1);
    assert.equal(app.panel.querySelector('input').value, '页面 B');
    assert.equal(app.panel.querySelector('.status').textContent, undefined);
  });
}

test('restore errors remain inline and re-enable controls for retry', async () => {
  const app = createOverlayHarness();
  app.open();
  app.panel.querySelector('[data-restore-available]').fire('click');
  assert.equal(app.messages[0].message.type, 'deduped-history:restore-inline-rename');
  app.messages[0].respond({ ok: false, error: '请重试' });
  await flushPromises();
  assert.equal(app.panel.querySelector('.status').textContent, '请重试');
  assert.equal(app.panel.querySelector('input').disabled, false);
  assert.equal(app.panel.querySelector('[data-restore-available]').disabled, false);
});

function createOverlayHarness() {
  const root = new FakeElement('html');
  const keyListeners = new Set();
  const messages = [];
  const timers = new Map();
  let nextTimer = 0;
  let onMessage;
  const context = vm.createContext({
    document: { documentElement: root, createElement: (tag) => new FakeElement(tag) },
    window: {
      addEventListener: (_type, listener) => keyListeners.add(listener),
      removeEventListener: (_type, listener) => keyListeners.delete(listener)
    },
    chrome: {
      runtime: {
        onMessage: { addListener: (listener) => { onMessage = listener; } },
        sendMessage: (message, respond) => messages.push({ message, respond })
      }
    },
    setTimeout: (callback) => { timers.set(++nextTimer, callback); return nextTimer; },
    clearTimeout: (id) => timers.delete(id)
  });
  vm.runInContext(source, context);
  return {
    root, keyListeners, messages, timers,
    get panel() { return root.children[0].shadow.querySelector('form'); },
    open(value = draft) {
      onMessage({ type: 'deduped-history:init-inline-rename', draft: value }, null, () => {});
    },
    escape() {
      for (const listener of [...keyListeners]) {
        listener({
          key: 'Escape', composedPath: () => [root.children[0]],
          stopImmediatePropagation() {}, preventDefault() {}
        });
      }
    },
    runTimers() {
      for (const [id, callback] of [...timers]) { timers.delete(id); callback(); }
    }
  };
}

class FakeElement {
  constructor(tag) {
    this.tag = tag;
    this.children = [];
    this.dataset = {};
    this.listeners = new Map();
  }
  append(...children) {
    for (const child of children) { child.parent = this; this.children.push(child); }
  }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this);
    this.parent = null;
  }
  attachShadow() { this.shadow = new FakeElement('shadow'); return this.shadow; }
  setAttribute() {}
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  fire(type) { this.listeners.get(type)?.({ preventDefault() {}, stopPropagation() {} }); }
  focus() {}
  select() {}
  querySelector(selector) { return this.querySelectorAll(selector)[0]; }
  querySelectorAll(selector) {
    const matches = (node) => selector.split(',').some((part) => {
      const value = part.trim();
      if (value.startsWith('.')) return node.className === value.slice(1);
      if (value === '[data-restore-available]') return 'restoreAvailable' in node.dataset;
      return node.tag === value;
    });
    return this.children.flatMap((child) => [
      ...(matches(child) ? [child] : []), ...child.querySelectorAll(selector)
    ]);
  }
}

async function flushPromises() {
  await new Promise((resolve) => setImmediate(resolve));
}
