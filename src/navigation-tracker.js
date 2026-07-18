export function createNavigationTracker() {
  const states = new Map();

  return {
    remove(tabId) {
      states.delete(tabId);
    },

    update(tabId, changeInfo = {}, tab = {}) {
      if (typeof tabId !== 'number') {
        return [tab?.url].filter(Boolean);
      }

      let state = states.get(tabId);
      const hasPendingNavigation = Boolean(tab.pendingUrl) && tab.pendingUrl !== tab.url;
      const startsNavigation = (changeInfo.status === 'loading' && !state?.isLoading) ||
        (Boolean(changeInfo.url) && !state?.isLoading) ||
        (hasPendingNavigation && !state?.isLoading);

      if (!state || startsNavigation) {
        state = {
          isLoading: changeInfo.status === 'loading' || Boolean(changeInfo.url) ||
            hasPendingNavigation,
          urls: new Set()
        };
        states.set(tabId, state);
      }

      const candidateUrls = [changeInfo.url, tab.pendingUrl];
      if (!state.isLoading || changeInfo.status === 'complete') {
        candidateUrls.push(tab.url);
      }

      for (const url of candidateUrls) {
        if (/^(https?|file):/i.test(String(url ?? ''))) {
          state.urls.add(url);
        }
      }

      if (changeInfo.status === 'complete' || (changeInfo.url && tab.status === 'complete')) {
        state.isLoading = false;
      }

      return [...state.urls];
    }
  };
}
