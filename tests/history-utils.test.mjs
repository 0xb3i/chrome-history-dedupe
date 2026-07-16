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
  normalizeHistoryKey
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

test('normalized URL mode keeps two manually renamed redirect aliases in one bucket', () => {
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

  assert.deepEqual(
    results.map((item) => item.id),
    ['current-doc', 'legacy-doc']
  );
  assert.deepEqual(
    results.map((item) => item.title),
    ['Current Docs', 'Legacy Docs']
  );
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
  assert.match(results[0].dedupeKey, /mcp inspector/);
  assert.match(results[0].dedupeKey, /4syx48fa/);
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
        url: 'https://cloud.example.com/release-management?activeTab=overview&from=recent',
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

test('page title mode keeps a renamed route variant before the higher-visit sibling', () => {
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
  const [result] = dedupeHistoryItems(urlDedupedItems, 'page-title');

  assert.equal(result.id, 'ppe');
  assert.equal(result.title, 'TCC PPE 配置');
  assert.equal(result.url, url1);
  assert.equal(result.totalVisitCount, 21);
});

test('page title mode keeps two renamed route variants in one bucket', () => {
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
      [normalizeHistoryKey({ url: url1 }, 'normalized-url'), 'TCC PPE 配置'],
      [normalizeHistoryKey({ url: url2 }, 'normalized-url'), 'TCC Prod 配置']
    ])
  );
  const urlDedupedItems = dedupeHistoryItems(items, 'normalized-url');
  const results = dedupeHistoryItems(urlDedupedItems, 'page-title');

  assert.deepEqual(
    results.map((item) => item.id),
    ['prod', 'ppe']
  );
  assert.deepEqual(
    results.map((item) => item.title),
    ['TCC Prod 配置', 'TCC PPE 配置']
  );
});

test('stale history titles never affect display search or cross-URL dedupe', () => {
  const items = applyCapturedTitlesToItems([
    { id: 'a', title: 'Docs', url: 'https://example.com/doc/abc12345' },
    { id: 'b', title: 'Docs', url: 'https://example.com/doc/xyz98765' }
  ]);

  assert.equal(items[0].title, '');
  assert.equal(items[1].title, '');
  assert.equal(filterHistoryItemsByQuery(items, 'Docs').length, 0);
  assert.equal(dedupeHistoryItems(items, 'page-title').length, 2);
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
  assert.match(
    results[0].dedupeKey,
    /^联盟搜索 & agent 周报 20260603 - 20260609 - 飞书云文档\n/
  );
  assert.match(results[0].dedupeKey, /FkjVwUDZciqChskTeQcc2ATjnQb/);
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

test('minimal service mode keeps ordinary query variants distinct when no resource id is visible', () => {
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

  assert.equal(results.length, 2);
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

  assert.equal(key, 'https://example.com/docs?b=2');
});

test('title override keys normalize URLs so tracking variants share one custom title', () => {
  const key = getHistoryItemTitleOverrideKey({
    url: 'https://example.com/docs/?utm_source=mail&b=2#section'
  });

  assert.equal(key, 'https://example.com/docs?b=2');
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
    'https://example.com/docs/abc12345/overview',
    'https://example.com/docs/abc12345/settings'
  ]);
});

test('query filtering searches effective renamed titles and URLs', () => {
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
    ['plain']
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

test('plain keywords search titles only and ignore hidden URL parameters', () => {
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
    ['unrelated-doc']
  );
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

test('renamed pages sort after pinned pages and before natural group order', () => {
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
