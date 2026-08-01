# Deduped History Search

Lightweight Chrome extension for searching history with automatic URL deduplication.

## Install

1. Open `chrome://extensions`.
2. Enable `Developer mode`.
3. Click `Load unpacked`.
4. Select `/Users/bytedance/chrome-history-dedupe-extension`.

After loading, `chrome://history` opens this deduped search page. Disable the extension to return to Chrome's native history page.

## Shortcut

The extension suggests `Option+S` on macOS and `Alt+S` on other platforms to open the popup search panel. It also suggests `Option+Shift+S` on macOS and `Alt+Shift+S` elsewhere to rename the current page inside the extension. Chrome lets you change or clear shortcuts at `chrome://extensions/shortcuts`.

The popup remembers the last search term, selected time range, and renamed-pages filter, so reopening it with the shortcut returns to the same search context.

The rename shortcut opens an inline dialog on the current page, keeping focus and placement inside the active Chrome window on multi-display and fullscreen setups. Restricted pages that do not allow script injection fall back to a popup centered over that Chrome window, including displays positioned left of or above the primary display.

## Behavior

The extension derives a stable page identity independently of the page title. When a path contains an ID-shaped resource segment, identity stops at the first such segment and ignores every later path segment, query parameter, and anchor. When no path resource ID exists, explicit resource-ID parameters such as `id`, `task_id`, and `qualified_name` remain part of the identity; their camelCase, snake_case, and kebab-case aliases are canonicalized. Stateful routes such as `keyword_search` discard every query parameter. Ordinary anchors are ignored, while `#/` and `#!/` application routes remain part of the identity.

Each page identity produces exactly one result. A manually renamed tab wins; otherwise the URL with the highest all-time visit count wins, with the latest visit used as the tie-breaker. Search can match any collapsed tab while still returning that stable representative. Time ranges control which pages are included, while displayed visit counts remain Chrome's all-time totals.

Use the `极简` metric button to hide result URLs for a more compact presentation. It does not change dedupe identity or merge additional pages.

Search results are displayed as collapsible domain groups. For example, `https://cloud-ttp-us.bytedance.net/tae/mcp_server/4syx48fa/tools` and `https://cloud-ttp-us.bytedance.net/tae/mcp_server/4syx48fa/inspector` appear under the same `cloud-ttp-us.bytedance.net` group.

Pages inside a domain group can be pinned. Multiple pages may be pinned at the same time, pinned pages stay at the top of their group in the order they were pinned, and unpinning returns them to the normal visit-time ordering.

Use the pencil button next to any result to rename that representative URL inside the extension. Renames are stored once per page identity together with the selected target URL and update time, so renaming another tab replaces the previous page-level rename instead of creating another result. Renamed results show a compact `已重命名` tag beside the custom title and remain visible outside the selected time range while any URL alias for the same page still exists in Chrome history. Version 0.3.0 migrates legacy URL-level renames and pins to the same page identity; version 0.3.1 adds the visible rename indicator; version 0.3.2 merges non-resource query variants and migrates their old rename keys; version 0.3.3 makes renamed links time-range independent; version 0.3.4 replaces inline success text with Ant-style floating success messages; version 0.3.5 restores renamed URL aliases; version 0.3.6 removes per-URL visit lookups and displays Chrome's all-time visit totals; version 0.3.7 makes minimal mode a zero-recompute presentation toggle; version 0.3.8 makes the first path resource ID the complete page identity; version 0.3.9 persists the latest matching search snapshot; version 0.3.10 stores the processed matching results so reopening skips loading, dedupe, and filtering work; version 0.3.11 invalidates those results when renames, captured titles, or Chrome history change; version 0.3.12 keeps Feishu document renames attached to the same resource token across personal and tenant domains; version 0.3.13 adds bounded Chinese shorthand matching, such as `大模型` matching `大语言模型`; version 0.4.0 keeps a processed page index per active range so hot searches perform only local filtering and rendering; version 0.4.1 keeps shortcut renaming inside the active Chrome page and preserves negative multi-display coordinates for fallback popups.

The background service worker captures live titles per URL, follows URL changes during a navigation so redirect aliases can resolve to the final page, and stores up to 5,000 records ordered by their latest title or redirect-target change. Chrome history titles are never used for display or identity because they may be stale placeholders such as `Docs`. Search uses a manual rename first, then the captured live title; without either, the result displays its URL. Existing entries gain titles after their pages are opened again.

## Local Data

The extension requests `activeTab`, `history`, `scripting`, `storage`, and `tabs` permissions. It does not upload or sync history. Pinned pages, custom page names, and the last search state are stored locally in `chrome.storage.local`. The `activeTab` and `scripting` permissions are used only to show the inline rename dialog on the current page while Chrome is fullscreen.

## Development

```bash
npm test
npm run verify
```
