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

When Chrome is in macOS fullscreen, the rename shortcut opens an inline dialog on the current page instead of creating a separate popup window in another Space.

## Behavior

The extension derives a stable page identity independently of the page title. It prefers the deepest ID-shaped path segment and aggressively ignores non-resource query parameters, so filters, tabs, sorting, environments, and opaque state after `?` collapse into one page. Only explicit resource-ID parameters such as `id`, `task_id`, and `qualified_name` remain part of the identity; their camelCase, snake_case, and kebab-case aliases are canonicalized. Stateful routes such as `keyword_search` discard every query parameter. Ordinary anchors are ignored, while `#/` and `#!/` application routes remain part of the identity.

Each page identity produces exactly one result. A manually renamed tab wins; otherwise the URL with the highest visit count in the selected time range wins, with the latest visit used as the tie-breaker. Search can match any collapsed tab while still returning that stable representative. Scoped ranges count visits inside the selected time window before selection.

Use the `极简` metric button to hide result URLs for a more compact presentation. It does not change dedupe identity or merge additional pages.

Search results are displayed as collapsible domain groups. For example, `https://cloud-ttp-us.bytedance.net/tae/mcp_server/4syx48fa/tools` and `https://cloud-ttp-us.bytedance.net/tae/mcp_server/4syx48fa/inspector` appear under the same `cloud-ttp-us.bytedance.net` group.

Pages inside a domain group can be pinned. Multiple pages may be pinned at the same time, pinned pages stay at the top of their group in the order they were pinned, and unpinning returns them to the normal visit-time ordering.

Use the pencil button next to any result to rename that representative URL inside the extension. Renames are stored once per page identity together with the selected target URL and update time, so renaming another tab replaces the previous page-level rename instead of creating another result. Renamed results show a compact `已重命名` tag beside the custom title. Version 0.3.0 migrates legacy URL-level renames and pins to the same page identity; version 0.3.1 adds the visible rename indicator; version 0.3.2 merges non-resource query variants and migrates their old rename keys.

The background service worker captures live titles per URL, follows URL changes during a navigation so redirect aliases can resolve to the final page, and stores up to 5,000 records ordered by their latest title or redirect-target change. Chrome history titles are never used for display or identity because they may be stale placeholders such as `Docs`. Search uses a manual rename first, then the captured live title; without either, the result displays its URL. Existing entries gain titles after their pages are opened again.

## Local Data

The extension requests `activeTab`, `history`, `scripting`, `storage`, and `tabs` permissions. It does not upload or sync history. Pinned pages, custom page names, and the last search state are stored locally in `chrome.storage.local`. The `activeTab` and `scripting` permissions are used only to show the inline rename dialog on the current page while Chrome is fullscreen.

## Development

```bash
npm test
npm run verify
```
