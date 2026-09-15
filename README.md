# Deduped History Search

Lightweight Chrome extension for searching history with automatic URL deduplication.

## Install

1. Open `chrome://extensions`.
2. Enable `Developer mode`.
3. Click `Load unpacked`.
4. Select the directory containing this project’s `manifest.json` (currently `/Users/bytedance/history-dedupe`).

After loading, `chrome://history` opens this deduped search page. Disable the extension to return to Chrome's native history page.

## Shortcut

The extension suggests `Option+S` on macOS and `Alt+S` on other platforms to open the popup search panel. It also suggests `Option+Shift+S` on macOS and `Alt+Shift+S` elsewhere to rename the current page inside the extension. Chrome lets you change or clear shortcuts at `chrome://extensions/shortcuts`.

The popup supports 24-hour, 7-day, 30-day, 90-day, and all-history searches and remembers the last search term, time filter, and renamed-pages filter, so reopening it with the shortcut returns to the same search context. A background index keeps committed search data ready before the popup opens, so keyword searches never wait for Chrome's History API.

The rename shortcut opens an inline dialog on the active page. Restricted pages fall back to a popup centered over the active Chrome window. Rename saves acknowledge durable storage immediately; background indexing does not block the dialog.

## 行为与架构（0.13.0）

弹窗的同名分组在展开时才生成子链接与地址说明，每次加载 30 条；继续加载会追加内容，后台刷新保留已展开的数量，避免打开弹窗时生成大量不可见节点。

标题或曾用名含搜索命中时自动换行，完整显示高亮，避免后半段的关键词被单行省略号遮住。

- **资源身份**：独立资源分别保留。未知网址保留完整路径、非跟踪查询参数和 fragment，不再按“第一个像 ID 的片段”截断。飞书官方域上的同类型文档 token 可跨租户域归并；字节云 MCP server 的 `tools` / `inspector` 合并为同一资源。表格子资源参数保持独立。Google 搜索保留 `q`，忽略分页和辅助参数。
- **导航别名**：只有浏览器确认的同一次主框架服务器重定向才建立别名。取消加载、切换地址、SPA 和无法明确归属的导航不会推断成同一页面。旧版本未经验证的跳转关系不再参与归并。
- **代表链接与统计**：以完整历史归并资源，再按所选时间筛选最近访问的资源。默认链接由规范化 URL 的累计访问次数、最近访问和稳定键选出；手动重命名保留用户指定的目标链接。
- **重命名**：名称、目标链接、更新时间独立保存，即时更新显示与搜索。已重命名页面不受时间筛选限制，但只有对应资源仍存在于 Chrome 历史中才显示。它不是独立书签库。旧名称按保存的目标链接迁移到具体资源。
- **结果组织与排序**：Command + Y 打开的完整历史页采用时间线，首次打开默认全部时间、最近访问倒序；按本地日期分隔，每个资源独立一行，左侧显示访问时间，不再折叠域名或同名页面。每次展示 50 条，可继续加载；按最近访问排序时，置顶、重命名和点击次数不改变时间先后。完整页与弹窗分别保存搜索词、时间范围和排序偏好。弹窗保留同名折叠和每批 30 项；默认按置顶、搜索匹配、重命名、次数和最近访问排序。两种视图均可选点击次数降序、上次访问降序和名称升序；名称支持中文及自然数字顺序。弹窗的所有排序，以及完整页的次数和名称排序，保留置顶顺序。切换排序不重新读取历史。来源标签优先显示自定义分组名，色点由域名稳定决定；在完整页点击来源标签可修改分组名。
- **同名链接**：弹窗中，同一域名内，未重命名、未置顶的同名结果显示为统一的结果行，标题直接打开组内累计访问最多的链接，并显示最近访问与合计次数；右侧链接数量用于展开和收起。每条子链接显示累计访问次数；默认按次数、最近访问时间和稳定键排序，切换排序后子链接遵循所选规则；组外位置仍沿用搜索结果排序。展开后优先展示能区分目标的相对路径；已识别的 Codebase/GitLab 同一合并请求页签显示概览、文件变更或提交记录，未知路由保留真实路径。只有仍然重名的选项才补充锚点、参数等必要信息，凭证值不在列表中明文显示。关键内容允许换行，不因截断而丢失区别；重命名和置顶操作保留，访问时间和完整网址放在悬停信息中。长列表在组内滚动，避免撑长页面。也可通过浏览器链接菜单复制完整网址；实际打开地址保持完整。显示分组不改变资源身份。
- **筛选与反馈**：`仅已命名` 是结果筛选；`显示` 菜单管理网址路径显隐，弹窗还提供全部展开/折叠。结果数量始终可见，已命名页面因不受时间范围限制而保留时显示“跨时间保留”。无结果时提供扩大时间范围、清除筛选、清空关键词等适用操作，读取失败可以重试，操作失败显示可见提示。
- **即时搜索**：输入停顿 180ms 后搜索，中文输入法组合期间不提交，时间和命名筛选即选即生效。输入草稿与已提交条件仍独立，后台刷新使用已提交条件，旧请求不能覆盖新请求或较新的索引；初始化也不会覆盖用户刚修改的筛选偏好。显示标题中的命中内容高亮；命中历史名称时显示真实曾用名及对应高亮。搜索只匹配标题（含归并成员的标题），仍打开资源的稳定代表链接；中文支持有界简称匹配。
- **标题来源**：显示优先采用自定义名称，其次实时捕获的页面标题，最后显示 URL。Chrome 历史标题只用于搜索。最多保存 5,000 条实时标题记录。

后台保留原始历史，并以原子 generation 发布可重建的派生索引。每轮构建只执行一次全量资源归并，仅持久化一份完整资源索引，前台在该索引上按最近访问时间过滤，切换时间无需重建索引。重命名直接更新用户数据投影，不触发全量索引重建；前台关键词搜索不访问 History API。索引写入和回收由 Web Locks 协调，失败或 Worker 终止留下的未发布分片会安全回收。

核心边界：`page-identity.js` 负责身份；`history-utils.js` 负责事实归并与统一排序；`search-match.js` 负责匹配解释与原文高亮区间；`history-index/project.js` 负责用户名称投影；`search-state.js` 管理已提交条件和索引版本；`live-search.js` 管理输入防抖与输入法状态；`rename-session.js` 隔离异步弹窗会话。

## Local Data

The extension requests `activeTab`, `alarms`, `history`, `scripting`, `storage`, `tabs`, and `webNavigation` permissions. It does not upload or sync history. Pinned pages, custom page names, and the last search state are stored locally in `chrome.storage.local`; the rebuildable search index is stored locally in extension IndexedDB. `alarms` performs an hourly background reconciliation so searches never have to wait for it. `webNavigation` distinguishes committed redirects from canceled navigations. The `activeTab` and `scripting` permissions are used only to show the inline rename dialog on the current page.

## 备份与恢复

打开完整历史页，右上角「备份」会导出一份 JSON，包含页面重命名、分组名和置顶顺序。「恢复」选择备份文件后合并导入，保留当前已有名称与置顶顺序，并迁移旧版数据；重复导入不会增加重复记录。原始浏览历史、自动捕获标题和搜索索引不包含在备份中。恢复后，页面仍需存在于 Chrome 历史记录里才能显示。

未打包扩展的 ID 可能随加载目录变化；不同 ID 的本地数据彼此隔离。移动目录、删除或重新安装前先备份，普通升级在扩展管理页点击「重新加载」即可。此功能是手动备份，尚未导出的新增修改不会自动保存到文件。

## Development

```bash
npm test
npm run verify
```

验证包括纯逻辑测试、Node 模拟 DOM 的页面交互测试和静态检查；`linkedom` 仅为开发测试依赖，扩展运行时不加载它。默认不启动真实浏览器验收。
