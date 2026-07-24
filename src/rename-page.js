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
let canRestoreOriginalTitle = false;

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
    canRestoreOriginalTitle = await hasTitleOverride(currentDraft.titleOverrideKey);
    restoreButton.disabled = !canRestoreOriginalTitle;
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
    setError('标题不能为空。');
    titleInput.focus();
    return;
  }

  setPending(true);
  try {
    await saveTitleOverride(currentDraft.titleOverrideKey, title, {
      targetUrl: currentDraft.url
    });
    await deleteRenameDraft(currentDraft.id);
    showSuccessMessage('保存成功');
    closeSoon();
  } catch (error) {
    setPending(false);
    setError(error.message || '保存失败。');
  }
}

async function restoreOriginalTitle() {
  if (!currentDraft) {
    return;
  }

  titleInput.value = currentDraft.originalTitle || currentDraft.url || '';

  setPending(true);
  try {
    await deleteTitleOverrides([currentDraft.titleOverrideKey]);
    await deleteRenameDraft(currentDraft.id);
    showSuccessMessage('已还原原名');
    closeSoon();
  } catch (error) {
    setPending(false);
    setError(error.message || '还原失败。');
  }
}

async function hasTitleOverride(titleOverrideKey) {
  const overrides = await loadTitleOverrides();
  return overrides.has(titleOverrideKey);
}

function renderError(message) {
  titleInput.disabled = true;
  restoreButton.disabled = true;
  setError(message);
}

function setError(message) {
  statusLabel.textContent = message;
}

function setPending(isPending) {
  titleInput.disabled = isPending;
  restoreButton.disabled = isPending || !canRestoreOriginalTitle;
  cancelButton.disabled = isPending;
  form.querySelector('button[type="submit"]').disabled = isPending;

  if (isPending) {
    setError('');
  }
}

function showSuccessMessage(message) {
  document.querySelector('.rename-message')?.remove();

  const element = document.createElement('div');
  element.className = 'rename-message';
  element.setAttribute('role', 'status');
  element.setAttribute('aria-live', 'polite');

  const icon = document.createElement('span');
  icon.className = 'rename-message-icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = '✓';

  const text = document.createElement('span');
  text.textContent = message;
  element.append(icon, text);
  document.body.append(element);
}

function closeWindow() {
  globalThis.close();
}

function closeSoon() {
  globalThis.setTimeout(closeWindow, 1200);
}
