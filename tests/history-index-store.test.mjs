import assert from 'node:assert/strict';
import test from 'node:test';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { createHistoryIndexStore } from '../src/history-index/store.js';

const DATABASE_NAME = 'deduped-history-index-v1';

test('failed multi-batch writes remove partial chunks and preserve the published index', async () => {
  const context = createContext();
  const store = context.createStore();
  const committed = await store.commitRangeIndexes(indexes('published'), 0);
  const previous = await store.loadRange('all');
  let writtenBeforeFailure = 0;
  const failingStore = context.createStore({
    yieldControl: async () => {
      writtenBeforeFailure = (await context.readChunks())
        .filter((chunk) => chunk.generation !== committed.generation).length;
    }
  });
  const nextIndexes = indexes('new', 5001);
  nextIndexes.get('all')[5000].invalidValue = () => {};

  await assert.rejects(failingStore.commitRangeIndexes(nextIndexes, 0), { name: 'DataCloneError' });

  assert.equal(writtenBeforeFailure, 20);
  assert.deepEqual(await store.loadRange('all'), previous);
  assert.deepEqual(new Set((await context.readChunks()).map((chunk) => chunk.generation)),
    new Set([committed.generation]));
});

test('initialization collects abandoned worker chunks while preserving active generation', async () => {
  const context = createContext();
  const store = context.createStore();
  const committed = await store.commitRangeIndexes(indexes('published'), 0);
  await context.writeAbandonedChunk();
  assert.equal((await context.readChunks()).length, 2);

  const reopened = context.createStore();
  assert.equal((await reopened.loadRange('all')).pageItems[0].url, 'https://example.com/published/0');
  assert.deepEqual(new Set((await context.readChunks()).map((chunk) => chunk.generation)),
    new Set([committed.generation]));
});

test('a new reader neither waits for nor collects an in-progress writer generation', async () => {
  const context = createContext();
  const store = context.createStore();
  await store.commitRangeIndexes(indexes('published'), 0);
  const entered = deferred();
  const release = deferred();
  let batches = 0;
  const writer = context.createStore({
    yieldControl: async () => {
      if (++batches === 1) {
        entered.resolve();
        await release.promise;
      }
    }
  });
  const commit = writer.commitRangeIndexes(indexes('new', 5001), 0);
  await entered.promise;
  let timeout;
  try {
    const reader = context.createStore();
    const loaded = await Promise.race([
      reader.loadRange('all'),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error('reader waited for writer')), 1000);
      })
    ]);
    assert.equal(loaded.pageItems[0].url, 'https://example.com/published/0');
    assert.equal((await context.readChunks()).length, 21);
  } finally {
    clearTimeout(timeout);
    release.resolve();
    await commit;
  }

  const loaded = await store.loadRange('all');
  assert.equal(loaded.pageItems.length, 5001);
  assert.equal(loaded.pageItems[0].url, 'https://example.com/new/0');
  assert.equal(new Set((await context.readChunks()).map((chunk) => chunk.generation)).size, 1);
});

test('a stale raw revision rejects publication and removes its staged chunks', async () => {
  const context = createContext();
  const store = context.createStore();
  const committed = await store.commitRangeIndexes(indexes('published'), 0);
  const writer = context.createStore({
    yieldControl: async () => {
      await store.applyRawMutation({ upserts: [{ url: 'https://example.com/visited' }] });
    }
  });

  assert.equal(await writer.commitRangeIndexes(indexes('stale'), 0), null);
  assert.equal((await store.loadRange('all')).pageItems[0].url, 'https://example.com/published/0');
  assert.deepEqual(new Set((await context.readChunks()).map((chunk) => chunk.generation)),
    new Set([committed.generation]));
});

function createContext() {
  const indexedDBApi = new IDBFactory();
  return {
    createStore(options = {}) {
      return createHistoryIndexStore({
        indexedDBApi,
        keyRangeApi: IDBKeyRange,
        locksApi: navigator.locks,
        yieldControl: async () => {},
        ...options
      });
    },
    async readChunks() {
      const database = await openDatabase(indexedDBApi);
      try {
        return await requestResult(database.transaction('index-chunks', 'readonly')
          .objectStore('index-chunks').getAll());
      } finally {
        database.close();
      }
    },
    async writeAbandonedChunk() {
      const database = await openDatabase(indexedDBApi);
      try {
        const transaction = database.transaction('index-chunks', 'readwrite');
        transaction.objectStore('index-chunks').put({
          id: 'abandoned:all:0', generation: 'abandoned', range: 'all', chunkIndex: 0, pageItems: []
        });
        await new Promise((resolve, reject) => {
          transaction.oncomplete = resolve;
          transaction.onabort = () => reject(transaction.error);
        });
      } finally {
        database.close();
      }
    }
  };
}

function indexes(prefix, count = 1) {
  return new Map([['all', Array.from({ length: count }, (_, index) => ({
    url: `https://example.com/${prefix}/${index}`
  }))]]);
}

function deferred() {
  let resolve;
  const promise = new Promise((accept) => { resolve = accept; });
  return { promise, resolve };
}

function openDatabase(indexedDBApi) {
  return requestResult(indexedDBApi.open(DATABASE_NAME));
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
