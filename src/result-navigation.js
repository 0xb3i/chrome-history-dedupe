const TITLE_SELECTOR = 'a.result-title';
const ACTION_SELECTOR = 'a[href], button, summary, [tabindex]';

function isVisible(element, boundary) {
  for (let node = element; node && node !== boundary; node = node.parentElement) {
    if (node.hidden || node.getAttribute('aria-hidden') === 'true'
      || node.style?.display === 'none' || node.style?.visibility === 'hidden') return false;
    if (node.localName === 'details' && !node.hasAttribute('open')) {
      const summary = [...node.children].find((child) => child.localName === 'summary');
      if (!summary?.contains(element)) return false;
    }
  }
  return !element.disabled && element.getAttribute('aria-disabled') !== 'true';
}

function actionIdentity(element) {
  if (element.matches(TITLE_SELECTOR)) return 'title';
  return element.getAttribute('data-navigation-action')
    || `${element.localName}:${element.getAttribute('role') || ''}:${[...element.classList].sort().join(' ')}`;
}

// Native links keep their Enter behavior. The caller owns busy/modal state and
// supplies stable resource keys on rows or links before rendering them.
export function createResultNavigation({ queryInput, results, isBlocked = () => false, scrollContainer = results }) {
  const document = results.ownerDocument;
  let composing = false;
  let focusRevision = 0;
  const visibleTitles = () => [...results.querySelectorAll(TITLE_SELECTOR)]
    .filter((element) => isVisible(element, results));
  const blocked = () => isBlocked() || results.getAttribute('aria-busy') === 'true';
  const onFocus = () => { focusRevision += 1; };
  const onCompositionStart = () => { composing = true; };
  const onCompositionEnd = () => { composing = false; };

  function onKeydown(event) {
    if (event.defaultPrevented || composing || event.isComposing || event.keyCode === 229
      || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || blocked()) return;
    const fromQuery = event.target === queryInput;
    const fromTitle = event.target.matches?.(TITLE_SELECTOR) && results.contains(event.target);
    if (!fromQuery && !fromTitle) return;
    let target;
    if (fromQuery && event.key === 'ArrowDown') target = visibleTitles()[0];
    else if (fromTitle && event.key === 'Escape') target = queryInput;
    else if (fromTitle && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      const titles = visibleTitles();
      const index = titles.indexOf(event.target);
      if (index === -1) return;
      target = event.key === 'ArrowDown' ? titles[index + 1] : (titles[index - 1] || queryInput);
      // At the last result, stay put instead of scrolling the popup away.
      if (!target) target = event.target;
    }
    if (!target) return;
    event.preventDefault();
    target.focus();
  }

  queryInput.addEventListener('keydown', onKeydown);
  results.addEventListener('keydown', onKeydown);
  queryInput.addEventListener('compositionstart', onCompositionStart);
  queryInput.addEventListener('compositionend', onCompositionEnd);
  document.addEventListener('focusin', onFocus);

  return {
    capture() {
      const element = document.activeElement;
      if (!element || !results.contains(element)) return { scrollTop: scrollContainer.scrollTop };
      const resource = element.closest('[data-navigation-key]');
      const titles = visibleTitles();
      const title = element.matches(TITLE_SELECTOR) ? element : resource?.querySelector(TITLE_SELECTOR);
      return {
        element, key: resource?.getAttribute('data-navigation-key'), action: actionIdentity(element),
        index: Math.max(0, titles.indexOf(title)), focusRevision, scrollTop: scrollContainer.scrollTop
      };
    },
    restore(snapshot) {
      if (!snapshot) return false;
      scrollContainer.scrollTop = snapshot.scrollTop;
      if (!snapshot.element || snapshot.element.isConnected || snapshot.focusRevision !== focusRevision || blocked()) return false;
      const active = document.activeElement;
      if (active?.isConnected && active !== document.body && active !== document.documentElement) return false;
      const resources = [...results.querySelectorAll('[data-navigation-key]')]
        .filter((element) => element.getAttribute('data-navigation-key') === snapshot.key);
      let target;
      for (const resource of resources) {
        const actions = [resource, ...resource.querySelectorAll(ACTION_SELECTOR)];
        target = actions.find((element) => element.matches(ACTION_SELECTOR)
          && actionIdentity(element) === snapshot.action && isVisible(element, results));
        if (target) break;
      }
      target ||= resources.flatMap((resource) => resource.matches(TITLE_SELECTOR)
        ? [resource] : [...resource.querySelectorAll(TITLE_SELECTOR)])
        .find((element) => isVisible(element, results));
      const titles = visibleTitles();
      target ||= titles[Math.min(snapshot.index, titles.length - 1)] || queryInput;
      target.focus({ preventScroll: true });
      scrollContainer.scrollTop = snapshot.scrollTop;
      return true;
    },
    destroy() {
      queryInput.removeEventListener('keydown', onKeydown);
      results.removeEventListener('keydown', onKeydown);
      queryInput.removeEventListener('compositionstart', onCompositionStart);
      queryInput.removeEventListener('compositionend', onCompositionEnd);
      document.removeEventListener('focusin', onFocus);
    }
  };
}
