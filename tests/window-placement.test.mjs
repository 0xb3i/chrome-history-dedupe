import assert from 'node:assert/strict';
import test from 'node:test';

import { getCenteredCoordinate, observeContentWindowHeight } from '../src/window-placement.js';

test('popup placement preserves negative coordinates for displays left of the primary display', () => {
  assert.equal(getCenteredCoordinate(-1920, 1920, 480), -1200);
});

test('popup placement preserves negative coordinates for displays above the primary display', () => {
  assert.equal(getCenteredCoordinate(-1080, 1080, 230), -655);
});

test('popup placement centers on displays with positive coordinates', () => {
  assert.equal(getCenteredCoordinate(1920, 2560, 480), 2960);
});

test('popup placement rejects incomplete window bounds', () => {
  assert.equal(getCenteredCoordinate(undefined, 1920, 480), undefined);
  assert.equal(getCenteredCoordinate(0, undefined, 480), undefined);
  assert.equal(getCenteredCoordinate(0, 1920, undefined), undefined);
});

function createContentWindow({ contentHeight = 170, innerHeight = 198, height = 230,
  zoom = 1, type = 'popup' } = {}) {
  let observer;
  let disconnected = false;
  let nextFrameId = 0;
  const frames = new Map();
  const updates = [];
  const warnings = [];
  const current = { id: 7, type, height, top: 100 };
  const content = { getBoundingClientRect: () => ({ height: contentHeight }) };
  const windowApi = {
    innerHeight,
    ResizeObserver: class {
      constructor(callback) { observer = callback; }
      observe(element) { assert.equal(element, content); }
      disconnect() { disconnected = true; }
    },
    requestAnimationFrame(callback) {
      const id = ++nextFrameId;
      frames.set(id, callback);
      return id;
    },
    cancelAnimationFrame(id) { frames.delete(id); },
    console: { warn: (...args) => warnings.push(args) },
    chrome: {
      tabs: { getZoom: async () => zoom },
      windows: {
        getCurrent: async () => ({ ...current }),
        update: async (id, bounds) => {
          assert.equal(id, current.id);
          updates.push(bounds);
          windowApi.innerHeight += (bounds.height - current.height) / zoom;
          Object.assign(current, bounds);
          return { ...current };
        }
      }
    }
  };
  return {
    content, windowApi, updates, warnings,
    get disconnected() { return disconnected; },
    resizeContent(height) {
      contentHeight = height;
      if (!disconnected) observer([]);
    },
    async flushFrame() {
      const callbacks = [...frames.values()];
      frames.clear();
      for (const callback of callbacks) callback();
      await new Promise((resolve) => setImmediate(resolve));
    }
  };
}

test('content-sized popup removes spare space while preserving its browser frame and center', async () => {
  const context = createContentWindow();
  const stop = observeContentWindowHeight(context.content, context.windowApi);
  context.resizeContent(170);
  await context.flushFrame();

  assert.deepEqual(context.updates, [{ height: 202, top: 114 }]);
  assert.equal(context.windowApi.innerHeight, 170);
  stop();
});

test('content-sized popup grows for an inline error and contracts after it clears', async () => {
  const context = createContentWindow();
  const stop = observeContentWindowHeight(context.content, context.windowApi);
  context.resizeContent(170);
  await context.flushFrame();
  context.resizeContent(210);
  await context.flushFrame();
  assert.deepEqual(context.updates.at(-1), { height: 242, top: 94 });
  assert.equal(context.windowApi.innerHeight, 210);

  context.resizeContent(170);
  await context.flushFrame();
  assert.deepEqual(context.updates.at(-1), { height: 202, top: 114 });
  stop();
});

test('content-sized popup converts zoomed CSS height to window coordinates', async () => {
  const context = createContentWindow({ zoom: 2, innerHeight: 198, height: 428 });
  const stop = observeContentWindowHeight(context.content, context.windowApi);
  context.resizeContent(170);
  await context.flushFrame();

  assert.deepEqual(context.updates, [{ height: 372, top: 128 }]);
  assert.equal(context.windowApi.innerHeight, 170);
  stop();
});

test('opening the rename page in a normal tab never resizes its browser window', async () => {
  const context = createContentWindow({ type: 'normal' });
  const stop = observeContentWindowHeight(context.content, context.windowApi);
  context.resizeContent(170);
  await context.flushFrame();
  assert.deepEqual(context.updates, []);
  stop();
});

test('content size cleanup cancels queued work and ignores a pending window lookup', async () => {
  const queued = createContentWindow();
  const stopQueued = observeContentWindowHeight(queued.content, queued.windowApi);
  queued.resizeContent(170);
  stopQueued();
  await queued.flushFrame();
  assert.equal(queued.disconnected, true);
  assert.deepEqual(queued.updates, []);

  const pending = createContentWindow();
  let resolveWindow;
  pending.windowApi.chrome.windows.getCurrent = () => new Promise((resolve) => { resolveWindow = resolve; });
  const stopPending = observeContentWindowHeight(pending.content, pending.windowApi);
  pending.resizeContent(170);
  await pending.flushFrame();
  assert.equal(typeof resolveWindow, 'function');
  stopPending();
  resolveWindow({ id: 7, type: 'popup', height: 230, top: 100 });
  await pending.flushFrame();
  assert.equal(pending.disconnected, true);
  assert.deepEqual(pending.updates, []);
});

test('a failed window lookup is reported and a later content change can recover', async () => {
  const context = createContentWindow();
  const getCurrent = context.windowApi.chrome.windows.getCurrent;
  context.windowApi.chrome.windows.getCurrent = async () => { throw new Error('Window unavailable'); };
  const stop = observeContentWindowHeight(context.content, context.windowApi);
  context.resizeContent(170);
  await context.flushFrame();
  assert.deepEqual(context.updates, []);
  assert.equal(context.warnings.length, 1);

  context.windowApi.chrome.windows.getCurrent = getCurrent;
  context.resizeContent(210);
  await context.flushFrame();
  assert.deepEqual(context.updates, [{ height: 242, top: 94 }]);
  stop();
});
