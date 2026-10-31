import { initializeUserDataControls } from './user-data-controls.js';
import { applySavedTheme, saveTheme } from './theme.js';

const version = globalThis.chrome?.runtime?.getManifest?.()?.version;
const versionLabel = document.querySelector('#app-version');
if (version && versionLabel) versionLabel.textContent = `版本 ${version}`;

const themeSelect = document.querySelector('#theme-color');
applySavedTheme(document, { onChange: (value) => { if (themeSelect) themeSelect.value = value; } });
themeSelect?.addEventListener('change', () => saveTheme(document, themeSelect.value));

document.querySelector('#shortcut-settings')?.addEventListener('click', () => {
  globalThis.chrome?.tabs?.create?.({ url: 'chrome://extensions/shortcuts' });
});

initializeUserDataControls(document);
