import assert from 'node:assert/strict';
import test from 'node:test';
import { createHistoryPageInitializer } from '../src/history-page-init.js';
import { createSearchState } from '../src/search-state.js';
import { normalizeLastSearchState } from '../src/storage.js';

const now = Date.UTC(2026, 8, 8, 12);
const pageItems = ['Saved query', 'Submitted query', 'Draft query'].map((title, index) => ({
  dedupeKey: `https://example.com/${index}`, url: `https://example.com/${index}`,
  title, searchableTitles: [title], lastVisitTime: now, totalVisitCount: index + 1
}));
const index = { revision: 1, pageItems };
const saved = { query: 'Saved query', range: 'week' };

test('untouched controls restore saved preferences and search their committed conditions', async () => {
  const page = createPage();
  const initializing = page.initializer.initialize();
  page.preferences.resolve({ lastSearchState: saved });
  await initializing;
  assert.deepEqual(page.draft, saved);
  assert.deepEqual(page.searches, [saved]);
  assert.equal(page.state.snapshot.query, saved.query);
  assert.equal(page.restores.length, 1);
});

test('a saved day filter is restored and excludes history from a year ago', async () => {
  const oldIndex = { revision: 2, pageItems: pageItems.map((item) => ({
    ...item, lastVisitTime: now - 365 * 24 * 60 * 60 * 1000
  })) };
  const page = createPage({ loadIndex: () => oldIndex });
  const initializing = page.initializer.initialize();
  page.preferences.resolve({
    lastSearchState: normalizeLastSearchState({ query: saved.query, range: 'day' })
  });
  await initializing;
  assert.deepEqual(page.searches, [{ query: saved.query, range: 'day' }]);
  assert.deepEqual(page.state.snapshot.matchedItems, []);
  assert.equal(page.state.snapshot.range, 'day');
  assert.equal(page.draft.range, 'day');
});

test('typing before preferences load preserves the draft without submitting it', async () => {
  const page = createPage();
  const initializing = page.initializer.initialize();
  page.edit({ query: 'Draft query', range: 'all' });
  page.preferences.resolve({ lastSearchState: saved });
  await initializing;
  assert.equal(page.draft.query, 'Draft query');
  assert.deepEqual(page.searches, [saved]);
  assert.equal(page.state.snapshot.query, saved.query);
  assert.equal(page.restores.length, 0);
});

test('a submitted search keeps ownership when saved preferences arrive later', async () => {
  const page = createPage();
  const initializing = page.initializer.initialize();
  page.edit({ query: 'Submitted query', range: 'all' });
  await page.submit();
  page.preferences.resolve({ lastSearchState: saved });
  await initializing;
  assert.deepEqual(page.draft, { query: 'Submitted query', range: 'all' });
  assert.deepEqual(page.searches, [{ query: 'Submitted query', range: 'all' }]);
  assert.equal(page.state.snapshot.query, 'Submitted query');
  assert.equal(page.restores.length, 0);
  assert.equal(page.applied.length, 1);
});

test('submitting without a preceding edit event also blocks preference restoration', async () => {
  const page = createPage();
  const initializing = page.initializer.initialize();
  await page.submit();
  page.preferences.resolve({ lastSearchState: saved });
  await initializing;
  assert.deepEqual(page.draft, { query: '', range: 'all' });
  assert.deepEqual(page.searches, [{ query: '', range: 'all' }]);
});

test('late preferences still apply annotations to the submitted search without rerunning saved conditions', async () => {
  const page = createPage();
  const initializing = page.initializer.initialize();
  page.edit({ query: 'Custom title', range: 'all' });
  await page.submit();
  assert.equal(page.state.snapshot.matchedItems.length, 0);
  page.preferences.resolve({ lastSearchState: saved, titleOverrides: new Map([[pageItems[1].dedupeKey, {
    title: 'Custom title', targetUrl: pageItems[1].url, updatedAt: now
  }]]) });
  await initializing;
  assert.deepEqual(page.searches, [{ query: 'Custom title', range: 'all' }]);
  assert.equal(page.state.snapshot.matchedItems[0].title, 'Custom title');
});

test('a submission during the initial index read supersedes the saved search', async () => {
  const slowIndex = deferred();
  let reads = 0;
  const page = createPage({ loadIndex: () => ++reads === 1 ? slowIndex.promise : index });
  const initializing = page.initializer.initialize();
  page.preferences.resolve({ lastSearchState: saved });
  await Promise.resolve();
  page.edit({ query: 'Submitted query', range: 'all' });
  await page.submit();
  slowIndex.resolve(index);
  await initializing;
  assert.equal(page.state.snapshot.query, 'Submitted query');
  assert.deepEqual(page.draft, { query: 'Submitted query', range: 'all' });
});

test('editing during the initial index read does not change the committed search', async () => {
  const slowIndex = deferred();
  const page = createPage({ loadIndex: () => slowIndex.promise });
  const initializing = page.initializer.initialize();
  page.preferences.resolve({ lastSearchState: saved });
  await Promise.resolve();
  page.edit({ query: 'Draft query', range: 'all' });
  slowIndex.resolve(index);
  await initializing;
  assert.deepEqual(page.draft, { query: 'Draft query', range: 'all' });
  assert.deepEqual(page.searches, [saved]);
  assert.equal(page.state.snapshot.query, saved.query);
});

test('without saved preferences an edited draft cannot replace the captured page defaults', async () => {
  const page = createPage();
  const initializing = page.initializer.initialize();
  page.edit({ query: 'Draft query', range: 'all' });
  page.preferences.resolve({ lastSearchState: null });
  await initializing;
  assert.deepEqual(page.draft, { query: 'Draft query', range: 'all' });
  assert.deepEqual(page.searches, [{ query: '', range: 'all' }]);
});

test('editing only the time selector while preferences load preserves the draft', async () => {
  const page = createPage();
  const initializing = page.initializer.initialize();
  page.edit({ range: 'quarter' });
  page.preferences.resolve({ lastSearchState: saved });
  await initializing;
  assert.equal(page.draft.range, 'quarter');
  assert.equal(page.state.snapshot.range, 'week');
  await page.submit();
  assert.equal(page.state.snapshot.range, 'quarter');
});

function createPage({ loadIndex = () => index } = {}) {
  const preferences = deferred();
  const draft = { query: '', range: 'all' };
  const searches = [];
  const restores = [];
  const applied = [];
  const state = createSearchState({ loadIndex, ensureIndex: async () => {}, onChange: () => {}, now: () => now });
  const search = (query, range) => {
    searches.push({ query, range });
    return state.search(query, range);
  };
  const initializer = createHistoryPageInitializer({
    initialSearch: draft,
    load: () => preferences.promise,
    apply(value) { applied.push(value); state.setTitleOverrides(value.titleOverrides ?? new Map()); },
    restore(value) { restores.push(value); Object.assign(draft, { query: value.query, range: value.range }); },
    search
  });
  return {
    initializer, preferences, draft, searches, restores, applied, state,
    edit(value) { Object.assign(draft, value); initializer.markEdited(); },
    submit() { initializer.markSubmitted(); return search(draft.query, draft.range); }
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
