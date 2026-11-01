export const THEME_STORAGE_KEY = 'history-ui-color';
export const THEME_COLORS = ['blue', 'orange', 'green', 'neutral'];

const themeRevisions = new WeakMap();

export function applyTheme(document, value = 'blue') {
  if (!THEME_COLORS.includes(value)) return false;
  document.documentElement.dataset.themeColor = value;
  themeRevisions.set(document, (themeRevisions.get(document) ?? 0) + 1);
  try { globalThis.localStorage?.setItem(THEME_STORAGE_KEY, value); } catch { /* Extension storage remains authoritative. */ }
  return true;
}

// Apply the cached accent immediately, then reconcile with extension storage.
// Pages with their own storage listener pass watch: false and forward changes
// to applyTheme so they also invalidate an older in-flight initial read.
export function applySavedTheme(document, { onChange = () => {}, watch = true } = {}) {
  const apply = (value) => {
    if (applyTheme(document, value)) onChange(document.documentElement.dataset.themeColor);
  };
  let cached;
  try { cached = globalThis.localStorage?.getItem(THEME_STORAGE_KEY); } catch { /* Read the authoritative value below. */ }
  apply(THEME_COLORS.includes(cached) ? cached : 'blue');

  if (watch) globalThis.chrome?.storage?.onChanged?.addListener?.((changes, area) => {
    if (area === 'local' && changes[THEME_STORAGE_KEY]) apply(changes[THEME_STORAGE_KEY].newValue);
  });
  const revision = themeRevisions.get(document);
  globalThis.chrome?.storage?.local?.get?.(THEME_STORAGE_KEY, (saved) => {
    const failed = Boolean(globalThis.chrome?.runtime?.lastError);
    if (failed || themeRevisions.get(document) !== revision) return;
    apply(saved?.[THEME_STORAGE_KEY]);
  });
}

export function saveTheme(document, value) {
  if (!THEME_COLORS.includes(value) || !applyTheme(document, value)) return;
  globalThis.chrome?.storage?.local?.set?.({ [THEME_STORAGE_KEY]: value });
}
