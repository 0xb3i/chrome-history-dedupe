# Deduped History Search

Lightweight Chrome extension for searching history with automatic URL deduplication.

## 1.10.6 正式版

移除子链接查找框，展开区直接显示链接列表。

子链接行高统一为 54px，预留两行文字空间，不随参数有无或文本长度变化。

无独立标题的子链接统一显示路径和参数，最多两行；每批显示 8 条，通过「显示更多链接」继续浏览。

展开链接采用紧凑布局：标题、访问次数和操作按钮同排，参数在标题下方；缩小上下留白和链接间距。

来源筛选改为轻量文字状态，搭配独立关闭按钮；长来源名自动省略，悬停可查看全名。

来源使用 Chrome 提供的网站图标，加载失败回退为稳定色点；弹窗行间距略微收紧，「已命名」状态使用更小字号。

重命名界面统一为紧凑布局：网址单行省略、还原原名位于左下，取消和保存位于右下；未修改名称时禁用保存，无自定义名称时隐藏还原入口。

正式版包含历史搜索与资源去重、弹窗分组与完整页时间线、重命名与置顶、备份恢复和本地后台索引。v1.10.6 默认使用完整浅蓝主题，弹窗和完整页统一使用纯白底，不使用渐变，搜索框和交互色块保持轻量，主题统一覆盖列表交互态、文字、边框、菜单、来源色点及交互高亮，提供蓝色、暖橙、绿色和中性四种完整浅色主题，选择会保存在扩展存储中，快捷键重命名浮层与独立重命名窗口共用主题；弹窗底部及完整页顶部可切换。界面采用 Raycast 风格的浅色启动器界面：弹窗直接从搜索框开始，完整页入口位于底部右侧；结果行标题与小号「已命名」状态位于上行，来源、访问次数与相对时间位于左下；今天显示时刻、昨天显示「昨天」、近一周显示星期、更早显示日期，悬停查看完整时间，改名、固定及链接数量位于右下；配合整行焦点反馈，底部只保留主题与完整页入口，延续 v1.1.0 的搜索和键盘操作。

- **运行环境：** Chrome 105 及以上；扩展不在无痕模式中运行。直接加载项目目录即可使用，无需构建或安装 Node.js。
- **升级方式：** 在原目录更新文件，在 `chrome://extensions` 点击「重新加载」，重新打开完整历史页，确认顶部显示 `v1.10.6`。旧版用户数据沿用现有迁移流程；移动目录或重新安装前按下文导出备份。
- **首次使用：** 后台需要读取 Chrome 历史并建立索引；历史较多时初始化需要时间。之后关键词搜索使用本地索引。
- **数据边界：** 去重只影响展示，不删除 Chrome 原始历史。重命名页面仍依赖浏览器保留对应历史；备份不包含原始历史。扩展不上传数据，也不提供跨设备同步。

## Install

1. Open `chrome://extensions`.
2. Enable `Developer mode`.
3. Click `Load unpacked`.
4. Select the directory containing this project’s `manifest.json`.

After loading, `chrome://history` opens this deduped search page. Disable the extension to return to Chrome's native history page.

## Shortcut

The extension suggests `Option+S` on macOS and `Alt+S` on other platforms to open the popup search panel. It also suggests `Option+Shift+S` on macOS and `Alt+Shift+S` elsewhere to rename the current page inside the extension. Chrome lets you change or clear shortcuts at `chrome://extensions/shortcuts`.

The popup supports 24-hour, 7-day, 30-day, 90-day, and all-history searches and remembers the last search term, time filter, and renamed-pages filter, so reopening it with the shortcut returns to the same search context. A background index keeps committed search data ready before the popup opens, so keyword searches never wait for Chrome's History API.

The rename shortcut opens an inline dialog on the active page. Restricted pages fall back to a popup centered over the active Chrome window. Rename saves acknowledge durable storage immediately; background indexing does not block the dialog.

## 行为与架构

搜索框独占主操作行；时间筛选与「仅已命名」复选框集中在下方。筛选与排序即时生效，次级操作使用轻量样式。

弹窗搜索区固定在顶部，结果区独立滚动。 时间与命名筛选位于搜索框下方左侧，排序位于同一行右侧；结果数单独位于列表上方。输入后自动搜索，Enter 仍提交查询；按 ↓ 进入结果，↑/↓ 移动，聚焦链接后 Enter 打开，Esc 返回搜索框。折叠分组内的链接不会参与导航。后台更新保留当前资源的焦点与滚动位置。默认隐藏普通网址路径，区分同名链接所需的路径始终可见。各改名入口展示目标地址与处理中状态。

弹窗的同名分组在展开时才生成子链接与地址说明，每次加载 8 条；继续加载会追加内容，后台刷新保留已展开的数量，避免打开弹窗时生成大量不可见节点。展开区外围延续页面背景，用留白和缩进连接父行与白色子列表，子列表保留极轻中性边框，行间用留白分隔，子行悬停与聚焦底色使用 6px 圆角，访问次数位于左下，改名与固定按钮统一位于右下，路径与必要参数分层显示。子链接优先显示已有且不同于分组名的页面标题，下方显示简化 URL；没有可用标题时回退为路径与参数，不使用无对应关系的搜索曾用名。地址省略公共协议与域名，路径与参数分两行，参数使用小字号，超长内容单行省略，悬停可查看完整地址，保留路径、查询参数和片段，不再翻译参数名或展示字段说明；不同来源保留协议与域名，凭证值隐藏。已固定状态使用标题左侧的次级色小图钉表示，已重命名状态使用标题末尾的小号「自定义」文字表示，悬停可查看说明；所有结果行的改名与置顶按钮仅在悬停当前行或键盘聚焦时显现，触摸设备保持可见。

标题或曾用名含搜索命中时最多显示三行；过长内容截取首个命中词附近的摘要，避免长 URL 撑满列表。完整标题和曾用名可悬停查看，实际打开地址保持完整。时间筛选与排序共用 Ant 风格自绘下拉菜单，支持键盘选择；搜索与结果工具栏统一使用 14px 常规字重、32px 控件高度和 6px 圆角。

- **资源身份**：独立资源分别保留。未知网址保留完整路径、非跟踪查询参数和 fragment，不再按“第一个像 ID 的片段”截断。飞书官方域上的同类型文档 token 可跨租户域归并；字节云 MCP server 的 `tools` / `inspector` 合并为同一资源。表格子资源参数保持独立。Google 搜索保留 `q`，忽略分页和辅助参数。
- **导航别名**：只有浏览器确认的同一次主框架服务器重定向才建立别名。取消加载、切换地址、SPA 和无法明确归属的导航不会推断成同一页面。旧版本未经验证的跳转关系不再参与归并。
- **代表链接与统计**：以完整历史归并资源，再按所选时间筛选最近访问的资源。默认链接由规范化 URL 的累计访问次数、最近访问和稳定键选出；手动重命名保留用户指定的目标链接。
- **重命名**：名称、目标链接、更新时间独立保存，即时更新显示与搜索。已重命名页面不受时间筛选限制，但只有对应资源仍存在于 Chrome 历史中才显示。它不是独立书签库。旧名称按保存的目标链接迁移到具体资源。
- **结果组织与排序**：Command + Y 打开的完整历史页采用时间线，首次打开默认全部时间、最近访问倒序；按本地日期分隔，每个资源独立一行，左侧显示访问时间，不再折叠域名或同名页面。每次展示 50 条，可继续加载；按最近访问排序时，置顶、重命名和点击次数不改变时间先后。完整页与弹窗分别保存搜索词、时间范围和排序偏好。弹窗保留同名折叠和每批 30 项；默认按置顶、搜索匹配、重命名、次数和最近访问排序。两种视图均可选点击次数降序、上次访问降序和名称升序；名称支持中文及自然数字顺序。弹窗的所有排序，以及完整页的次数和名称排序，保留置顶顺序。切换排序不重新读取历史。来源标签优先显示自定义分组名，色点由域名稳定决定；弹窗与完整页均可点击来源标签筛选网站，通过结果数量上方的来源标签清除筛选；右键来源标签或聚焦后按 F2 可修改分组名；同名折叠行中的标签也支持筛选和右键修改，不会触发展开或打开链接。
- **同名链接**：弹窗中，同一域名内，未重命名、未置顶的同名结果显示为统一的结果行，标题直接打开组内累计访问最多的链接，并显示最近访问与合计次数；右侧链接数量用于展开和收起。每条子链接显示累计访问次数；默认按次数、最近访问时间和稳定键排序，切换排序后子链接遵循所选规则；组外位置仍沿用搜索结果排序。展开后统一展示简化 URL，保留路径、参数和片段，凭证值不在列表中明文显示。关键内容允许换行，不因截断而丢失区别；重命名和置顶操作保留，访问时间和完整网址放在悬停信息中。展开链接随外层结果列表统一滚动，每次加载 8 条，通过「显示更多链接」追加，不再使用嵌套滚动区域。也可通过浏览器链接菜单复制完整网址；实际打开地址保持完整。显示分组不改变资源身份。
- **筛选与反馈**：`仅已命名` 是结果筛选；默认保持简洁展示，同名分组逐组展开或收起，不再提供「显示选项」菜单。结果数量始终可见，已命名页面因不受时间范围限制而保留时显示“跨时间保留”。无结果时提供扩大时间范围、清除筛选、清空关键词等适用操作，读取失败可以重试，操作失败显示可见提示。
- **即时搜索**：输入停顿 180ms 后搜索，中文输入法组合期间不提交，时间和命名筛选即选即生效。输入草稿与已提交条件仍独立，后台刷新使用已提交条件，旧请求不能覆盖新请求或较新的索引；初始化也不会覆盖用户刚修改的筛选偏好。显示标题中的命中内容高亮；命中历史名称时显示真实曾用名及对应高亮。搜索只匹配标题（含归并成员的标题），仍打开资源的稳定代表链接；中文支持有界简称匹配。
- **标题来源**：显示优先采用自定义名称，其次有效的实时捕获标题、Chrome 历史标题，最后才显示 URL。URL 和明确的加载占位文字不会覆盖有效名称；同一资源的代表链接缺少名称时使用其他成员的有效标题，不改变代表链接与访问统计。缺少实时捕获记录不会把历史名称变成「曾用名」；搜索命中与当前名称不同的历史名称时才显示该提示。最多保存 5,000 条实时标题记录。

后台保留原始历史，并以原子 generation 发布可重建的派生索引。每轮构建只执行一次全量资源归并，仅持久化一份完整资源索引，前台在该索引上按最近访问时间过滤，切换时间无需重建索引。重命名直接更新用户数据投影，不触发全量索引重建；前台关键词搜索不访问 History API。索引写入和回收由 Web Locks 协调，失败或 Worker 终止留下的未发布分片会安全回收。

核心边界：`page-identity.js` 负责身份；`history-utils.js` 负责事实归并与统一排序；`search-match.js` 负责匹配解释与原文高亮区间；`history-index/project.js` 负责用户名称投影；`search-state.js` 管理已提交条件和索引版本；`live-search.js` 管理输入防抖与输入法状态；`rename-session.js` 隔离异步弹窗会话。

## Local Data

The extension requests `activeTab`, `history`, `scripting`, `storage`, `tabs`, and `webNavigation` permissions. It does not upload or sync history. Pinned pages, custom page names, and the last search state are stored locally in `chrome.storage.local`; the rebuildable search index is stored locally in extension IndexedDB. A full history scan runs only when that index is missing or incompatible; normal history changes update it through browser events. `webNavigation` distinguishes committed redirects from canceled navigations. The `activeTab` and `scripting` permissions are used only to show the inline rename dialog on the current page.

## 备份与恢复

打开完整历史页，右上角「备份」会导出一份 JSON，包含页面重命名、自动采集标题、分组名和置顶顺序。「恢复」选择备份文件后合并导入，保留当前已有名称与置顶顺序，并迁移旧版数据；重复导入不会增加重复记录。旧版备份仍可导入，缺少自动采集标题时使用有效的 Chrome 历史标题。原始浏览历史和搜索索引不包含在备份中。恢复后，页面仍需存在于 Chrome 历史记录里才能显示。

未打包扩展的 ID 可能随加载目录变化；不同 ID 的本地数据彼此隔离。移动目录、删除或重新安装前先备份，普通升级在扩展管理页点击「重新加载」即可。此功能是手动备份，尚未导出的新增修改不会自动保存到文件。

## Development

开发验证需要 Node.js 20.19 及以上，建议使用仍受支持的 LTS 版本。先安装锁定的开发依赖，再执行检查：

```bash
npm ci
npm run verify
```

验证包括纯逻辑测试、Node 模拟 DOM 的页面交互测试和静态检查；`linkedom` 仅为开发测试依赖，扩展运行时不加载它。默认不启动真实浏览器验收。
