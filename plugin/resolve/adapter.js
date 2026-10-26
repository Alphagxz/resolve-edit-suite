'use strict';
/**
 * Thin, instrumented wrapper around the Resolve scripting objects exposed by
 * WorkflowIntegration.node. Every call goes through `call()`, which:
 *   - checks the method exists (see capabilities.js for reliability caveats)
 *   - enforces a timeout when the binding returns a promise
 *   - classifies failures so Diagnostics can say whether a problem comes from
 *     Resolve, a missing asset, a disabled API method or the plugin itself
 *   - records the call in the operation log
 */

class SuiteError extends Error {
  /**
   * @param {string} message  user-facing, actionable
   * @param {'resolve-not-connected'|'no-project'|'no-timeline'|'method-missing'|'call-failed'|'timeout'|'exception'|'unsupported'|'edition'|'asset-missing'|'invalid-input'|'verification-failed'|'cancelled'|'plugin'} category
   * @param {object} [detail]
   */
  constructor(message, category, detail = {}) {
    super(message);
    this.name = 'SuiteError';
    this.category = category;
    this.detail = detail;
  }
}

const SOURCE_OF = {
  'resolve-not-connected': 'Resolve',
  'no-project': 'Resolve state',
  'no-timeline': 'Resolve state',
  'method-missing': 'Resolve API (method not exposed on this build)',
  'call-failed': 'Resolve API (call returned failure)',
  timeout: 'Resolve API (no response)',
  exception: 'Resolve API (raised an error)',
  unsupported: 'Resolve API limitation',
  edition: 'Resolve edition',
  'asset-missing': 'Missing asset',
  'invalid-input': 'Input',
  'verification-failed': 'Result verification',
  cancelled: 'Cancelled by user',
  plugin: 'Plugin',
};

function describeError(err) {
  if (err instanceof SuiteError) {
    return { message: err.message, category: err.category, source: SOURCE_OF[err.category] || 'Plugin', detail: err.detail };
  }
  return { message: err && err.message ? err.message : String(err), category: 'plugin', source: 'Plugin (unexpected error)', detail: { stack: err && err.stack } };
}

function createAdapter({ resolve, log, timeoutMs = 30000 }) {
  if (!resolve) throw new SuiteError('Could not connect to DaVinci Resolve. Make sure Resolve Studio is running and the plugin was opened from Workspace > Workflow Integrations.', 'resolve-not-connected');

  async function call(objType, obj, method, ...args) {
    if (!obj) throw new SuiteError(`No ${objType} object available for ${method}.`, objType === 'Project' ? 'no-project' : objType === 'Timeline' ? 'no-timeline' : 'plugin');
    let fn;
    try { fn = obj[method]; } catch { fn = undefined; }
    if (typeof fn !== 'function') {
      throw new SuiteError(`${objType}.${method} is not available in this version of Resolve.`, 'method-missing', { objType, method });
    }
    const started = Date.now();
    let result;
    try {
      const value = fn.apply(obj, args);
      result = value && typeof value.then === 'function'
        ? await Promise.race([value, new Promise((_, rej) => setTimeout(() => rej(new SuiteError(`${objType}.${method} did not respond within ${timeoutMs / 1000}s.`, 'timeout', { objType, method })), timeoutMs))])
        : value;
    } catch (e) {
      if (e instanceof SuiteError) throw e;
      log && log.api({ objType, method, ok: false, ms: Date.now() - started, error: e.message });
      throw new SuiteError(`${objType}.${method} raised an error: ${e.message}`, 'exception', { objType, method });
    }
    log && log.api({ objType, method, ok: result !== false && result !== undefined && result !== null, ms: Date.now() - started });
    return result;
  }

  /** Like call(), but treats false/null/undefined as failure with a clear message. */
  async function must(objType, obj, method, ...args) {
    const r = await call(objType, obj, method, ...args);
    if (r === false || r === null || r === undefined) {
      throw new SuiteError(`${objType}.${method} reported failure.`, 'call-failed', { objType, method });
    }
    return r;
  }

  async function version() {
    const v = await call('Resolve', resolve, 'GetVersion');
    const vs = await call('Resolve', resolve, 'GetVersionString').catch(() => null);
    let product = null;
    try { product = await call('Resolve', resolve, 'GetProductName'); } catch { product = null; }
    const arr = Array.isArray(v) ? v : v && typeof v === 'object' ? Object.values(v) : null;
    const isStudio = product ? /studio/i.test(String(product)) : null;
    return { version: arr ? arr.slice(0, 4).map(Number) : null, versionString: vs, product, isStudio };
  }

  async function projectManager() {
    return must('Resolve', resolve, 'GetProjectManager');
  }

  async function currentProject() {
    const pm = await projectManager();
    const p = await call('ProjectManager', pm, 'GetCurrentProject');
    if (!p) throw new SuiteError('No project is open in Resolve.', 'no-project');
    return { pm, project: p };
  }

  async function currentTimeline() {
    const { pm, project } = await currentProject();
    const tl = await call('Project', project, 'GetCurrentTimeline');
    if (!tl) throw new SuiteError('The current project has no active timeline. Open a timeline on the Edit page.', 'no-timeline');
    return { pm, project, timeline: tl };
  }

  return { resolve, call, must, version, projectManager, currentProject, currentTimeline };
}

module.exports = { SuiteError, createAdapter, describeError, SOURCE_OF };
