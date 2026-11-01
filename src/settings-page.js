import { initializeUserDataControls } from './user-data-controls.js';
import { applySavedTheme, saveTheme } from './theme.js';
import { createSelectControl } from './select-control.js';

const version = globalThis.chrome?.runtime?.getManifest?.()?.version;
const versionLabel = document.querySelector('#app-version');
if (version && versionLabel) versionLabel.textContent = `版本 ${version}`;

const themeSelect = document.querySelector('#theme-color');
const themeDropdown = themeSelect && createSelectControl(themeSelect, { label: '主题色' });
applySavedTheme(document, { onChange: (value) => {
  if (!themeSelect) return;
  themeSelect.value = value;
  themeDropdown.sync();
} });
themeSelect?.addEventListener('change', () => saveTheme(document, themeSelect.value));

document.querySelector('#shortcut-settings')?.addEventListener('click', () => {
  globalThis.chrome?.tabs?.create?.({ url: 'chrome://extensions/shortcuts' });
});

const shortcutLabels = document.querySelectorAll('[data-shortcut-command]');
let shortcutRequest = 0;

function renderShortcuts(commands, failed = false) {
  for (const label of shortcutLabels) {
    const command = commands.find((item) => item.name === label.dataset.shortcutCommand);
    label.replaceChildren();
    // Older Chrome versions may omit the built-in action from getAll().
    // An absent command is unknown; only an empty shortcut means unassigned.
    if (failed || !command) {
      label.textContent = '暂时无法读取';
    } else if (!command.shortcut) {
      label.textContent = '未设置';
    } else {
      const key = document.createElement('kbd');
      key.textContent = command.shortcut;
      label.append(key);
    }
  }
}

function refreshShortcuts() {
  const request = ++shortcutRequest;
  const chrome = globalThis.chrome;
  if (!chrome?.commands?.getAll) {
    renderShortcuts([], true);
    return;
  }
  try {
    chrome.commands.getAll((commands) => {
      const failed = Boolean(chrome.runtime?.lastError);
      if (request !== shortcutRequest) return;
      renderShortcuts(commands ?? [], failed);
    });
  } catch {
    if (request === shortcutRequest) renderShortcuts([], true);
  }
}

window.addEventListener('focus', refreshShortcuts);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') refreshShortcuts();
});
refreshShortcuts();

initializeUserDataControls(document);
