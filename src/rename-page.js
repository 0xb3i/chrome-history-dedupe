import {
  deleteRenameDraft,
  deleteTitleOverrides,
  loadRenameDraft,
  loadTitleOverrides,
  saveTitleOverride
} from './storage.js';

const form = document.querySelector('#rename-form');
const titleInput = document.querySelector('#rename-title');
const statusLabel = document.querySelector('#rename-status');
const cancelButton = document.querySelector('#cancel-button');
const restoreButton = document.querySelector('#restore-button');

let currentDraft = null;

form.addEventListener('submit', (event) => {
  event.preventDefault();
  saveRename();
});

cancelButton.addEventListener('click', () => {
  closeWindow();
});

restoreButton.addEventListener('click', () => {
  restoreOriginalTitle();
});

init();

async function init() {
  const draftId = new URLSearchParams(globalThis.location.search).get('draft');

  if (!draftId) {
    renderError('没有找到要重命名的网页。');
    return;
  }

  try {
    currentDraft = await loadRenameDraft(draftId);

    if (!currentDraft) {
      renderError('重命名窗口已过期，请重新按快捷键。');
      return;
    }

    titleInput.value = currentDraft.currentTitle;
    restoreButton.disabled = !(await hasTitleOverride(currentDraft.titleOverrideKey));
    titleInput.select();
  } catch (error) {
    renderError(error.message || '读取网页信息失败。');
  }
}

async function saveRename() {
  if (!currentDraft) {
    return;
  }

  const title = titleInput.value.trim().replace(/\s+/g, ' ');

  if (!title) {
    setStatus('标题不能为空。');
    titleInput.focus();
    return;
  }

  try {
    await saveTitleOverride(currentDraft.titleOverrideKey, title);
    await deleteRenameDraft(currentDraft.id);
    setStatus('已保存');
    closeSoon();
  } catch (error) {
    setStatus(error.message || '保存失败。');
  }
}

async function restoreOriginalTitle() {
  if (!currentDraft) {
    return;
  }

  titleInput.value = currentDraft.originalTitle || currentDraft.url || '';

  try {
    await deleteTitleOverrides([currentDraft.titleOverrideKey]);
    await deleteRenameDraft(currentDraft.id);
    setStatus('已还原');
    closeSoon();
  } catch (error) {
    setStatus(error.message || '还原失败。');
  }
}

async function hasTitleOverride(titleOverrideKey) {
  const overrides = await loadTitleOverrides();
  return overrides.has(titleOverrideKey);
}

function renderError(message) {
  titleInput.disabled = true;
  restoreButton.disabled = true;
  setStatus(message);
}

function setStatus(message) {
  statusLabel.textContent = message;
}

function closeWindow() {
  globalThis.close();
}

function closeSoon() {
  globalThis.setTimeout(closeWindow, 250);
}
