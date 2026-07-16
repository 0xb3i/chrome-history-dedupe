import {
  getHistoryItemCapturedTitleKey,
  getHistoryItemTitleOverrideKey
} from './history-utils.js';
import {
  deleteTitleOverrides,
  loadTitleOverrides,
  saveCapturedPageTitle,
  saveRenameDraft,
  saveTitleOverride
} from './storage.js';

const RENAME_CURRENT_PAGE_COMMAND = 'rename-current-page';
const RENAME_WINDOW_WIDTH = 480;
const RENAME_WINDOW_HEIGHT = 230;
const INLINE_RENAME_SCRIPT = 'src/rename-overlay.js';
const INLINE_RENAME_INIT_MESSAGE = 'deduped-history:init-inline-rename';
const INLINE_RENAME_SAVE_MESSAGE = 'deduped-history:save-inline-rename';
const INLINE_RENAME_RESTORE_MESSAGE = 'deduped-history:restore-inline-rename';
let capturedTitleWriteQueue = Promise.resolve();

globalThis.chrome?.tabs?.onUpdated?.addListener((_tabId, changeInfo, tab) => {
  if (changeInfo?.title) {
    enqueueCapturedTabTitle({ ...tab, title: changeInfo.title });
  }
});

captureOpenTabTitles();

globalThis.chrome?.commands?.onCommand?.addListener((command) => {
  if (command === RENAME_CURRENT_PAGE_COMMAND) {
    openRenameWindowForCurrentPage();
  }
});

globalThis.chrome?.runtime?.onMessage?.addListener((message, _sender, sendResponse) => {
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

function enqueueCapturedTabTitle(tab) {
  if (!isCapturableTab(tab)) {
    return;
  }

  const titleKey = getHistoryItemCapturedTitleKey({ url: tab.url });
  capturedTitleWriteQueue = capturedTitleWriteQueue
    .then(() => saveCapturedPageTitle(titleKey, tab.title, { resolvedUrl: tab.url }))
    .catch(() => {});
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

    if ((await isFullscreenWindow(tab.windowId)) && (await openInlineRenameDialog(tab, draft))) {
      return;
    }

    await saveRenameDraft(draft);
    await createRenameWindow(draft.id, tab.windowId);
  } catch {
    // Keyboard commands have no visible surface for errors; failing closed is safest.
  }
}

async function isFullscreenWindow(windowId) {
  try {
    const window = await getWindow(windowId);
    return window?.state === 'fullscreen';
  } catch {
    return false;
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
  await saveTitleOverride(message?.titleOverrideKey, message?.title);
}

async function restoreInlineRename(message) {
  await deleteTitleOverrides([message?.titleOverrideKey]);
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

function getCenteredCoordinate(origin, outerSize, innerSize) {
  const numericOrigin = Number(origin);
  const numericOuterSize = Number(outerSize);

  if (!Number.isFinite(numericOrigin) || !Number.isFinite(numericOuterSize)) {
    return undefined;
  }

  return Math.max(0, Math.round(numericOrigin + (numericOuterSize - innerSize) / 2));
}

async function createRenameDraft(tab) {
  const titleOverrideKey = getHistoryItemTitleOverrideKey({ url: tab.url });
  const titleOverrides = await loadTitleOverrides();
  const originalTitle = tab.title || tab.url;
  const hasTitleOverride = titleOverrides.has(titleOverrideKey);

  return {
    id: createDraftId(),
    titleOverrideKey,
    url: tab.url,
    currentTitle: titleOverrides.get(titleOverrideKey) || originalTitle,
    originalTitle,
    hasTitleOverride,
    createdAt: Date.now()
  };
}

function createDraftId() {
  return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
}
