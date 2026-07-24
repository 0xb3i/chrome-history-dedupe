# 项目约定

## UI 风格

- 当前项目的 UI 必须默认与 Ant Design v5 的设计风格对齐；新增或调整控件时优先复用 `src/styles.css` 里的 Ant 风格 token，不另起一套视觉语言。
- 色彩、圆角、字号、行高、阴影和交互态参考 Ant Design v5：主色 `#1677ff`，正文 `rgba(0, 0, 0, 0.88)`，次级文字 `rgba(0, 0, 0, 0.65)`，弱提示 `rgba(0, 0, 0, 0.45)`，边框 `#d9d9d9`，小圆角 `6px`，默认控件高度 `32px`。
- 表单控件按 Ant 的 Input / Select / Button 风格实现：白底、细边框、轻 hover/focus 状态、无厚重投影；focus 使用蓝色边框和浅蓝外发光。
- 图标按钮和清空按钮保持 Ant 的扁平图标语义：无立体阴影、无浏览器原生高光、默认 `rgba(0, 0, 0, 0.25)` 或项目弱文本色，hover 加深到 `rgba(0, 0, 0, 0.45)` 或主色。
- 搜索框清空按钮应表现为 Ant `Input allowClear` 风格的小号圆形关闭图标，不使用浏览器默认的凸起或平台化 search cancel 外观。
- 不引入 Ant Design 运行时依赖，除非用户明确要求；这个扩展保持原生 HTML/CSS/JS，手写样式只用于复刻必要的 Ant 表面行为。

## 扩展浏览器验证

- 修改扩展代码后，先运行 `npm run verify`；通过后必须使用 Chrome DevTools MCP 在用户当前 Chrome Profile 中完成真实浏览器 smoke test，不能只依赖 Node.js 测试。
- 启动浏览器验证前，先检查 Chrome DevTools MCP 配置必须包含 `--ignoreDefaultChromeArg=--disable-extensions` 和 `--categoryExtensions=true`，再调用第一次 `list_pages`；禁止先按默认参数启动后才补救。随后检查 Agent Canary 主进程命令行，确认不含 `--disable-extensions`；若仍存在该参数，立即停止加载尝试，只终止智能体自己启动的 MCP/Agent Canary，并用 `--channel canary --userDataDir /Users/bytedance/.codex/chrome-profiles/agent-canary --ignoreDefaultChromeArg=--disable-extensions --categoryExtensions=true` 重启，不得改用 Stable、`--autoConnect` 或用户主 Profile。优先使用 MCP 的 `install_extension` / `reload_extension`；`chrome://extensions` 显示目录选择成功不代表扩展已加载，必须以扩展卡片出现及 `chrome://history` 进入 `chrome-extension:` 上下文为准。
- 本项目无需构建，Chrome 直接把仓库根目录作为 unpacked extension 加载。不要为 MCP 添加无法从 npm 子进程调用的伪 `test:browser` 脚本，也不要硬编码扩展 ID。
- 优先复用已有的空白页或扩展页并导航到 `chrome://history`。确认实际页面满足 `location.protocol === 'chrome-extension:'`，并读取 `chrome.runtime.getManifest().version` 与 `#app-version`，确保运行版本与 `manifest.json` 一致。
- 在扩展页通过 Chrome DevTools MCP 执行 `setTimeout(() => chrome.runtime.reload(), 0)` 触发重载。旧扩展页目标随后关闭属于正常行为；重新导航到 `chrome://history`，再次校验 manifest 版本和页面版本角标，禁止把“已发送 reload”误判为验证完成。
- 重载后按本次变更执行最小真实交互，至少覆盖相关主路径、检查页面 Console error，并确认主要控件仍可操作。除非测试目标本身需要，避免修改用户的重命名、置顶等持久数据。
- 验证搜索缓存或启动性能时，不能只证明 `chrome.history.search` 未调用；必须确认缓存保存的是去重、过滤后的匹配结果而非原始历史快照，并用页面加载前注入的观察器记录重开状态序列，确保同关键词缓存命中不出现“搜索中”且不重复执行去重、过滤。主动点击搜索仍必须进入“搜索中”并刷新缓存。
- 只有 MCP 无法进入扩展上下文或调用 `chrome.runtime.reload()` 时，才使用 Computer Use 在 `chrome://extensions` 操作重载，并在交付中说明降级原因。
