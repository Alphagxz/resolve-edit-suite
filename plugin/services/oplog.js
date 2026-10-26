'use strict';
/**
 * Operation log: one record per user-level action (what, on which objects,
 * result, errors) plus the API calls it made. Persisted as JSONL by storage.
 */
const { describeError } = require('../resolve/adapter');

function createOpLog(storage) {
  let current = null;

  return {
    /** API-level call record (attached to the running operation). */
    api(rec) {
      if (current) current.calls.push(rec);
    },
    async run(action, affected, fn) {
      const op = { id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`, action, affected, calls: [] };
      const prev = current;
      current = op;
      const started = Date.now();
      try {
        const result = await fn(op);
        storage.appendLog({ id: op.id, action, affected, result: 'ok', summary: result && result.summary, ms: Date.now() - started, calls: op.calls });
        return result;
      } catch (e) {
        const d = describeError(e);
        storage.appendLog({ id: op.id, action, affected, result: 'error', error: d, ms: Date.now() - started, calls: op.calls });
        throw e;
      } finally {
        current = prev;
      }
    },
  };
}

module.exports = { createOpLog };
