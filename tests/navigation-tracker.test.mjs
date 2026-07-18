import assert from 'node:assert/strict';
import test from 'node:test';

import { createNavigationTracker } from '../src/navigation-tracker.js';

test('navigation tracker keeps redirect aliases until the final page completes', () => {
  const tracker = createNavigationTracker();

  tracker.update(7, { status: 'loading', url: 'https://example.com/legacy' }, {
    pendingUrl: 'https://example.com/legacy',
    url: 'https://example.com/legacy'
  });
  tracker.update(7, { url: 'https://example.com/final' }, {
    pendingUrl: 'https://example.com/final',
    url: 'https://example.com/final'
  });
  const urls = tracker.update(7, { status: 'complete' }, {
    url: 'https://example.com/final'
  });

  assert.deepEqual(urls, [
    'https://example.com/legacy',
    'https://example.com/final'
  ]);
});

test('a later SPA URL update starts a fresh chain instead of becoming a redirect alias', () => {
  const tracker = createNavigationTracker();

  tracker.update(1, { status: 'loading', url: 'https://example.com/a' }, {
    url: 'https://example.com/a'
  });
  tracker.update(1, { status: 'complete' }, { url: 'https://example.com/a' });

  assert.deepEqual(
    tracker.update(1, { url: 'https://example.com/b' }, { url: 'https://example.com/b' }),
    ['https://example.com/b']
  );
});

test('a new navigation never records the previously loaded tab URL as an alias', () => {
  const tracker = createNavigationTracker();
  tracker.update(3, { status: 'complete' }, { url: 'https://example.com/old' });

  const loadingUrls = tracker.update(3, { status: 'loading' }, {
    pendingUrl: 'https://example.com/new',
    url: 'https://example.com/old'
  });
  const completedUrls = tracker.update(3, { status: 'complete' }, {
    url: 'https://example.com/new'
  });

  assert.deepEqual(loadingUrls, ['https://example.com/new']);
  assert.deepEqual(completedUrls, ['https://example.com/new']);
});

test('a pending URL starts a fresh chain even if the worker first sees only a title event', () => {
  const tracker = createNavigationTracker();

  assert.deepEqual(
    tracker.update(4, { title: 'New page loading' }, {
      pendingUrl: 'https://example.com/new',
      status: 'loading',
      url: 'https://example.com/old'
    }),
    ['https://example.com/new']
  );
});

test('removed tabs discard their previous navigation chain', () => {
  const tracker = createNavigationTracker();
  tracker.update(2, { status: 'loading', url: 'https://example.com/old' }, {
    url: 'https://example.com/old'
  });
  tracker.remove(2);

  assert.deepEqual(
    tracker.update(2, {}, { url: 'https://example.com/current' }),
    ['https://example.com/current']
  );
});
