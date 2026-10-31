export const THEME_STORAGE_KEY = 'history-ui-color';
export const THEME_COLORS = ['blue', 'orange', 'green', 'neutral'];

export function applyTheme(document, value) {
  if (!THEME_COLORS.includes(value)) return false;
  document.documentElement.dataset.themeColor = value;
  return true;
}

// Apply the saved accent immediately from the page's local cache, then from
// extension storage. Pages with their own storage listener pass watch: false
// and forward theme changes to applyTheme.
export function applySavedTheme(document, { onChange = () => {}, watch = true } = {}) {
  const apply = (value) => {
    if (applyTheme(document, value)) onChange(value);
  };
  try { apply(globalThis.localStorage?.getItem(THEME_STORAGE_KEY)); } catch { /* Default theme is fine. */ }
  if (!document.documentElement.dataset.themeColor) document.documentElement.dataset.themeColor = 'blue';
  globalThis.chrome?.storage?.local?.get?.(THEME_STORAGE_KEY, (saved) => apply(saved?.[THEME_STORAGE_KEY]));
  if (!watch) return;
  globalThis.chrome?.storage?.onChanged?.addListener?.((changes, area) => {
    if (area === 'local' && changes[THEME_STORAGE_KEY]) apply(changes[THEME_STORAGE_KEY].newValue);
  });
}

export function saveTheme(document, value) {
  if (!applyTheme(document, value)) return;
  globalThis.chrome?.storage?.local?.set?.({ [THEME_STORAGE_KEY]: value });
  try { globalThis.localStorage?.setItem(THEME_STORAGE_KEY, value); } catch { /* Kept for this page. */ }
}
