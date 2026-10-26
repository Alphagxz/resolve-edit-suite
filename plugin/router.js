'use strict';
/**
 * IPC router: the complete, whitelisted surface the renderer can call.
 * Independent of Electron so it can be tested with a mock Resolve.
 *
 * Safety rules enforced here (not only in the UI):
 *   - every write requires `confirm: true`
 *   - previews/analyses live on this side; the renderer refers to them by id,
 *     so an applied edit is exactly the one that was reviewed
 *   - every user-level action is recorded in the operation log
 */
const fs = require('fs');
const { createAdapter, SuiteError, describeError } = require('./resolve/adapter');
const { createOpLog } = require('./services/oplog');
const { createTaskRunner } = require('./services/tasks');
const { identifyAsset } = require('./core/assets');
const { searchTemplates } = require('./core/templates');
const reads = require('./ops/resolve-reads');
const assets = require('./ops/assets');
const captions = require('./ops/captions');
const roughcut = require('./ops/roughcut');
const diagnostics = require('./ops/diagnostics');

const SETTABLE = new Set(['ffmpegPath', 'templateRoots', 'captions', 'roughCut']);

function createRouter({ getResolve, storage, emit = () => {}, pluginVersion = '0.0.0' }) {
  const log = createOpLog(storage);
  const tasks = createTaskRunner((e) => emit('suite:progress', e));
  const previews = new Map();
  const analyses = new Map();
  let capsCache = null;

  function adapter() {
    return createAdapter({ resolve: getResolve(), log });
  }
  const deps = {
    storage,
    calibration: () => storage.loadSettings().calibration || {},
    capabilities: () => capsCache,
  };
  async function refreshCaps(a) {
    capsCache = await diagnostics.capabilities(a, storage);
    return capsCache;
  }
  function requireConfirm(args, what) {
    if (!args || args.confirm !== true) throw new SuiteError(`${what} changes your project and needs explicit confirmation.`, 'invalid-input');
  }
  function remember(map, value, max = 5) {
    const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    map.set(id, value);
    while (map.size > max) map.delete(map.keys().next().value);
    return id;
  }
  function task(kind, fn) {
    const { id, promise } = tasks.start(kind, fn);
    emit('suite:task-started', { taskId: id, kind });
    return promise;
  }

  const handlers = {
    'app.info': async () => ({ version: pluginVersion, dataDir: storage.dir, logFile: storage.logFile }),
    'project.summary': async () => {
      const a = adapter();
      const summary = await reads.projectSummary(a, deps.calibration());
      await refreshCaps(a).catch(() => null);
      return { ...summary, capabilities: capsCache && capsCache.features };
    },

    'setup.checklist': async () => {
      const s = storage.loadSettings();
      const steps = [];
      let caps = null;
      try { caps = await refreshCaps(adapter()); } catch (e) { steps.push({ id: 'connect', done: false, label: 'Connect to Resolve Studio', detail: describeError(e).message }); }
      if (caps) {
        steps.push({ id: 'connect', done: true, label: 'Connected to Resolve', detail: `${caps.product || 'Resolve'} ${caps.versionString || ''}` });
        steps.push({ id: 'studio', done: caps.isStudio !== false, label: 'Studio edition', detail: caps.isStudio === false ? 'Transcription, auto-subtitles and Workflow Integrations need Studio.' : 'OK' });
        const cal = s.calibration || {};
        steps.push({ id: 'calibrate', done: cal.build === caps.build, label: 'Calibrate frame conventions', detail: cal.build === caps.build ? `Done for ${cal.build}` : 'Diagnostics › Calibrate (uses a scratch timeline)' });
        const v = (s.verified || {})['captions.srtTrack'];
        steps.push({ id: 'subtitles', done: Boolean(v && v.ok && v.build === caps.build), optional: true, label: 'Test subtitle import', detail: v && v.build === caps.build ? v.detail : 'Diagnostics › Test subtitle import (enables "Add as subtitle track")' });
      }
      const ps = assets.captionPresetStatus(storage);
      steps.push({ id: 'preset', done: ps.status === 'ok', label: 'Locate caption preset file', detail: ps.status === 'ok' ? `${ps.record.kind} (${ps.record.confidence})` : ps.message || 'Asset Setup › Locate preset file' });
      const { findFfmpeg } = require('./services/media-audio');
      const ff = findFfmpeg(s.ffmpegPath);
      steps.push({ id: 'ffmpeg', done: Boolean(ff), optional: true, label: 'FFmpeg for Rough Cut (non-WAV media)', detail: ff ? ff.version : 'Settings › FFmpeg' });
      return { steps };
    },
    'settings.get': async () => storage.loadSettings(),
    'settings.set': async ({ key, value }) => {
      if (!SETTABLE.has(key)) throw new SuiteError(`Setting "${key}" cannot be changed here.`, 'invalid-input');
      if (key === 'ffmpegPath' && value && !fs.existsSync(value)) throw new SuiteError(`FFmpeg not found at ${value}`, 'asset-missing');
      if (key === 'templateRoots' && (!Array.isArray(value) || value.some((v) => typeof v !== 'string'))) throw new SuiteError('Template folders must be a list of paths.', 'invalid-input');
      return storage.updateSettings((s) => ({ ...s, [key]: value }));
    },
    'favourites.toggle': async ({ kind, id }) => {
      if (!['templates', 'captionStyles'].includes(kind)) throw new SuiteError('Unknown favourites list.', 'invalid-input');
      return storage.updateSettings((s) => {
        const set = new Set(s.favourites[kind] || []);
        set.has(id) ? set.delete(id) : set.add(id);
        return { ...s, favourites: { ...s.favourites, [kind]: [...set] } };
      }).favourites;
    },

    'diag.report': async () => diagnostics.report(adapter(), storage, pluginVersion),
    'diag.log': async ({ limit } = {}) => storage.readLog(limit || 200),
    'diag.calibrate': async (args) => {
      requireConfirm(args, 'Calibration (creates and deletes a scratch timeline)');
      const a = adapter();
      return log.run('diagnostics.calibrate', {}, () => diagnostics.calibrate(a, storage));
    },
    'diag.testSubtitles': async (args) => {
      requireConfirm(args, 'Subtitle import test (creates and deletes a scratch timeline)');
      const a = adapter();
      const r = await log.run('diagnostics.testSubtitleImport', {}, () => diagnostics.testSubtitleImport(a, storage));
      await refreshCaps(a).catch(() => null);
      return r;
    },

    'assets.identify': async ({ path }) => identifyAsset(path),
    'assets.presetStatus': async () => assets.captionPresetStatus(storage),
    'assets.setPreset': async ({ path }) => log.run('assets.setCaptionPreset', { path }, async () => assets.setCaptionPreset(storage, path)),
    'assets.relinkPreset': async ({ path, acceptDifferent }) => log.run('assets.relinkCaptionPreset', { path }, async () => assets.relinkCaptionPreset(storage, path, { acceptDifferent })),
    'assets.importBin': async (args) => {
      requireConfirm(args, 'Importing the caption preset bin');
      const a = adapter();
      return log.run('assets.importCaptionBin', { path: (storage.loadSettings().captionPreset || {}).path }, () => assets.importCaptionBin(a, storage, { force: Boolean(args.force) }));
    },
    'assets.captionStyles': async () => assets.captionStyles(adapter(), storage),
    'assets.templates': async ({ query, category, favouritesOnly } = {}) => {
      const cat = assets.templates(storage);
      const fav = new Set(cat.favourites);
      return { ...cat, templates: searchTemplates(cat.templates, query, { category, favourites: favouritesOnly ? fav : undefined }) };
    },
    'assets.thumbnail': async ({ thumb }) => {
      if (!thumb) return null;
      let bytes;
      if (thumb.file) bytes = fs.readFileSync(thumb.file);
      else if (thumb.bundle) {
        const { listZip, readZipEntry } = require('./core/zip');
        const entry = listZip(thumb.bundle).find((e) => e.name === thumb.entry);
        bytes = entry ? readZipEntry(thumb.bundle, entry, 4 * 1024 * 1024) : null;
      }
      return bytes ? `data:image/png;base64,${bytes.toString('base64')}` : null;
    },
    'templates.insertTitle': async (args) => {
      requireConfirm(args, 'Inserting a title');
      const a = adapter();
      return log.run('templates.insertFusionTitle', { name: args.name }, async () => {
        const { timeline } = await a.currentTimeline();
        const count = async () => {
          const n = (await a.call('Timeline', timeline, 'GetTrackCount', 'video')) || 0;
          const per = [];
          for (let i = 1; i <= n; i++) per.push(reads.listOf(await a.call('Timeline', timeline, 'GetItemListInTrack', 'video', i)).length);
          return per;
        };
        const before = await count();
        const item = await a.call('Timeline', timeline, 'InsertFusionTitleIntoTimeline', args.name);
        const after = await count();
        const track = after.findIndex((n, i) => n > (before[i] || 0));
        if (!item || track < 0) {
          throw new SuiteError(`Resolve did not insert "${args.name}". Check that the destination track (Edit page track selector) is unlocked and that the title name is unique. Manual alternative: Effects Library > Titles > drag "${args.name}" onto the timeline.`, 'call-failed');
        }
        const start = await a.call('TimelineItem', item, 'GetStart');
        const ctx = await reads.timelineContext(a, timeline, deps.calibration());
        return { track: track + 1, start, startTc: ctx.timecodeAt(start), summary: `Inserted "${args.name}" on V${track + 1} at ${ctx.timecodeAt(start)}.` };
      });
    },

    'captions.prepare': async (req) => task('captions-prepare', async (t) => {
      const preview = await captions.prepare(adapter(), deps, req, t);
      return { previewId: remember(previews, preview), ...preview };
    }),
    'captions.transcribe': async (args) => {
      requireConfirm(args, 'Starting transcription');
      const a = adapter();
      const { timeline } = await a.currentTimeline();
      return task('captions-transcribe', (t) => log.run('captions.transcribe', { track: args.track }, () => captions.transcribeTrack(a, timeline, args.track, t)));
    },
    'captions.srtText': async ({ previewId }) => {
      const p = previews.get(previewId);
      if (!p) throw new SuiteError('That preview has expired; generate it again.', 'invalid-input');
      return captions.srtFromPreview(p);
    },
    'captions.applySubtitleTrack': async (args) => {
      requireConfirm(args, 'Adding subtitles');
      const p = previews.get(args.previewId);
      if (!p) throw new SuiteError('That preview has expired; generate it again.', 'invalid-input');
      const a = adapter();
      if (!capsCache) await refreshCaps(a);
      return task('captions-apply', (t) => log.run('captions.applySubtitleTrack', { cues: p.cues.length }, () => captions.applySubtitleTrack(a, deps, p, t)));
    },
    'captions.applyStyled': async (args) => {
      requireConfirm(args, 'Placing styled captions');
      const p = previews.get(args.previewId);
      if (!p) throw new SuiteError('That preview has expired; generate it again.', 'invalid-input');
      const a = adapter();
      return task('captions-apply', (t) => log.run('captions.applyStyled', { cues: args.limit || p.cues.length, styleId: args.styleId }, () => captions.applyStyled(a, deps, p, args, t)));
    },

    'roughcut.analyse': async (req) => task('roughcut-analyse', async (t) => {
      const r = await roughcut.analyse(adapter(), deps, req, t);
      const runId = remember(analyses, r);
      return { runId, ...r };
    }),
    'roughcut.markers': async (args) => {
      requireConfirm(args, 'Adding review markers');
      const r = analyses.get(args.runId);
      if (!r) throw new SuiteError('That analysis has expired; analyse again.', 'invalid-input');
      const cuts = r.cuts.map((c) => ({ ...c, enabled: (args.enabledIds || []).includes(c.id) }));
      return log.run('roughcut.addReviewMarkers', { runId: args.runId }, () => roughcut.addReviewMarkers(adapter(), deps, { runId: args.runId, cuts }));
    },
    'roughcut.clearMarkers': async (args) => {
      requireConfirm(args, 'Removing review markers');
      return log.run('roughcut.clearReviewMarkers', { runId: args.runId }, () => roughcut.clearReviewMarkers(adapter(), deps, { runId: args.runId }));
    },
    'roughcut.build': async (args) => {
      const r = analyses.get(args.runId);
      if (!r) throw new SuiteError('That analysis has expired; analyse again.', 'invalid-input');
      if (!args.dryRun) requireConfirm(args, 'Building the rough-cut timeline');
      const cuts = r.cuts.map((c) => ({ ...c, enabled: (args.enabledIds || []).includes(c.id) }));
      const a = adapter();
      return task('roughcut-build', (t) => log.run(args.dryRun ? 'roughcut.dryRun' : 'roughcut.build', { runId: args.runId, cuts: cuts.filter((c) => c.enabled).length }, () => roughcut.build(a, deps, { track: r.track, cuts, dryRun: args.dryRun, saveAndReverify: args.saveAndReverify }, t)));
    },

    'task.cancel': async ({ taskId }) => ({ cancelled: tasks.cancel(taskId) }),
  };

  async function invoke(op, args) {
    const h = handlers[op];
    if (!h) return { ok: false, error: { message: `Unknown operation ${op}`, category: 'plugin', source: 'Plugin' } };
    try {
      return { ok: true, result: await h(args || {}) };
    } catch (e) {
      return { ok: false, error: describeError(e) };
    }
  }

  return { invoke, ops: Object.keys(handlers) };
}

module.exports = { createRouter };
