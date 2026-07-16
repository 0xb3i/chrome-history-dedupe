import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizeCapturedPageMap,
  normalizeCapturedTitleMap,
  normalizeLastSearchState,
  removeLegacyBatchTitleOverrides,
  updateCapturedTitleRecords
} from '../src/storage.js';

test('last search state normalizes query, range, and renamed filter', () => {
  assert.deepEqual(
    normalizeLastSearchState({
      query: '  MEEGO   story  ',
      range: 'week',
      showRenamedOnly: true,
      showMinimalMode: true
    }),
    {
      query: 'MEEGO story',
      range: 'week',
      showRenamedOnly: true,
      showMinimalMode: true
    }
  );
});

test('last search state falls back to the main page default for invalid ranges', () => {
  assert.deepEqual(normalizeLastSearchState({ query: 'MEEGO', range: 'forever' }), {
    query: 'MEEGO',
    range: 'month',
    showRenamedOnly: false,
    showMinimalMode: false
  });
});

test('legacy batch rename migration removes duplicated custom titles but keeps unique ones', () => {
  const migrated = removeLegacyBatchTitleOverrides(
    new Map([
      ['https://example.com/detail/abc', 'Shared custom name'],
      ['https://example.com/result/xyz', 'Shared custom name'],
      ['https://example.com/unique', 'Unique custom name']
    ])
  );

  assert.deepEqual([...migrated], [['https://example.com/unique', 'Unique custom name']]);
});

test('captured title records normalize valid titles and discard malformed entries', () => {
  assert.deepEqual(
    [...normalizeCapturedTitleMap({
      'https://example.com/a': { title: '  Final   title  ', updatedAt: 200 },
      'https://example.com/b': { title: '', updatedAt: 100 },
      '': { title: 'Missing URL', updatedAt: 300 }
    })],
    [['https://example.com/a', 'Final title']]
  );
});

test('captured title records strip invisible Unicode format controls', () => {
  assert.deepEqual(
    [...normalizeCapturedTitleMap({
      'https://example.com/a': {
        title: '\u2064\u200bAgent Node Replay 使用指南 - 飞书云文档',
        updatedAt: 200
      }
    })],
    [['https://example.com/a', 'Agent Node Replay 使用指南 - 飞书云文档']]
  );
});

test('captured page records preserve the final URL after redirects', () => {
  assert.deepEqual(
    [...normalizeCapturedPageMap({
      'https://cloud.example.com/legacy': {
        title: 'Release',
        resolvedUrl: 'https://cloud.example.com/final',
        updatedAt: 200
      }
    })],
    [['https://cloud.example.com/legacy', {
      title: 'Release',
      resolvedUrl: 'https://cloud.example.com/final'
    }]]
  );
});

test('captured title records skip storage updates when the title is unchanged', () => {
  const stored = {
    'https://example.com/doc/abc12345': {
      title: 'Final title',
      updatedAt: 100
    }
  };

  const unchanged = updateCapturedTitleRecords(
    stored,
    'https://example.com/doc/abc12345',
    'Final title',
    200
  );
  const renamed = updateCapturedTitleRecords(
    stored,
    'https://example.com/doc/abc12345',
    'Renamed title',
    200
  );

  assert.equal(unchanged.changed, false);
  assert.equal(unchanged.records.get('https://example.com/doc/abc12345').updatedAt, 100);
  assert.equal(renamed.changed, true);
  assert.deepEqual(renamed.records.get('https://example.com/doc/abc12345'), {
    title: 'Renamed title',
    updatedAt: 200
  });
});
