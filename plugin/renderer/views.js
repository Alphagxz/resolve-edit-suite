'use strict';
/* Module views. Every control maps to a router operation; nothing is decorative. */
(function () {
  const { h, call, toast, confirmAction, badgeFor, EVIDENCE, field, num, select, list } = window.UI;
  const state = { summary: null, caps: {}, captionPreview: null, roughcut: null, styles: [], favourites: { templates: [], captionStyles: [] } };
  window.SuiteState = state;

  const capBadge = (id) => {
    const c = state.caps[id];
    if (!c) return h('span.badge', 'unknown');
    return h('span.badge.' + badgeFor(c.status), { title: [...c.reasons, ...c.caveats].join('\n') }, `${c.status} · ${EVIDENCE[c.evidence] || c.evidence}`);
  };
  const usable = (id) => state.caps[id] && ['available', 'assumed'].includes(state.caps[id].status);
  const sec = (t) => `${Number(t).toFixed(2)} s`;

  // ---------- Overview ----------
  function overview() {
    const s = state.summary;
    if (!s) return h('div', h('h1', 'Overview'), h('p.lead', 'Reading project from Resolve…'));
    const tl = s.timeline;
    return h('div',
      h('h1', 'Overview'),
      h('p.lead', 'Live summary of the open project and timeline as reported by Resolve. Use Refresh after switching timelines.'),
      h('div.grid.cols-3',
        h('div.card', h('h2', 'Resolve'),
          h('div', h('b', s.resolve.product || 'DaVinci Resolve'), ' ', s.resolve.versionString || ''),
          s.resolve.isStudio === false ? h('div.notice.warn', 'Free edition: transcription and auto-subtitles need Studio, and Workflow Integrations are a Studio feature.') : null),
        h('div.card', h('h2', 'Project'),
          s.project ? [h('div', h('b', s.project.name)), h('div.muted.small', `${s.project.timelineCount} timeline(s) · project default ${s.project.frameRate} fps ${s.project.width}×${s.project.height}`)] : h('div.muted', 'No project open')),
        h('div.card', h('h2', 'Timeline'),
          tl ? [
            h('div', h('b', tl.name)),
            h('div.row.small',
              h('div.stat', h('b', tl.rate), h('span', tl.dropFrame ? 'fps · drop-frame' : 'fps')),
              h('div.stat', h('b', `${tl.width}×${tl.height}`), h('span', tl.aspect)),
              h('div.stat', h('b', tl.duration), h('span', `${tl.durationFrames} frames`))),
            h('div.small.muted', `Starts ${tl.startTimecode} · V${tl.tracks.video} A${tl.tracks.audio} S${tl.tracks.subtitle}`),
            tl.projectRateDiffers ? h('div.notice.warn', 'This timeline uses its own frame rate, different from the project default. The suite never changes either.') : null,
          ] : h('div.muted', 'No active timeline'))),
      state.checklist && state.checklist.steps.some((x) => !x.done && !x.optional) ? h('div.card', { style: 'margin-top:14px' }, h('h2', 'Setup checklist'),
        h('table', h('tbody', state.checklist.steps.map((x) => h('tr', h('td', h('span.badge.' + (x.done ? 'ok' : x.optional ? 'warn' : 'err'), x.done ? 'done' : x.optional ? 'optional' : 'to do')), h('td', x.label), h('td.small.muted', x.detail)))))) : null,
      s.problems && s.problems.length ? h('div.card', { style: 'margin-top:14px' }, h('h2', 'Notes'), list(s.problems)) : null,
      h('div.card', { style: 'margin-top:14px' }, h('h2', 'Feature availability on this build'),
        h('table', h('thead', h('tr', h('th', 'Feature'), h('th', 'Status'), h('th', 'Why'))),
          h('tbody', Object.values(state.caps).map((c) => h('tr', h('td', c.label), h('td', capBadge(c.id)), h('td.small.muted', [...c.reasons, ...c.caveats].join(' ') || '—')))))));
  }

  // ---------- Captions ----------
  const capForm = {
    sourceKind: 'file', path: '', offsetMs: 0, trackType: 'audio', trackIndex: 1,
    maxCharsPerLine: 32, maxLines: 2, maxWordsPerCue: 0, minDurationMs: 700, maxDurationMs: 6000, maxGapMs: 600, lingerMs: 250, maxCps: 20,
    caseMode: 'as-is', emphasisWords: '', emphNumbers: false, emphLongest: false, timingShiftMs: 0, minGapFrames: 0, zone: '', anchor: '',
    previewIndex: 0, styleId: '', emphasisStyleId: '', styleQuery: '',
  };

  function captionsView(rerender) {
    const f = capForm;
    const bind = (k, conv = (v) => v) => (e) => { f[k] = e.target.type === 'checkbox' ? e.target.checked : conv(e.target.value); };
    const n = (k, attrs) => num(f[k], { ...attrs, onchange: bind(k, Number) });
    const p = state.captionPreview;

    const source = h('div.card',
      h('h2', '1 · Source'),
      h('div.seg', ['file', 'transcription'].map((k) => h('button' + (f.sourceKind === k ? '.on' : ''), { onclick: () => { f.sourceKind = k; rerender(); } }, k === 'file' ? 'Subtitle / transcript file' : 'Resolve transcription'))),
      f.sourceKind === 'file'
        ? h('div', { style: 'margin-top:10px' },
          h('div.row', h('input', { type: 'text', value: f.path, placeholder: 'Choose an .srt or .vtt file', style: 'flex:1', onchange: bind('path') }),
            h('button.secondary', { onclick: async () => { const p2 = await window.suite.dialog('open', { filters: [{ name: 'Subtitles', extensions: ['srt', 'vtt'] }] }); if (p2) { f.path = p2; rerender(); } } }, 'Browse…')),
          h('div.fields', { style: 'margin-top:8px' }, field('Offset from timeline start (ms)', n('offsetMs'))),
          h('div.small.faint', 'Subtitle files carry cue timing only; word timing is estimated and flagged.'))
        : h('div', { style: 'margin-top:10px' },
          h('div.fields', field('Track type', select([['audio', 'Audio'], ['video', 'Video']], f.trackType, { onchange: bind('trackType') })), field('Track number', n('trackIndex', { min: 1 }))),
          h('div.row', { style: 'margin-top:8px' }, capBadge('captions.transcription'),
            h('button.secondary', { disabled: !usable('captions.transcription') || undefined, onclick: async () => {
              if (!(await confirmAction('Transcribe clips', 'Starts Resolve\'s own transcription for every clip on this track that is not transcribed yet. This uses Resolve Studio\'s AI and can take a while; it does not change the timeline.'))) return;
              const r = await call('captions.transcribe', { track: { type: f.trackType, index: f.trackIndex }, confirm: true });
              toast(r.message, { ok: true });
            } }, 'Transcribe clips'))));

    const seg = h('div.card',
      h('h2', '2 · Segmentation & style rules'),
      h('div.fields',
        field('Max characters / line', n('maxCharsPerLine', { min: 8, max: 80 })),
        field('Max lines', n('maxLines', { min: 1, max: 4 })),
        field('Words per caption (0 = auto)', n('maxWordsPerCue', { min: 0, max: 50 })),
        field('Min duration (ms)', n('minDurationMs', { min: 0 })),
        field('Max duration (ms)', n('maxDurationMs', { min: 0 })),
        field('Pause that splits (ms)', n('maxGapMs', { min: 0 })),
        field('Hold after last word (ms)', n('lingerMs', { min: 0 })),
        field('Reading speed limit (chars/s)', n('maxCps', { min: 1 })),
        field('Case', select([['as-is', 'As spoken'], ['upper', 'UPPERCASE'], ['lower', 'lowercase']], f.caseMode, { onchange: bind('caseMode') })),
        field('Timing shift (ms, ±)', n('timingShiftMs')),
        field('Gap between captions (frames)', n('minGapFrames', { min: 0 })),
        field('Safe area', select([['', 'Auto for frame shape'], ['title-safe', 'Title-safe 90%'], ['action-safe', 'Action-safe'], ['social-vertical', 'Social vertical (approx.)'], ['social-square', 'Social square (approx.)'], ['none', 'Full frame']], f.zone, { onchange: bind('zone') })),
        field('Position', select([['', 'Auto'], ['bottom', 'Bottom'], ['lower-third', 'Lower third'], ['center', 'Centre'], ['top', 'Top']], f.anchor, { onchange: bind('anchor') }))),
      h('div.row', { style: 'margin-top:10px' },
        field('Emphasise words (comma-separated)', h('input', { type: 'text', value: f.emphasisWords, style: 'min-width:260px', onchange: bind('emphasisWords') })),
        h('label.check', h('input', { type: 'checkbox', checked: f.emphNumbers, onchange: bind('emphNumbers') }), 'Numbers'),
        h('label.check', h('input', { type: 'checkbox', checked: f.emphLongest, onchange: bind('emphLongest') }), 'Key word per caption')),
      h('div.row.end', { style: 'margin-top:12px' },
        h('button.primary', { onclick: async () => {
          const req = {
            source: f.sourceKind === 'file' ? { kind: 'file', path: f.path, offsetMs: f.offsetMs } : { kind: 'transcription', track: { type: f.trackType, index: f.trackIndex } },
            options: { maxCharsPerLine: f.maxCharsPerLine, maxLines: f.maxLines, maxWordsPerCue: f.maxWordsPerCue, minDurationMs: f.minDurationMs, maxDurationMs: f.maxDurationMs, maxGapMs: f.maxGapMs, lingerMs: f.lingerMs, maxCps: f.maxCps, caseMode: f.caseMode,
              emphasis: { words: f.emphasisWords.split(',').map((s) => s.trim()).filter(Boolean), numbers: f.emphNumbers, longestPerCue: f.emphLongest } },
            timingShiftMs: f.timingShiftMs, minGapFrames: f.minGapFrames,
            layout: { zone: f.zone || undefined, anchor: f.anchor || undefined },
          };
          state.captionPreview = await call('captions.prepare', req);
          f.previewIndex = 0;
          rerender();
        } }, p ? 'Regenerate preview' : 'Generate preview')));

    return h('div',
      h('h1', 'Captions'),
      h('p.lead', 'Build readable captions from a subtitle file or Resolve\'s transcription, preview them against the active timeline, then add them as a subtitle track or with your imported caption presets. Every apply step backs up the timeline first.'),
      h('div.grid.cols-2', source, seg),
      p ? captionPreviewBlock(p, rerender) : null);
  }

  function framePreview(p, cue) {
    const maxW = 420, maxH = 300;
    const s = Math.min(maxW / p.timeline.width, maxH / p.timeline.height);
    const L = p.layout;
    const px = (v) => `${Math.round(v * s)}px`;
    const fontPx = Math.max(9, Math.round(L.fontPx * s));
    const text = cue ? cue.lines.join('\n') : '';
    const capbox = h('div.capbox', { style: `left:${px(L.box.x)};top:${px(L.box.y)};width:${px(L.box.w)};height:${px(L.box.h)};font-size:${fontPx}px;line-height:1.2` });
    if (cue) {
      // render with emphasis highlighting, word by word
      const emph = new Set(cue.emphasis.map((w) => w.toLowerCase()));
      cue.lines.forEach((line, li) => {
        line.split(' ').forEach((w, wi) => { capbox.append(emph.has(w.toLowerCase()) ? h('em.emph', w) : w); if (wi < line.split(' ').length - 1) capbox.append(' '); });
        if (li < cue.lines.length - 1) capbox.append(h('br'));
      });
    } else capbox.textContent = text;
    return h('div.frame', { style: `width:${px(p.timeline.width)};height:${px(p.timeline.height)}` },
      h('div.safe', { style: `left:${px(L.safe.x)};top:${px(L.safe.y)};width:${px(L.safe.w)};height:${px(L.safe.h)}` }), capbox);
  }

  function captionPreviewBlock(p, rerender) {
    const f = capForm;
    const cue = p.cues[f.previewIndex] || p.cues[0];
    const notes = [...p.warnings, ...p.report.map((r) => `Caption ${r.id}: ${r.message}`)];
    const styleList = state.styles.filter((s) => !f.styleQuery || `${s.name} ${s.folder}`.toLowerCase().includes(f.styleQuery.toLowerCase()));
    const favs = new Set(state.favourites.captionStyles);
    styleList.sort((a, b) => Number(favs.has(b.id)) - Number(favs.has(a.id)));

    const exportSrt = async () => {
      const file = await window.suite.dialog('save', { defaultPath: 'captions.srt', filters: [{ name: 'SubRip', extensions: ['srt'] }] });
      if (!file) return;
      await window.suite.writeText(file, await call('captions.srtText', { previewId: p.previewId }));
      toast(`Saved ${file}`, { ok: true });
    };
    const applyTrack = async () => {
      if (!(await confirmAction('Add subtitle track', [`Adds ${p.cues.length} subtitles to the active timeline.`, 'A backup copy of the timeline is created first, and the placed timings are read back and compared with this preview.']))) return;
      const r = await call('captions.applySubtitleTrack', { previewId: p.previewId, confirm: true });
      toast(`${r.summary}. Backup: ${r.backup.backupName}`, { ok: r.verify.ok });
      if (!r.verify.ok) toast(r.verify.problems.slice(0, 3).join(' '), { source: 'Result verification' });
    };
    const applyStyled = async (limit) => {
      if (!f.styleId) return toast('Choose a caption style first.', { source: 'Input' });
      const what = limit ? 'Places ONE test caption' : `Places ${p.cues.length} captions`;
      if (!(await confirmAction(limit ? 'Place test caption' : 'Place all captions', [`${what} on a new video track using the selected preset, and sets its text.`, 'The timeline is backed up first; nothing on existing tracks is moved or replaced.']))) return;
      const r = await call('captions.applyStyled', { previewId: p.previewId, styleId: f.styleId, emphasisStyleId: f.emphasisStyleId || undefined, limit, confirm: true });
      toast(r.summary, { ok: r.verify.ok && !r.textFailures.length });
      for (const x of [...r.skipped, ...r.textFailures.map((t) => `Caption ${t.id}: ${t.reason}`)].slice(0, 4)) toast(x, { source: 'Result verification' });
    };

    return h('div.grid', { style: 'margin-top:14px' },
      h('div.grid.cols-2',
        h('div.card',
          h('h2', `Preview · ${p.cues.length} captions · ${p.timeline.rate} fps ${p.timeline.width}×${p.timeline.height}`),
          framePreview(p, cue),
          h('div.row', { style: 'margin-top:10px' },
            h('button.ghost', { onclick: () => { f.previewIndex = Math.max(0, f.previewIndex - 1); rerender(); } }, '‹ Prev'),
            h('span.mono', cue ? `${cue.startTc} → ${cue.endTc}` : ''),
            h('button.ghost', { onclick: () => { f.previewIndex = Math.min(p.cues.length - 1, f.previewIndex + 1); rerender(); } }, 'Next ›'),
            h('span.spacer'),
            h('span.small.faint', `Dashed: safe area (${p.layout.zone}). Box: caption area.`))),
        h('div.card',
          h('h2', 'Apply'),
          h('div.row', h('button.secondary', { onclick: exportSrt }, 'Export SRT…'), h('span.small.muted', 'Keep this as the original version before any transformation.')),
          h('hr', { style: 'border:0;border-top:1px solid var(--line);margin:12px 0' }),
          h('h3', 'Subtitle track'), h('div.row', capBadge('captions.srtTrack')),
          h('div.small.muted', { style: 'margin:6px 0' }, 'Resolve\'s API cannot style subtitle tracks; use the Subtitle track inspector after placing.'),
          state.caps['captions.srtTrack'] && state.caps['captions.srtTrack'].status === 'needs-verification'
            ? h('div.notice.warn', 'Enable this by running Diagnostics › "Test subtitle import" once on this Resolve build.') : null,
          h('button.secondary', { disabled: !usable('captions.srtTrack') || undefined, onclick: applyTrack }, 'Add as subtitle track'),
          h('hr', { style: 'border:0;border-top:1px solid var(--line);margin:12px 0' }),
          h('h3', 'Styled captions (your presets)'),
          state.styles.length ? h('div',
            h('div.row', h('input', { type: 'search', placeholder: 'Search styles', value: f.styleQuery, oninput: (e) => { f.styleQuery = e.target.value; rerender(); } })),
            h('div.fields', { style: 'margin-top:8px' },
              field('Caption style', select([['', 'Choose…'], ...styleList.map((s) => [s.id, `${favs.has(s.id) ? '★ ' : ''}${s.name} — ${s.folder}`])], f.styleId, { onchange: (e) => { f.styleId = e.target.value; } })),
              field('Emphasis style (optional)', select([['', 'Same style'], ...styleList.map((s) => [s.id, s.name])], f.emphasisStyleId, { onchange: (e) => { f.emphasisStyleId = e.target.value; } }))),
            h('div.row', { style: 'margin-top:6px' },
              h('button.ghost', { disabled: !f.styleId || undefined, onclick: async () => { state.favourites = await call('favourites.toggle', { kind: 'captionStyles', id: f.styleId }); rerender(); } }, favs.has(f.styleId) ? '★ Unfavourite style' : '☆ Favourite style')),
            h('div.row', { style: 'margin-top:10px' },
              h('button.secondary', { disabled: !usable('fusion.textEdit') || undefined, onclick: () => applyStyled(1) }, 'Place first caption (test)'),
              h('button.primary', { disabled: !usable('fusion.textEdit') || undefined, onclick: () => applyStyled(0) }, 'Place all')))
            : h('div.notice', 'No caption presets imported in this project. Import them in Asset Setup, then ', h('button.ghost', { onclick: async () => { const r = await call('assets.captionStyles'); state.styles = r.styles; rerender(); } }, 'reload styles'), '.'))),
      notes.length ? h('div.card', h('h2', 'Checks'), list(notes)) : null,
      h('div.card.flush', h('div.table-wrap', h('table',
        h('thead', h('tr', h('th', '#'), h('th', 'In'), h('th', 'Out'), h('th', 'Text'), h('th', 'Flags'))),
        h('tbody', p.cues.map((c, i) => h('tr', { onclick: () => { f.previewIndex = i; rerender(); }, style: 'cursor:pointer' },
          h('td.tc', c.id), h('td.tc', c.startTc), h('td.tc', c.endTc), h('td', c.lines.join(' / ')),
          h('td', c.estimated ? h('span.badge.warn', 'timing estimated') : null, c.emphasis.length ? h('span.badge.info', `emphasis: ${c.emphasis.join(', ')}`) : null))))))));
  }

  // ---------- Rough Cut ----------
  const rcForm = { trackType: 'audio', trackIndex: 1, thresholdMode: 'auto', thresholdDb: -40, minSilenceMs: 500, paddingMs: 120, keepPauseMs: 150, protectColor: '', saveAndReverify: true };

  function roughcutView(rerender) {
    const f = rcForm;
    const bind = (k, conv = (v) => v) => (e) => { f[k] = e.target.type === 'checkbox' ? e.target.checked : conv(e.target.value); };
    const r = state.roughcut;
    const enabledIds = () => r.cuts.filter((c) => c.enabled).map((c) => c.id);

    const settings = h('div.card',
      h('h2', 'Detection'),
      h('div.fields',
        field('Analyse track', select([['audio', 'Audio'], ['video', 'Video (linked audio)']], f.trackType, { onchange: bind('trackType') })),
        field('Track number', num(f.trackIndex, { min: 1, onchange: bind('trackIndex', Number) })),
        field('Threshold', select([['auto', 'Auto (noise floor + 10 dB)'], ['fixed', 'Fixed']], f.thresholdMode, { onchange: (e) => { f.thresholdMode = e.target.value; rerender(); } })),
        f.thresholdMode === 'fixed' ? field('Threshold (dBFS)', num(f.thresholdDb, { max: 0, min: -100, onchange: bind('thresholdDb', Number) })) : null,
        field('Shortest pause to cut (ms)', num(f.minSilenceMs, { min: 100, onchange: bind('minSilenceMs', Number) })),
        field('Protect speech edges (ms)', num(f.paddingMs, { min: 0, onchange: bind('paddingMs', Number) })),
        field('Keep of each pause (ms)', num(f.keepPauseMs, { min: 0, onchange: bind('keepPauseMs', Number) })),
        field('Protect ranges marked', select([['', 'No marker protection'], ...['Blue', 'Cyan', 'Green', 'Yellow', 'Red', 'Pink', 'Purple', 'Fuchsia', 'Rose', 'Lavender', 'Sky', 'Mint', 'Lemon', 'Sand', 'Cocoa', 'Cream'].map((c) => [c, `${c} markers`])], f.protectColor, { onchange: bind('protectColor') }))),
      h('div.row.end', { style: 'margin-top:12px' },
        h('button.primary', { onclick: async () => {
          state.roughcut = await call('roughcut.analyse', { track: { type: f.trackType, index: f.trackIndex }, options: { thresholdDb: f.thresholdMode === 'auto' ? 'auto' : f.thresholdDb, minSilenceMs: f.minSilenceMs, paddingMs: f.paddingMs, keepPauseMs: f.keepPauseMs, protectMarkerColor: f.protectColor || undefined } });
          rerender();
        } }, r ? 'Re-analyse' : 'Analyse')));

    const review = r ? h('div.grid', { style: 'margin-top:14px' },
      h('div.card',
        h('div.row',
          h('div.stat', h('b', r.cuts.length), h('span', 'proposed cuts')),
          h('div.stat', h('b', sec(r.cuts.filter((c) => c.enabled).reduce((s, c) => s + c.seconds, 0))), h('span', `of ${sec(r.totalSeconds)} removed`)),
          h('div.stat', h('b', r.protectedCount), h('span', 'protected marker ranges')),
          h('span.spacer'),
          h('button.ghost', { onclick: () => { r.cuts.forEach((c) => { c.enabled = true; }); rerender(); } }, 'Select all'),
          h('button.ghost', { onclick: () => { r.cuts.forEach((c) => { c.enabled = false; }); rerender(); } }, 'Select none')),
        list(r.perItem.map((i) => i.skipped ? `${i.name}: skipped (${i.skipped})` : `${i.name}: threshold ${i.threshold} dBFS${i.noiseFloor !== null ? `, noise floor ${i.noiseFloor}` : ''}, ${i.silences} pause(s)`))),
      h('div.card',
        h('h2', 'Review & apply'),
        h('p.small.muted', 'The original timeline is never edited. Review markers are optional and removable; building creates a NEW timeline from the kept ranges.'),
        h('div.row',
          h('button.secondary', { onclick: async () => {
            if (!(await confirmAction('Add review markers', `Adds red markers on the current timeline for ${enabledIds().length} selected cut(s). They can be removed with "Remove review markers".`))) return;
            const m = await call('roughcut.markers', { runId: r.runId, enabledIds: enabledIds(), confirm: true });
            toast(m.summary, { ok: !m.failed.length });
          } }, 'Add review markers'),
          h('button.ghost', { onclick: async () => {
            if (!(await confirmAction('Remove review markers', 'Removes only the markers this analysis added.'))) return;
            await call('roughcut.clearMarkers', { runId: r.runId, confirm: true });
            toast('Review markers removed.', { ok: true });
          } }, 'Remove review markers'),
          h('span.spacer'),
          h('label.check', h('input', { type: 'checkbox', checked: f.saveAndReverify, onchange: bind('saveAndReverify') }), 'Save project and re-verify'),
          h('button.secondary', { onclick: async () => {
            const d = await call('roughcut.build', { runId: r.runId, enabledIds: enabledIds(), dryRun: true });
            confirmAction('Dry run', [`${d.plan.pieces} piece(s) would be placed on a new timeline.`, list(d.plan.warnings.map((w) => w.message)) || 'No warnings.'], 'Close');
          } }, 'Dry run'),
          h('button.primary', { disabled: !enabledIds().length || undefined, onclick: async () => {
            if (!(await confirmAction('Build rough-cut timeline', [`Creates a new timeline with ${enabledIds().length} cut(s) applied, then reads it back to verify continuity.`, f.saveAndReverify ? 'The project is saved and the result re-read after saving.' : 'The project is not saved automatically.', 'Your original timeline is not modified.']))) return;
            const b = await call('roughcut.build', { runId: r.runId, enabledIds: enabledIds(), saveAndReverify: f.saveAndReverify, confirm: true });
            toast(b.summary, { ok: b.verify.ok });
            if (!b.verify.ok) toast(b.verify.problems.slice(0, 3).join(' '), { source: 'Result verification' });
            r.lastBuild = b;
            rerender();
          } }, 'Build rough-cut timeline'))),
      r.lastBuild ? h('div.card', h('h2', `Built "${r.lastBuild.timelineName}"`),
        h('div.notice' + (r.lastBuild.verify.ok ? '.ok' : '.err'), r.lastBuild.summary),
        list(r.lastBuild.verify.problems), r.lastBuild.warnings.length ? h('div', h('h3', { style: 'margin-top:10px' }, 'Plan notes'), list(r.lastBuild.warnings.map((w) => w.message))) : null) : null,
      h('div.card.flush', h('div.table-wrap', h('table',
        h('thead', h('tr', h('th', 'Cut'), h('th', 'From'), h('th', 'To'), h('th', 'Length'))),
        h('tbody', r.cuts.map((c) => h('tr',
          h('td', h('label.check', h('input', { type: 'checkbox', checked: c.enabled, onchange: (e) => { c.enabled = e.target.checked; rerender(); } }), String(c.id))),
          h('td.tc', c.startTc), h('td.tc', c.endTc), h('td.tc', sec(c.seconds))))))))) : null;

    return h('div',
      h('h1', 'Rough Cut'),
      h('p.lead', 'Find long pauses and gaps from the clips\' own audio, review every proposed cut, then build a tightened copy of the edit. Short pauses below your threshold are treated as intentional and kept.'),
      settings, review);
  }

  // ---------- Motion Graphics ----------
  const mgForm = { query: '', category: '', favouritesOnly: false };
  const thumbCache = new Map();

  function motionView(rerender) {
    const f = mgForm;
    const body = h('div', h('p.muted', 'Loading templates…'));
    let seq = 0;
    const load = async () => {
      const mine = ++seq;
      const cat = await call('assets.templates', { query: f.query, category: f.category || undefined, favouritesOnly: f.favouritesOnly });
      if (mine !== seq) return; // a newer search superseded this one
      const favs = new Set(cat.favourites);
      const found = cat.roots.filter((r) => r);
      body.replaceChildren(
        h('div.small.faint', { style: 'margin-bottom:10px' }, `${cat.templates.length} template(s) from ${found.length} folder(s). ${cat.duplicates.length ? cat.duplicates.length + ' name(s) are duplicated across packs; insertion by name is ambiguous for those.' : ''}`),
        cat.templates.length ? h('div.tiles', cat.templates.map((t) => {
          const thumb = h('div.thumb', t.thumbnail ? 'Loading…' : 'No preview');
          if (t.thumbnail) {
            const key = JSON.stringify(t.thumbnail);
            const p = thumbCache.get(key) || call('assets.thumbnail', { thumb: t.thumbnail }, { quiet: true }).catch(() => null);
            thumbCache.set(key, p);
            p.then((src) => thumb.replaceChildren(src ? h('img', { src, alt: '' }) : 'No preview'));
          }
          const canInsert = t.category === 'Titles' && t.insertSupported === true && !t.ambiguousName && usable('fusion.insertTitle');
          return h('div.tile', thumb, h('div.body',
            h('div.row', h('div.name', { title: t.name, style: 'flex:1;min-width:0' }, t.name),
              h('button.star' + (favs.has(t.id) ? '.on' : ''), { title: 'Favourite', onclick: async () => { await call('favourites.toggle', { kind: 'templates', id: t.id }); load(); } }, favs.has(t.id) ? '★' : '☆')),
            h('div.small.faint', [t.category, t.subcategory].filter(Boolean).join(' / ')),
            t.ambiguousName ? h('span.badge.warn', 'duplicate name') : null,
            canInsert
              ? h('button.secondary', { onclick: async () => {
                if (!(await confirmAction(`Insert "${t.name}"`, ['Resolve inserts titles at the playhead on the Edit page destination track (the API has no track option). Make sure the destination track is the one you want and is unlocked.']))) return;
                const r = await call('templates.insertTitle', { name: t.name, confirm: true });
                toast(r.summary, { ok: true });
              } }, 'Insert at playhead')
              : h('div.small.muted', { title: t.insertNote }, t.category === 'Titles' && t.ambiguousName ? 'Rename or remove the duplicate to insert by name; or drag from the Effects Library.' : t.insertNote)));
        })) : h('div.notice', f.query ? `No templates match "${f.query}".` : 'No templates found. Add your template folders in Settings if mKeynote packs are installed somewhere else.'));
    };
    const reload = () => load().catch((e) => body.replaceChildren(h('div.notice.err', e.message)));
    reload();
    let timer = null;

    return h('div',
      h('h1', 'Motion Graphics'),
      h('p.lead', 'Your installed Fusion templates (including mKeynote packs) catalogued from the Fusion Templates folders. Originals are only read, never modified.'),
      h('div.row', { style: 'margin-bottom:14px' },
        h('input', { type: 'search', placeholder: 'Search templates', value: f.query, style: 'min-width:260px', oninput: (e) => { f.query = e.target.value; clearTimeout(timer); timer = setTimeout(reload, 200); } }),
        h('div.seg', ['', 'Titles', 'Generators', 'Effects', 'Transitions', 'Other'].map((c) => h('button' + (f.category === c ? '.on' : ''), { onclick: () => { f.category = c; rerender(); } }, c || 'All'))),
        h('label.check', h('input', { type: 'checkbox', checked: f.favouritesOnly, onchange: (e) => { f.favouritesOnly = e.target.checked; reload(); } }), 'Favourites only')),
      body);
  }

  // ---------- Asset Setup ----------
  function setupView(rerender) {
    const body = h('div', h('p.muted', 'Loading…'));
    (async () => {
      const st = await call('assets.presetStatus');
      const rec = st.record;
      const choose = async (relink) => {
        const file = await window.suite.dialog('open', { filters: [{ name: 'Resolve bins, projects, Fusion templates', extensions: ['drb', 'drp', 'drfx', 'setting', 'comp', 'zip'] }, { name: 'All files', extensions: ['*'] }] });
        if (!file) return;
        if (relink) {
          let r = await call('assets.relinkPreset', { path: file });
          if (r.needsConfirmation) {
            if (!(await confirmAction('Different file', r.message, 'Use this file'))) return;
            r = await call('assets.relinkPreset', { path: file, acceptDifferent: true });
          }
        } else await call('assets.setPreset', { path: file });
        rerender();
      };
      const kindHelp = {
        'resolve-bin-export': 'Media Pool bin export. Imported with MediaPool.ImportFolderFromFile, preserving its folders and names.',
        'resolve-project-archive': 'Resolve project archive, not a bin. Do NOT import it into your working project. Migration: Project Manager › right-click › Import Project, open it, select the caption folder in its Media Pool, right-click › Export Bin… (.drb), then choose that .drb here.',
        'resolve-project-archive-folder': 'Resolve project archive folder (.dra). Same migration as a project archive: restore it in the Project Manager, export the caption bin as .drb, choose that here.',
        'fusion-template-bundle': 'Fusion template bundle (.drfx). Install by double-clicking it (Resolve installs it into Fusion Templates), restart Resolve, and the titles appear in Motion Graphics.',
        'fusion-setting': 'A single Fusion template/macro (.setting). Install by copying it into Fusion/Templates/Edit/Titles (see the asset guide).',
        'sqlite-database': 'A database file. The suite never reads or writes Resolve databases.',
      };
      body.replaceChildren(
        h('div.card',
          h('h2', 'Caption preset pack (e.g. MotionText Pro)'),
          !rec ? h('p.muted', 'Locate the caption preset file you were supplied. The suite inspects its real format before deciding how to import it.') : h('div',
            h('div.row', h('span.mono', rec.path), h('span.badge.' + (st.status === 'ok' ? 'ok' : 'err'), st.status)),
            h('div.row', { style: 'margin-top:6px' }, h('span.badge.info', rec.kind), h('span.badge' + (rec.confidence === 'content' ? '.ok' : '.warn'), rec.confidence === 'content' ? 'identified by content' : 'identified by extension only')),
            h('div.notice' + (rec.kind === 'resolve-bin-export' ? '' : '.warn'), kindHelp[rec.kind] || 'Unrecognised format; the suite will not import it. See docs/ASSET_SETUP.md.'),
            rec.contents ? h('div.small.muted', { style: 'margin-top:6px' }, `Written by Resolve ${rec.contents.writtenBy || 'unknown version'}. Bins: ${rec.contents.binFolders.join(', ')}`) : null,
            rec.contents && rec.contents.basis ? h('div.small.faint', rec.contents.basis) : null,
            list(rec.warnings), st.message ? h('div.notice.err', st.message) : null),
          h('div.row', { style: 'margin-top:10px' },
            h('button.secondary', { onclick: () => choose(false) }, rec ? 'Choose a different file…' : 'Locate preset file…'),
            rec ? h('button.ghost', { onclick: () => choose(true) }, 'Relink moved file…') : null,
            rec && rec.kind === 'resolve-bin-export' && st.status === 'ok' ? h('button.primary', { disabled: !usable('media.importBin') || undefined, onclick: async () => {
              if (!(await confirmAction('Import caption presets', ['Imports the bin into the Media Pool of the CURRENT project. If this exact file was already imported here, nothing happens.', 'Your project timelines are not touched.']))) return;
              const r = await call('assets.importBin', { confirm: true });
              toast(r.message, { ok: true });
              state.styles = (await call('assets.captionStyles')).styles;
            } }, 'Import into current project') : null)),
        h('div.card', { style: 'margin-top:14px' },
          h('h2', 'mKeynote and other Fusion templates'),
          h('p.muted', 'Installed templates are discovered automatically from the Fusion Templates folders and listed in Motion Graphics. Add extra folders in Settings.'),
          h('button.secondary', { onclick: () => document.querySelector('[data-view=motion]').click() }, 'Open Motion Graphics')));
    })().catch((e) => body.replaceChildren(h('div.notice.err', e.message)));
    return h('div', h('h1', 'Asset Setup'), h('p.lead', 'Connect your premium assets. Originals are never modified, moved or re-encoded.'), body);
  }

  // ---------- Diagnostics ----------
  function diagnosticsView(rerender) {
    const body = h('div', h('p.muted', 'Collecting diagnostics…'));
    let report = null;
    (async () => {
      report = await call('diag.report');
      const log = await call('diag.log', { limit: 100 });
      const caps = report.capabilities ? Object.values(report.capabilities.features) : [];
      body.replaceChildren(
        h('div.grid.cols-3',
          h('div.card', h('h2', 'Resolve'), report.resolve && report.resolve.error ? h('div.notice.err', report.resolve.error.message) : h('div', `${report.resolve.product} ${report.resolve.version}`)),
          h('div.card', h('h2', 'Runtime'), h('div.small', `${report.os.platform} ${report.os.release} · Electron ${report.runtime.electron || '?'} · Node ${report.runtime.node}`)),
          h('div.card', h('h2', 'FFmpeg'), report.ffmpeg ? h('div.small', report.ffmpeg.version) : h('div.notice.warn', 'Not found. Needed to analyse non-WAV media in Rough Cut.'))),
        h('div.card', { style: 'margin-top:14px' },
          h('h2', 'Verify on this machine'),
          h('p.small.muted', 'These tests create a scratch timeline named "Edit Suite Scratch (safe to delete)" in the current project, run, then delete it and restore your timeline.'),
          h('div.row',
            h('button.secondary', { onclick: async () => {
              if (!(await confirmAction('Calibrate frame conventions', 'Uses the first media clip on V1/A1 of the current timeline. Creates and deletes a scratch timeline.'))) return;
              const r = await call('diag.calibrate', { confirm: true });
              toast(`Calibrated for ${r.build}: append end ${r.appendEndInclusive ? 'inclusive' : 'exclusive'}, item end ${r.itemEndInclusive ? 'inclusive' : 'exclusive'}.`, { ok: true });
              if (r.cleanupWarning) toast(r.cleanupWarning, { source: 'Resolve' });
              rerender();
            } }, 'Calibrate frame conventions'),
            h('button.secondary', { onclick: async () => {
              if (!(await confirmAction('Test subtitle import', 'Imports a two-line test SRT onto a scratch timeline and checks the frames.'))) return;
              const r = await call('diag.testSubtitles', { confirm: true });
              toast(r.detail, { ok: r.ok, source: r.ok ? undefined : 'Resolve API' });
              if (window.SuiteRefresh) await window.SuiteRefresh();
            } }, 'Test subtitle import'),
            h('span.spacer'),
            h('button.ghost', { onclick: async () => {
              const file = await window.suite.dialog('save', { defaultPath: 'edit-suite-diagnostics.json', filters: [{ name: 'JSON', extensions: ['json'] }] });
              if (file) { await window.suite.writeText(file, JSON.stringify({ report, log }, null, 2)); toast(`Saved ${file}`, { ok: true }); }
            } }, 'Save report…')),
          report.calibration && report.calibration.build ? h('div.small.muted', { style: 'margin-top:8px' }, `Last calibration: ${report.calibration.build} at ${report.calibration.at}`) : h('div.notice.warn', 'Not calibrated yet. Placement uses documented defaults until you calibrate.')),
        h('div.card.flush', { style: 'margin-top:14px' }, h('div.table-wrap', h('table',
          h('thead', h('tr', h('th', 'Feature'), h('th', 'Status'), h('th', 'Evidence'), h('th', 'Detail'))),
          h('tbody', caps.map((c) => h('tr', h('td', c.label), h('td', h('span.badge.' + badgeFor(c.status), c.status)), h('td.small', EVIDENCE[c.evidence] || c.evidence), h('td.small.muted', [...c.reasons, ...c.caveats].join(' ') || '—'))))))),
        h('div.card', { style: 'margin-top:14px' }, h('h2', 'Operation log (latest)'),
          log.length ? h('div.table-wrap', h('table',
            h('thead', h('tr', h('th', 'Time'), h('th', 'Action'), h('th', 'Result'), h('th', 'Detail'))),
            h('tbody', log.slice().reverse().map((e) => h('tr', h('td.tc', (e.at || '').replace('T', ' ').slice(0, 19)), h('td', e.action), h('td', h('span.badge.' + (e.result === 'ok' ? 'ok' : 'err'), e.result)),
              h('td.small.muted', e.error ? `${e.error.source}: ${e.error.message}` : e.summary || `${(e.calls || []).length} API call(s)`)))))) : h('p.muted', 'Nothing logged yet.')),
        h('details', { style: 'margin-top:14px' }, h('summary', 'Raw report'), h('pre.json', JSON.stringify(report, null, 2))));
    })().catch((e) => body.replaceChildren(h('div.notice.err', e.message)));
    return h('div', h('h1', 'Diagnostics'), h('p.lead', 'Tells you whether a problem comes from Resolve, a missing asset, an API method this build does not expose, or the plugin itself.'), body);
  }

  // ---------- Settings ----------
  function settingsView(rerender) {
    const body = h('div', h('p.muted', 'Loading…'));
    (async () => {
      const s = await call('settings.get');
      const info = await call('app.info');
      const roots = s.templateRoots || [];
      body.replaceChildren(
        h('div.card', h('h2', 'FFmpeg'),
          h('p.small.muted', 'Used only to read audio levels from non-WAV media for Rough Cut. Never downloads or uploads anything.'),
          h('div.row', h('span.mono', s.ffmpegPath || '(using ffmpeg on PATH if present)'),
            h('button.secondary', { onclick: async () => { const p = await window.suite.dialog('open', {}); if (p) { await call('settings.set', { key: 'ffmpegPath', value: p }); rerender(); } } }, 'Choose…'),
            s.ffmpegPath ? h('button.ghost', { onclick: async () => { await call('settings.set', { key: 'ffmpegPath', value: null }); rerender(); } }, 'Clear') : null)),
        h('div.card', { style: 'margin-top:14px' }, h('h2', 'Extra template folders'),
          roots.length ? h('table', h('tbody', roots.map((r) => h('tr', h('td.mono', r), h('td', h('button.ghost', { onclick: async () => { await call('settings.set', { key: 'templateRoots', value: roots.filter((x) => x !== r) }); rerender(); } }, 'Remove')))))) : h('p.muted', 'None. The standard Fusion Templates folders are always included.'),
          h('button.secondary', { onclick: async () => { const p = await window.suite.dialog('open', { directory: true }); if (p) { await call('settings.set', { key: 'templateRoots', value: [...roots, p] }); rerender(); } } }, 'Add folder…')),
        h('div.card', { style: 'margin-top:14px' }, h('h2', 'Data'),
          h('div.small', 'Settings, operation log and generated files: ', h('span.mono', info.dataDir)),
          h('button.ghost', { style: 'margin-top:8px', onclick: () => window.suite.dialog('reveal', { path: info.logFile }) }, 'Show in folder')));
    })().catch((e) => body.replaceChildren(h('div.notice.err', e.message)));
    return h('div', h('h1', 'Settings'), body);
  }

  window.Views = { overview, captions: captionsView, roughcut: roughcutView, motion: motionView, setup: setupView, diagnostics: diagnosticsView, settings: settingsView };
})();
