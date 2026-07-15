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

The extension dedupes tab-like pages only when both their original page titles and stable resource identities match. A resource identity is derived from an ID-shaped path segment or resource-ID query parameter; when no reliable identity exists, the extension falls back to normalized URL dedupe. Custom names affect display and search but never page identity. For scoped ranges such as 7 days or 30 days, visit counts are counted inside the selected time window before sorting and deduping.

Use the `极简` metric button to hide result URLs for a more compact presentation. It does not change dedupe identity or merge additional pages.

Search results are displayed as collapsible domain groups. For example, `https://cloud-ttp-us.bytedance.net/tae/mcp_server/4syx48fa/tools` and `https://cloud-ttp-us.bytedance.net/tae/mcp_server/4syx48fa/inspector` appear under the same `cloud-ttp-us.bytedance.net` group.

Pages inside a domain group can be pinned. Multiple pages may be pinned at the same time, pinned pages stay at the top of their group in the order they were pinned, and unpinning returns them to the normal visit-time ordering.

Use the pencil button next to any result to rename that representative URL inside the extension. Renaming never propagates to other URLs in the same dedupe bucket. Version 0.1.5 removes duplicate custom-title records created by the older batch-rename behavior; affected pages need to be renamed once again.

The background service worker also captures final titles from open tabs and stores the most recent 5,000 URL-title pairs locally. Chrome history titles are never used for display, search, sorting, or dedupe because they may be stale placeholders such as `Docs`. Search uses a manual rename first, then the captured live title; without either, the result displays its URL and only normalized-URL dedupe applies. Existing entries gain titles after their pages are opened again.

The `刷新标题` action serially reloads all unique HTTP(S) URLs visited in the last seven days inside a temporary normal window that shares the current browser profile and SSO session. It captures stable titles, shows progress, and closes the window afterward. These reloads are recorded as new Chrome history visits.

## Local Data

The extension requests `activeTab`, `history`, `scripting`, `storage`, and `tabs` permissions. It does not upload or sync history. Pinned pages, custom page names, and the last search state are stored locally in `chrome.storage.local`. The `activeTab` and `scripting` permissions are used only to show the inline rename dialog on the current page while Chrome is fullscreen.

## Development

```bash
npm test
npm run verify
```
