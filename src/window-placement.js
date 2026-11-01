export function getCenteredCoordinate(origin, outerSize, innerSize) {
  const numericOrigin = Number(origin);
  const numericOuterSize = Number(outerSize);
  const numericInnerSize = Number(innerSize);

  if (
    !Number.isFinite(numericOrigin) ||
    !Number.isFinite(numericOuterSize) ||
    !Number.isFinite(numericInnerSize)
  ) {
    return undefined;
  }

  return Math.round(numericOrigin + (numericOuterSize - numericInnerSize) / 2);
}

// Fit the client area without assuming an OS title-bar height or browser zoom.
export function observeContentWindowHeight(content, windowApi = globalThis) {
  let frame = null;
  let resizing = false;
  let pending = false;
  let stopped = false;

  function scheduleResize() {
    if (stopped) return;
    if (resizing) {
      pending = true;
      return;
    }
    if (frame === null) frame = windowApi.requestAnimationFrame(resize);
  }

  async function resize() {
    frame = null;
    if (stopped) return;
    resizing = true;
    try {
      const [current, zoom] = await Promise.all([
        windowApi.chrome.windows.getCurrent(),
        windowApi.chrome.tabs.getZoom()
      ]);
      if (stopped || current.type !== 'popup') return;

      const contentHeight = content.getBoundingClientRect().height;
      const delta = (contentHeight - windowApi.innerHeight) * zoom;
      if (!Number.isFinite(delta) || contentHeight <= 0 || zoom <= 0 || Math.abs(delta) < 1) return;

      const height = current.height + Math.ceil(delta);
      const top = getCenteredCoordinate(current.top, current.height, height);
      await windowApi.chrome.windows.update(current.id, {
        height,
        ...(top === undefined ? {} : { top })
      });
    } catch (error) {
      // Resizing is cosmetic; keep the rename form usable if the window closed.
      windowApi.console?.warn('Could not fit the rename window to its content.', error);
    } finally {
      resizing = false;
      if (pending) {
        pending = false;
        scheduleResize();
      }
    }
  }

  const observer = new windowApi.ResizeObserver(scheduleResize);
  observer.observe(content);
  scheduleResize();

  return () => {
    stopped = true;
    observer.disconnect();
    if (frame !== null) windowApi.cancelAnimationFrame(frame);
  };
}
