import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyCapturedTitlesToItems,
  applyPinnedStateToGroups,
  applyPinnedStateToItemsByName,
  applyTitleOverridesToItems,
  dedupeHistoryItems,
  filterHistoryItemsByQuery,
  formatHistoryUrlForGroup,
  getHistoryItemCapturedTitleKey,
  getHistoryItemPinKey,
  getHistoryItemTitleOverrideKey,
  groupHistoryItems,
  groupHistoryItemsByCandidateRank,
  normalizeHistoryKey,
  prepareHistoryItemsForSearch
} from '../src/history-utils.js';

test('normalized URL mode collapses repeat visits and keeps the latest item', () => {
  const older = {
    id: 'older',
    title: 'Older A',
    url: 'https://Example.com/a/?utm_source=newsletter&b=2#section',
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

test('normalized URL mode keeps a manually renamed redirect alias before visit count', () => {
  const [result] = dedupeHistoryItems(
    applyTitleOverridesToItems(
      applyCapturedTitlesToItems(
        [
          {
            id: 'renamed-low-count',
            title: 'Docs',
            url: 'https://example.com/legacy-doc',
            lastVisitTime: 100,
            visitCount: 1
          },
          {
            id: 'plain-high-count',
            title: 'Docs',
            url: 'https://example.com/current-doc',
            lastVisitTime: 200,
            visitCount: 20
          }
        ],
        new Map([
          [
            'https://example.com/legacy-doc',
            { title: 'Docs', resolvedUrl: 'https://example.com/doc' }
          ],
          [
            'https://example.com/current-doc',
            { title: 'Docs', resolvedUrl: 'https://example.com/doc' }
          ]
        ])
      ),
      new Map([['https://example.com/legacy-doc', 'My Docs']])
    ),
    'normalized-url'
  );

  assert.equal(result.id, 'renamed-low-count');
  assert.equal(result.title, 'My Docs');
  assert.equal(result.totalVisitCount, 21);
});

test('normalized URL mode keeps only the latest manual rename in one redirect bucket', () => {
  const results = dedupeHistoryItems(
    applyTitleOverridesToItems(
      applyCapturedTitlesToItems(
        [
          {
            id: 'legacy-doc',
            title: 'Docs',
            url: 'https://example.com/legacy-doc',
            lastVisitTime: 100,
            visitCount: 1
          },
          {
            id: 'current-doc',
            title: 'Docs',
            url: 'https://example.com/current-doc',
            lastVisitTime: 200,
            visitCount: 20
          }
        ],
        new Map([
          [
            'https://example.com/legacy-doc',
            { title: 'Docs', resolvedUrl: 'https://example.com/doc' }
          ],
          [
            'https://example.com/current-doc',
            { title: 'Docs', resolvedUrl: 'https://example.com/doc' }
          ]
        ])
      ),
      new Map([
        ['https://example.com/legacy-doc', 'Legacy Docs'],
        ['https://example.com/current-doc', 'Current Docs']
      ])
    ),
    'normalized-url'
  );

  assert.equal(results.length, 1);
  assert.equal(results[0].id, 'current-doc');
  assert.equal(results[0].title, 'Current Docs');
  assert.equal(results[0].totalVisitCount, 21);
});

test('two-stage dedupe merges one normalized URL before comparing page titles', () => {
  const url =
    'https://dataleap-tx.tiktok-row.net/coral/datamap/result?query=i18n_ecom_alliance.ods_agent_trajectory_segments';
  const urlDedupedItems = dedupeHistoryItems(
    [
      { id: 'old-title', title: 'ods_agent_trajectory_segments', url, visitCount: 3 },
      { id: 'new-title', title: 'DataLeap - 数据地图', url, visitCount: 11 }
    ],
    'normalized-url'
  );
  const results = dedupeHistoryItems(urlDedupedItems, 'page-title');

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

test('exact URL mode does not collapse query parameter variants', () => {
  const results = dedupeHistoryItems(
    [
      { id: 'a', url: 'https://example.com/a?x=1', lastVisitTime: 100 },
      { id: 'b', url: 'https://example.com/a?x=2', lastVisitTime: 200 }
    ],
    'exact-url'
  );

  assert.deepEqual(
    results.map((item) => item.id),
    ['b', 'a']
  );
});

test('normalized URL and minimal modes keep DataLeap detail and search-result pages distinct', () => {
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

  const minimalResults = dedupeHistoryItems(results, 'minimal-service');
  assert.equal(minimalResults.length, 2);
  assert.deepEqual(
    new Set(minimalResults.map((item) => item.url)),
    new Set([detailUrl, resultUrl])
  );
});

test('domain mode collapses all pages from the same hostname', () => {
  const [result] = dedupeHistoryItems(
    [
      { id: 'home', url: 'https://example.com/', lastVisitTime: 100 },
      { id: 'docs', url: 'https://example.com/docs', lastVisitTime: 300 },
      { id: 'blog', url: 'https://EXAMPLE.com/blog', lastVisitTime: 200 }
    ],
    'domain'
  );

  assert.equal(result.id, 'docs');
  assert.equal(result.dedupeCount, 3);
  assert.equal(result.dedupeKey, 'example.com');
});

test('invalid URLs fall back to their raw URL string', () => {
  const key = normalizeHistoryKey({ url: 'not a valid url' }, 'normalized-url');

  assert.equal(key, 'not a valid url');
});

test('page title mode collapses same live-title tabs of one stable resource', () => {
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
    'page-title'
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

test('page title mode keeps unrelated resources with the same original title distinct', () => {
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
    'page-title'
  );

  assert.equal(results.length, 2);
});

test('page title mode ignores page-state query variants on the same route', () => {
  const results = dedupeHistoryItems(
    [
      {
        id: 'release-overview',
        identityTitle: '代码发布管理 US-TTP BDEE - 字节云',
        title: '代码发布管理 US-TTP BDEE - 字节云',
        url: 'https://cloud.example.com/release-management?activeTab=overview&view=summary',
        visitCount: 2
      },
      {
        id: 'release-instances',
        identityTitle: '代码发布管理 US-TTP BDEE - 字节云',
        title: '代码发布管理 US-TTP BDEE - 字节云',
        url: 'https://cloud.example.com/release-management?activeTab=instances&timestamp=123',
        visitCount: 3
      }
    ],
    'page-title'
  );

  assert.equal(results.length, 1);
  assert.equal(results[0].dedupeCount, 2);
  assert.equal(results[0].totalVisitCount, 5);
});

test('page family mode merges non-resource query variants and keeps a manual rename', () => {
  const url1 =
    'https://cloud-ttp-us.bytedance.net/tcc/namespace/bytedance.mcp.ecom_affiliate_tools?by_key=false&condition=name&configId=&dir_path=all_dir&env=ppe_product_selection_niubei&filter_empty_dir=false&filter_no_tag=false&keyword=&order=&pn=1&region=all_region&release_operator=&release_status=&rn=20&scope=all&source=&tab=';
  const url2 =
    'https://cloud-ttp-us.bytedance.net/tcc/namespace/bytedance.mcp.ecom_affiliate_tools?by_key=false&condition=name&configId=&dir_path=all_dir&env=prod&filter_empty_dir=false&filter_no_tag=false&keyword=&order=&pn=1&region=all_region&release_operator=&release_status=&rn=20&scope=all&source=&tab=';
  const capturedTitle = 'TCC 配置管理 - 字节云';
  const items = applyTitleOverridesToItems(
    [
      {
        id: 'ppe',
        identityTitle: capturedTitle,
        title: capturedTitle,
        url: url1,
        lastVisitTime: 100,
        visitCount: 1
      },
      {
        id: 'prod',
        identityTitle: capturedTitle,
        title: capturedTitle,
        url: url2,
        lastVisitTime: 200,
        visitCount: 20
      }
    ],
    new Map([[normalizeHistoryKey({ url: url1 }, 'normalized-url'), 'TCC PPE 配置']])
  );
  const urlDedupedItems = dedupeHistoryItems(items, 'normalized-url');
  const [result] = dedupeHistoryItems(urlDedupedItems, 'page-family');

  assert.equal(result.id, 'ppe');
  assert.equal(result.title, 'TCC PPE 配置');
  assert.equal(result.totalVisitCount, 21);
  assert.equal(result.dedupeCount, 2);
});

test('page family mode keeps only the latest rename after query variants merge', () => {
  const url1 =
    'https://cloud-ttp-us.bytedance.net/tcc/namespace/bytedance.mcp.ecom_affiliate_tools?by_key=false&condition=name&configId=&dir_path=all_dir&env=ppe_product_selection_niubei&filter_empty_dir=false&filter_no_tag=false&keyword=&order=&pn=1&region=all_region&release_operator=&release_status=&rn=20&scope=all&source=&tab=';
  const url2 =
    'https://cloud-ttp-us.bytedance.net/tcc/namespace/bytedance.mcp.ecom_affiliate_tools?by_key=false&condition=name&configId=&dir_path=all_dir&env=prod&filter_empty_dir=false&filter_no_tag=false&keyword=&order=&pn=1&region=all_region&release_operator=&release_status=&rn=20&scope=all&source=&tab=';
  const capturedTitle = 'TCC 配置管理 - 字节云';
  const items = applyTitleOverridesToItems(
    [
      {
        id: 'ppe',
        identityTitle: capturedTitle,
        title: capturedTitle,
        url: url1,
        lastVisitTime: 100,
        visitCount: 1
      },
      {
        id: 'prod',
        identityTitle: capturedTitle,
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
  const [result] = dedupeHistoryItems(urlDedupedItems, 'page-family');

  assert.equal(result.id, 'prod');
  assert.equal(result.title, 'TCC Prod 配置');
  assert.equal(result.isTitleRenamed, true);
  assert.equal(result.totalVisitCount, 21);
});

test('history titles remain search-only aliases without affecting display or cross-URL dedupe', () => {
  const items = applyCapturedTitlesToItems([
    { id: 'a', title: 'Docs', url: 'https://example.com/doc/abc12345' },
    { id: 'b', title: 'Docs', url: 'https://example.com/doc/xyz98765' }
  ]);

  assert.equal(items[0].title, '');
  assert.equal(items[1].title, '');
  assert.equal(filterHistoryItemsByQuery(items, 'Docs').length, 2);
  assert.equal(dedupeHistoryItems(items, 'page-title').length, 2);
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

test('page title mode falls back to normalized URL when title is empty', () => {
  const results = dedupeHistoryItems(
    [
      {
        id: 'older-empty-title',
        title: '',
        url: 'https://example.com/a/?utm_source=test',
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
    'page-title'
  );

  assert.equal(results.length, 1);
  assert.equal(results[0].id, 'newer-empty-title');
  assert.equal(results[0].dedupeKey, 'https://example.com/a');
});

test('page title mode ignores zero-width characters in titles', () => {
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
    'page-title'
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
  const renamedItems = applyTitleOverridesToItems(
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
  const pageKey = 'https://example.com/projects/prj12345';
  const items = applyTitleOverridesToItems(
    [
      {
        id: 'overview',
        identityTitle: 'Project Overview',
        title: 'Project Overview',
        url: `${pageKey}/overview`,
        lastVisitTime: 300,
        visitCount: 20
      },
      {
        id: 'settings',
        identityTitle: 'Project Settings',
        title: 'Project Settings',
        url: `${pageKey}/settings`,
        lastVisitTime: 100,
        visitCount: 1
      }
    ],
    new Map([[pageKey, {
      title: '核心项目',
      targetUrl: `${pageKey}/settings`,
      updatedAt: 200
    }]])
  );
  const renamedItems = items.filter((item) => item.isTitleRenamed);
  const [result] = dedupeHistoryItems(items, 'page-family');

  assert.deepEqual(renamedItems.map((item) => item.id), ['settings']);
  assert.equal(result.id, 'settings');
  assert.equal(result.title, '核心项目');
  assert.equal(result.totalVisitCount, 21);
  assert.equal(result.lastVisitTime, 300);
});

test('page family identity stops at the first resource id and merges later child resources', () => {
  const taskA = normalizeHistoryKey({
    url: 'https://example.com/projects/prj12345/tasks/task0001/overview'
  }, 'page-family');
  const taskB = normalizeHistoryKey({
    url: 'https://example.com/projects/prj12345/tasks/task0002/settings'
  }, 'page-family');

  assert.equal(taskA, 'https://example.com/projects/prj12345');
  assert.equal(taskA, taskB);
});

test('resource identity ignores every path suffix after the first resource id', () => {
  const alice = normalizeHistoryKey({
    url: 'https://example.com/projects/prj12345/members/alice'
  }, 'page-family');
  const bob = normalizeHistoryKey({
    url: 'https://example.com/projects/prj12345/members/bob'
  }, 'page-family');

  assert.equal(alice, 'https://example.com/projects/prj12345');
  assert.equal(alice, bob);
});

test('path resource identities ignore query resource ids after the first path id', () => {
  const first = normalizeHistoryKey({
    url: 'https://aeolus.example.com/aeolus/pages/queryEditor/files/6337616?appId=1000137&taskId=281475001639962'
  }, 'page-family');
  const second = normalizeHistoryKey({
    url: 'https://aeolus.example.com/aeolus/pages/queryEditor/files/6337616?appId=1000137&folderId=882956&taskId=281475001533557'
  }, 'page-family');

  assert.equal(first, 'https://aeolus.example.com/aeolus/pages/queryEditor/files/6337616');
  assert.equal(first, second);
});

test('page family identity ignores all non-resource query parameters', () => {
  const tabA = normalizeHistoryKey({
    url: 'https://example.com/report?query=alpha&activeTab=summary&timestamp=100'
  }, 'page-family');
  const tabB = normalizeHistoryKey({
    url: 'https://example.com/report?query=alpha&activeTab=details&timestamp=200'
  }, 'page-family');
  const otherContent = normalizeHistoryKey({
    url: 'https://example.com/report?query=beta&activeTab=summary'
  }, 'page-family');

  assert.equal(tabA, 'https://example.com/report');
  assert.equal(tabA, tabB);
  assert.equal(tabA, otherContent);
});

test('Dorado instance query variants collapse and keep the preferred representative', () => {
  const baseUrl = 'https://dataleap-va.tiktok-row.net/dorado/instance';
  const projectUrl =
    `${baseUrl}?_instanceD_=project%253Di18n_1867%2526id%253D109477584%2526tab%253Doverview`;
  const searchUrl =
    `${baseUrl}?searchType=content&keyword=109477584&schedule=2026-07-16&tab=runtime`;
  const popularUrl =
    `${baseUrl}?_instanceD_=project%253Di18n_1867%2526id%253D109477584%2526tab%253Dmonitor`;
  const rawItems = [
    {
      id: 'project-overview',
      title: '实例运维 - Dorado',
      url: projectUrl,
      lastVisitTime: 200,
      visitCount: 3
    },
    {
      id: 'search-transition',
      title: searchUrl,
      url: searchUrl,
      lastVisitTime: 300,
      visitCount: 1
    },
    {
      id: 'popular-monitor',
      title: '实例运维 - Dorado',
      url: popularUrl,
      lastVisitTime: 100,
      visitCount: 8
    }
  ];

  assert.deepEqual(
    rawItems.map((item) => normalizeHistoryKey(item, 'page-family')),
    [baseUrl, baseUrl, baseUrl]
  );

  const [popular] = dedupeHistoryItems(
    dedupeHistoryItems(rawItems, 'normalized-url'),
    'page-family'
  );
  assert.equal(popular.id, 'popular-monitor');
  assert.equal(popular.totalVisitCount, 12);
  assert.equal(popular.dedupeCount, 3);
  assert.deepEqual(
    filterHistoryItemsByQuery([popular], 'dorado/instance?searchType=content')
      .map((item) => item.id),
    []
  );

  const renamedItems = applyTitleOverridesToItems(
    rawItems,
    new Map([[baseUrl, {
      title: '我的实例运维',
      targetUrl: searchUrl,
      updatedAt: 500
    }]])
  );
  const [renamed] = dedupeHistoryItems(
    dedupeHistoryItems(renamedItems, 'normalized-url'),
    'page-family'
  );
  assert.equal(renamed.id, 'search-transition');
  assert.equal(renamed.title, '我的实例运维');
  assert.equal(renamed.totalVisitCount, 12);
  assert.equal(renamed.dedupeCount, 3);
});

test('page family identity preserves only canonical resource ID query parameters', () => {
  const taskA = normalizeHistoryKey({
    url: 'https://example.com/detail?taskId=123456&filter=failed&tabId=logs'
  }, 'page-family');
  const taskB = normalizeHistoryKey({
    url: 'https://example.com/detail?task_id=123456&filter=success&env=prod'
  }, 'page-family');
  const taskC = normalizeHistoryKey({
    url: 'https://example.com/detail?task-id=654321&filter=failed'
  }, 'page-family');
  const qualifiedCamel = normalizeHistoryKey({
    url: 'https://example.com/detail?qualifiedName=HiveTable%3A%2F%2F%2Forders&tab=schema'
  }, 'page-family');
  const qualifiedSnake = normalizeHistoryKey({
    url: 'https://example.com/detail?qualified_name=HiveTable%3A%2F%2F%2Forders&tab=lineage'
  }, 'page-family');
  const otherQualifiedName = normalizeHistoryKey({
    url: 'https://example.com/detail?qualifiedName=HiveTable%3A%2F%2F%2Fusers'
  }, 'page-family');

  assert.equal(taskA, 'https://example.com/detail?task_id=123456');
  assert.equal(taskA, taskB);
  assert.notEqual(taskA, taskC);
  assert.equal(qualifiedCamel, qualifiedSnake);
  assert.notEqual(qualifiedCamel, otherQualifiedName);
});

test('keyword search route treats all search parameters as one page state', () => {
  const baseUrl = 'https://cloud.example.com/argos/streamlog/info_overview/keyword_search';
  const first = normalizeHistoryKey({
    url: `${baseUrl}?auto_search=false&data_source=service_a&keyword=timeout`
  }, 'page-family');
  const second = normalizeHistoryKey({
    url: `${baseUrl}?auto_search=true&data_source=service_b&keyword=panic&region=us`
  }, 'page-family');
  const resourceShaped = normalizeHistoryKey({
    url: `${baseUrl}?task_id=123456&keyword=rpc`
  }, 'page-family');

  assert.equal(first, baseUrl);
  assert.equal(second, baseUrl);
  assert.equal(resourceShaped, baseUrl);
  assert.equal(
    normalizeHistoryKey({
      url: 'https://cloud.example.com/#/argos/keyword_search?keyword=panic&task_id=123456'
    }, 'page-family'),
    'https://cloud.example.com/#/argos/keyword_search'
  );
  assert.equal(
    normalizeHistoryKey({
      url: 'https://cloud.example.com/argos/keyword_searching?keyword=panic'
    }, 'page-family'),
    'https://cloud.example.com/argos/keyword_searching'
  );
  assert.notEqual(
    normalizeHistoryKey({
      url: 'https://cloud.example.com/argos/keyword_search/result?task_id=123456'
    }, 'page-family'),
    'https://cloud.example.com/argos/keyword_search/result'
  );
});

test('resource paths ignore non-resource query context', () => {
  const prod = normalizeHistoryKey({
    url: 'https://example.com/projects/prj12345/overview?env=prod&activeTab=logs&from=recent'
  }, 'page-family');
  const ppe = normalizeHistoryKey({
    url: 'https://example.com/projects/prj12345/settings?env=ppe&activeTab=config'
  }, 'page-family');

  assert.equal(prod, 'https://example.com/projects/prj12345');
  assert.equal(ppe, 'https://example.com/projects/prj12345');
  assert.equal(prod, ppe);
});

test('keyword search variants keep only the renamed representative', () => {
  const baseUrl = 'https://cloud.example.com/argos/streamlog/info_overview/keyword_search';
  const items = applyTitleOverridesToItems(
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
    new Map([[baseUrl, {
      title: 'Argos 日志',
      targetUrl: `${baseUrl}?keyword=timeout&data_source=service_a`,
      updatedAt: 200
    }]])
  );
  const [result] = dedupeHistoryItems(items, 'page-family');

  assert.equal(result.id, 'renamed');
  assert.equal(result.title, 'Argos 日志');
  assert.equal(result.totalVisitCount, 24);
  assert.equal(result.dedupeCount, 3);
  assert.equal(result.lastVisitTime, 500);
});

test('normal anchors merge while hash-router resources remain distinct', () => {
  assert.equal(
    normalizeHistoryKey({ url: 'https://example.com/docs#comments' }, 'page-family'),
    normalizeHistoryKey({ url: 'https://example.com/docs#top' }, 'page-family')
  );
  assert.notEqual(
    normalizeHistoryKey({ url: 'https://example.com/#/docs/doc0001/overview' }, 'page-family'),
    normalizeHistoryKey({ url: 'https://example.com/#/docs/doc0002/overview' }, 'page-family')
  );
  assert.equal(
    normalizeHistoryKey({ url: 'https://example.com/#/docs/doc0001/overview' }, 'page-family'),
    normalizeHistoryKey({ url: 'https://example.com/#/docs/doc0001/settings' }, 'page-family')
  );
});

test('hash routes ignore shell and route state query while preserving resource IDs', () => {
  const reportA = normalizeHistoryKey({
    url: 'https://example.com/?theme=dark#/reports?query=alpha&tab=summary'
  }, 'page-family');
  const reportB = normalizeHistoryKey({
    url: 'https://example.com/?theme=light#/reports?query=beta&tab=details'
  }, 'page-family');
  const taskA = normalizeHistoryKey({
    url: 'https://example.com/?source=mail#/detail?taskId=123456&filter=failed'
  }, 'page-family');
  const taskB = normalizeHistoryKey({
    url: 'https://example.com/?source=chat#/detail?task_id=123456&filter=success'
  }, 'page-family');
  const taskC = normalizeHistoryKey({
    url: 'https://example.com/#/detail?task_id=654321&filter=failed'
  }, 'page-family');

  assert.equal(reportA, 'https://example.com/#/reports');
  assert.equal(reportA, reportB);
  assert.equal(taskA, 'https://example.com/#/detail?task_id=123456');
  assert.equal(taskA, taskB);
  assert.notEqual(taskA, taskC);
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
      url: 'https://example.com/docs/doc0001/overview',
      lastVisitTime: 500,
      visitCount: 2,
      totalVisitCount: 2,
      dedupeCount: 2
    },
    {
      id: 'large-older',
      url: 'https://example.com/docs/doc0001/settings',
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
      url: 'https://example.com/projects/prj12345/overview?utm_source=mail',
      lastVisitTime: 100,
      visitCount: 6
    },
    {
      id: 'overview-chat',
      url: 'https://example.com/projects/prj12345/overview?utm_source=chat',
      lastVisitTime: 200,
      visitCount: 6
    },
    {
      id: 'settings',
      url: 'https://example.com/projects/prj12345/settings',
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
      url: 'https://example.com/projects/prj12345/overview',
      visitCount: 20
    },
    {
      id: 'rare',
      title: 'Audit Timeline',
      url: 'https://example.com/projects/prj12345/audit',
      visitCount: 1
    }
  ], 'page-family');

  assert.equal(family.id, 'popular');
  assert.deepEqual(filterHistoryItemsByQuery([family], 'Audit Timeline').map((item) => item.id), [
    'popular'
  ]);
});

test('minimal service mode merges tab-like pages under the same resource id', () => {
  const results = dedupeHistoryItems(
    [
      {
        id: 'tools',
        title: 'MCP Server Tools',
        url: 'https://cloud-ttp-us.bytedance.net/tae/mcp_server/rd2nw9df/tools',
        lastVisitTime: 200,
        visitCount: 2
      },
      {
        id: 'inspector',
        title: 'MCP Server Inspector',
        url: 'https://cloud-ttp-us.bytedance.net/tae/mcp_server/rd2nw9df/inspector',
        lastVisitTime: 100,
        visitCount: 1
      }
    ],
    'minimal-service'
  );

  assert.equal(results.length, 1);
  assert.equal(
    results[0].dedupeKey,
    'https://cloud-ttp-us.bytedance.net/tae/mcp_server/rd2nw9df'
  );
  assert.equal(results[0].dedupeCount, 2);
  assert.equal(results[0].totalVisitCount, 3);
});

test('minimal service mode prefers a renamed item within a merged service bucket', () => {
  const results = dedupeHistoryItems(
    [
      {
        id: 'popular-tools',
        title: 'MCP Server Tools',
        url: 'https://cloud-ttp-us.bytedance.net/tae/mcp_server/rd2nw9df/tools',
        lastVisitTime: 300,
        visitCount: 20,
        isTitleRenamed: false
      },
      {
        id: 'renamed-inspector',
        title: '核心 MCP 服务',
        url: 'https://cloud-ttp-us.bytedance.net/tae/mcp_server/rd2nw9df/inspector',
        lastVisitTime: 100,
        visitCount: 1,
        isTitleRenamed: true
      }
    ],
    'minimal-service'
  );

  assert.equal(results.length, 1);
  assert.equal(results[0].id, 'renamed-inspector');
  assert.equal(results[0].title, '核心 MCP 服务');
  assert.equal(results[0].totalVisitCount, 21);
});

test('minimal service mode merges ordinary query variants by path', () => {
  const results = dedupeHistoryItems(
    [
      {
        id: 'search-a',
        title: 'Search A',
        url: 'https://example.com/search?q=alpha',
        lastVisitTime: 200,
        visitCount: 1
      },
      {
        id: 'search-b',
        title: 'Search B',
        url: 'https://example.com/search?q=beta',
        lastVisitTime: 100,
        visitCount: 1
      }
    ],
    'minimal-service'
  );

  assert.equal(results.length, 1);
  assert.equal(results[0].id, 'search-a');
  assert.equal(results[0].totalVisitCount, 2);
});

test('minimal service mode keeps root resource query URLs valid', () => {
  const key = normalizeHistoryKey(
    {
      url: 'https://example.com/?id=123&utm_source=mail'
    },
    'minimal-service'
  );

  assert.equal(key, 'https://example.com/?id=123');
});

test('minimal service mode does not merge tab-like paths without a resource id', () => {
  const results = dedupeHistoryItems(
    [
      {
        id: 'project-tools',
        title: 'Project Tools',
        url: 'https://example.com/project/acme/tools',
        lastVisitTime: 200,
        visitCount: 1
      },
      {
        id: 'project-inspector',
        title: 'Project Inspector',
        url: 'https://example.com/project/acme/inspector',
        lastVisitTime: 100,
        visitCount: 1
      }
    ],
    'minimal-service'
  );

  assert.equal(results.length, 2);
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

test('domain groups sort by the sum of visit counts across the group', () => {
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

test('groups rank by pinned then visit count then rename then latest visit time', () => {
  const rankedItems = dedupeHistoryItems(
    applyTitleOverridesToItems(
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
    groupHistoryItemsByCandidateRank(rankedItems),
    new Set()
  );

  assert.deepEqual(groups.map((group) => group.key), [
    'frequent.example',
    'renamed.example'
  ]);

  const pinnedGroups = applyPinnedStateToGroups(
    groupHistoryItemsByCandidateRank(rankedItems),
    new Set(['https://renamed.example/page'])
  );
  assert.deepEqual(pinnedGroups.map((group) => group.key), [
    'renamed.example',
    'frequent.example'
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
    applyTitleOverridesToItems(
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

test('candidate-ranked grouping follows the best matching tab instead of group traffic', () => {
  const groups = groupHistoryItemsByCandidateRank([
    { id: 'top-tab', url: 'https://small.example/top', lastVisitTime: 500, visitCount: 1 },
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

  assert.equal(key, 'https://example.com/docs');
});

test('title override keys normalize URLs so tracking variants share one custom title', () => {
  const key = getHistoryItemTitleOverrideKey({
    url: 'https://example.com/docs/?utm_source=mail&b=2#section'
  });

  assert.equal(key, 'https://example.com/docs');
});

test('captured live titles replace stale history titles before manual overrides', () => {
  const url = 'https://example.com/doc/abc12345';
  const capturedItems = applyCapturedTitlesToItems(
    [{ id: 'doc', title: 'Docs', url }],
    new Map([[url, '真实文档标题 - 飞书云文档']])
  );
  const renamedItems = applyTitleOverridesToItems(
    capturedItems,
    new Map([[url, '我的自定义标题']])
  );

  assert.equal(capturedItems[0].title, '真实文档标题 - 飞书云文档');
  assert.equal(capturedItems[0].historyTitle, 'Docs');
  assert.equal(capturedItems[0].identityTitle, '真实文档标题 - 飞书云文档');
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

test('captured titles follow first-id page identity across nested resource URLs', () => {
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

  assert.equal(items[0].dedupeUrl, 'https://example.com/projects/prj12345/tasks/task0001/overview');
  assert.equal(items[1].dedupeUrl, 'https://example.com/projects/prj12345/tasks/task0001/overview');
  assert.equal(dedupeHistoryItems(items, 'page-family').length, 1);
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

test('title overrides affect display without becoming page-title dedupe identity', () => {
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
  const renamedItems = applyTitleOverridesToItems(
    rawItems,
    new Map([['https://example.com/docs', 'Guide']])
  );
  const results = dedupeHistoryItems(renamedItems, 'page-title');

  assert.equal(results.length, 2);
});

test('keyword search keeps renamed and unrenamed same-title pages separate across resources', () => {
  const detailUrl =
    'https://dataleap-tx.tiktok-row.net/coral/datamap/detail?groupName=og&qualifiedName=HiveTable%3A%2F%2F%2Fi18n_ecom_alliance%2Fods_agent_trajectory_segments%409&subTab=schema&tab=table_info#group=og';
  const resultUrl =
    'https://dataleap-tx.tiktok-row.net/coral/datamap/result?query=i18n_ecom_alliance.ods_agent_trajectory_segments';
  const renamedItems = applyTitleOverridesToItems(
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
    'page-title'
  );

  assert.equal(results.length, 2);
  assert.equal(results.find((item) => item.id === 'detail')?.isTitleRenamed, true);
});

test('page title dedupe keeps tab variants of one resource together', () => {
  const [result] = dedupeHistoryItems(
    applyTitleOverridesToItems([
      {
        id: 'docs-a',
        title: 'Docs',
        url: 'https://example.com/docs/abc12345/overview',
        lastVisitTime: 100,
        visitCount: 1
      },
      {
        id: 'docs-b',
        title: 'Docs',
        url: 'https://example.com/docs/abc12345/settings',
        lastVisitTime: 200,
        visitCount: 2
      }
    ]),
    'page-title'
  );

  assert.deepEqual(result.titleOverrideKeys, [
    'https://example.com/docs/abc12345'
  ]);
});

test('query filtering searches effective titles but never URLs', () => {
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
  const renamedItems = applyTitleOverridesToItems(
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
    []
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
  const [renamedItem] = applyTitleOverridesToItems(
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
    applyTitleOverridesToItems(
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

test('renamed view sorts pinned and unpinned sections independently by display name', () => {
  const items = applyPinnedStateToItemsByName(
    [
      { id: 'unpinned-z', title: 'Zulu', url: 'https://example.com/z' },
      { id: 'pinned-z', title: 'Pinned Zulu', url: 'https://example.com/pinned-z' },
      { id: 'unpinned-a', title: 'Alpha', url: 'https://example.com/a' },
      { id: 'pinned-a', title: 'Pinned Alpha', url: 'https://example.com/pinned-a' }
    ],
    new Set(['https://example.com/pinned-z', 'https://example.com/pinned-a'])
  );

  assert.deepEqual(
    items.map((item) => item.id),
    ['pinned-a', 'pinned-z', 'unpinned-a', 'unpinned-z']
  );
});

test('renamed view places Latin names before Chinese names within each pin section', () => {
  const items = applyPinnedStateToItemsByName(
    [
      { id: 'chinese', title: '压测', url: 'https://example.com/load-test' },
      { id: 'eval', title: 'Eval 发版', url: 'https://example.com/eval' },
      { id: 'agent', title: 'Agent 编译', url: 'https://example.com/agent' }
    ],
    new Set()
  );

  assert.deepEqual(items.map((item) => item.id), ['agent', 'eval', 'chinese']);
});
