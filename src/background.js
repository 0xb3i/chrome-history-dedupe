import {
  getHistoryItemCapturedTitleKey,
  getHistoryItemTitleOverrideKey
} from './history-utils.js';
import {
  CAPTURED_PAGE_TITLES_STORAGE_KEY,
  deleteTitleOverrides,
  loadTitleOverrides,
  saveCapturedPageTitle,
  saveRenameDraft,
  saveTitleOverride,
  TITLE_OVERRIDES_STORAGE_KEY
} from './storage.js';
import { createNavigationTracker } from './navigation-tracker.js';
import { getCenteredCoordinate } from './window-placement.js';
import { createHistoryIndexStore } from './history-index/store.js';
import { createHistoryIndexService } from './history-index/service.js';
import {
  HISTORY_INDEX_ALARM_NAME,
  HISTORY_INDEX_ENSURE_MESSAGE,
  HISTORY_INDEX_REBUILD_MESSAGE,
  HISTORY_INDEX_UPDATED_MESSAGE
} from './history-index/protocol.js';

const RENAME_CURRENT_PAGE_COMMAND = 'rename-current-page';
const RENAME_WINDOW_WIDTH = 480;
const RENAME_WINDOW_HEIGHT = 230;
const INLINE_RENAME_SCRIPT = 'src/rename-overlay.js';
const INLINE_RENAME_INIT_MESSAGE = 'deduped-history:init-inline-rename';
const INLINE_RENAME_SAVE_MESSAGE = 'deduped-history:save-inline-rename';
const INLINE_RENAME_RESTORE_MESSAGE = 'deduped-history:restore-inline-rename';
let capturedTitleWriteQueue = Promise.resolve();
const navigationTracker = createNavigationTracker();
const historyIndexStore = createHistoryIndexStore();
const historyIndexService = createHistoryIndexService({
  store: historyIndexStore,
  notifyUpdated: notifyHistoryIndexUpdated
});

globalThis.chrome?.tabs?.onUpdated?.addListener((tabId, changeInfo, tab) => {
  const navigationUrls = navigationTracker.update(tabId, changeInfo, tab);
  const hasPendingNavigation = Boolean(tab?.pendingUrl) && tab.pendingUrl !== tab.url;

  if (
    (changeInfo?.title && !hasPendingNavigation) ||
    changeInfo?.status === 'complete' ||
    (changeInfo?.url && tab?.status === 'complete')
  ) {
    enqueueCapturedTabTitle(
      { ...tab, title: changeInfo?.title || tab?.title },
      navigationUrls
    );
  }
});
globalThis.chrome?.tabs?.onRemoved?.addListener((tabId) => {
  navigationTracker.remove(tabId);
});
globalThis.chrome?.history?.onVisited?.addListener((item) => {
  void historyIndexService.handleVisited(item).catch(() => {});
});
globalThis.chrome?.history?.onVisitRemoved?.addListener((details) => {
  void historyIndexService.handleRemoved(details).catch(() => {});
});
globalThis.chrome?.storage?.onChanged?.addListener((changes, areaName) => {
  if (
    areaName === 'local' &&
    (changes[TITLE_OVERRIDES_STORAGE_KEY] || changes[CAPTURED_PAGE_TITLES_STORAGE_KEY])
  ) {
    void historyIndexService.rebuildDerived().catch(() => {});
  }
});
globalThis.chrome?.runtime?.onStartup?.addListener(() => {
  void historyIndexService.calibrate().catch(() => {});
});
globalThis.chrome?.runtime?.onInstalled?.addListener(() => {
  scheduleHistoryIndexAlarm();
  void historyIndexService.calibrate().catch(() => {});
});
globalThis.chrome?.alarms?.onAlarm?.addListener((alarm) => {
  if (alarm?.name === HISTORY_INDEX_ALARM_NAME) {
    void historyIndexService.calibrate().catch(() => {});
  }
});

captureOpenTabTitles();

globalThis.chrome?.commands?.onCommand?.addListener((command) => {
  if (command === RENAME_CURRENT_PAGE_COMMAND) {
    openRenameWindowForCurrentPage();
  }
});

globalThis.chrome?.runtime?.onMessage?.addListener((message, _sender, sendResponse) => {
  if (message?.type === HISTORY_INDEX_ENSURE_MESSAGE) {
    historyIndexService.ensureReady()
      .then((state) => sendResponse({ ok: true, state }))
      .catch((error) => sendResponse({ ok: false, error: error.message || '索引初始化失败。' }));
    return true;
  }

  if (message?.type === HISTORY_INDEX_REBUILD_MESSAGE) {
    historyIndexService.rebuildDerived({ immediate: true })
      .then((state) => sendResponse({ ok: true, state }))
      .catch((error) => sendResponse({ ok: false, error: error.message || '索引更新失败。' }));
    return true;
  }

  if (message?.type === INLINE_RENAME_SAVE_MESSAGE) {
    saveInlineRename(message)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message || '保存失败。' }));
    return true;
  }

  if (message?.type === INLINE_RENAME_RESTORE_MESSAGE) {
    restoreInlineRename(message)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message || '还原失败。' }));
    return true;
  }

  return false;
});

scheduleHistoryIndexAlarm();
void historyIndexService.ensureReady().catch(() => {});

async function captureOpenTabTitles() {
  try {
    const tabs = await queryTabs({});
    for (const tab of tabs) {
      enqueueCapturedTabTitle(tab);
    }
  } catch {
    // Title capture enriches history but must never block the extension.
  }
}

function enqueueCapturedTabTitle(tab, navigationUrls = [tab?.url]) {
  if (!isCapturableTab(tab)) {
    return;
  }

  const aliases = new Set([...navigationUrls, tab.url].filter(Boolean));

  for (const url of aliases) {
    const titleKey = getHistoryItemCapturedTitleKey({ url });
    capturedTitleWriteQueue = capturedTitleWriteQueue
      .then(() => saveCapturedPageTitle(titleKey, tab.title, { resolvedUrl: tab.url }))
      .catch(() => {});
  }
}

function isCapturableTab(tab) {
  return /^(https?|file):/i.test(String(tab?.url ?? '')) && Boolean(String(tab?.title ?? '').trim());
}

async function openRenameWindowForCurrentPage() {
  try {
    const tab = await getActiveTab();

    if (!tab?.url) {
      return;
    }

    const draft = await createRenameDraft(tab);

    if (await openInlineRenameDialog(tab, draft)) {
      return;
    }

    await saveRenameDraft(draft);
    await createRenameWindow(draft.id, tab.windowId);
  } catch {
    // Keyboard commands have no visible surface for errors; failing closed is safest.
  }
}

async function openInlineRenameDialog(tab, draft) {
  if (typeof tab?.id !== 'number') {
    return false;
  }

  try {
    await executeScriptInTab(tab.id, [INLINE_RENAME_SCRIPT]);
    await sendMessageToTab(tab.id, {
      type: INLINE_RENAME_INIT_MESSAGE,
      draft: toInlineRenameDraft(draft)
    });
    return true;
  } catch {
    return false;
  }
}

function executeScriptInTab(tabId, files) {
  return new Promise((resolve, reject) => {
    globalThis.chrome.scripting.executeScript({ target: { tabId }, files }, () => {
      const lastError = globalThis.chrome.runtime?.lastError;

      if (lastError) {
        reject(new Error(lastError.message));
        return;
      }

      resolve();
    });
  });
}

function sendMessageToTab(tabId, message) {
  return new Promise((resolve, reject) => {
    globalThis.chrome.tabs.sendMessage(tabId, message, (response) => {
      const lastError = globalThis.chrome.runtime?.lastError;

      if (lastError) {
        reject(new Error(lastError.message));
        return;
      }

      resolve(response);
    });
  });
}

async function saveInlineRename(message) {
  await saveTitleOverride(message?.titleOverrideKey, message?.title, {
    targetUrl: message?.url
  });
  await historyIndexService.rebuildDerived({ immediate: true });
}

async function restoreInlineRename(message) {
  await deleteTitleOverrides([message?.titleOverrideKey]);
  await historyIndexService.rebuildDerived({ immediate: true });
}

function scheduleHistoryIndexAlarm() {
  if (!globalThis.chrome?.alarms?.get || !globalThis.chrome?.alarms?.create) {
    return;
  }
  globalThis.chrome.alarms.get(HISTORY_INDEX_ALARM_NAME, (alarm) => {
    void globalThis.chrome.runtime?.lastError;
    if (alarm) return;
    globalThis.chrome.alarms.create(HISTORY_INDEX_ALARM_NAME, {
      delayInMinutes: 1,
      periodInMinutes: 60
    });
  });
}

function notifyHistoryIndexUpdated(update) {
  return new Promise((resolve) => {
    if (!globalThis.chrome?.runtime?.sendMessage) {
      resolve();
      return;
    }
    globalThis.chrome.runtime.sendMessage({
      type: HISTORY_INDEX_UPDATED_MESSAGE,
      revision: update?.revision
    }, () => {
      void globalThis.chrome.runtime?.lastError;
      resolve();
    });
  });
}

function toInlineRenameDraft(draft) {
  return {
    titleOverrideKey: draft.titleOverrideKey,
    url: draft.url,
    currentTitle: draft.currentTitle,
    originalTitle: draft.originalTitle,
    hasTitleOverride: draft.hasTitleOverride
  };
}

async function getActiveTab() {
  const [lastFocusedTab] = await queryTabs({ active: true, lastFocusedWindow: true });

  if (lastFocusedTab) {
    return lastFocusedTab;
  }

  const [currentWindowTab] = await queryTabs({ active: true, currentWindow: true });
  return currentWindowTab;
}

function queryTabs(queryInfo) {
  return new Promise((resolve, reject) => {
    globalThis.chrome.tabs.query(queryInfo, (tabs) => {
      const lastError = globalThis.chrome.runtime?.lastError;

      if (lastError) {
        reject(new Error(lastError.message));
        return;
      }

      resolve(tabs ?? []);
    });
  });
}

async function createRenameWindow(draftId, windowId) {
  const placement = await getCenteredWindowPlacement(windowId);

  return new Promise((resolve, reject) => {
    const url = globalThis.chrome.runtime.getURL(
      `rename.html?draft=${encodeURIComponent(draftId)}`
    );

    globalThis.chrome.windows.create(
      {
        focused: true,
        height: RENAME_WINDOW_HEIGHT,
        ...placement,
        type: 'popup',
        url,
        width: RENAME_WINDOW_WIDTH
      },
      (window) => {
        const lastError = globalThis.chrome.runtime?.lastError;

        if (lastError) {
          reject(new Error(lastError.message));
          return;
        }

        resolve(window);
      }
    );
  });
}

async function getCenteredWindowPlacement(windowId) {
  try {
    const baseWindow = await getWindow(windowId);
    const left = getCenteredCoordinate(baseWindow.left, baseWindow.width, RENAME_WINDOW_WIDTH);
    const top = getCenteredCoordinate(baseWindow.top, baseWindow.height, RENAME_WINDOW_HEIGHT);

    if (left === undefined || top === undefined) {
      return {};
    }

    return { left, top };
  } catch {
    return {};
  }
}

function getWindow(windowId) {
  return new Promise((resolve, reject) => {
    if (typeof windowId !== 'number') {
      reject(new Error('Missing window id'));
      return;
    }

    globalThis.chrome.windows.get(windowId, (window) => {
      const lastError = globalThis.chrome.runtime?.lastError;

      if (lastError) {
        reject(new Error(lastError.message));
        return;
      }

      resolve(window);
    });
  });
}

async function createRenameDraft(tab) {
  const titleOverrideKey = getHistoryItemTitleOverrideKey({ url: tab.url });
  const titleOverrides = await loadTitleOverrides();
  const originalTitle = tab.title || tab.url;
  const titleOverride = titleOverrides.get(titleOverrideKey);
  const hasTitleOverride = Boolean(titleOverride);

  return {
    id: createDraftId(),
    titleOverrideKey,
    url: tab.url,
    currentTitle: titleOverride?.title || originalTitle,
    originalTitle,
    hasTitleOverride,
    createdAt: Date.now()
  };
}

function createDraftId() {
  return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
}
