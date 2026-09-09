import test from 'node:test';
import assert from 'node:assert/strict';
import { getPageIdentityKey, normalizeUrlKey } from '../src/page-identity.js';

const key = getPageIdentityKey;
const mcpRoot = 'https://cloud-ttp-us.bytedance.net/tae/mcp_server/server01';

test('nested resources, version paths and unknown views keep independent identities', () => {
  for (const [left, right] of [
    ['/projects/prj12345/tasks/task0001/overview', '/projects/prj12345/tasks/task0002/overview'],
    ['/projects/prj12345/members/alice', '/projects/prj12345/members/bob'],
    ['/docs/python3/classes', '/docs/python3/functions'],
    ['/projects/prj12345/overview', '/projects/prj12345/settings'],
    ['/docs', '/docs/']
  ]) assert.notEqual(key(`https://example.com${left}`), key(`https://example.com${right}`));
});

test('unknown query parameters retain resource and search intent', () => {
  for (const [left, right] of [
    ['https://www.youtube.com/watch?v=alpha', 'https://www.youtube.com/watch?v=beta'],
    ['https://example.com/search?q=alpha', 'https://example.com/search?q=beta'],
    ['https://example.com/tasks/123456?env=prod', 'https://example.com/tasks/123456?env=ppe'],
    ['https://example.com/detail?taskId=123', 'https://example.com/detail?task_id=123']
  ]) assert.notEqual(key(left), key(right));
});

test('unknown fragments remain distinct in both normalization stages', () => {
  for (const normalize of [normalizeUrlKey, key]) {
    assert.notEqual(normalize('https://mail.google.com/mail/u/0/#inbox/a'), normalize('https://mail.google.com/mail/u/0/#inbox/b'));
    assert.notEqual(normalize('https://example.com/#/tasks/a'), normalize('https://example.com/#/tasks/b'));
    assert.notEqual(normalize('https://example.com/docs#one'), normalize('https://example.com/docs#two'));
  }
});

test('MCP tools and inspector are views of the same server on supported hosts', () => {
  assert.equal(key(`${mcpRoot}/tools`), mcpRoot);
  assert.equal(key(`${mcpRoot}/inspector`), mcpRoot);
  assert.equal(key(`${mcpRoot}/`), mcpRoot);
  assert.notEqual(key(`${mcpRoot}/tools/tool01`), mcpRoot);
  assert.notEqual(key(`${mcpRoot}/tools?task_id=1`), key(`${mcpRoot}/tools?task_id=2`));
  assert.notEqual(key('https://example.com/tae/mcp_server/server01/tools'), key('https://example.com/tae/mcp_server/server01/inspector'));
});

test('known MCP hash routes preserve shell context and child resources', () => {
  const shell = 'https://cloud-ttp-us.bytedance.net/?env=prod';
  assert.equal(key(`${shell}#/tae/mcp_server/server01/tools`), `${shell}#/tae/mcp_server/server01`);
  assert.equal(key(`${shell}#!/tae/mcp_server/server01/inspector`), `${shell}#!/tae/mcp_server/server01`);
  assert.notEqual(key(`${shell}#/tae/mcp_server/server01/tools`), key(`${shell}#/tae/mcp_server/server02/tools`));
});

test('Feishu document identity uses route and token across tenant domains', () => {
  const token = 'AlphaToken'; // Tokens do not need a digit to be valid resource identifiers.
  const expected = `https://feishu.cn/wiki/${token}`;
  assert.equal(key(`https://my.feishu.cn/wiki/${token}?from=recent#heading`), expected);
  assert.equal(key(`https://tenant.feishu.cn/wiki/${token}?open_in_browser=true&create_from=create_doc_to_wiki`), expected);
  assert.notEqual(key(`https://tenant.feishu.cn/docx/${token}`), expected);
  assert.notEqual(key(`https://tenant.feishu.cn/wiki/${token}/children/child01`), expected);
  assert.notEqual(key(`https://example.com/wiki/${token}?from=recent`), key(`https://example.com/wiki/${token}`));
});

test('Feishu bases and sheets preserve child resource parameters', () => {
  assert.notEqual(key('https://tenant.feishu.cn/base/base01?table=tableA'), key('https://tenant.feishu.cn/base/base01?table=tableB'));
  assert.notEqual(key('https://tenant.feishu.cn/sheets/sheet01#sheetA'), key('https://tenant.feishu.cn/sheets/sheet01#sheetB'));
});

test('Google search keeps the existing query identity rule', () => {
  assert.equal(key('https://www.google.com.hk/search?q=kv%20cache&source=chrome&start=10'), 'https://www.google.com.hk/search?q=kv+cache');
  assert.notEqual(key('https://www.google.com/search?q=alpha'), key('https://www.google.com/search?q=beta'));
});

test('normalization removes tracking without decoding reserved path characters', () => {
  assert.equal(key('https://EXAMPLE.com/a?b=2&utm_source=mail&a=1'), 'https://example.com/a?a=1&b=2');
  for (const reserved of ['2F', '3F', '23', '25']) {
    assert.notEqual(key(`https://example.com/a%${reserved}b/doc1234`), key(`https://example.com/a%25${reserved}b/doc1234`));
  }
});

test('identity keys are idempotent and tolerate non-web or malformed URLs', () => {
  for (const url of [
    `${mcpRoot}/tools`, 'https://tenant.feishu.cn/wiki/AlphaToken?from=recent',
    'https://example.com/a%2Fb/doc1234?resource=1#detail',
    'https://example.com/a%252Fb/doc1234', 'file:///tmp/report.html#section',
    'not a url'
  ]) assert.equal(key(key(url)), key(url));
});
