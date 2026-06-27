import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeLastSearchState } from '../src/storage.js';

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
