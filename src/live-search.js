export function createLiveSearch({
  read, search, markEdited, markSubmitted, onPending = () => {}, delay = 180,
  setTimer = setTimeout, clearTimer = clearTimeout
}) {
  let timer = null;
  let composing = false;
  let disposed = false;

  function cancel() {
    if (timer !== null) clearTimer(timer);
    timer = null;
  }

  function submit() {
    if (disposed) return;
    cancel();
    if (composing) return;
    const { query, range } = read();
    markSubmitted();
    return search(query, range);
  }

  function schedule() {
    cancel();
    onPending();
    if (composing) return;
    timer = setTimer(submit, delay);
  }

  return {
    input({ isComposing = false } = {}) {
      if (disposed) return;
      if (isComposing) composing = true;
      markEdited();
      schedule();
    },
    compositionStart() {
      if (disposed) return;
      composing = true;
      cancel();
    },
    compositionEnd() {
      if (disposed) return;
      composing = false;
      markEdited();
      schedule();
    },
    submit,
    change() {
      if (disposed) return;
      markEdited();
      if (composing) {
        cancel();
        onPending();
        return;
      }
      return submit();
    },
    cancel,
    dispose() {
      cancel();
      disposed = true;
    }
  };
}
