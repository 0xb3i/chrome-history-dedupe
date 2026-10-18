(() => {
  const INIT_MESSAGE = 'deduped-history:init-inline-rename';
  const SAVE_MESSAGE = 'deduped-history:save-inline-rename';
  const RESTORE_MESSAGE = 'deduped-history:restore-inline-rename';
  const HOST_ID = 'deduped-history-inline-rename-host';

  if (globalThis.__dedupedHistoryInlineRenameInstalled) {
    return;
  }

  globalThis.__dedupedHistoryInlineRenameInstalled = true;
  let currentSession = null;

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

    currentSession?.dispose();

    const host = document.createElement('div');
    host.id = HOST_ID;
    document.documentElement.append(host);

    const shadow = host.attachShadow({ mode: 'open' });
    const overlay = document.createElement('div');
    overlay.className = 'overlay';

    const panel = document.createElement('form');
    panel.className = 'panel';
    panel.setAttribute('aria-label', '重命名网页');

    const title = document.createElement('h2');
    title.textContent = '重命名网页';

    const url = document.createElement('p');
    url.className = 'target-url';
    url.textContent = draft.url;
    url.title = draft.url;

    const field = document.createElement('label');
    field.className = 'field';

    const label = document.createElement('span');
    label.textContent = '名称';

    const input = document.createElement('input');
    input.type = 'text';
    input.autocomplete = 'off';
    input.value = draft.currentTitle || draft.url;

    field.append(label, input);

    const status = document.createElement('p');
    status.className = 'status';
    status.setAttribute('role', 'alert');

    const actions = document.createElement('div');
    actions.className = 'actions';

    const restoreButton = document.createElement('button');
    restoreButton.type = 'button';
    restoreButton.className = 'secondary restore';
    restoreButton.dataset.restoreAvailable = String(draft.hasTitleOverride);
    restoreButton.textContent = '还原原名';
    restoreButton.disabled = !draft.hasTitleOverride;
    restoreButton.hidden = !draft.hasTitleOverride;

    const cancelButton = document.createElement('button');
    cancelButton.type = 'button';
    cancelButton.className = 'secondary';
    cancelButton.textContent = '取消';

    const saveButton = document.createElement('button');
    saveButton.type = 'submit';
    saveButton.dataset.saveAction = '';
    saveButton.className = 'primary';
    saveButton.textContent = '保存';
    panel.dataset.initialName = input.value.trim().replace(/\s+/g, ' ');
    saveButton.disabled = true;
    input.addEventListener('input', () => {
      saveButton.disabled = !input.value.trim() || input.value.trim().replace(/\s+/g, ' ') === panel.dataset.initialName;
    });

    const primaryActions = document.createElement('div');
    primaryActions.className = 'primary-actions';
    primaryActions.append(cancelButton, saveButton);
    actions.append(restoreButton, primaryActions);
    panel.append(title, url, field, status, actions);
    overlay.append(panel);
    shadow.append(createStyle(), overlay);
    chrome.storage?.local?.get?.('history-ui-color', (saved) => {
      const theme = saved?.['history-ui-color'];
      if (['blue', 'orange', 'green', 'neutral'].includes(theme)) host.dataset.themeColor = theme;
    });

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
    let disposed = false;
    let closeTimer = null;
    const close = () => {
      if (disposed) return;
      disposed = true;
      if (closeTimer !== null) globalThis.clearTimeout(closeTimer);
      window.removeEventListener('keydown', protectRenameKeystroke, true);
      host.remove();
      if (currentSession === session) currentSession = null;
    };
    const session = {
      dispose: close,
      isActive: () => !disposed,
      closeSoon() {
        closeTimer = globalThis.setTimeout(close, 1200);
      }
    };
    currentSession = session;

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
      saveRename(draft, input, status, panel, shadow, overlay, session);
    });
    restoreButton.addEventListener('click', () => {
      input.value = draft.originalTitle || draft.url || '';
      restoreRename(draft, status, panel, shadow, overlay, session);
    });
    input.focus();
    input.select();
  }

  async function saveRename(draft, input, status, panel, shadow, overlay, session) {
    const title = input.value.trim().replace(/\s+/g, ' ');

    if (!title) {
      setError(status, '标题不能为空。');
      input.focus();
      return;
    }

    setPending(panel, true);
    try {
      await sendRuntimeMessage({
        type: SAVE_MESSAGE,
        titleOverrideKey: draft.titleOverrideKey,
        title,
        url: draft.url
      });
      if (!session.isActive()) return;
      showSuccessMessage(shadow, overlay, '保存成功');
      session.closeSoon();
    } catch (error) {
      if (!session.isActive()) return;
      setPending(panel, false);
      setError(status, error.message || '保存失败。');
    }
  }

  async function restoreRename(draft, status, panel, shadow, overlay, session) {
    setPending(panel, true);
    try {
      await sendRuntimeMessage({
        type: RESTORE_MESSAGE,
        titleOverrideKey: draft.titleOverrideKey
      });
      if (!session.isActive()) return;
      showSuccessMessage(shadow, overlay, '已还原原名');
      session.closeSoon();
    } catch (error) {
      if (!session.isActive()) return;
      setPending(panel, false);
      setError(status, error.message || '还原失败。');
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

  function setError(status, message) {
    status.textContent = message;
  }

  function setPending(panel, isPending) {
    for (const control of panel.querySelectorAll('input, button')) {
      control.disabled = isPending;
    }
    panel.querySelector('[data-save-action]').textContent = isPending ? '处理中…' : '保存';

    if (!isPending) {
      const restoreButton = panel.querySelector('[data-restore-available]');
      restoreButton.disabled = restoreButton.dataset.restoreAvailable !== 'true';
      const input = panel.querySelector('input');
      panel.querySelector('[data-save-action]').disabled = !input.value.trim() ||
        input.value.trim().replace(/\s+/g, ' ') === panel.dataset.initialName;
    }

    if (isPending) {
      setError(panel.querySelector('.status'), '');
    }
  }

  function showSuccessMessage(shadow, overlay, message) {
    overlay.remove();

    const element = document.createElement('div');
    element.className = 'message';
    element.setAttribute('role', 'status');
    element.setAttribute('aria-live', 'polite');

    const icon = document.createElement('span');
    icon.className = 'message-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = '✓';

    const text = document.createElement('span');
    text.textContent = message;
    element.append(icon, text);
    shadow.append(element);
  }

  function createStyle() {
    const style = document.createElement('style');
    style.textContent = `
      :host {
        all: initial;
        color-scheme: light;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "PingFang SC", "Microsoft YaHei", sans-serif;
      }

      :host {
        --accent: #1264d6;
        --accent-hover: #0958d9;
        --accent-active: #0958d9;
        --text: #26282c;
        --muted: #636b76;
        --line: #e1e6ee;
        --selection: #e3efff;
      }
      :host([data-theme-color="orange"]) {
        --accent: #b65e19; --accent-hover: #8c4210; --accent-active: #8c4210;
        --text: #2d2925; --muted: #71685f; --line: #e9e1d7; --selection: #fff0dc;
      }
      :host([data-theme-color="green"]) {
        --accent: #32816a; --accent-hover: #205b49; --accent-active: #205b49;
        --text: #252d29; --muted: #626f67; --line: #dde8e1; --selection: #e3f3e9;
      }
      :host([data-theme-color="neutral"]) {
        --accent: #45454a; --accent-hover: #252528; --accent-active: #252528;
        --text: #262629; --muted: #626268; --line: #d5d5db; --selection: #ebebef;
      }
      input::selection { background: var(--selection); color: var(--text); }
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
        color: var(--text);
        display: grid;
        gap: 12px;
        margin: 0;
        max-width: min(480px, calc(100vw - 32px));
        padding: 20px 24px 16px;
        width: 480px;
      }

      h2 {
        color: var(--text);
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
        color: var(--text);
        font-size: 14px;
        font-weight: 400;
      }

      input {
        background: #ffffff;
        border: 1px solid var(--line);
        border-radius: 6px;
        box-sizing: border-box;
        color: var(--text);
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
        border-color: var(--accent-hover);
      }

      input:focus {
        border-color: #c4c9d1;
        box-shadow: none;
      }

      .target-url {
        color: var(--muted);
        font-size: 12px;
        line-height: 1.45;
        margin: -6px 0 0;
        white-space: nowrap;
        text-overflow: ellipsis;
        overflow: hidden;
      }

      .status {
        color: #b43838;
        font-size: 12px;
        margin: -2px 0 0;
      }

      .status:empty {
        display: none;
      }

      .message {
        align-items: center;
        animation: message-enter 160ms cubic-bezier(0.645, 0.045, 0.355, 1) both;
        background: #ffffff;
        border-radius: 8px;
        box-shadow: 0 6px 16px 0 rgba(0, 0, 0, 0.08), 0 3px 6px -4px rgba(0, 0, 0, 0.12), 0 9px 28px 8px rgba(0, 0, 0, 0.05);
        color: var(--text);
        display: flex;
        font-size: 14px;
        gap: 8px;
        left: 50%;
        line-height: 1.5714;
        padding: 9px 12px;
        position: fixed;
        top: 24px;
        transform: translateX(-50%);
        white-space: nowrap;
        z-index: 2147483647;
      }

      .message-icon {
        align-items: center;
        border: 1.5px solid currentColor;
        border-radius: 50%;
        color: #35704b;
        display: inline-flex;
        font-size: 10px;
        font-weight: 700;
        height: 16px;
        justify-content: center;
        line-height: 1;
        width: 16px;
      }

      @keyframes message-enter {
        from {
          opacity: 0;
          transform: translate(-50%, -8px);
        }
        to {
          opacity: 1;
          transform: translate(-50%, 0);
        }
      }

      @media (prefers-reduced-motion: reduce) {
        .message {
          animation: none;
        }
      }

      .primary-actions {
        display: flex;
        gap: 8px;
        margin-left: auto;
      }

      .actions {
        display: flex;
        align-items: center;
        width: 100%;
        gap: 8px;
        margin-top: 8px;
      }

      [hidden] { display: none; }

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
        border: 1px solid var(--line);
        color: var(--text);
      }

      .secondary:hover:not(:disabled) {
        border-color: var(--accent-hover);
        color: var(--accent-hover);
      }

      .primary {
        background: var(--accent);
        border: 1px solid var(--accent);
        box-shadow: none;
        color: #ffffff;
      }

      .primary:hover {
        background: var(--accent-hover);
        border-color: var(--accent-hover);
      }

      .primary:active {
        background: var(--accent-active);
        border-color: var(--accent-active);
      }

      @media (max-width: 520px) {
        button { padding-inline: 12px; }
      }
    `;
    return style;
  }
})();
