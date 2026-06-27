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

The extension always dedupes by page title first. If a page has no usable title, it falls back to normalized URL dedupe. For scoped ranges such as 7 days or 30 days, visit counts are counted inside the selected time window before sorting and deduping. When multiple history items share the same title, the visible result keeps the entry with the highest windowed `visitCount`; ties fall back to the most recent visit.

Use the `极简` metric button to additionally merge pages under the same detected service resource ID. For example, `/tae/mcp_server/rd2nw9df/tools` and `/tae/mcp_server/rd2nw9df/inspector` collapse into one result keyed by `/tae/mcp_server/rd2nw9df`. Paths without a clear resource ID are left distinct. If one page in a merged bucket has a custom name, the renamed page is kept as the visible result.

Search results are displayed as collapsible domain groups. For example, `https://cloud-ttp-us.bytedance.net/tae/mcp_server/4syx48fa/tools` and `https://cloud-ttp-us.bytedance.net/tae/mcp_server/4syx48fa/inspector` appear under the same `cloud-ttp-us.bytedance.net` group.

Pages inside a domain group can be pinned. Multiple pages may be pinned at the same time, pinned pages stay at the top of their group in the order they were pinned, and unpinning returns them to the normal visit-time ordering.

Use the pencil button next to any result to rename that page inside the extension. Custom names are applied before page-title dedupe, so renamed pages merge or split according to the edited title.

## Local Data

The extension requests `activeTab`, `history`, `scripting`, `storage`, and `tabs` permissions. It does not upload or sync history. Pinned pages, custom page names, and the last search state are stored locally in `chrome.storage.local`. The `activeTab` and `scripting` permissions are used only to show the inline rename dialog on the current page while Chrome is fullscreen.

## Development

```bash
npm test
npm run verify
```
