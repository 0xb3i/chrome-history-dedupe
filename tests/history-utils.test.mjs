import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyCapturedTitlesToItems,
  applyPinnedStateToGroups,
  compareHistoryItemsByVisits,
  compareHistoryItems,
  dedupeHistoryItems,
  filterHistoryItemsByQuery,
  formatHistoryUrlForGroup,
  getHistoryItemCapturedTitleKey,
  getHistoryItemComparator,
  getHistoryItemPinKey,
  getHistoryItemTitleOverrideKey,
  groupHistoryItems,
  normalizeHistoryKey,
  normalizeSortOrder,
  prepareHistoryItemsForSearch
} from '../src/history-utils.js';
import { projectPageItems } from '../src/history-index/project.js';
import { normalizePageTitleOverrideMap } from '../src/storage.js';

function projectHistoryItems(items, overrides = new Map()) {
  const urlItems = dedupeHistoryItems(items, 'normalized-url');
  const pageItems = dedupeHistoryItems(urlItems, 'page-family');
  return projectPageItems(pageItems, normalizePageTitleOverrideMap(overrides));
}

test('usage ranking orders lifetime visits, recency and stable keys without search preferences', () => {
  const items = Object.freeze([
    Object.freeze({ url: 'https://example.com/low', totalVisitCount: 1, lastVisitTime: 999,
      searchMatch: { score: 500 }, isPinned: true }),
    Object.freeze({ url: 'https://example.com/high-old', totalVisitCount: '10', lastVisitTime: 100 }),
    Object.freeze({ url: 'https://example.com/high-b', visitCount: 10, lastVisitTime: 200 }),
    Object.freeze({ url: 'https://example.com/high-a', totalVisitCount: 10, visitCount: 999, lastVisitTime: 200 }),
    Object.freeze({ url: 'https://example.com/zero', totalVisitCount: 0, visitCount: 999 }),
    Object.freeze({ url: 'https://example.com/missing' })
  ]);
  const sorted = [...items].sort(compareHistoryItemsByVisits);
  assert.deepEqual(sorted.map((item) => item.url.split('/').at(-1)),
    ['high-a', 'high-b', 'high-old', 'low', 'missing', 'zero']);
  assert.equal(items[0].url, 'https://example.com/low');
});

test('explicit sorting uses visits, recency or natural display names while preserving pin order', () => {
  const items = [
    { id: 'match', title: 'Zulu', visitCount: 1, lastVisitTime: 10, searchMatch: { score: 100 } },
    { id: 'rename', title: 'Beta', visitCount: 2, lastVisitTime: 20, isTitleRenamed: true },
    { id: 'heavy', title: 'Agent 10', totalVisitCount: 100, visitCount: 1, lastVisitTime: 30 },
    { id: 'new', title: 'agent 2', visitCount: 3, lastVisitTime: 100 },
    { id: 'pin-second', title: 'A', visitCount: 999, lastVisitTime: 999, isPinned: true, pinOrder: 1 },
    { id: 'pin-first', title: 'Z', visitCount: 0, lastVisitTime: 0, isPinned: true, pinOrder: 0 }
  ].map((item) => Object.freeze({ ...item, url: `https://example.com/${item.id}` }));
  const expected = {
    default: ['match', 'rename', 'heavy', 'new'],
    visits: ['heavy', 'new', 'rename', 'match'],
    recent: ['new', 'heavy', 'rename', 'match'],
    name: ['new', 'heavy', 'rename', 'match']
  };
  for (const [sortOrder, ids] of Object.entries(expected)) {
    for (const input of [items, [...items].reverse()]) {
      assert.deepEqual([...input].sort(getHistoryItemComparator(sortOrder)).map((item) => item.id),
        ['pin-first', 'pin-second', ...ids]);
    }
  }
  for (const invalid of [undefined, null, '', 'unknown', 'toString', {}]) {
    assert.equal(normalizeSortOrder(invalid), 'default');
    assert.equal(getHistoryItemComparator(invalid), compareHistoryItems);
  }
});

test('name sorting uses Chinese collation and resolves equal names by visits and stable keys', () => {
  const items = [
    { id: 'z', title: '阿里', visitCount: 2, lastVisitTime: 999 },
    { id: 'a', title: '阿里', visitCount: 2, lastVisitTime: 1 },
    { id: 'heavy', title: '阿里', totalVisitCount: 3 },
    { id: 'baidu', title: '百度', visitCount: 999 },
    { id: 'numeric-ten', title: '版本 10' },
    { id: 'numeric-two', title: '版本 2' }
  ].map((item) => ({ ...item, url: `https://example.com/${item.id}` }));
  for (const input of [items, [...items].reverse()]) {
    assert.deepEqual(input.sort(getHistoryItemComparator('name')).map((item) => item.id),
      ['heavy', 'a', 'z', 'baidu', 'numeric-two', 'numeric-ten']);
  }
  assert.ok(getHistoryItemComparator('name')(
    { title: '', url: 'https://a.example/' }, { title: 'https://b.example/' }
  ) < 0);
});

test('each sort order ranks groups by their best member and reapplies the same order after unpinning', () => {
  const items = [
    { id: 'a-heavy', url: 'https://a.example/heavy', title: 'Beta', totalVisitCount: 100, lastVisitTime: 10 },
    { id: 'a-name', url: 'https://a.example/name', title: 'Alpha', totalVisitCount: 1, lastVisitTime: 20 },
    { id: 'b-new', url: 'https://b.example/new', title: 'Gamma', totalVisitCount: 10, lastVisitTime: 100 },
    { id: 'c-name', url: 'https://c.example/name', title: 'Aardvark', totalVisitCount: 50, lastVisitTime: 50 }
  ];
  const expected = {
    visits: ['a-heavy', 'c-name', 'b-new'],
    recent: ['b-new', 'c-name', 'a-name'],
    name: ['c-name', 'a-name', 'b-new']
  };
  for (const [sortOrder, ids] of Object.entries(expected)) {
    const groups = groupHistoryItems(items, sortOrder);
    assert.deepEqual(groups.map((group) => group.items[0].id), ids);
    const pinned = applyPinnedStateToGroups(groups,
      ['https://b.example/new', 'https://a.example/name'], sortOrder);
    assert.deepEqual(pinned.map((group) => group.items[0].id), ['b-new', 'a-name', 'c-name']);
    const unpinned = applyPinnedStateToGroups(pinned, [], sortOrder);
    assert.deepEqual(unpinned.map((group) => group.items[0].id), ids);
    assert.deepEqual(unpinned.find((group) => group.key === 'a.example').items.map((item) => item.id),
      sortOrder === 'visits' ? ['a-heavy', 'a-name'] : ['a-name', 'a-heavy']);
  }
});

test('normalized URL mode collapses repeat visits and keeps the latest item', () => {
  const older = {
    id: 'older',
    title: 'Older A',
    url: 'https://Example.com/a?utm_source=newsletter&b=2',
    lastVisitTime: 100,
    visitCount: 1
  };
  const newer = {
    id: 'newer',
    title: 'Newer A',
    url: 'https://example.com/a?b=2&utm_campaign=spring',
    lastVisitTime: 200,
    visitCount: 3
  };

  const [result] = dedupeHistoryItems([older, newer], 'normalized-url');

  assert.equal(result.id, 'newer');
  assert.equal(result.dedupeCount, 2);
  assert.equal(result.dedupeKey, 'https://example.com/a?b=2');
});

test('two-stage dedupe merges one normalized URL before comparing resource identities', () => {
  const url =
    'https://dataleap-tx.tiktok-row.net/coral/datamap/result?query=i18n_ecom_alliance.ods_agent_trajectory_segments';
  const urlDedupedItems = dedupeHistoryItems(
    [
      { id: 'old-title', title: 'ods_agent_trajectory_segments', url, visitCount: 3 },
      { id: 'new-title', title: 'DataLeap - 数据地图', url, visitCount: 11 }
    ],
    'normalized-url'
  );
  const results = dedupeHistoryItems(urlDedupedItems, 'page-family');

  assert.equal(results.length, 1);
  assert.equal(results[0].totalVisitCount, 14);
});

test('normalized URL mode strips common tracking parameters but preserves meaningful parameters', () => {
  const key = normalizeHistoryKey(
    {
      url: 'https://example.com/search?q=chrome&utm_medium=email&fbclid=abc&sort=recent'
    },
    'normalized-url'
  );

  assert.equal(key, 'https://example.com/search?q=chrome&sort=recent');
});

test('two-stage URL and resource dedupe keep DataLeap detail and search-result pages distinct', () => {
  const detailUrl =
    'https://dataleap-tx.tiktok-row.net/coral/datamap/detail?groupName=og&qualifiedName=HiveTable%3A%2F%2F%2Fi18n_ecom_alliance%2Fods_agent_trajectory_segments%409&subTab=schema&tab=table_info#group=og';
  const resultUrl =
    'https://dataleap-tx.tiktok-row.net/coral/datamap/result?query=i18n_ecom_alliance.ods_agent_trajectory_segments';
  const results = dedupeHistoryItems(
    [
      { id: 'detail', title: 'ods_agent_trajectory_segments', url: detailUrl },
      { id: 'result', title: 'ods_agent_trajectory_segments', url: resultUrl }
    ],
    'normalized-url'
  );

  assert.equal(results.length, 2);
  assert.deepEqual(new Set(results.map((item) => item.url)), new Set([detailUrl, resultUrl]));

  const pageResults = dedupeHistoryItems(results, 'page-family');
  assert.equal(pageResults.length, 2);
  assert.deepEqual(
    new Set(pageResults.map((item) => item.url)),
    new Set([detailUrl, resultUrl])
  );
});

test('invalid URLs fall back to their raw URL string', () => {
  const key = normalizeHistoryKey({ url: 'not a valid url' }, 'normalized-url');

  assert.equal(key, 'not a valid url');
});

test('resource identity collapses same live-title tabs of one stable resource', () => {
  const results = dedupeHistoryItems(
    applyCapturedTitlesToItems([
      {
        id: 'older-high-count',
        title: 'Loading',
        url: 'https://cloud-ttp-us.bytedance.net/tae/mcp_server/4syx48fa/inspector',
        lastVisitTime: 200,
        visitCount: 12
      },
      {
        id: 'newer-low-count',
        title: 'Loading',
        url: 'https://cloud-ttp-us.bytedance.net/tae/mcp_server/4syx48fa/tools',
        lastVisitTime: 400,
        visitCount: 3
      }
    ], new Map([
      ['https://cloud-ttp-us.bytedance.net/tae/mcp_server/4syx48fa', 'MCP Inspector']
    ])),
    'page-family'
  );

  assert.equal(results.length, 1);
  assert.equal(results[0].id, 'older-high-count');
  assert.equal(
    results[0].dedupeKey,
    'https://cloud-ttp-us.bytedance.net/tae/mcp_server/4syx48fa'
  );
  assert.equal(results[0].dedupeCount, 2);
  assert.equal(results[0].totalVisitCount, 15);
});

test('resource identity keeps unrelated resources with the same original title distinct', () => {
  const results = dedupeHistoryItems(
    [
      {
        id: 'docs-a',
        title: 'Docs',
        url: 'https://docs.example.com/doc/abc12345?tab=content'
      },
      {
        id: 'docs-b',
        title: 'Docs',
        url: 'https://docs.example.com/doc/xyz98765?tab=content'
      }
    ],
    'page-family'
  );

  assert.equal(results.length, 2);
});

test('resource identity preserves unknown query variants even with equal titles', () => {
  const results = dedupeHistoryItems(
    [
      {
        id: 'release-overview',
        title: '代码发布管理 US-TTP BDEE - 字节云',
        url: 'https://cloud.example.com/release-management?activeTab=overview&view=summary',
        visitCount: 2
      },
      {
        id: 'release-instances',
        title: '代码发布管理 US-TTP BDEE - 字节云',
        url: 'https://cloud.example.com/release-management?activeTab=instances&timestamp=123',
        visitCount: 3
      }
    ],
    'page-family'
  );

  assert.equal(results.length, 2);
  assert.deepEqual(results.map((item) => item.totalVisitCount), [3, 2]);
});

test('page family mode keeps environment-specific results and their manual rename', () => {
  const url1 =
    'https://cloud-ttp-us.bytedance.net/tcc/namespace/bytedance.mcp.ecom_affiliate_tools?by_key=false&condition=name&configId=&dir_path=all_dir&env=ppe_product_selection_niubei&filter_empty_dir=false&filter_no_tag=false&keyword=&order=&pn=1&region=all_region&release_operator=&release_status=&rn=20&scope=all&source=&tab=';
  const url2 =
    'https://cloud-ttp-us.bytedance.net/tcc/namespace/bytedance.mcp.ecom_affiliate_tools?by_key=false&condition=name&configId=&dir_path=all_dir&env=prod&filter_empty_dir=false&filter_no_tag=false&keyword=&order=&pn=1&region=all_region&release_operator=&release_status=&rn=20&scope=all&source=&tab=';
  const capturedTitle = 'TCC 配置管理 - 字节云';
  const items = projectHistoryItems(
    [
      {
        id: 'ppe',
        title: capturedTitle,
        url: url1,
        lastVisitTime: 100,
        visitCount: 1
      },
      {
        id: 'prod',
        title: capturedTitle,
        url: url2,
        lastVisitTime: 200,
        visitCount: 20
      }
    ],
    new Map([[normalizeHistoryKey({ url: url1 }, 'normalized-url'), 'TCC PPE 配置']])
  );
  const urlDedupedItems = dedupeHistoryItems(items, 'normalized-url');
  const results = dedupeHistoryItems(urlDedupedItems, 'page-family');
  assert.equal(results.length, 2);
  const result = results.find((item) => item.id === 'ppe');

  assert.equal(result.id, 'ppe');
  assert.equal(result.title, 'TCC PPE 配置');
  assert.equal(result.totalVisitCount, 1);
  assert.equal(result.dedupeCount, 1);
});

test('page family mode preserves independent names for different environment URLs', () => {
  const url1 =
    'https://cloud-ttp-us.bytedance.net/tcc/namespace/bytedance.mcp.ecom_affiliate_tools?by_key=false&condition=name&configId=&dir_path=all_dir&env=ppe_product_selection_niubei&filter_empty_dir=false&filter_no_tag=false&keyword=&order=&pn=1&region=all_region&release_operator=&release_status=&rn=20&scope=all&source=&tab=';
  const url2 =
    'https://cloud-ttp-us.bytedance.net/tcc/namespace/bytedance.mcp.ecom_affiliate_tools?by_key=false&condition=name&configId=&dir_path=all_dir&env=prod&filter_empty_dir=false&filter_no_tag=false&keyword=&order=&pn=1&region=all_region&release_operator=&release_status=&rn=20&scope=all&source=&tab=';
  const capturedTitle = 'TCC 配置管理 - 字节云';
  const items = projectHistoryItems(
    [
      {
        id: 'ppe',
        title: capturedTitle,
        url: url1,
        lastVisitTime: 100,
        visitCount: 1
      },
      {
        id: 'prod',
        title: capturedTitle,
        url: url2,
        lastVisitTime: 200,
        visitCount: 20
      }
    ],
    new Map([
      [normalizeHistoryKey({ url: url1 }, 'normalized-url'), {
        title: 'TCC PPE 配置',
        targetUrl: url1,
        updatedAt: 100
      }],
      [normalizeHistoryKey({ url: url2 }, 'normalized-url'), {
        title: 'TCC Prod 配置',
        targetUrl: url2,
        updatedAt: 200
      }]
    ])
  );
  const urlDedupedItems = dedupeHistoryItems(items, 'normalized-url');
  const results = dedupeHistoryItems(urlDedupedItems, 'page-family');
  assert.equal(results.length, 2);
  assert.deepEqual(new Set(results.map((item) => item.title)), new Set(['TCC PPE 配置', 'TCC Prod 配置']));
  const result = results[0];

  assert.equal(result.id, 'prod');
  assert.equal(result.title, 'TCC Prod 配置');
  assert.equal(result.isTitleRenamed, true);
  assert.equal(result.totalVisitCount, 20);
});

test('history titles remain search-only aliases without affecting display or cross-URL dedupe', () => {
  const items = applyCapturedTitlesToItems([
    { id: 'a', title: 'Docs', url: 'https://example.com/doc/abc12345' },
    { id: 'b', title: 'Docs', url: 'https://example.com/doc/xyz98765' }
  ]);

  assert.equal(items[0].title, '');
  assert.equal(items[1].title, '');
  assert.equal(filterHistoryItemsByQuery(items, 'Docs').length, 2);
  assert.equal(dedupeHistoryItems(items, 'page-family').length, 2);
});

test('a Lark history title is searchable when live title capture is missing', () => {
  const url = 'https://bytedance.larkoffice.com/wiki/VLn7wplvtiWnFPkZWpOc4Lz5nwg';
  const [item] = prepareHistoryItemsForSearch(applyCapturedTitlesToItems([
    { title: '评估分析v2', url }
  ]));

  assert.equal(item.title, '');
  assert.deepEqual(item.normalizedSearchTitles, ['评估分析v2']);
  assert.deepEqual(
    filterHistoryItemsByQuery([item], '评估').map((result) => result.url),
    [url]
  );
});

test('resource identity falls back to normalized URL when title is empty', () => {
  const results = dedupeHistoryItems(
    [
      {
        id: 'older-empty-title',
        title: '',
        url: 'https://example.com/a?utm_source=test',
        lastVisitTime: 100,
        visitCount: 1
      },
      {
        id: 'newer-empty-title',
        title: '',
        url: 'https://example.com/a',
        lastVisitTime: 300,
        visitCount: 2
      }
    ],
    'page-family'
  );

  assert.equal(results.length, 1);
  assert.equal(results[0].id, 'newer-empty-title');
  assert.equal(results[0].dedupeKey, 'https://example.com/a');
});

test('resource identity ignores zero-width characters in titles', () => {
  const capturedKey =
    'https://bytedance.larkoffice.com/wiki/FkjVwUDZciqChskTeQcc2ATjnQb';
  const results = dedupeHistoryItems(
    applyCapturedTitlesToItems([
      {
        id: 'plain-title',
        title: 'Docs',
        url: 'https://bytedance.larkoffice.com/wiki/FkjVwUDZciqChskTeQcc2ATjnQb?open_in_browser=true',
        lastVisitTime: 100,
        visitCount: 4
      },
      {
        id: 'zero-width-title',
        title: 'Docs',
        url: 'https://bytedance.larkoffice.com/wiki/FkjVwUDZciqChskTeQcc2ATjnQb?open_in_browser=true&create_from=create_doc_to_wiki',
        lastVisitTime: 300,
        visitCount: 6
      }
    ], new Map([[
      capturedKey,
      '\u200c\u2064\u2062\u200b联盟搜索 & Agent 周报 20260603 - 20260609 - 飞书云文档'
    ]])),
    'page-family'
  );

  assert.equal(results.length, 1);
  assert.equal(results[0].id, 'zero-width-title');
  assert.equal(
    results[0].dedupeKey,
    'https://larkoffice.com/wiki/FkjVwUDZciqChskTeQcc2ATjnQb'
  );
});

test('Feishu wiki renames follow the same token across my and tenant domains', () => {
  const token = 'M1Cew0iYaiH9jfkeD5XcXEuZn3d';
  const renameUrl = `https://my.feishu.cn/wiki/${token}`;
  const historyUrl = `https://scnajei2ds6y.feishu.cn/wiki/${token}`;
  const renamedItems = projectHistoryItems(
    [{
      id: 'tenant-history-entry',
      title: '从1到∞: 多模态大模型知识面试一本通 - 飞书云文档',
      url: historyUrl,
      lastVisitTime: 100,
      visitCount: 5
    }],
    new Map([[getHistoryItemTitleOverrideKey({ url: renameUrl }), {
      title: '大模型知识面试一本通',
      targetUrl: renameUrl,
      updatedAt: 200
    }]])
  );
  const [result] = dedupeHistoryItems(renamedItems, 'page-family');

  assert.equal(getHistoryItemTitleOverrideKey({ url: renameUrl }),
    'https://feishu.cn/wiki/M1Cew0iYaiH9jfkeD5XcXEuZn3d');
  assert.equal(getHistoryItemTitleOverrideKey({ url: historyUrl }),
    'https://feishu.cn/wiki/M1Cew0iYaiH9jfkeD5XcXEuZn3d');
  assert.equal(result.title, '大模型知识面试一本通');
  assert.equal(result.isTitleRenamed, true);
  assert.deepEqual(
    filterHistoryItemsByQuery([result], '大模型').map((item) => item.id),
    ['tenant-history-entry']
  );
});

test('page family identity ignores changing tab titles and keeps a manual rename', () => {
  const pageKey = 'https://cloud-ttp-us.bytedance.net/tae/mcp_server/prj12345';
  const items = projectHistoryItems(
    [
      {
        id: 'overview',
        title: 'Project Overview',
        url: `${pageKey}/tools`,
        lastVisitTime: 300,
        visitCount: 20
      },
      {
        id: 'settings',
        title: 'Project Settings',
        url: `${pageKey}/inspector`,
        lastVisitTime: 100,
        visitCount: 1
      }
    ],
    new Map([[pageKey, {
      title: '核心项目',
      targetUrl: `${pageKey}/inspector`,
      updatedAt: 200
    }]])
  );
  const renamedItems = items.filter((item) => item.isTitleRenamed);
  const [result] = dedupeHistoryItems(items, 'page-family');

  assert.deepEqual(renamedItems.map((item) => item.id), ['overview']);
  assert.equal(result.id, 'overview');
  assert.equal(result.url, `${pageKey}/inspector`);
  assert.equal(result.defaultUrl, `${pageKey}/tools`);
  assert.equal(result.title, '核心项目');
  assert.equal(result.totalVisitCount, 21);
  assert.equal(result.lastVisitTime, 300);
});

test('page family identity keeps child resources distinct under the same parent', () => {
  const taskA = normalizeHistoryKey({
    url: 'https://example.com/projects/prj12345/tasks/task0001/overview'
  }, 'page-family');
  const taskB = normalizeHistoryKey({
    url: 'https://example.com/projects/prj12345/tasks/task0002/settings'
  }, 'page-family');

  assert.equal(taskA, 'https://example.com/projects/prj12345/tasks/task0001/overview');
  assert.notEqual(taskA, taskB);
});

test('resource identity preserves member names after parent IDs', () => {
  const alice = normalizeHistoryKey({
    url: 'https://example.com/projects/prj12345/members/alice'
  }, 'page-family');
  const bob = normalizeHistoryKey({
    url: 'https://example.com/projects/prj12345/members/bob'
  }, 'page-family');

  assert.equal(alice, 'https://example.com/projects/prj12345/members/alice');
  assert.notEqual(alice, bob);
});

test('path resource identities preserve query resource ids after a path id', () => {
  const first = normalizeHistoryKey({
    url: 'https://aeolus.example.com/aeolus/pages/queryEditor/files/6337616?appId=1000137&taskId=281475001639962'
  }, 'page-family');
  const second = normalizeHistoryKey({
    url: 'https://aeolus.example.com/aeolus/pages/queryEditor/files/6337616?appId=1000137&folderId=882956&taskId=281475001533557'
  }, 'page-family');

  assert.equal(first, 'https://aeolus.example.com/aeolus/pages/queryEditor/files/6337616?appId=1000137&taskId=281475001639962');
  assert.notEqual(first, second);
});

test('unknown query semantics never erase different report content', () => {
  const items = ['alpha', 'beta'].map((query) => ({ url: `https://example.com/report?query=${query}&activeTab=summary` }));
  assert.equal(dedupeHistoryItems(items, 'page-family').length, 2);
});

test('page family identity keeps distinct Google search queries', () => {
  const first = normalizeHistoryKey({
    url: 'https://www.google.com.hk/search?q=kv+cache&sourceid=chrome&start=10'
  }, 'page-family');
  const sameQuery = normalizeHistoryKey({
    url: 'https://www.google.com.hk/search?oq=kv+cache&q=kv%20cache&hl=zh-CN'
  }, 'page-family');
  const otherQuery = normalizeHistoryKey({
    url: 'https://www.google.com.hk/search?q=attention+cache'
  }, 'page-family');

  assert.equal(first, 'https://www.google.com.hk/search?q=kv+cache');
  assert.equal(first, sameQuery);
  assert.notEqual(first, otherQuery);
});

test('page family mode does not merge different Google search queries', () => {
  const results = dedupeHistoryItems(
    [
      {
        id: 'kv-cache',
        title: 'kv cache - Google 搜索',
        url: 'https://www.google.com.hk/search?q=kv+cache&sourceid=chrome',
        visitCount: 2
      },
      {
        id: 'attention-cache',
        title: 'attention cache - Google 搜索',
        url: 'https://www.google.com.hk/search?q=attention+cache&sourceid=chrome',
        visitCount: 3
      }
    ],
    'page-family'
  );

  assert.equal(results.length, 2);
  assert.deepEqual(new Set(results.map((item) => item.totalVisitCount)), new Set([2, 3]));
});

test('Dorado URLs preserve encoded instance identity until an explicit adapter exists', () => {
  const baseUrl = 'https://dataleap-va.tiktok-row.net/dorado/instance';
  const urls = [
    `${baseUrl}?_instanceD_=project%253Di18n_1867%2526id%253D109477584%2526tab%253Doverview`,
    `${baseUrl}?_instanceD_=project%253Di18n_1867%2526id%253D109477585%2526tab%253Doverview`,
    `${baseUrl}?searchType=content&keyword=109477584&schedule=2026-07-16&tab=runtime`
  ];
  const items = urls.map((url, index) => ({ url, visitCount: index + 1 }));
  const overrides = new Map(urls.map((url, index) => [normalizeHistoryKey({ url }, 'page-family'), {
    title: `实例 ${index}`, targetUrl: url, updatedAt: index
  }]));
  const results = dedupeHistoryItems(projectHistoryItems(items, overrides), 'page-family');
  assert.equal(results.length, 3);
  assert.deepEqual(new Set(results.map((item) => item.title)), new Set(['实例 0', '实例 1', '实例 2']));
});

test('unknown query keys keep their spelling and values', () => {
  const urls = [
    'https://example.com/detail?taskId=123456&filter=failed',
    'https://example.com/detail?task_id=123456&filter=failed',
    'https://example.com/detail?task-id=123456&filter=failed'
  ];
  assert.equal(new Set(urls.map((url) => normalizeHistoryKey({ url }, 'page-family'))).size, 3);
});

test('keyword search paths retain query and service context', () => {
  const baseUrl = 'https://cloud.example.com/argos/streamlog/info_overview/keyword_search';
  const urls = [
    `${baseUrl}?data_source=service_a&keyword=timeout`,
    `${baseUrl}?data_source=service_b&keyword=panic`,
    `${baseUrl}?task_id=123456&keyword=rpc`
  ];
  assert.equal(new Set(urls.map((url) => normalizeHistoryKey({ url }, 'page-family'))).size, 3);
});

test('resource paths preserve environment context', () => {
  const items = ['prod', 'ppe'].map((env) => ({ url: `https://example.com/projects/prj12345/overview?env=${env}` }));
  assert.equal(dedupeHistoryItems(items, 'page-family').length, 2);
});

test('keyword search variants keep independent search intents when one is renamed', () => {
  const baseUrl = 'https://cloud.example.com/argos/streamlog/info_overview/keyword_search';
  const items = projectHistoryItems(
    [
      {
        id: 'renamed',
        title: '日志关键字检索 | Argos-US-TTP',
        url: `${baseUrl}?keyword=timeout&data_source=service_a`,
        lastVisitTime: 100,
        visitCount: 1
      },
      {
        id: 'popular',
        title: '日志关键字检索 | Argos-US-TTP',
        url: `${baseUrl}?keyword=panic&data_source=service_b`,
        lastVisitTime: 300,
        visitCount: 20
      },
      {
        id: 'recent',
        title: '日志关键字检索 | Argos-US-TTP',
        url: `${baseUrl}?keyword=rpc&region=us`,
        lastVisitTime: 500,
        visitCount: 3
      }
    ],
    new Map([[normalizeHistoryKey({ url: `${baseUrl}?keyword=timeout&data_source=service_a` }, 'page-family'), {
      title: 'Argos 日志',
      targetUrl: `${baseUrl}?keyword=timeout&data_source=service_a`,
      updatedAt: 200
    }]])
  );
  const results = dedupeHistoryItems(items, 'page-family');
  assert.equal(results.length, 3);
  const result = results.find((item) => item.id === 'renamed');

  assert.equal(result.id, 'renamed');
  assert.equal(result.title, 'Argos 日志');
  assert.equal(result.totalVisitCount, 1);
  assert.equal(result.dedupeCount, 1);
  assert.equal(result.lastVisitTime, 100);
});

test('unknown fragments remain distinct until their site semantics are known', () => {
  assert.notEqual(
    normalizeHistoryKey({ url: 'https://example.com/docs#comments' }, 'page-family'),
    normalizeHistoryKey({ url: 'https://example.com/docs#top' }, 'page-family')
  );
  assert.notEqual(
    normalizeHistoryKey({ url: 'https://example.com/#/docs/doc0001/overview' }, 'page-family'),
    normalizeHistoryKey({ url: 'https://example.com/#/docs/doc0002/overview' }, 'page-family')
  );
  assert.notEqual(
    normalizeHistoryKey({ url: 'https://example.com/#/docs/doc0001/overview' }, 'page-family'),
    normalizeHistoryKey({ url: 'https://example.com/#/docs/doc0001/settings' }, 'page-family')
  );
});

test('unknown hash routers preserve shell and route queries', () => {
  const urls = [
    'https://example.com/?theme=dark#/reports?query=alpha&tab=summary',
    'https://example.com/?theme=light#/reports?query=beta&tab=details',
    'https://example.com/?source=mail#/detail?taskId=123456&filter=failed',
    'https://example.com/?source=chat#/detail?task_id=123456&filter=success'
  ];
  assert.equal(new Set(urls.map((url) => normalizeHistoryKey({ url }, 'page-family'))).size, 4);
});

test('local files and date paths never use resource-id heuristics', () => {
  const fileA = normalizeHistoryKey({
    url: 'file:///tmp/20260718/report-a.html'
  }, 'page-family');
  const fileB = normalizeHistoryKey({
    url: 'file:///tmp/20260718/report-b.html'
  }, 'page-family');
  const newsA = normalizeHistoryKey({
    url: 'https://news.example.com/20260718/article-a'
  }, 'page-family');
  const newsB = normalizeHistoryKey({
    url: 'https://news.example.com/20260718/article-b'
  }, 'page-family');

  assert.equal(fileA, 'file:///tmp/20260718/report-a.html');
  assert.equal(fileB, 'file:///tmp/20260718/report-b.html');
  assert.notEqual(fileA, fileB);
  assert.equal(newsA, 'https://news.example.com/20260718/article-a');
  assert.equal(newsB, 'https://news.example.com/20260718/article-b');
  assert.notEqual(newsA, newsB);
});

test('dedupe adds existing bucket metadata and selects the largest normalized URL bucket', () => {
  const [result] = dedupeHistoryItems([
    {
      id: 'small-newer',
      url: 'https://cloud-ttp-us.bytedance.net/tae/mcp_server/doc0001/tools',
      lastVisitTime: 500,
      visitCount: 2,
      totalVisitCount: 2,
      dedupeCount: 2
    },
    {
      id: 'large-older',
      url: 'https://cloud-ttp-us.bytedance.net/tae/mcp_server/doc0001/inspector',
      lastVisitTime: 100,
      visitCount: 1,
      totalVisitCount: 9,
      representativeVisitCount: 9,
      dedupeCount: 3
    }
  ], 'page-family');

  assert.equal(result.id, 'large-older');
  assert.equal(result.totalVisitCount, 11);
  assert.equal(result.dedupeCount, 5);
  assert.equal(result.lastVisitTime, 500);
});

test('two-stage dedupe chooses the tab with the largest aggregated normalized-URL count', () => {
  const normalizedItems = dedupeHistoryItems([
    {
      id: 'overview-mail',
      url: 'https://cloud-ttp-us.bytedance.net/tae/mcp_server/prj12345/tools?utm_source=mail',
      lastVisitTime: 100,
      visitCount: 6
    },
    {
      id: 'overview-chat',
      url: 'https://cloud-ttp-us.bytedance.net/tae/mcp_server/prj12345/tools?utm_source=chat',
      lastVisitTime: 200,
      visitCount: 6
    },
    {
      id: 'settings',
      url: 'https://cloud-ttp-us.bytedance.net/tae/mcp_server/prj12345/inspector',
      lastVisitTime: 300,
      visitCount: 10
    }
  ], 'normalized-url');
  const [result] = dedupeHistoryItems(normalizedItems, 'page-family');

  assert.equal(result.id, 'overview-chat');
  assert.equal(result.representativeVisitCount, 12);
  assert.equal(result.totalVisitCount, 22);
  assert.equal(result.dedupeCount, 3);
});

test('dedupe representative is deterministic when normalized URL scores tie', () => {
  const items = [
    {
      id: 'mail',
      title: 'Mail entry',
      url: 'https://example.com/docs?utm_source=mail',
      lastVisitTime: 100,
      visitCount: 1
    },
    {
      id: 'recent',
      title: 'Recent entry',
      url: 'https://example.com/docs?utm_source=recent',
      lastVisitTime: 100,
      visitCount: 1
    }
  ];
  const forward = dedupeHistoryItems(items, 'normalized-url')[0];
  const reversed = dedupeHistoryItems([...items].reverse(), 'normalized-url')[0];

  assert.equal(forward.id, reversed.id);
  assert.equal(forward.url, reversed.url);
});

test('query matching a non-representative tab still returns the stable family representative', () => {
  const [family] = dedupeHistoryItems([
    {
      id: 'popular',
      title: 'Project Overview',
      url: 'https://cloud-ttp-us.bytedance.net/tae/mcp_server/prj12345/tools',
      visitCount: 20
    },
    {
      id: 'rare',
      title: 'Audit Timeline',
      url: 'https://cloud-ttp-us.bytedance.net/tae/mcp_server/prj12345/inspector',
      visitCount: 1
    }
  ], 'page-family');

  assert.equal(family.id, 'popular');
  assert.deepEqual(filterHistoryItemsByQuery([family], 'Audit Timeline').map((item) => item.id), [
    'popular'
  ]);
});

test('rename projection changes the target without changing resource totals', () => {
  const pageKey = 'https://cloud-ttp-us.bytedance.net/tae/mcp_server/rd2nw9df';
  const facts = dedupeHistoryItems([
    { id: 'popular-tools', title: 'Tools', url: `${pageKey}/tools`, visitCount: 20, lastVisitTime: 300 },
    { id: 'rare-inspector', title: 'Inspector', url: `${pageKey}/inspector`, visitCount: 1, lastVisitTime: 100 }
  ], 'page-family');
  const [renamed] = projectPageItems(facts, new Map([[pageKey, {
    title: '核心 MCP 服务', targetUrl: `${pageKey}/inspector`, updatedAt: 1
  }]]));
  assert.equal(renamed.id, 'popular-tools');
  assert.equal(renamed.url, `${pageKey}/inspector`);
  assert.equal(renamed.totalVisitCount, 21);
  assert.equal(renamed.lastVisitTime, 300);
  const [restored] = projectPageItems([renamed]);
  assert.equal(restored.url, `${pageKey}/tools`);
  assert.equal(restored.title, 'Tools');
  assert.equal(restored.isTitleRenamed, false);
  assert.equal(restored.totalVisitCount, 21);
});

test('domain grouping puts different paths from the same host in one group', () => {
  const groups = groupHistoryItems([
    {
      id: 'tools',
      url: 'https://cloud-ttp-us.bytedance.net/tae/mcp_server/4syx48fa/tools',
      lastVisitTime: 300
    },
    {
      id: 'inspector',
      url: 'https://cloud-ttp-us.bytedance.net/tae/mcp_server/4syx48fa/inspector',
      lastVisitTime: 200
    },
    {
      id: 'other',
      url: 'https://example.com/a',
      lastVisitTime: 100
    }
  ]);

  assert.equal(groups.length, 2);
  assert.equal(groups[0].key, 'cloud-ttp-us.bytedance.net');
  assert.deepEqual(
    groups[0].items.map((item) => item.id),
    ['tools', 'inspector']
  );
});

test('domain groups report summed traffic while ranking their best members', () => {
  const groups = groupHistoryItems([
    { id: 'older-a', url: 'https://a.example/one', lastVisitTime: 100, visitCount: 9 },
    { id: 'newer-b', url: 'https://b.example/two', lastVisitTime: 500, visitCount: 2 },
    { id: 'older-b', url: 'https://b.example/one', lastVisitTime: 200, visitCount: 1 }
  ]);

  assert.deepEqual(
    groups.map((group) => group.key),
    ['a.example', 'b.example']
  );
  assert.equal(groups[0].totalVisitCount, 9);
  assert.equal(groups[1].totalVisitCount, 3);
});

test('page candidates sort by visit count before latest visit time', () => {
  const candidates = dedupeHistoryItems([
    {
      id: 'newer-rare',
      url: 'https://rare.example/page',
      lastVisitTime: 500,
      visitCount: 2
    },
    {
      id: 'older-frequent',
      url: 'https://frequent.example/page',
      lastVisitTime: 100,
      visitCount: 20
    }
  ], 'page-family');

  assert.deepEqual(candidates.map((item) => item.id), ['older-frequent', 'newer-rare']);
});

test('groups rank renamed resources ahead of higher traffic and pinned resources ahead of both', () => {
  const rankedItems = dedupeHistoryItems(
    projectHistoryItems(
      [
        {
          id: 'renamed-63',
          title: 'Renamed 63',
          url: 'https://renamed.example/page',
          lastVisitTime: 500,
          visitCount: 63
        },
        {
          id: 'plain-183',
          title: 'Plain 183',
          url: 'https://frequent.example/page',
          lastVisitTime: 100,
          visitCount: 183
        }
      ],
      new Map([['https://renamed.example/page', 'Custom 63']])
    ),
    'page-family'
  );
  const groups = applyPinnedStateToGroups(
    groupHistoryItems(rankedItems),
    new Set()
  );

  assert.deepEqual(groups.map((group) => group.key), [
    'renamed.example',
    'frequent.example'
  ]);

  const pinnedGroups = applyPinnedStateToGroups(
    groupHistoryItems(rankedItems),
    new Set(['https://frequent.example/page'])
  );
  assert.deepEqual(pinnedGroups.map((group) => group.key), [
    'frequent.example',
    'renamed.example'
  ]);
});

test('items inside browsing groups sort by visit count before latest visit time', () => {
  const [group] = groupHistoryItems([
    {
      id: 'newer-rare',
      url: 'https://example.com/newer',
      lastVisitTime: 500,
      visitCount: 2
    },
    {
      id: 'older-frequent',
      url: 'https://example.com/frequent',
      lastVisitTime: 100,
      visitCount: 20
    }
  ]);

  assert.deepEqual(group.items.map((item) => item.id), ['older-frequent', 'newer-rare']);
});

test('group items follow renamed then visit count then latest visit time', () => {
  const groups = groupHistoryItems(
    projectHistoryItems(
      [
        {
          id: 'frequent-plain',
          title: 'Frequent Plain',
          url: 'https://example.com/frequent',
          lastVisitTime: 100,
          visitCount: 183
        },
        {
          id: 'renamed-lower-count',
          title: 'Renamed Lower Count',
          url: 'https://example.com/renamed-lower',
          lastVisitTime: 500,
          visitCount: 63
        },
        {
          id: 'plain-equal-count',
          title: 'Plain Equal Count',
          url: 'https://example.com/plain-equal',
          lastVisitTime: 600,
          visitCount: 20
        },
        {
          id: 'renamed-equal-count',
          title: 'Renamed Equal Count',
          url: 'https://example.com/renamed-equal',
          lastVisitTime: 200,
          visitCount: 20
        }
      ],
      new Map([
        ['https://example.com/renamed-lower', 'Custom Lower'],
        ['https://example.com/renamed-equal', 'Custom Equal']
      ])
    )
  );

  assert.deepEqual(groups[0].items.map((item) => item.id), [
    'renamed-lower-count',
    'renamed-equal-count',
    'frequent-plain',
    'plain-equal-count'
  ]);
});

test('domain groups prefer item totalVisitCount when summing group frequency', () => {
  const groups = groupHistoryItems([
    {
      id: 'a-one',
      url: 'https://a.example/one',
      lastVisitTime: 100,
      visitCount: 2,
      totalVisitCount: 7
    },
    {
      id: 'b-one',
      url: 'https://b.example/one',
      lastVisitTime: 400,
      visitCount: 5,
      totalVisitCount: 5
    }
  ]);

  assert.deepEqual(
    groups.map((group) => group.key),
    ['a.example', 'b.example']
  );
  assert.equal(groups[0].totalVisitCount, 7);
});

test('group rank follows its best member rather than aggregate traffic or input order', () => {
  const groups = groupHistoryItems([
    { id: 'top-tab', isTitleRenamed: true, url: 'https://small.example/top', lastVisitTime: 500, visitCount: 1 },
    { id: 'busy-newer', url: 'https://busy.example/newer', lastVisitTime: 400, visitCount: 100 },
    { id: 'small-second', url: 'https://small.example/second', lastVisitTime: 300, visitCount: 1 },
    { id: 'busy-older', url: 'https://busy.example/older', lastVisitTime: 200, visitCount: 100 }
  ]);

  assert.deepEqual(groups.map((group) => group.key), ['small.example', 'busy.example']);
  assert.deepEqual(groups[0].items.map((item) => item.id), ['top-tab', 'small-second']);
  assert.equal(groups[1].totalVisitCount, 200);
});

test('local file URLs use a visible stable group instead of an empty hostname', () => {
  const groups = groupHistoryItems([
    {
      id: 'local-file',
      title: 'ENFJ 主人公型人格深度解析',
      url: 'file:///Users/bytedance/Library/Application%20Support/TRAE%20SOLO%20CN/report.html',
      lastVisitTime: 100,
      visitCount: 2
    }
  ]);

  assert.equal(groups.length, 1);
  assert.equal(groups[0].key, '本地文件');
  assert.equal(groups[0].label, '本地文件');
});

test('grouped URL display omits the repeated domain and keeps distinguishing suffixes', () => {
  assert.equal(
    formatHistoryUrlForGroup(
      {
        url: 'https://meego.larkoffice.com/data_ecom/story/detail/7306503596?openScene=4#comments'
      },
      'meego.larkoffice.com'
    ),
    '/data_ecom/story/detail/7306503596?openScene=4#comments'
  );

  assert.equal(
    formatHistoryUrlForGroup({ url: 'http://localhost:5173/history.html?range=week' }, 'localhost'),
    ':5173/history.html?range=week'
  );
});

test('grouped local file display shows a decoded filesystem path', () => {
  assert.equal(
    formatHistoryUrlForGroup(
      {
        url: 'file:///Users/bytedance/Library/Application%20Support/TRAE%20SOLO%20CN/report.html'
      },
      '本地文件'
    ),
    '/Users/bytedance/Library/Application Support/TRAE SOLO CN/report.html'
  );

  assert.equal(
    formatHistoryUrlForGroup({ url: 'file:///Users/bytedance/My%20Report.html' }),
    '/Users/bytedance/My Report.html'
  );
});

test('grouped URL display falls back to the original URL outside matching domain groups', () => {
  assert.equal(
    formatHistoryUrlForGroup({ url: 'https://example.com/docs' }, 'other.example.com'),
    'https://example.com/docs'
  );
  assert.equal(formatHistoryUrlForGroup({ url: 'not a valid url' }, 'example.com'), 'not a valid url');
});

test('pin keys normalize URLs so tracking variants share the same pin', () => {
  const key = getHistoryItemPinKey({
    url: 'https://example.com/docs/?utm_source=mail&b=2#section'
  });

  assert.equal(key, 'https://example.com/docs/?b=2#section');
});

test('title override keys normalize URLs so tracking variants share one custom title', () => {
  const key = getHistoryItemTitleOverrideKey({
    url: 'https://example.com/docs/?utm_source=mail&b=2#section'
  });

  assert.equal(key, 'https://example.com/docs/?b=2#section');
});

test('captured live titles replace stale history titles before manual overrides', () => {
  const url = 'https://example.com/doc/abc12345';
  const capturedItems = applyCapturedTitlesToItems(
    [{ id: 'doc', title: 'Docs', url }],
    new Map([[url, '真实文档标题 - 飞书云文档']])
  );
  const renamedItems = projectHistoryItems(
    capturedItems,
    new Map([[url, '我的自定义标题']])
  );

  assert.equal(capturedItems[0].title, '真实文档标题 - 飞书云文档');
  assert.equal(capturedItems[0].historyTitle, 'Docs');
  assert.equal(renamedItems[0].title, '我的自定义标题');
  assert.equal(renamedItems[0].originalTitle, '真实文档标题 - 飞书云文档');
});

test('captured redirect targets dedupe different history aliases of one final page', () => {
  const items = applyCapturedTitlesToItems(
    [
      { id: 'legacy-favor', url: 'https://cloud-ttp-us.bytedance.net/scm/legacy-favor' },
      { id: 'favorite-entry', url: 'https://cloud-ttp-us.bytedance.net/scm/favorite-entry' }
    ],
    new Map([
      ['https://cloud-ttp-us.bytedance.net/scm/legacy-favor', {
        title: '代码发布管理 US-TTP BDEE - 字节云',
        resolvedUrl: 'https://cloud-ttp-us.bytedance.net/scm/favor'
      }],
      ['https://cloud-ttp-us.bytedance.net/scm/favorite-entry', {
        title: '代码发布管理 US-TTP BDEE - 字节云',
        resolvedUrl: 'https://cloud-ttp-us.bytedance.net/scm/favor'
      }]
    ])
  );

  const results = dedupeHistoryItems(items, 'normalized-url');

  assert.equal(results.length, 1);
  assert.equal(results[0].dedupeCount, 2);
});

test('captured titles never spread an old parent capture onto independent child resources', () => {
  const legacyKey = 'https://example.com/projects/prj12345';
  const items = applyCapturedTitlesToItems(
    [
      {
        id: 'task-a',
        url: 'https://example.com/projects/prj12345/tasks/task0001/overview'
      },
      {
        id: 'task-b',
        url: 'https://example.com/projects/prj12345/tasks/task0002/overview'
      }
    ],
    new Map([[legacyKey, {
      title: 'Legacy task title',
      resolvedUrl: 'https://example.com/projects/prj12345/tasks/task0001/overview'
    }]])
  );

  assert.equal(items[0].dedupeUrl, undefined);
  assert.equal(items[0].title, '');
  assert.equal(items[1].dedupeUrl, undefined);
  assert.equal(items[1].title, '');
  assert.equal(dedupeHistoryItems(items, 'page-family').length, 2);
});

test('display titles remove invisible Unicode format controls that shift text alignment', () => {
  const url = 'https://example.com/doc/abc12345';
  const [item] = applyCapturedTitlesToItems(
    [{ title: 'Docs', url }],
    new Map([[url, '\u2064\u2062\u200b\u200c字节 Codex 攻略大全 - 飞书云文档']])
  );

  assert.equal(item.title, '字节 Codex 攻略大全 - 飞书云文档');
});

test('captured titles share one stable key across query variants of the same document', () => {
  const liveUrl = 'https://example.larkoffice.com/wiki/FkjVwUDZciqChskTeQcc2ATjnQb';
  const historyUrl =
    'https://example.larkoffice.com/wiki/FkjVwUDZciqChskTeQcc2ATjnQb?open_in_browser=true&from=recent';
  const capturedKey = getHistoryItemCapturedTitleKey({ url: liveUrl });
  const [item] = applyCapturedTitlesToItems(
    [{ title: 'Docs', url: historyUrl }],
    new Map([[capturedKey, '本地 AI Coding 工具链安装工具 - 飞书云文档']])
  );

  assert.equal(
    capturedKey,
    'https://example.larkoffice.com/wiki/FkjVwUDZciqChskTeQcc2ATjnQb'
  );
  assert.equal(item.title, '本地 AI Coding 工具链安装工具 - 飞书云文档');
});

test('title overrides affect display without becoming resource identity', () => {
  const rawItems = [
    {
      id: 'docs',
      title: 'Docs',
      url: 'https://example.com/docs?utm_source=mail',
      lastVisitTime: 100,
      visitCount: 1
    },
    {
      id: 'guide',
      title: 'Guide',
      url: 'https://example.com/guide',
      lastVisitTime: 200,
      visitCount: 2
    }
  ];
  const renamedItems = projectHistoryItems(
    rawItems,
    new Map([['https://example.com/docs', 'Guide']])
  );
  const results = dedupeHistoryItems(renamedItems, 'page-family');

  assert.equal(results.length, 2);
});

test('keyword search keeps renamed and unrenamed same-title pages separate across resources', () => {
  const detailUrl =
    'https://dataleap-tx.tiktok-row.net/coral/datamap/detail?groupName=og&qualifiedName=HiveTable%3A%2F%2F%2Fi18n_ecom_alliance%2Fods_agent_trajectory_segments%409&subTab=schema&tab=table_info#group=og';
  const resultUrl =
    'https://dataleap-tx.tiktok-row.net/coral/datamap/result?query=i18n_ecom_alliance.ods_agent_trajectory_segments';
  const renamedItems = projectHistoryItems(
    [
      {
        id: 'detail',
        title: 'DataLeap - Data Map',
        url: detailUrl,
        visitCount: 3
      },
      {
        id: 'result',
        title: 'ods_agent_trajectory_segments',
        url: resultUrl,
        visitCount: 20
      }
    ],
    new Map([[normalizeHistoryKey({ url: detailUrl }), 'ods_agent_trajectory_segments']])
  );

  const results = dedupeHistoryItems(
    filterHistoryItemsByQuery(renamedItems, 'ods'),
    'page-family'
  );

  assert.equal(results.length, 2);
  assert.equal(results.find((item) => item.id === 'detail')?.isTitleRenamed, true);
});

test('resource dedupe keeps tab variants of one resource together', () => {
  const [result] = dedupeHistoryItems(
    projectHistoryItems([
      {
        id: 'docs-a',
        title: 'Docs',
        url: 'https://cloud-ttp-us.bytedance.net/tae/mcp_server/abc12345/tools',
        lastVisitTime: 100,
        visitCount: 1
      },
      {
        id: 'docs-b',
        title: 'Docs',
        url: 'https://cloud-ttp-us.bytedance.net/tae/mcp_server/abc12345/inspector',
        lastVisitTime: 200,
        visitCount: 2
      }
    ]),
    'page-family'
  );

  assert.deepEqual(result.titleOverrideKeys, [
    'https://cloud-ttp-us.bytedance.net/tae/mcp_server/abc12345'
  ]);
});

test('query filtering retains original title aliases alongside projected names but never URLs', () => {
  const rawItems = [
    {
      id: 'renamed',
      title: 'Original Title',
      url: 'https://example.com/a',
      lastVisitTime: 100
    },
    {
      id: 'plain',
      title: 'Plain Docs',
      url: 'https://docs.example.com/guide',
      lastVisitTime: 200
    }
  ];
  const renamedItems = projectHistoryItems(
    rawItems,
    new Map([['https://example.com/a', 'Project Atlas']])
  );

  assert.deepEqual(
    filterHistoryItemsByQuery(renamedItems, 'atlas').map((item) => item.id),
    ['renamed']
  );
  assert.deepEqual(
    filterHistoryItemsByQuery(renamedItems, 'docs.example.com').map((item) => item.id),
    []
  );
  assert.deepEqual(
    filterHistoryItemsByQuery(renamedItems, 'Original Title').map((item) => item.id),
    ['renamed']
  );
  assert.deepEqual(
    filterHistoryItemsByQuery(
      [{ id: 'non-contiguous', title: 'A B C', url: 'https://example.com/abc' }],
      'A C'
    ).map((item) => item.id),
    ['non-contiguous']
  );
});

test('Chinese shorthand search matches a bounded phrase in the real renamed Feishu title', () => {
  const url = 'https://my.feishu.cn/wiki/M1Cew0iYaiH9jfkeD5XcXEuZn3d';
  const [renamedItem] = projectHistoryItems(
    [{
      id: 'real-feishu-history-item',
      title: '从0到∞: 大语言模型知识面试一本通 - 飞书云文档',
      url,
      lastVisitTime: 1785568922000,
      visitCount: 6
    }],
    new Map([['https://feishu.cn/wiki/M1Cew0iYaiH9jfkeD5XcXEuZn3d', {
      targetUrl: url,
      title: '大语言模型知识面试一本通',
      updatedAt: 1785569265309
    }]])
  );

  assert.equal(renamedItem.title, '大语言模型知识面试一本通');
  assert.deepEqual(
    filterHistoryItemsByQuery([renamedItem], '大模型').map((item) => item.id),
    ['real-feishu-history-item']
  );
  assert.deepEqual(filterHistoryItemsByQuery([renamedItem], '大面试'), []);
});

test('search matches titles only and ignores every part of URLs', () => {
  const items = [
    {
      id: 'unrelated-doc',
      title: 'Generator 模块后训练技术方案 - 飞书云文档',
      url: 'https://example.com/wiki/abc12345?source=ods_agent_trajectory_segments'
    },
    {
      id: 'renamed-target',
      title: 'ods_agent_trajectory_segments',
      url: 'https://example.com/wiki/xyz98765'
    }
  ];

  assert.deepEqual(
    filterHistoryItemsByQuery(items, 'ods').map((item) => item.id),
    ['renamed-target']
  );
  assert.deepEqual(
    filterHistoryItemsByQuery(items, 'https://example.com/wiki/abc12345').map((item) => item.id),
    []
  );
  assert.deepEqual(filterHistoryItemsByQuery(items, 'example.com'), []);
  assert.deepEqual(filterHistoryItemsByQuery(items, 'abc12345'), []);
  assert.deepEqual(filterHistoryItemsByQuery(items, 'source'), []);
});

test('pinned pages move to the top of their group and support multiple pins', () => {
  const groups = groupHistoryItems([
    { id: 'newest', url: 'https://example.com/newest', lastVisitTime: 500 },
    { id: 'pinned-older', url: 'https://example.com/pinned-older', lastVisitTime: 100 },
    { id: 'middle', url: 'https://example.com/middle', lastVisitTime: 300 },
    { id: 'pinned-newer', url: 'https://example.com/pinned-newer', lastVisitTime: 200 }
  ]);

  const pinnedGroups = applyPinnedStateToGroups(groups, [
    'https://example.com/pinned-older',
    'https://example.com/pinned-newer'
  ]);

  assert.deepEqual(
    pinnedGroups[0].items.map((item) => item.id),
    ['pinned-older', 'pinned-newer', 'newest', 'middle']
  );
  assert.deepEqual(
    pinnedGroups[0].items.map((item) => item.isPinned),
    [true, true, false, false]
  );
  assert.equal(pinnedGroups[0].pinnedCount, 2);
});

test('a legacy redirect alias remains pinned after the final URL becomes representative', () => {
  const [item] = dedupeHistoryItems(
    applyCapturedTitlesToItems(
      [{
        id: 'legacy',
        title: 'Docs',
        url: 'https://example.com/legacy-doc',
        visitCount: 3
      }],
      new Map([['https://example.com/legacy-doc', {
        title: 'Docs',
        resolvedUrl: 'https://example.com/final-doc'
      }]])
    ),
    'page-family'
  );
  const [group] = applyPinnedStateToGroups(
    groupHistoryItems([item]),
    new Set(['https://example.com/legacy-doc'])
  );

  assert.equal(group.items[0].isPinned, true);
  assert.deepEqual(group.items[0].pinKeys, [
    'https://example.com/final-doc',
    'https://example.com/legacy-doc'
  ]);
});

test('pinned pages follow the order they were pinned instead of visit time or URL', () => {
  const groups = groupHistoryItems([
    { id: 'alpha-newest', url: 'https://example.com/alpha', lastVisitTime: 500 },
    { id: 'beta-oldest', url: 'https://example.com/beta', lastVisitTime: 100 },
    { id: 'gamma-middle', url: 'https://example.com/gamma', lastVisitTime: 300 }
  ]);

  const pinnedGroups = applyPinnedStateToGroups(groups, [
    'https://example.com/beta',
    'https://example.com/gamma',
    'https://example.com/alpha'
  ]);

  assert.deepEqual(
    pinnedGroups[0].items.map((item) => item.id),
    ['beta-oldest', 'gamma-middle', 'alpha-newest']
  );
});

test('renamed pages sort after pinned pages and before visit-priority order', () => {
  const groups = groupHistoryItems(
    projectHistoryItems(
      [
        {
          id: 'newest-plain',
          title: 'Newest Plain',
          url: 'https://example.com/newest-plain',
          lastVisitTime: 500
        },
        {
          id: 'oldest-renamed',
          title: 'Oldest Renamed',
          url: 'https://example.com/oldest-renamed',
          lastVisitTime: 100
        },
        {
          id: 'middle-pinned',
          title: 'Middle Pinned',
          url: 'https://example.com/middle-pinned',
          lastVisitTime: 300
        },
        {
          id: 'middle-plain',
          title: 'Middle Plain',
          url: 'https://example.com/middle-plain',
          lastVisitTime: 250
        }
      ],
      new Map([['https://example.com/oldest-renamed', 'Custom Oldest']])
    )
  );

  const sortedGroups = applyPinnedStateToGroups(groups, ['https://example.com/middle-pinned']);

  assert.deepEqual(
    sortedGroups[0].items.map((item) => item.id),
    ['middle-pinned', 'oldest-renamed', 'newest-plain', 'middle-plain']
  );
});

test('unpinned pages return to the original group sort order', () => {
  const groups = groupHistoryItems([
    { id: 'newest', url: 'https://example.com/newest', lastVisitTime: 500 },
    { id: 'pinned-older', url: 'https://example.com/pinned-older', lastVisitTime: 100 },
    { id: 'middle', url: 'https://example.com/middle', lastVisitTime: 300 }
  ]);

  const unpinnedGroups = applyPinnedStateToGroups(groups, new Set());

  assert.deepEqual(
    unpinnedGroups[0].items.map((item) => item.id),
    ['newest', 'middle', 'pinned-older']
  );
  assert.deepEqual(
    unpinnedGroups[0].items.map((item) => item.isPinned),
    [false, false, false]
  );
  assert.equal(unpinnedGroups[0].pinnedCount, 0);
});


test('pins retain their order while search relevance precedes rename and visit priority', () => {
  const items = [
    { id: 'plain', url: 'https://example.com/plain', title: 'shared', visitCount: 999 },
    { id: 'renamed-low', url: 'https://example.com/r-low', title: 'shared Zulu', isTitleRenamed: true, visitCount: 1 },
    { id: 'renamed-high', url: 'https://example.com/r-high', title: 'shared Alpha', isTitleRenamed: true, visitCount: 10 },
    { id: 'pin-first', url: 'https://example.com/p1', title: 'shared Zulu', isTitleRenamed: true, visitCount: 1 },
    { id: 'pin-second', url: 'https://example.com/p2', title: 'shared Alpha', isTitleRenamed: true, visitCount: 999 }
  ];
  const pins = new Set(['https://example.com/p1', 'https://example.com/p2']);
  const rank = (visibleItems) => applyPinnedStateToGroups(groupHistoryItems(visibleItems), pins)[0].items.map((item) => item.id);
  const expected = ['pin-first', 'pin-second', 'renamed-high', 'renamed-low', 'plain'];
  assert.deepEqual(rank(items), expected);
  assert.deepEqual(rank(filterHistoryItemsByQuery(items, 'shared')), ['pin-first', 'pin-second', 'plain', 'renamed-high', 'renamed-low']);
  assert.deepEqual(rank(items.filter((item) => item.isTitleRenamed)), expected.slice(0, -1));
  assert.deepEqual(rank([...items].reverse()), expected);
});

test('the best member defines group order using pin order, not total group traffic', () => {
  const items = [
    { id: 'a-pin', url: 'https://a.example/pin', visitCount: 1 },
    { id: 'b-pin', url: 'https://b.example/pin', visitCount: 10 },
    { id: 'a-heavy', url: 'https://a.example/heavy', visitCount: 999 },
    { id: 'c-rename', url: 'https://c.example/rename', isTitleRenamed: true, visitCount: 1 },
    { id: 'd-heavy', url: 'https://d.example/heavy', visitCount: 1000 }
  ];
  const pins = new Set(['https://b.example/pin', 'https://a.example/pin']);
  const groups = applyPinnedStateToGroups(groupHistoryItems(items), pins);
  assert.deepEqual(groups.map((group) => group.key), ['b.example', 'a.example', 'c.example', 'd.example']);
  assert.deepEqual(groups[1].items.map((item) => item.id), ['a-pin', 'a-heavy']);
  const unpinned = applyPinnedStateToGroups(groups);
  assert.deepEqual(unpinned.map((group) => group.key), ['c.example', 'd.example', 'a.example', 'b.example']);
  assert.deepEqual(unpinned.find((group) => group.key === 'a.example').items.map((item) => item.id), ['a-heavy', 'a-pin']);
});

test('equal ranks resolve by time then stable identity regardless of input order', () => {
  const items = [
    { id: 'older', url: 'https://example.com/old', visitCount: 2, lastVisitTime: 1 },
    { id: 'z', url: 'https://example.com/z', visitCount: 2, lastVisitTime: 2 },
    { id: 'a', url: 'https://example.com/a', visitCount: 2, lastVisitTime: 2 }
  ];
  for (const input of [items, [...items].reverse()]) {
    assert.deepEqual(applyPinnedStateToGroups(groupHistoryItems(input))[0].items.map((item) => item.id), ['a', 'z', 'older']);
  }
});

test('observed redirect aliases retain annotations while the latest name is projected once', () => {
  const finalUrl = 'https://example.com/document';
  const aliases = ['https://example.com/old-entry', 'https://example.com/new-entry'];
  const captured = applyCapturedTitlesToItems(aliases.map((url, index) => ({
    url, visitCount: index + 1, title: 'History title'
  })), new Map(aliases.map((url) => [url, { title: 'Captured title', resolvedUrl: finalUrl }])));
  const [result] = projectHistoryItems(captured, new Map(aliases.map((url, index) => [url, {
    title: `Name ${index}`, targetUrl: url, updatedAt: index + 1
  }])));
  assert.equal(result.title, 'Name 1');
  assert.equal(result.url, aliases[1]);
  assert.equal(result.totalVisitCount, 3);
  assert.deepEqual(new Set(result.titleOverrideKeys), new Set([finalUrl, ...aliases]));
  assert.equal(projectPageItems([result])[0].title, 'Captured title');
});
