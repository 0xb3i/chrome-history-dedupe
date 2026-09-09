export function createRenameSession() {
  let current = null;
  return {
    open(value) {
      current = { value, pending: false };
    },
    close() { current = null; },
    get value() { return current?.value; },
    async run(operation, { pending, success, error }) {
      const session = current;
      if (!session || session.pending) return;
      session.pending = true;
      pending(true);
      try {
        await operation(session.value);
        if (current === session) success();
      } catch (failure) {
        if (current === session) error(failure);
      } finally {
        session.pending = false;
        if (current === session) pending(false);
      }
    }
  };
}
