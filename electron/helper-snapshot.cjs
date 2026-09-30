// A transient IPC failure must not permanently disable status polling.
function createSnapshotPoller({ request, receive, failed, now = Date.now }) {
  let pending = null;
  let checkedAt = -Infinity;
  let retrying = false;
  return {
    invalidate() {
      checkedAt = -Infinity;
    },
    refresh(ids, force = false) {
      if (pending) return pending;
      if (!force && now() - checkedAt < (retrying ? 5000 : 1500)) return;
      checkedAt = now();
      pending = Promise.resolve()
        .then(() => request({ op: "snapshot", ids }, 10000))
        .then((snapshot) => {
          retrying = false;
          receive(snapshot);
        })
        .catch((error) => {
          retrying = true;
          failed(error);
        })
        .finally(() => {
          pending = null;
        });
      return pending;
    },
  };
}
module.exports = { createSnapshotPoller };
