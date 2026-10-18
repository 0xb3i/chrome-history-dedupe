import assert from 'node:assert/strict';
import test from 'node:test';
import { createHighlightedExcerpt, describeLinkChoices, formatRelativeVisitTime, groupItemsByDisplayTitle } from '../src/result-presentation.js';

test('relative visit times use local calendar days and retain dates beyond a week', () => {
  const now = new Date(2026, 9, 18, 12).getTime();
  assert.equal(formatRelativeVisitTime(new Date(2026, 9, 18, 9, 18).getTime(), now), '09:18');
  assert.equal(formatRelativeVisitTime(new Date(2026, 9, 17, 23).getTime(), now), '昨天');
  assert.equal(formatRelativeVisitTime(new Date(2026, 9, 16, 12).getTime(), now), '周五');
  assert.equal(formatRelativeVisitTime(new Date(2026, 9, 11, 12).getTime(), now), '10/11');
  assert.equal(formatRelativeVisitTime(new Date(2025, 9, 18, 12).getTime(), now), '2025/10/18');
  assert.equal(formatRelativeVisitTime(0, now), '未知时间');
});

test('long highlighted titles use a bounded excerpt near the first match and preserve input ranges', () => {
  for (const prefix of ['', '说明'.repeat(300)]) {
    const text = `${prefix}目标页面${'后文'.repeat(300)}目标页面`;
    const ranges = Object.freeze([Object.freeze([prefix.length, prefix.length + 4]),
      Object.freeze([text.length - 4, text.length])]);
    const excerpt = createHighlightedExcerpt(text, ranges);
    assert.ok(excerpt.text.length <= 162);
    assert.equal(excerpt.text.startsWith('…'), Boolean(prefix));
    assert.ok(excerpt.text.endsWith('…'));
    assert.deepEqual(excerpt.ranges.map(([start, end]) => excerpt.text.slice(start, end)), ['目标页面']);
    assert.equal(ranges[0][0], prefix.length);
  }
});

test('excerpts retain local matches, short titles and unmatched text without breaking emoji', () => {
  const short = '资料：目标页面';
  assert.deepEqual(createHighlightedExcerpt(short, [[3, 7]]), { text: short, ranges: [[3, 7]] });
  const text = `${'前'.repeat(200)}😀${'文'.repeat(23)}目标 页面${'😀'.repeat(100)}`;
  const ranges = [[225, 227], [228, 230]];
  const excerpt = createHighlightedExcerpt(text, ranges);
  assert.deepEqual(excerpt.ranges.map(([start, end]) => excerpt.text.slice(start, end)), ['目标', '页面']);
  assert.equal(excerpt.text.isWellFormed(), true);
  assert.deepEqual(createHighlightedExcerpt(text), { text, ranges: [] });
});

function item(path, extra = {}) {
  return Object.freeze({ title: 'ModelHub 平台', url: `https://gpt.example.com/${path}`, ...extra });
}

test('same-title results become one display bucket without merging resource data', () => {
  const items = Object.freeze([
    item('models', { visitCount: 59, lastVisitTime: 100 }),
    item('keys', { totalVisitCount: 19, visitCount: 99, lastVisitTime: 300 }),
    item('usage', { visitCount: 14, lastVisitTime: 200 })
  ]);
  const [row] = groupItemsByDisplayTitle(items);
  assert.equal(row.kind, 'title-group');
  assert.equal(row.title, 'ModelHub 平台');
  assert.deepEqual(row.items, items);
  row.items.forEach((member, index) => assert.equal(member, items[index]));
  assert.equal('url' in row, false);
  assert.equal('titleOverrideKey' in row, false);
  assert.equal(row.totalVisitCount, 92);
  assert.equal(row.lastVisitTime, 300);
});

test('explicit renamed and pinned entries remain independent even with identical titles', () => {
  const renamed = item('custom', { isTitleRenamed: true });
  const pinned = item('pinned', { isPinned: true });
  const rows = groupItemsByDisplayTitle([pinned, renamed, item('models'), item('keys')]);
  assert.deepEqual(rows.map((row) => row.kind), ['item', 'item', 'title-group']);
  assert.equal(rows[0].item, pinned);
  assert.equal(rows[1].item, renamed);
  assert.equal(rows[0].distinguishUrl, true);
  assert.equal(rows[1].distinguishUrl, true);
});

test('the first ranked member fixes display position and members keep their existing order', () => {
  const first = item('usage');
  const other = item('other', { title: '其他平台' });
  const last = item('models');
  const rows = groupItemsByDisplayTitle([first, other, last]);
  assert.deepEqual(rows[0].items, [first, last]);
  assert.equal(rows[1].item, other);
});

test('different domains and missing titles never become a shared platform bucket', () => {
  const items = [item('models'), item('keys', { url: 'https://other.example.com/keys' }),
    item('blank-a', { title: '' }), item('blank-b', { title: '' })];
  assert.ok(groupItemsByDisplayTitle(items).every((row) => row.kind === 'item'));
});

test('a single search match stays a directly actionable result', () => {
  const matched = item('keys');
  assert.deepEqual(groupItemsByDisplayTitle([matched]), [{ kind: 'item', item: matched }]);
});

test('display grouping preserves distinguishing query, fragment and protocol URLs', () => {
  const urls = ['https://gpt.example.com/view?id=a', 'https://gpt.example.com/view?id=b',
    'https://gpt.example.com/view#details', 'http://gpt.example.com/view#details'];
  const rows = groupItemsByDisplayTitle(urls.map((url) => item('', { url })));
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].items.map((member) => member.url), urls);
});

test('renaming or pinning a member removes only that member from the collapsed bucket', () => {
  const a = item('a');
  const b = item('b');
  const c = item('c');
  const oldKey = groupItemsByDisplayTitle([a, b, c])[0].key;
  const rows = groupItemsByDisplayTitle([{ ...a, isPinned: true }, b, c]);
  assert.equal(rows[0].kind, 'item');
  assert.equal(rows[1].key, oldKey);
  assert.deepEqual(rows[1].items, [b, c]);
});

test('simplified URLs retain paths, every query parameter and fragments', () => {
  const choices = describeLinkChoices([
    item('explore?channel_id=homefeed_recommend'), item('explore'),
    item('user/profile/123'), item('explore?app_platform=ios&channel_id='),
    item('app#/models?tab=usage')
  ]);
  assert.deepEqual(choices.map((choice) => choice.label + choice.secondary), [
    '/explore?channel_id=homefeed_recommend', '/explore', '/user/profile/123',
    '/explore?app_platform=ios&channel_id=', '/app#/models?tab=usage'
  ]);
});

test('simplified URLs preserve parameter order, repeated values and encoded delimiters', () => {
  assert.deepEqual(describeLinkChoices([item('a%2Fb?filter=a&filter=b&empty=#notes')]),
    [{ label: '/a%2Fb', secondary: '?filter=a&filter=b&empty=#notes' }]);
});

test('different origins remain visible and credentials are hidden but distinguishable', () => {
  const items = [{ url: 'https://alice:one@example.com/a?token=one' },
    { url: 'http://bob:two@example.com/a?token=two' }];
  const choices = describeLinkChoices(items);
  assert.match(choices[0].label, /^https:\/\/example.com/);
  assert.match(choices[1].label, /^http:\/\/example.com/);
  assert.doesNotMatch(JSON.stringify(choices), /alice|bob|one|two/);
  assert.equal(new Set(choices.map((choice) => choice.label + choice.secondary)).size, 2);
});

test('query and hash credentials are redacted without hiding ordinary parameters', () => {
  const choices = describeLinkChoices([item('app?%74oken=secret&lang=zh#/view?api_key=private&tab=files')]);
  assert.doesNotMatch(choices[0].secondary, /secret|private/);
  assert.match(choices[0].secondary, /lang=zh/);
  assert.match(choices[0].secondary, /tab=files/);
});

test('simplifying URLs preserves frozen inputs and order', () => {
  const items = Object.freeze([item('models/z?id=last'), item('models/a?id=first')]);
  const before = JSON.stringify(items);
  assert.deepEqual(describeLinkChoices(items).map((choice) => choice.label + choice.secondary),
    ['/models/z?id=last', '/models/a?id=first']);
  assert.equal(JSON.stringify(items), before);
  assert.deepEqual(describeLinkChoices([]), []);
});

test('invalid addresses remain displayable', () => {
  const addresses = ['bad address', '/relative/path', '', 42, null, undefined];
  assert.deepEqual(describeLinkChoices(addresses.map((url) => ({ url }))),
    addresses.map((url) => ({ label: String(url ?? ''), secondary: '' })));
});


test('expanded choices use recorded page titles and retain the simplified address below', () => {
  const choices = describeLinkChoices([
    { url: 'https://example.com/wiki/123?view=edit', title: 'Docs', historyTitle: '接口设计文档' },
    { url: 'https://example.com/wiki/456', title: 'Docs', originalTitle: '部署指南' },
    { url: 'https://example.com/wiki/789', title: 'Docs' }
  ], { groupTitle: 'Docs' });
  assert.deepEqual(choices, [
    { label: '接口设计文档', secondary: '/wiki/123?view=edit', isPageTitle: true },
    { label: '部署指南', secondary: '/wiki/456', isPageTitle: true },
    { label: '/wiki/789', secondary: '' }
  ]);
});

test('expanded choices never promote URLs or unrelated search aliases to titles', () => {
  assert.deepEqual(describeLinkChoices([{ url: 'https://example.com/wiki/123', title: 'Docs',
    historyTitle: 'https://example.com/wiki/123', searchableTitles: ['不确定的旧标题'] }], { groupTitle: 'Docs' }),
    [{ label: '/wiki/123', secondary: '' }]);
});
