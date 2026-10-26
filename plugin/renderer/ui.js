'use strict';
/* Small DOM + IPC helpers shared by the views. No framework, no remote code. */
(function () {
  const $ = (sel, root = document) => root.querySelector(sel);

  /** h('div.card', {onclick}, children...) */
  function h(tag, attrs, ...children) {
    const [name, ...classes] = tag.split('.');
    const el = document.createElement(name || 'div');
    if (classes.length) el.className = classes.join(' ');
    // Anything that is not a plain attribute object (including 0 and '') is a child.
    if (attrs !== null && attrs !== undefined && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) {
      children.unshift(attrs);
      attrs = null;
    }
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'class') el.className += ' ' + v;
      else if (k === 'style') el.style.cssText = v; // CSSOM: allowed under the strict CSP
      else if (k === 'value') el.value = v;
      else if (k === 'checked') el.checked = Boolean(v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat(Infinity)) {
      if (c === null || c === undefined || c === false) continue;
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }

  function toast(message, { ok = false, warn = false, source, ms = 7000 } = {}) {
    const el = h('div.toast' + (ok ? '.ok' : warn ? '.warn' : ''), message, source ? h('small', `Source: ${source}`) : null);
    const box = $('#toasts');
    box.append(el);
    while (box.children.length > 3) box.firstElementChild.remove();
    setTimeout(() => el.remove(), ms);
  }

  /** Invoke a main-process operation; surfaces errors with their source. */
  async function call(op, args, { quiet = false } = {}) {
    const r = await window.suite.invoke(op, args);
    if (!r.ok) {
      if (!quiet) toast(r.error.message, { source: r.error.source });
      const err = new Error(r.error.message);
      err.info = r.error;
      throw err;
    }
    return r.result;
  }

  function confirmAction(title, bodyNodes, okLabel = 'Continue') {
    const dlg = $('#confirm');
    $('#confirm-title').textContent = title;
    const body = $('#confirm-body');
    body.replaceChildren(...[].concat(bodyNodes).map((n) => (n instanceof Node ? n : h('p', n))));
    $('#confirm-ok').textContent = okLabel;
    dlg.showModal();
    return new Promise((resolve) => dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok'), { once: true }));
  }

  // Task progress cards with cooperative cancel.
  const tasks = new Map();
  window.suite.on('suite:task-started', ({ taskId, kind }) => {
    const bar = h('i', { style: 'width:0%' });
    const msg = h('div.small.muted', 'Starting…');
    const cancel = h('button.ghost', { onclick: () => { call('task.cancel', { taskId }); msg.textContent = 'Cancelling after the current step…'; cancel.disabled = true; } }, 'Cancel');
    const el = h('div.task', h('div.row', h('strong', kind.replace(/-/g, ' ')), h('span.spacer'), cancel), h('div.bar', bar), msg);
    tasks.set(taskId, { el, bar, msg });
    $('#tasks').append(el);
  });
  window.suite.on('suite:progress', (e) => {
    const t = tasks.get(e.taskId);
    if (!t) return;
    if (e.done) { t.el.remove(); tasks.delete(e.taskId); return; }
    t.bar.style.width = `${e.pct}%`;
    if (e.message) t.msg.textContent = e.message;
  });

  const badgeFor = (status) => ({ available: 'ok', assumed: 'warn', 'needs-verification': 'warn', unavailable: 'err', 'failed-verification': 'err' }[status] || '');
  const EVIDENCE = {
    'verified-here': 'Verified on this machine',
    'live-21.1': 'Third-party live test, 21.1',
    'live-21.0': 'Third-party live test, 21.0',
    'live-legacy': 'Third-party live test, 19/20',
    reported: 'Single user report',
    unverified: 'Unverified',
  };

  function field(label, input) { return h('label.field', label, input); }
  function num(value, attrs = {}) { return h('input', { type: 'number', value, ...attrs }); }
  function select(options, value, attrs = {}) {
    return h('select', attrs, options.map(([v, l]) => h('option', { value: v, selected: String(v) === String(value) || undefined }, l)));
  }
  function list(items, cls = 'plain') { return items && items.length ? h('ul.' + cls, items.map((i) => h('li', i))) : null; }

  window.UI = { $, h, toast, call, confirmAction, badgeFor, EVIDENCE, field, num, select, list };
})();
