export const INLINE_RENAME_PREPARE_TIMEOUT_MS = 300;

export async function waitForInlineRenamePreparation(preparation, options = {}) {
  const timeoutMs = Number(options.timeoutMs ?? INLINE_RENAME_PREPARE_TIMEOUT_MS);
  const setTimeoutApi = options.setTimeoutApi ?? globalThis.setTimeout;
  const clearTimeoutApi = options.clearTimeoutApi ?? globalThis.clearTimeout;
  let timeoutId;

  try {
    return await Promise.race([
      Promise.resolve(preparation).then(() => true, () => false),
      new Promise((resolve) => {
        timeoutId = setTimeoutApi(() => resolve(false), timeoutMs);
      })
    ]);
  } finally {
    if (timeoutId !== undefined) {
      clearTimeoutApi(timeoutId);
    }
  }
}
