import assert from 'node:assert/strict';
import test from 'node:test';

import { createNavigationTracker } from '../src/navigation-tracker.js';

const original = 'https://example.com/legacy';
const final = 'https://example.com/final';
const event = (url, timeStamp, extra = {}) => ({ tabId: 7, frameId: 0, url, timeStamp, ...extra });

test('only a committed server redirect establishes aliases', () => {
  const tracker = createNavigationTracker();
  tracker.beforeNavigate(event(original, 1));
  assert.deepEqual(tracker.getCaptureUrls(7, { url: original }), []);
  tracker.committed(event(final, 2, { transitionQualifiers: ['server_redirect'] }));
  assert.deepEqual(tracker.getCaptureUrls(7, { url: final }), [original, final]);
});

test('URL changes during loading and client redirects do not establish aliases', () => {
  const tracker = createNavigationTracker();
  tracker.beforeNavigate(event(original, 1));
  assert.deepEqual(tracker.getCaptureUrls(7, { url: final, status: 'loading' }), []);
  tracker.committed(event(final, 2, { transitionQualifiers: ['client_redirect'] }));
  assert.deepEqual(tracker.getCaptureUrls(7, { url: final }), [final]);
});

test('canceling A and navigating to B cannot copy the B title onto A', () => {
  const tracker = createNavigationTracker();
  tracker.beforeNavigate(event(original, 1));
  tracker.beforeNavigate(event(final, 2));
  tracker.errorOccurred(event(original, 3, { error: 'net::ERR_ABORTED' }));
  assert.deepEqual(tracker.getCaptureUrls(7, { url: final }), []);
  tracker.committed(event(final, 4));
  assert.deepEqual(tracker.getCaptureUrls(7, { url: final }), [final]);
});

test('an overlapping navigation with ambiguous attribution does not create redirect aliases', () => {
  const tracker = createNavigationTracker();
  tracker.beforeNavigate(event(original, 1));
  tracker.beforeNavigate(event('https://example.com/replacement', 2));
  tracker.committed(event(final, 3, { transitionQualifiers: ['server_redirect'] }));
  assert.deepEqual(tracker.getCaptureUrls(7, { url: final }), [final]);
});

test('SPA routes discard committed redirect aliases even when returning to the original route', () => {
  const tracker = createNavigationTracker();
  tracker.beforeNavigate(event(original, 1));
  tracker.committed(event(final, 2, { transitionQualifiers: ['server_redirect'] }));
  const spa = 'https://example.com/another-resource';
  assert.deepEqual(tracker.getCaptureUrls(7, { url: spa }), [spa]);
  assert.deepEqual(tracker.getCaptureUrls(7, { url: final }), [final]);
});

test('a pending URL cannot capture the previously loaded tab title, including after a worker restart', () => {
  const tracker = createNavigationTracker();
  assert.deepEqual(tracker.getCaptureUrls(7, { url: original, pendingUrl: final }), []);
  assert.deepEqual(tracker.getCaptureUrls(7, { url: final }), [final]);
});

test('subframe and stale navigation events cannot replace main-frame aliases', () => {
  const tracker = createNavigationTracker();
  tracker.beforeNavigate(event(original, 10));
  tracker.committed(event(final, 20, { transitionQualifiers: ['server_redirect'] }));
  tracker.beforeNavigate(event('https://example.com/frame', 30, { frameId: 2 }));
  tracker.committed(event(original, 5));
  tracker.errorOccurred(event(original, 6));
  assert.deepEqual(tracker.getCaptureUrls(7, { url: final }), [original, final]);
});

test('failed navigation and removed tabs discard pending state', () => {
  const tracker = createNavigationTracker();
  tracker.beforeNavigate(event(original, 1));
  tracker.errorOccurred(event(original, 2, { error: 'net::ERR_ABORTED' }));
  assert.deepEqual(tracker.getCaptureUrls(7, { url: final }), [final]);
  tracker.beforeNavigate(event(original, 3));
  tracker.remove(7);
  assert.deepEqual(tracker.getCaptureUrls(7, { url: final }), [final]);
});

test('a commit after a worker restart captures the final page without inventing aliases', () => {
  const tracker = createNavigationTracker();
  tracker.committed(event(final, 2, { transitionQualifiers: ['server_redirect'] }));
  assert.deepEqual(tracker.getCaptureUrls(7, { url: final }), [final]);
  assert.deepEqual(tracker.getCaptureUrls(7, { url: 'chrome://history' }), []);
});
