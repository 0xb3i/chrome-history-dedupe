const CAPTURABLE_URL = /^(https?|file):/i;

export function createNavigationTracker() {
  const states = new Map();

  function isMainFrame(details) {
    return typeof details?.tabId === 'number' && details.tabId >= 0 && details.frameId === 0;
  }

  function isOlderEvent(details, state) {
    return Number(details.timeStamp ?? 0) < Number(state?.timeStamp ?? 0);
  }

  return {
    remove(tabId) {
      states.delete(tabId);
    },

    beforeNavigate(details) {
      if (!isMainFrame(details)) return;
      const previous = states.get(details.tabId);
      if (isOlderEvent(details, previous)) return;
      states.set(details.tabId, {
        pendingUrl: details.url,
        timeStamp: details.timeStamp,
        // webNavigation has no navigation ID before commit. Overlapping starts
        // cannot safely be associated with a later redirect, so do not alias them.
        ambiguous: Boolean(previous?.pendingUrl)
      });
    },

    committed(details) {
      if (!isMainFrame(details)) return;
      const previous = states.get(details.tabId);
      if (isOlderEvent(details, previous)) return;
      const aliases = [details.url];
      if (
        previous?.pendingUrl && !previous.ambiguous &&
        details.transitionQualifiers?.includes('server_redirect') &&
        CAPTURABLE_URL.test(previous.pendingUrl)
      ) {
        aliases.unshift(previous.pendingUrl);
      }
      states.set(details.tabId, {
        url: details.url,
        aliases: [...new Set(aliases)],
        timeStamp: details.timeStamp
      });
    },

    errorOccurred(details) {
      if (!isMainFrame(details)) return;
      const state = states.get(details.tabId);
      if (isOlderEvent(details, state)) return;
      // An aborted navigation can report its error after its replacement starts.
      // Clear only the pending URL that the event actually identifies.
      if (state?.pendingUrl === details.url) states.delete(details.tabId);
    },

    getCaptureUrls(tabId, tab = {}) {
      const url = String(tab.url ?? '');
      const state = states.get(tabId);
      if (
        !CAPTURABLE_URL.test(url) || state?.pendingUrl ||
        (tab.pendingUrl && tab.pendingUrl !== url)
      ) {
        return [];
      }
      if (state?.url === url) return [...state.aliases];
      // SPA URL changes and worker restarts supply only their own URL; neither
      // is evidence that the previous and current pages are the same resource.
      states.set(tabId, { url, aliases: [url], timeStamp: state?.timeStamp });
      return [url];
    }
  };
}
