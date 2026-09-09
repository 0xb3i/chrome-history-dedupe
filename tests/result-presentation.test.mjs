import assert from 'node:assert/strict';
import test from 'node:test';
import { describeLinkDifferences, groupItemsByDisplayTitle } from '../src/result-presentation.js';

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

test('long credential variants expose the actual difference without dumping tokens into rows', () => {
  const tokenA = 'a'.repeat(800);
  const tokenB = 'b'.repeat(800);
  const items = Object.freeze([item('wiki/document'),
    item(`wiki/document?disposable_login_token=${tokenA}`),
    item(`wiki/document?disposable_login_token=${tokenB}`)]);
  const view = describeLinkDifferences(items);
  assert.equal(view.sharedAddress, 'https://gpt.example.com/wiki/document');
  assert.equal(view.summary, '差异：登录凭证');
  assert.deepEqual(view.variants.map((row) => row.differences[0].value), ['无', '值 1', '值 2']);
  assert.equal(view.variants[1].differences[0].detail, tokenA);
  assert.equal(view.variants[2].differences[0].detail, tokenB);
  assert.equal(items[1].url, `https://gpt.example.com/wiki/document?disposable_login_token=${tokenA}`);
});

test('path comparisons remove shared segments but retain readable destinations', () => {
  const view = describeLinkDifferences([item('app/models'), item('app/usage')]);
  assert.equal(view.sharedAddress, 'https://gpt.example.com/app/…');
  assert.equal(view.sharedLabel, '共同路径');
  assert.deepEqual(view.variants.map((row) => row.differences[0].value), ['…/models', '…/usage']);
  const parent = describeLinkDifferences([item('app'), item('app/usage')]);
  assert.equal(parent.variants[0].differences[0].value, '/app');
});

test('common query values are omitted while changed, missing and empty values remain distinct', () => {
  const view = describeLinkDifferences([item('view?lang=zh&id=one'),
    item('view?lang=zh&id=two'), item('view?lang=zh'), item('view?lang=zh&id=')]);
  assert.equal(view.summary, '差异：id');
  assert.deepEqual(view.variants.map((row) => row.differences[0].value), ['one', 'two', '无', '（空值）']);
});

test('protocol, port, path, parameter and fragment differences can coexist', () => {
  const view = describeLinkDifferences([item('a?id=one#summary'),
    item('', { url: 'http://gpt.example.com:8080/b?id=two#detail' })]);
  assert.deepEqual(view.variants[1].differences.map((diff) => diff.label),
    ['协议', '主机', '路径', 'id', '页面片段']);
  assert.deepEqual(view.variants[1].differences.map((diff) => diff.detail),
    ['http:', 'gpt.example.com:8080', '/b', 'two', '#detail']);
});

test('credential labels are shared for equal values and separate for different fields', () => {
  const view = describeLinkDifferences([item('a?token=abc'), item('b?token=abc'), item('b?token=def')]);
  assert.deepEqual(view.variants.map((row) => row.differences[1].value), ['值 1', '值 1', '值 2']);
  const multiple = describeLinkDifferences([item('a?token=a&session=b'), item('a?token=b&session=c')]);
  assert.deepEqual(multiple.variants[0].differences.map((diff) => diff.label), ['参数 token', '参数 session']);
});

test('decoded paths are readable but do not hide encoding-only differences', () => {
  const readable = describeLinkDifferences([item('app/%E6%A8%A1%E5%9E%8B'), item('app/usage')]);
  assert.equal(readable.variants[0].differences[0].value, '…/模型');
  const encoded = describeLinkDifferences([item('%61'), item('a')]);
  assert.notEqual(encoded.variants[0].differences[0].value, encoded.variants[1].differences[0].value);
  assert.doesNotThrow(() => describeLinkDifferences([item('%broken'), item('a')]));
});

test('query ordering and invalid addresses remain distinguishable', () => {
  const ordered = describeLinkDifferences([item('a?x=1&y=2'), item('a?y=2&x=1')]);
  assert.equal(ordered.summary, '差异：地址写法');
  assert.deepEqual(ordered.variants.map((row) => row.differences[0].value), ['值 1', '值 2']);
  const invalid = describeLinkDifferences([{ url: 'bad address a' }, { url: 'bad address b' }]);
  assert.equal(invalid.sharedAddress, '');
  assert.equal(invalid.variants[1].differences[0].detail, 'bad address b');
  assert.deepEqual(describeLinkDifferences([]).variants, []);
});

test('repeated query parameters and literal absence text cannot look identical', () => {
  for (const paths of [['a?x=one&x=two', 'a?x=one%20%2F%20two'],
    ['a?x=无', 'a'], ['a?x=', 'a?x=（空值）']]) {
    const view = describeLinkDifferences(paths.map((path) => item(path)));
    assert.notEqual(view.variants[0].differences[0].value, view.variants[1].differences[0].value);
  }
});

test('long business values retain a short preview and an unambiguous value marker', () => {
  const prefix = 'prefix'.repeat(20);
  const suffix = 'suffix'.repeat(20);
  const view = describeLinkDifferences([item(`a?id=${prefix}A${suffix}`), item(`a?id=${prefix}B${suffix}`)]);
  const values = view.variants.map((row) => row.differences[0].value);
  assert.ok(values.every((value) => value.length < 45));
  assert.notEqual(values[0], values[1]);
  assert.equal(view.variants[1].differences[0].detail, `${prefix}B${suffix}`);
});
