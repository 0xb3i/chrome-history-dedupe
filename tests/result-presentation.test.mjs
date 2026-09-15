import assert from 'node:assert/strict';
import test from 'node:test';
import { describeLinkChoices, groupItemsByDisplayTitle } from '../src/result-presentation.js';

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

test('known merge request tabs explain the destination within the same request', () => {
  for (const host of ['code.byted.org', 'gitlab.com']) {
    const urls = ['', '/diffs', '/commits'].map((suffix) =>
      item('', { url: `https://${host}/team/repo/merge_requests/335${suffix}` }));
    assert.deepEqual(describeLinkChoices(urls), [
      { label: '概览', secondary: '' },
      { label: '文件变更', secondary: '' },
      { label: '提交记录', secondary: '' }
    ]);
  }
});

test('different merge request IDs retain the identifying route', () => {
  const urls = ['335/diffs', '336/diffs'].map((suffix) =>
    item('', { url: `https://code.byted.org/team/repo/merge_requests/${suffix}` }));
  assert.deepEqual(describeLinkChoices(urls), [
    { label: '335/diffs', secondary: '' },
    { label: '336/diffs', secondary: '' }
  ]);
});

test('unknown sites and unknown tab routes never receive invented page names', () => {
  assert.deepEqual(describeLinkChoices([
    item('team/repo/merge_requests/335/diffs'), item('team/repo/merge_requests/335/commits')
  ]), [{ label: 'diffs', secondary: '' }, { label: 'commits', secondary: '' }]);
  const urls = ['diffs', 'pipeline/details'].map((suffix) =>
    item('', { url: `https://code.byted.org/team/repo/merge_requests/335/${suffix}` }));
  assert.deepEqual(describeLinkChoices(urls), [
    { label: '文件变更', secondary: '' }, { label: 'pipeline/details', secondary: '' }
  ]);
});

test('relative paths remove shared directories without cutting different IDs or adding query noise', () => {
  const prefix = 'long/shared/model-access/';
  assert.deepEqual(describeLinkChoices([
    item(`${prefix}GEC-335/details?scene_keyword=model&token=first`),
    item(`${prefix}GEC-336/details?scene_keyword=other&token=second`)
  ]), [
    { label: 'GEC-335/details', secondary: '' },
    { label: 'GEC-336/details', secondary: '' }
  ]);
});

test('parent pages and root pages remain visible beside their children', () => {
  for (const prefix of ['', 'models']) {
    const choices = describeLinkChoices([item(prefix), item(`${prefix ? `${prefix}/` : ''}details`)]);
    assert.equal(choices[0].label, '页面入口');
    assert.deepEqual(choices[1], { label: 'details', secondary: '' });
  }
});

test('long identifying segments remain complete rather than being independently abbreviated', () => {
  const identifier = 'a'.repeat(200);
  assert.deepEqual(describeLinkChoices([
    item(`models/${identifier}/details`), item('models/other/details')
  ]), [
    { label: `${identifier}/details`, secondary: '' },
    { label: 'other/details', secondary: '' }
  ]);
});

test('same-path choices show the useful query field and omit repeated or redundant state', () => {
  assert.deepEqual(describeLinkChoices([
    item('view?tab=overview&scene_keyword=model&timestamp=100'),
    item('view?tab=files&scene_keyword=model&timestamp=200')
  ]), [{ label: 'tab：overview', secondary: '' }, { label: 'tab：files', secondary: '' }]);
});

test('only colliding route labels need additional query information', () => {
  assert.deepEqual(describeLinkChoices([
    item('models?id=1'), item('models?id=2'), item('dashboard?id=3')
  ]), [
    { label: 'models', secondary: 'id：1' },
    { label: 'models', secondary: 'id：2' },
    { label: 'dashboard', secondary: '' }
  ]);
});

test('query descriptions distinguish missing values, empty values and repeated keys', () => {
  assert.deepEqual(describeLinkChoices([
    item('view'), item('view?filter='), item('view?filter=a&filter=b'), item('view?filter=a')
  ]), [
    { label: 'filter：未指定', secondary: '' },
    { label: 'filter：（空值）', secondary: '' },
    { label: 'filter：["a","b"]', secondary: '' },
    { label: 'filter：a', secondary: '' }
  ]);
});

test('multiple independent query fields are retained when both are necessary to choose', () => {
  const choices = describeLinkChoices([
    item('view?tab=files&id=1'), item('view?tab=files&id=2'), item('view?tab=commits&id=1')
  ]);
  assert.equal(new Set(choices.map((choice) => JSON.stringify(choice))).size, 3);
  assert.match(choices[0].label, /tab：files/);
  assert.match(choices[0].label, /id：1/);
  assert.match(choices[1].label, /id：2/);
  assert.match(choices[2].label, /tab：commits/);
  choices.forEach((choice) => assert.equal(choice.secondary, ''));
});

test('hash routes retain their destination and hash queries can distinguish equal routes', () => {
  assert.deepEqual(describeLinkChoices([
    item('app?lang=zh#/models'), item('app?lang=zh#/usage')
  ]), [{ label: '#/models', secondary: '' }, { label: '#/usage', secondary: '' }]);
  assert.deepEqual(describeLinkChoices([
    item('app#/models?tab=details'), item('app#/models?tab=usage')
  ]), [
    { label: '片段参数 tab：details', secondary: '' },
    { label: '片段参数 tab：usage', secondary: '' }
  ]);
});

test('hash routes drop common directories and do not add noise to already distinct paths', () => {
  assert.deepEqual(describeLinkChoices([
    item('app#/long/shared/models'), item('app#/long/shared/usage')
  ]), [{ label: '#/models', secondary: '' }, { label: '#/usage', secondary: '' }]);
  assert.deepEqual(describeLinkChoices([
    item('models#notes'), item('dashboard#summary')
  ]), [{ label: 'models', secondary: '' }, { label: 'dashboard', secondary: '' }]);
});

test('Chinese paths are readable while encoded route delimiters and malformed encodings remain intact', () => {
  assert.deepEqual(describeLinkChoices([
    item('app/%E6%A8%A1%E5%9E%8B'), item('app/a%2Fb%3Fc%23d'), item('app/%broken')
  ]), [
    { label: '模型', secondary: '' },
    { label: 'a%2Fb%3Fc%23d', secondary: '' },
    { label: '%broken', secondary: '' }
  ]);
  assert.deepEqual(describeLinkChoices([
    item('app#/%E8%AF%A6%E6%83%85'), item('app#/%broken')
  ]), [{ label: '#/详情', secondary: '' }, { label: '#/%broken', secondary: '' }]);
});

test('protocol and port differences remain distinguishable within a hostname bucket', () => {
  const urls = ['https://gpt.example.com/view', 'http://gpt.example.com/view',
    'https://gpt.example.com:8443/view'].map((url) => item('', { url }));
  const choices = describeLinkChoices(urls);
  assert.equal(new Set(choices.map((choice) => JSON.stringify(choice))).size, urls.length);
  assert.match(choices[0].label, /https/);
  assert.match(choices[1].label, /http/);
  assert.match(choices[2].label, /8443/);
});

test('credential-only differences are identified without showing credential values', () => {
  for (const urls of [
    [item('view?token=secret-one'), item('view?token=secret-two')],
    [item('app#/?api_key=secret-one'), item('app#/?api_key=secret-two')],
    [item('', { url: 'https://alice:secret-one@gpt.example.com/view' }),
      item('', { url: 'https://bob:secret-two@gpt.example.com/view' })]
  ]) {
    const choices = describeLinkChoices(urls);
    assert.equal(new Set(choices.map((choice) => JSON.stringify(choice))).size, 2);
    assert.doesNotMatch(JSON.stringify(choices), /secret-one|secret-two|alice|bob/);
    assert.match(JSON.stringify(choices), /已隐藏/);
  }
});

test('large credential groups keep stable hidden labels with bounded serialization work', (t) => {
  const size = 1000;
  const items = Array.from({ length: size }, (_, index) =>
    item(`view?token=secret-${String(index).padStart(5, '0')}`));
  const stringify = JSON.stringify;
  let credentialSerializations = 0;
  t.mock.method(JSON, 'stringify', (value, ...args) => {
    if (Array.isArray(value) && String(value[0]).startsWith('secret-')) credentialSerializations += 1;
    return stringify(value, ...args);
  });
  const choices = describeLinkChoices([...items].reverse());
  assert.ok(credentialSerializations < size * 10,
    `credential serialization should scale linearly, received ${credentialSerializations}`);
  assert.equal(choices.length, size);
  choices.forEach((choice, index) => assert.deepEqual(choice, {
    label: `token：已隐藏 ${size - index}`, secondary: ''
  }));
  const repeated = describeLinkChoices([items[1], item('view'), items[0], items[1]]);
  assert.deepEqual(repeated.map((choice) => choice.label), [
    'token：已隐藏 2', 'token：未指定', 'token：已隐藏 1', 'token：已隐藏 2'
  ]);
});

test('decoded path collisions and equivalent query spellings remain distinguishable without invented destinations', () => {
  const paths = describeLinkChoices([item('app/a'), item('app/%61')]);
  assert.deepEqual(paths, [
    { label: 'a', secondary: '路径：/app/a' },
    { label: 'a', secondary: '路径：/app/%61' }
  ]);
  const ordered = describeLinkChoices([item('view?a=1&b=2'), item('view?b=2&a=1')]);
  assert.equal(new Set(ordered.map((choice) => JSON.stringify(choice))).size, 2);
  ordered.forEach((choice) => assert.match(choice.label, /^地址写法 \d+$/));
});

test('describing choices preserves frozen inputs, URLs and their existing order', () => {
  const items = Object.freeze([item('models/z?id=last'), item('models/a?id=first')]);
  const before = JSON.stringify(items);
  assert.deepEqual(describeLinkChoices(items), [
    { label: 'z', secondary: '' }, { label: 'a', secondary: '' }
  ]);
  assert.equal(JSON.stringify(items), before);
  assert.deepEqual(describeLinkChoices([]), []);
});

test('invalid and absent addresses remain displayable without throwing', () => {
  const addresses = ['bad address?original=true', '/relative/path', '', 42, null, undefined];
  assert.deepEqual(describeLinkChoices(addresses.map((url) => ({ url }))),
    addresses.map((url) => ({ label: String(url ?? ''), secondary: '' })));
});
