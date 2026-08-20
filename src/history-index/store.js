import {
  HISTORY_INDEX_ALGORITHM_VERSION,
  HISTORY_INDEX_RANGES
} from './derive.js';

const DATABASE_NAME = 'deduped-history-index-v1';
const DATABASE_VERSION = 1;
const META_STORE = 'meta';
const RAW_ITEMS_STORE = 'raw-items';
const INDEX_CHUNKS_STORE = 'index-chunks';
const INDEX_CHUNK_SIZE = 250;
const INDEX_WRITE_BATCH_SIZE = 20;
const STATE_KEY = 'state';

export function createHistoryIndexStore(options = {}) {
  const indexedDBApi = options.indexedDBApi ?? globalThis.indexedDB;
  const keyRangeApi = options.keyRangeApi ?? globalThis.IDBKeyRange;
  let databasePromise;

  const getDatabase = () => {
    if (!databasePromise) {
      databasePromise = openDatabase(indexedDBApi).catch((error) => {
        databasePromise = undefined;
        throw error;
      });
    }
    return databasePromise;
  };

  return {
    async getState() {
      const database = await getDatabase();
      const transaction = database.transaction(META_STORE, 'readonly');
      const state = await requestResult(transaction.objectStore(META_STORE).get(STATE_KEY));
      return normalizeState(state);
    },

    async loadRange(range) {
      const normalizedRange = normalizeRange(range);
      const database = await getDatabase();
      return loadRangeTransaction(database, keyRangeApi, normalizedRange);
    },

    async loadRawSnapshot() {
      const database = await getDatabase();
      const transaction = database.transaction([META_STORE, RAW_ITEMS_STORE], 'readonly');
      const [state, items] = await Promise.all([
        requestResult(transaction.objectStore(META_STORE).get(STATE_KEY)),
        requestResult(transaction.objectStore(RAW_ITEMS_STORE).getAll())
      ]);
      return {
        rawRevision: normalizeState(state).rawRevision,
        items
      };
    },

    async replaceRawItems(items, options = {}) {
      return mutateRawItems(await getDatabase(), {
        clear: true,
        upserts: normalizeRawItems(items),
        fullSyncAt: Number(options.fullSyncAt ?? Date.now())
      });
    },

    async applyRawMutation(mutation = {}) {
      return mutateRawItems(await getDatabase(), {
        clear: Boolean(mutation.clear),
        upserts: normalizeRawItems(mutation.upserts),
        deletes: normalizeUrls(mutation.deletes)
      });
    },

    async commitRangeIndexes(indexes, expectedRawRevision, options = {}) {
      const database = await getDatabase();
      const generation = createGenerationId();
      const builtAt = Number(options.builtAt ?? Date.now());
      const chunksByRange = {};
      const records = [];

      for (const range of HISTORY_INDEX_RANGES) {
        const pageItems = indexes instanceof Map ? indexes.get(range) : indexes?.[range];
        const chunks = chunkItems(Array.isArray(pageItems) ? pageItems : [], INDEX_CHUNK_SIZE);
        chunksByRange[range] = chunks.length;
        chunks.forEach((chunk, chunkIndex) => records.push({
          id: `${generation}:${range}:${chunkIndex}`,
          generation,
          range,
          chunkIndex,
          pageItems: chunk
        }));
      }

      await writeGenerationRecords(database, records);
      const result = await activateGeneration(
        database,
        generation,
        chunksByRange,
        Number(expectedRawRevision),
        builtAt
      );

      if (!result) {
        void deleteGeneration(database, keyRangeApi, generation).catch(() => {});
        return null;
      }

      if (result?.previousGeneration && result.previousGeneration !== generation) {
        void deleteGeneration(database, keyRangeApi, result.previousGeneration).catch(() => {});
      }

      return result;
    }
  };
}

function openDatabase(indexedDBApi) {
  if (!indexedDBApi?.open) {
    return Promise.reject(new Error('IndexedDB unavailable'));
  }

  return new Promise((resolve, reject) => {
    const request = indexedDBApi.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(META_STORE)) {
        database.createObjectStore(META_STORE, { keyPath: 'key' });
      }
      if (!database.objectStoreNames.contains(RAW_ITEMS_STORE)) {
        database.createObjectStore(RAW_ITEMS_STORE, { keyPath: 'url' });
      }
      if (!database.objectStoreNames.contains(INDEX_CHUNKS_STORE)) {
        const chunks = database.createObjectStore(INDEX_CHUNKS_STORE, { keyPath: 'id' });
        chunks.createIndex('by-generation-range', ['generation', 'range'], { unique: false });
      }
    };
    request.onerror = () => reject(request.error ?? new Error('Could not open history index'));
    request.onblocked = () => reject(new Error('History index upgrade blocked'));
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => database.close();
      resolve(database);
    };
  });
}

function mutateRawItems(database, mutation) {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction([META_STORE, RAW_ITEMS_STORE], 'readwrite');
    const metaStore = transaction.objectStore(META_STORE);
    const rawStore = transaction.objectStore(RAW_ITEMS_STORE);
    const stateRequest = metaStore.get(STATE_KEY);
    let nextState;

    stateRequest.onsuccess = () => {
      const state = normalizeState(stateRequest.result);
      if (mutation.clear) rawStore.clear();
      for (const url of mutation.deletes ?? []) rawStore.delete(url);
      for (const item of mutation.upserts ?? []) rawStore.put(item);
      nextState = {
        ...state,
        rawRevision: state.rawRevision + 1,
        ...(mutation.fullSyncAt ? { lastFullSyncAt: mutation.fullSyncAt } : {})
      };
      metaStore.put(nextState);
    };
    transaction.oncomplete = () => resolve(nextState);
    transaction.onerror = () => reject(transaction.error ?? new Error('History index mutation failed'));
    transaction.onabort = () => reject(transaction.error ?? new Error('History index mutation aborted'));
  });
}

async function writeGenerationRecords(database, records) {
  for (let start = 0; start < records.length; start += INDEX_WRITE_BATCH_SIZE) {
    const transaction = database.transaction(INDEX_CHUNKS_STORE, 'readwrite');
    const store = transaction.objectStore(INDEX_CHUNKS_STORE);
    for (const record of records.slice(start, start + INDEX_WRITE_BATCH_SIZE)) {
      store.put(record);
    }
    await transactionResult(transaction, 'History index chunk write failed');
    await yieldControl();
  }
}

function activateGeneration(database, generation, chunksByRange, expectedRawRevision, builtAt) {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(META_STORE, 'readwrite');
    const metaStore = transaction.objectStore(META_STORE);
    const stateRequest = metaStore.get(STATE_KEY);
    let result = null;
    let stale = false;

    stateRequest.onsuccess = () => {
      const state = normalizeState(stateRequest.result);
      if (state.rawRevision !== expectedRawRevision) {
        stale = true;
        transaction.abort();
        return;
      }

      const committedRevision = state.committedRevision + 1;
      metaStore.put({
        ...state,
        activeGeneration: generation,
        algorithmVersion: HISTORY_INDEX_ALGORITHM_VERSION,
        chunksByRange,
        committedRevision,
        indexedRawRevision: expectedRawRevision,
        lastBuiltAt: builtAt
      });
      result = {
        generation,
        revision: committedRevision,
        previousGeneration: state.activeGeneration
      };
    };
    transaction.oncomplete = () => resolve(result);
    transaction.onerror = () => reject(transaction.error ?? new Error('History index commit failed'));
    transaction.onabort = () => {
      if (stale) {
        resolve(null);
        return;
      }
      reject(transaction.error ?? new Error('History index commit aborted'));
    };
  });
}

async function deleteGeneration(database, keyRangeApi, generation) {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(INDEX_CHUNKS_STORE, 'readwrite');
    const store = transaction.objectStore(INDEX_CHUNKS_STORE);
    const generationRange = keyRangeApi.bound(
      [generation, ''],
      [generation, '\uffff']
    );
    const request = store.index('by-generation-range').openKeyCursor(generationRange);
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      store.delete(cursor.primaryKey);
      cursor.continue();
    };
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('History index cleanup failed'));
    transaction.onabort = () => reject(transaction.error ?? new Error('History index cleanup aborted'));
  });
}

function loadRangeTransaction(database, keyRangeApi, range) {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction([META_STORE, INDEX_CHUNKS_STORE], 'readonly');
    const stateRequest = transaction.objectStore(META_STORE).get(STATE_KEY);
    let result = null;

    stateRequest.onsuccess = () => {
      const state = normalizeState(stateRequest.result);
      if (!state.activeGeneration || state.algorithmVersion !== HISTORY_INDEX_ALGORITHM_VERSION) {
        return;
      }
      const chunksRequest = transaction.objectStore(INDEX_CHUNKS_STORE)
        .index('by-generation-range')
        .getAll(keyRangeApi.only([state.activeGeneration, range]));
      chunksRequest.onsuccess = () => {
        const chunks = chunksRequest.result;
        const expectedChunkCount = Number(state.chunksByRange?.[range] ?? 0);
        if (chunks.length !== expectedChunkCount) return;
        chunks.sort((left, right) => left.chunkIndex - right.chunkIndex);
        result = {
          revision: state.committedRevision,
          builtAt: state.lastBuiltAt,
          pageItems: chunks.flatMap((chunk) => chunk.pageItems)
        };
      };
    };
    transaction.oncomplete = () => resolve(result);
    transaction.onerror = () => reject(transaction.error ?? new Error('History index read failed'));
    transaction.onabort = () => reject(transaction.error ?? new Error('History index read aborted'));
  });
}

function normalizeState(value) {
  return {
    key: STATE_KEY,
    rawRevision: Number(value?.rawRevision ?? 0),
    indexedRawRevision: Number(value?.indexedRawRevision ?? 0),
    committedRevision: Number(value?.committedRevision ?? 0),
    activeGeneration: String(value?.activeGeneration ?? ''),
    algorithmVersion: Number(value?.algorithmVersion ?? 0),
    chunksByRange: value?.chunksByRange ?? {},
    lastFullSyncAt: Number(value?.lastFullSyncAt ?? 0),
    lastBuiltAt: Number(value?.lastBuiltAt ?? 0)
  };
}

function normalizeRawItems(items) {
  return (Array.isArray(items) ? items : [])
    .filter((item) => String(item?.url ?? '').trim())
    .map((item) => ({ ...item, url: String(item.url) }));
}

function normalizeUrls(urls) {
  return [...new Set((Array.isArray(urls) ? urls : []).map(String).filter(Boolean))];
}

function normalizeRange(range) {
  return HISTORY_INDEX_RANGES.includes(range) ? range : 'month';
}

function chunkItems(items, chunkSize) {
  if (items.length === 0) return [];
  const chunks = [];
  for (let index = 0; index < items.length; index += chunkSize) {
    chunks.push(items.slice(index, index + chunkSize));
  }
  return chunks;
}

function createGenerationId() {
  return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

function transactionResult(transaction, fallbackMessage) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error(fallbackMessage));
    transaction.onabort = () => reject(transaction.error ?? new Error(fallbackMessage));
  });
}

function yieldControl() {
  return new Promise((resolve) => globalThis.setTimeout(resolve, 0));
}
