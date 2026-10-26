'use strict';
/**
 * Long-running task registry with progress events and cooperative
 * cancellation. Cancellation is checked between steps: a single Resolve API
 * call that is already running cannot be interrupted, and the UI says so.
 */
const { SuiteError } = require('../resolve/adapter');

function createTaskRunner(emit) {
  const tasks = new Map();
  let seq = 0;

  function start(kind, fn) {
    const id = `${kind}-${++seq}`;
    const ctrl = { cancelled: false };
    const api = {
      id,
      progress(pct, message) {
        emit({ taskId: id, kind, pct: Math.max(0, Math.min(100, Math.round(pct))), message });
      },
      checkpoint() {
        if (ctrl.cancelled) throw new SuiteError('Cancelled. Steps already completed are listed in the operation log.', 'cancelled');
      },
      get cancelled() { return ctrl.cancelled; },
    };
    tasks.set(id, ctrl);
    const promise = Promise.resolve()
      .then(() => fn(api))
      .finally(() => {
        tasks.delete(id);
        emit({ taskId: id, kind, done: true });
      });
    return { id, promise };
  }

  function cancel(id) {
    const t = tasks.get(id);
    if (!t) return false;
    t.cancelled = true;
    return true;
  }

  return { start, cancel, running: () => [...tasks.keys()] };
}

module.exports = { createTaskRunner };
