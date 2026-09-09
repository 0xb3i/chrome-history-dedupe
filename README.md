# Deduped History Search

Lightweight Chrome extension for searching history with automatic URL deduplication.

## Install

1. Open `chrome://extensions`.
2. Enable `Developer mode`.
3. Click `Load unpacked`.
4. Select `/Users/bytedance/chrome-history-dedupe`.

After loading, `chrome://history` opens this deduped search page. Disable the extension to return to Chrome's native history page.

## Shortcut

The extension suggests `Option+S` on macOS and `Alt+S` on other platforms to open the popup search panel. It also suggests `Option+Shift+S` on macOS and `Alt+Shift+S` elsewhere to rename the current page inside the extension. Chrome lets you change or clear shortcuts at `chrome://extensions/shortcuts`.

The popup supports 24-hour, 7-day, 30-day, 90-day, and all-history searches and remembers the last search term, time filter, and renamed-pages filter, so reopening it with the shortcut returns to the same search context. A background index keeps committed search data ready before the popup opens, so keyword searches never wait for Chrome's History API.

The rename shortcut opens an inline dialog on the active page. Restricted pages fall back to a popup centered over the active Chrome window. Rename saves acknowledge durable storage immediately; background indexing does not block the dialog.

## 行为与架构（0.9.0）

- **资源身份**：独立资源分别保留。未知网址保留完整路径、非跟踪查询参数和 fragment，不再按“第一个像 ID 的片段”截断。飞书官方域上的同类型文档 token 可跨租户域归并；字节云 MCP server 的 `tools` / `inspector` 合并为同一资源。表格子资源参数保持独立。Google 搜索保留 `q`，忽略分页和辅助参数。
- **导航别名**：只有浏览器确认的同一次主框架服务器重定向才建立别名。取消加载、切换地址、SPA 和无法明确归属的导航不会推断成同一页面。旧版本未经验证的跳转关系不再参与归并。
- **代表链接与统计**：以完整历史归并资源，再按所选时间筛选最近访问的资源。默认链接由规范化 URL 的累计访问次数、最近访问和稳定键选出；手动重命名保留用户指定的目标链接。
- **重命名**：名称、目标链接、更新时间独立保存，即时更新显示与搜索。已重命名页面不受时间筛选限制，但只有对应资源仍存在于 Chrome 历史中才显示。它不是独立书签库。旧名称按保存的目标链接迁移到具体资源。
- **统一展示**：域分组始终保留；组内顺序为置顶顺序、已重命名、累计访问次数、最近访问、稳定键；组间按最优成员使用同一规则。`重命名` 按钮仅筛选。同一域名内，未重命名、未置顶的同名结果显示为统一的结果行，标题可直接打开常用链接，并显示最近访问与合计次数；右侧链接数量用于展开和收起。分组直接概括差异项，展开后共同地址只显示一次，各链接以等高双行展示不同的路径、参数或页面片段，以及访问时间、次数；常用链接单独标记。登录凭证以组内值编号区分，长参数压缩展示，详情可查看全部差异值并选取完整地址。每条链接保留原始打开地址、重命名和置顶操作。`极简` 隐藏普通结果的 URL，但保留同名结果的差异摘要。
- **搜索状态**：输入中的关键词、时间选择与已提交条件分开；时间下拉框保留，隐藏“范围”文字。后台刷新始终使用已提交条件，旧请求不能覆盖新请求或较新的索引。搜索可匹配归并成员的标题，仍打开资源的稳定代表链接；中文支持有界简称匹配。
- **标题来源**：显示优先采用自定义名称，其次实时捕获的页面标题，最后显示 URL。Chrome 历史标题只用于搜索。最多保存 5,000 条实时标题记录。

后台保留原始历史，并以原子 generation 发布可重建的派生索引。每轮构建只执行一次全量资源归并，仅持久化一份完整资源索引，前台在该索引上按最近访问时间过滤，切换时间无需重建索引。重命名直接更新用户数据投影，不触发全量索引重建；前台关键词搜索不访问 History API。索引写入和回收由 Web Locks 协调，失败或 Worker 终止留下的未发布分片会安全回收。

核心边界：`page-identity.js` 负责身份；`history-utils.js` 负责事实归并、匹配与统一排序；`history-index/project.js` 负责用户名称投影；`search-state.js` 管理已提交条件和索引版本；`rename-session.js` 隔离异步弹窗会话。

## Local Data

The extension requests `activeTab`, `alarms`, `history`, `scripting`, `storage`, `tabs`, and `webNavigation` permissions. It does not upload or sync history. Pinned pages, custom page names, and the last search state are stored locally in `chrome.storage.local`; the rebuildable search index is stored locally in extension IndexedDB. `alarms` performs an hourly background reconciliation so searches never have to wait for it. `webNavigation` distinguishes committed redirects from canceled navigations. The `activeTab` and `scripting` permissions are used only to show the inline rename dialog on the current page.

## Development

```bash
npm test
npm run verify
```
