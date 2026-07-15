(() => {
  const INIT_MESSAGE = 'deduped-history:init-inline-rename';
  const SAVE_MESSAGE = 'deduped-history:save-inline-rename';
  const RESTORE_MESSAGE = 'deduped-history:restore-inline-rename';
  const HOST_ID = 'deduped-history-inline-rename-host';

  if (globalThis.__dedupedHistoryInlineRenameInstalled) {
    return;
  }

  globalThis.__dedupedHistoryInlineRenameInstalled = true;

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== INIT_MESSAGE) {
      return false;
    }

    showRenameOverlay(message.draft);
    sendResponse({ ok: true });
    return false;
  });

  function showRenameOverlay(draft) {
    if (!draft?.titleOverrideKey || !draft?.url) {
      return;
    }

    const existingHost = document.getElementById(HOST_ID);
    if (existingHost) {
      existingHost.remove();
    }

    const host = document.createElement('div');
    host.id = HOST_ID;
    document.documentElement.append(host);

    const shadow = host.attachShadow({ mode: 'open' });
    const overlay = document.createElement('div');
    overlay.className = 'overlay';

    const panel = document.createElement('form');
    panel.className = 'panel';
    panel.setAttribute('aria-label', '修改网页名');

    const title = document.createElement('h2');
    title.textContent = '修改网页名';

    const field = document.createElement('label');
    field.className = 'field';

    const label = document.createElement('span');
    label.textContent = '网页名';

    const input = document.createElement('input');
    input.type = 'text';
    input.autocomplete = 'off';
    input.value = draft.currentTitle || draft.url;

    field.append(label, input);

    const status = document.createElement('p');
    status.className = 'status';
    status.setAttribute('role', 'status');

    const actions = document.createElement('div');
    actions.className = 'actions';

    const restoreButton = document.createElement('button');
    restoreButton.type = 'button';
    restoreButton.className = 'secondary';
    restoreButton.textContent = '还原原名';
    restoreButton.disabled = !draft.hasTitleOverride;

    const cancelButton = document.createElement('button');
    cancelButton.type = 'button';
    cancelButton.className = 'secondary';
    cancelButton.textContent = '取消';

    const saveButton = document.createElement('button');
    saveButton.type = 'submit';
    saveButton.className = 'primary';
    saveButton.textContent = '保存';

    actions.append(restoreButton, cancelButton, saveButton);
    panel.append(title, field, status, actions);
    overlay.append(panel);
    shadow.append(createStyle(), overlay);

    const protectRenameKeystroke = (event) => {
      if (!event.composedPath().includes(host)) {
        return;
      }

      event.stopImmediatePropagation();

      if (event.key === 'Escape') {
        event.preventDefault();
        close();
      }
    };
    const close = () => {
      window.removeEventListener('keydown', protectRenameKeystroke, true);
      host.remove();
    };

    window.addEventListener('keydown', protectRenameKeystroke, true);

    cancelButton.addEventListener('click', close);
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) {
        close();
      }
    });
    panel.addEventListener('click', (event) => event.stopPropagation());
    panel.addEventListener('submit', (event) => {
      event.preventDefault();
      saveRename(draft, input, status, close);
    });
    restoreButton.addEventListener('click', () => {
      input.value = draft.originalTitle || draft.url || '';
      restoreRename(draft, status, close);
    });
    input.focus();
    input.select();
  }

  async function saveRename(draft, input, status, close) {
    const title = input.value.trim().replace(/\s+/g, ' ');

    if (!title) {
      setStatus(status, '标题不能为空。');
      input.focus();
      return;
    }

    try {
      await sendRuntimeMessage({
        type: SAVE_MESSAGE,
        titleOverrideKey: draft.titleOverrideKey,
        title
      });
      setStatus(status, '已保存');
      closeSoon(close);
    } catch (error) {
      setStatus(status, error.message || '保存失败。');
    }
  }

  async function restoreRename(draft, status, close) {
    try {
      await sendRuntimeMessage({
        type: RESTORE_MESSAGE,
        titleOverrideKey: draft.titleOverrideKey
      });
      setStatus(status, '已还原');
      closeSoon(close);
    } catch (error) {
      setStatus(status, error.message || '还原失败。');
    }
  }

  function sendRuntimeMessage(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (response) => {
        const lastError = chrome.runtime.lastError;

        if (lastError) {
          reject(new Error(lastError.message));
          return;
        }

        if (!response?.ok) {
          reject(new Error(response?.error || '操作失败。'));
          return;
        }

        resolve(response);
      });
    });
  }

  function setStatus(status, message) {
    status.textContent = message;
  }

  function closeSoon(close) {
    globalThis.setTimeout(close, 250);
  }

  function createStyle() {
    const style = document.createElement('style');
    style.textContent = `
      :host {
        all: initial;
        color-scheme: light;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "PingFang SC", "Microsoft YaHei", sans-serif;
      }

      .overlay {
        align-items: center;
        background: rgba(0, 0, 0, 0.45);
        box-sizing: border-box;
        display: flex;
        inset: 0;
        justify-content: center;
        padding: 24px;
        position: fixed;
        z-index: 2147483647;
      }

      .panel {
        background: #ffffff;
        border: none;
        border-radius: 8px;
        box-shadow: 0 6px 16px 0 rgba(0, 0, 0, 0.08), 0 3px 6px -4px rgba(0, 0, 0, 0.12), 0 9px 28px 8px rgba(0, 0, 0, 0.05);
        box-sizing: border-box;
        color: rgba(0, 0, 0, 0.88);
        display: grid;
        gap: 14px;
        margin: 0;
        max-width: min(480px, calc(100vw - 32px));
        padding: 20px 24px 16px;
        width: 480px;
      }

      h2 {
        color: rgba(0, 0, 0, 0.88);
        font-size: 16px;
        font-weight: 600;
        line-height: 1.5;
        margin: 0;
      }

      .field {
        display: grid;
        gap: 6px;
      }

      .field span {
        color: rgba(0, 0, 0, 0.88);
        font-size: 14px;
        font-weight: 400;
      }

      input {
        background: #ffffff;
        border: 1px solid #d9d9d9;
        border-radius: 6px;
        box-sizing: border-box;
        color: rgba(0, 0, 0, 0.88);
        font: inherit;
        font-size: 14px;
        line-height: 1.5714;
        min-height: 32px;
        outline: none;
        padding: 4px 11px;
        transition: border-color 200ms cubic-bezier(0.645, 0.045, 0.355, 1), box-shadow 200ms cubic-bezier(0.645, 0.045, 0.355, 1);
        width: 100%;
      }

      input:hover {
        border-color: #4096ff;
      }

      input:focus {
        border-color: #1677ff;
        box-shadow: 0 0 0 2px rgba(5, 145, 255, 0.1);
      }

      .status {
        color: #ff4d4f;
        font-size: 12px;
        min-height: 16px;
        margin: -2px 0 0;
      }

      .actions {
        display: flex;
        gap: 8px;
        justify-content: flex-end;
      }

      button {
        border-radius: 6px;
        box-sizing: border-box;
        cursor: pointer;
        font: inherit;
        font-size: 14px;
        font-weight: 400;
        line-height: 1;
        min-height: 32px;
        padding: 0 15px;
        transition: background 200ms cubic-bezier(0.645, 0.045, 0.355, 1), border-color 200ms cubic-bezier(0.645, 0.045, 0.355, 1), color 200ms cubic-bezier(0.645, 0.045, 0.355, 1);
      }

      button:disabled {
        cursor: not-allowed;
        opacity: 0.5;
      }

      .secondary {
        background: #ffffff;
        border: 1px solid #d9d9d9;
        color: rgba(0, 0, 0, 0.88);
      }

      .secondary:hover:not(:disabled) {
        border-color: #4096ff;
        color: #4096ff;
      }

      .primary {
        background: #1677ff;
        border: 1px solid #1677ff;
        box-shadow: none;
        color: #ffffff;
      }

      .primary:hover {
        background: #4096ff;
        border-color: #4096ff;
      }

      .primary:active {
        background: #0958d9;
        border-color: #0958d9;
      }

      @media (max-width: 520px) {
        .actions {
          display: grid;
          grid-template-columns: 1fr 1fr 1fr;
        }

        button {
          padding-inline: 8px;
        }
      }
    `;
    return style;
  }
})();
