'use strict';
(function () {
  const { $, h, call } = window.UI;
  const state = window.SuiteState;
  let current = 'overview';

  function render() {
    const view = window.Views[current];
    $('#view').replaceChildren(view(render));
  }

  function chips() {
    const s = state.summary;
    const box = $('#summary-chips');
    if (!s) return box.replaceChildren(h('span.chip', 'Not connected'));
    const tl = s.timeline;
    box.replaceChildren(...[
      h('span.chip', h('b', s.project ? s.project.name : 'No project')),
      tl ? h('span.chip', h('b', tl.name)) : h('span.chip.warn', 'No timeline'),
      tl ? h('span.chip', h('b', tl.rate), ` fps${tl.dropFrame ? ' DF' : ''}`) : null,
      tl ? h('span.chip', h('b', `${tl.width}×${tl.height}`), ` ${tl.aspect}`) : null,
      tl ? h('span.chip', h('b', tl.duration)) : null,
      s.problems.length ? h('span.chip.warn', `${s.problems.length} note(s)`) : null,
    ].filter(Boolean));
  }

  async function refresh() {
    try {
      const s = await call('project.summary', undefined, { quiet: true });
      state.summary = s;
      state.caps = s.capabilities || {};
      $('#conn-status').replaceChildren(h('span.dot.ok'), `${s.resolve.product || 'Resolve'} ${s.resolve.versionString || ''}`);
      state.favourites = (await call('settings.get', undefined, { quiet: true })).favourites;
      state.checklist = await call('setup.checklist', undefined, { quiet: true }).catch(() => null);
      call('assets.captionStyles', undefined, { quiet: true }).then((r) => { state.styles = r.styles; }).catch(() => {});
    } catch (e) {
      state.summary = null;
      $('#conn-status').replaceChildren(h('span.dot.err'), e.info ? e.info.source : 'Not connected');
      const banner = $('#init-error');
      banner.textContent = e.message;
      banner.classList.remove('hidden');
    }
    chips();
    render();
  }

  window.SuiteRefresh = refresh;

  $('#nav').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-view]');
    if (!b) return;
    for (const x of document.querySelectorAll('#nav button')) x.classList.toggle('active', x === b);
    current = b.dataset.view;
    render();
  });
  $('#refresh-summary').addEventListener('click', () => { $('#init-error').classList.add('hidden'); refresh(); });

  (async () => {
    const initError = await call('app.initError', undefined, { quiet: true }).catch(() => null);
    if (initError) {
      const banner = $('#init-error');
      banner.textContent = initError;
      banner.classList.remove('hidden');
    }
    const info = await call('app.info', undefined, { quiet: true }).catch(() => null);
    if (info) $('#app-version').textContent = `v${info.version}`;
    await refresh();
  })();
})();
