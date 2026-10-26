'use strict';
/**
 * Diagnostics: environment + capability report, and opt-in calibration tests
 * that run on a SCRATCH timeline in the current project. Every scratch
 * timeline is named "Edit Suite Scratch (safe to delete)", deleted at the end
 * of the test, and the user's current timeline is restored.
 */
const os = require('os');
const fs = require('fs');
const tb = require('../core/timebase');
const subs = require('../core/subtitles');
const { defaultTemplateRoots } = require('../core/templates');
const { evaluateCapabilities, FEATURES } = require('../resolve/capabilities');
const { SuiteError, describeError } = require('../resolve/adapter');
const { listOf, trackItems, mediaRate, timelineContext } = require('./resolve-reads');
const { findFfmpeg } = require('../services/media-audio');
const { captionPresetStatus } = require('./assets');

const SCRATCH_NAME = 'Edit Suite Scratch (safe to delete)';

/** Gather live objects for capability probing without changing anything. */
async function liveObjects(a) {
  const objects = { Resolve: a.resolve };
  try {
    objects.ProjectManager = await a.projectManager();
    const project = await a.call('ProjectManager', objects.ProjectManager, 'GetCurrentProject');
    if (project) {
      objects.Project = project;
      objects.MediaPool = await a.call('Project', project, 'GetMediaPool');
      if (objects.MediaPool) objects.Folder = await a.call('MediaPool', objects.MediaPool, 'GetRootFolder');
      const tl = await a.call('Project', project, 'GetCurrentTimeline');
      if (tl) {
        objects.Timeline = tl;
        for (const type of ['video', 'audio']) {
          const items = listOf(await a.call('Timeline', tl, 'GetItemListInTrack', type, 1));
          if (items.length) {
            objects.TimelineItem = items[0];
            const mpi = await a.call('TimelineItem', items[0], 'GetMediaPoolItem');
            if (mpi) objects.MediaPoolItem = mpi;
            break;
          }
        }
      }
    }
  } catch { /* report what we have */ }
  return objects;
}

async function capabilities(a, storage) {
  const v = await a.version();
  const objects = await liveObjects(a);
  const verified = storage.loadSettings().verified || {};
  const build = v.versionString || (v.version || []).join('.');
  // Only scratch-test results from THIS build count as verified.
  const relevant = Object.fromEntries(Object.entries(verified).filter(([, r]) => r.build === build));
  return { ...v, build, ...evaluateCapabilities({ version: v.version, isStudio: v.isStudio, objects }, relevant) };
}

async function report(a, storage, pluginVersion) {
  const out = {
    generatedAt: new Date().toISOString(),
    plugin: { version: pluginVersion, dataDir: storage.dir },
    os: { platform: process.platform, release: os.release(), arch: process.arch },
    runtime: { electron: process.versions.electron || null, node: process.versions.node, chrome: process.versions.chrome || null },
    resolve: null,
    capabilities: null,
    ffmpeg: findFfmpeg(storage.loadSettings().ffmpegPath),
    captionPreset: captionPresetStatus(storage),
    templateRoots: defaultTemplateRoots().concat(storage.loadSettings().templateRoots || []).map((r) => ({ path: r, exists: fs.existsSync(r) })),
    calibration: storage.loadSettings().calibration,
    recentErrors: storage.readLog(300).filter((e) => e.result === 'error').slice(-20),
  };
  try {
    const caps = await capabilities(a, storage);
    out.resolve = { product: caps.product, version: caps.versionString, isStudio: caps.isStudio };
    out.capabilities = { features: caps.features, probeReliability: caps.probeReliability };
  } catch (e) {
    out.resolve = { error: describeError(e) };
  }
  return out;
}

async function withScratchTimeline(a, fn) {
  const { pm, project, timeline: original } = await a.currentTimeline();
  const mediaPool = await a.must('Project', project, 'GetMediaPool');
  const scratch = await a.call('MediaPool', mediaPool, 'CreateEmptyTimeline', SCRATCH_NAME);
  if (!scratch) throw new SuiteError(`Could not create the scratch timeline (is a timeline called "${SCRATCH_NAME}" already present? Delete it and retry).`, 'call-failed');
  try {
    await a.must('Project', project, 'SetCurrentTimeline', scratch);
    return await fn({ pm, project, mediaPool, scratch, original });
  } finally {
    await a.call('Project', project, 'SetCurrentTimeline', original);
    const deleted = await a.call('MediaPool', mediaPool, 'DeleteTimelines', [scratch]);
    if (!deleted) {
      // Surface but do not mask the primary result.
      a.cleanupWarning = `The scratch timeline "${SCRATCH_NAME}" could not be deleted automatically; delete it from the Media Pool.`;
    }
  }
}

/**
 * Measure frame conventions on this build using the first media clip of the
 * current timeline's V1 (or A1): AppendToTimeline endFrame inclusivity,
 * TimelineItem GetEnd convention, Timeline.GetEndFrame convention.
 */
async function calibrate(a, storage) {
  const caps = await capabilities(a, storage);
  const { timeline } = await a.currentTimeline();
  let source = null;
  for (const type of ['video', 'audio']) {
    const items = await trackItems(a, timeline, type, 1);
    for (const it of items) {
      const mpi = await a.call('TimelineItem', it.ref, 'GetMediaPoolItem');
      if (mpi) { source = { mpi, type }; break; }
    }
    if (source) break;
  }
  if (!source) throw new SuiteError('Calibration needs a media clip on V1 or A1 of the current timeline.', 'invalid-input');
  const rate = await mediaRate(a, source.mpi);
  if (!rate) throw new SuiteError('The calibration clip has no readable frame rate.', 'invalid-input');

  const result = await withScratchTimeline(a, async ({ mediaPool, scratch }) => {
    const ctx = await timelineContext(a, scratch, {});
    const sameRate = ctx.rate.num * rate.den === rate.num * ctx.rate.den;
    const placed = listOf(await a.call('MediaPool', mediaPool, 'AppendToTimeline', [{ mediaPoolItem: source.mpi, startFrame: 0, endFrame: 47, recordFrame: ctx.startFrame, trackIndex: 1 }]));
    if (!placed.length) throw new SuiteError('AppendToTimeline placed nothing during calibration.', 'call-failed');
    const it = placed[0];
    const start = await a.call('TimelineItem', it, 'GetStart');
    const end = await a.call('TimelineItem', it, 'GetEnd');
    const dur = await a.call('TimelineItem', it, 'GetDuration');
    const tlStart = await a.call('Timeline', scratch, 'GetStartFrame');
    const tlEnd = await a.call('Timeline', scratch, 'GetEndFrame');
    const expectInclusive = sameRate ? 48 : tb.convertFrames(48, rate, ctx.rate, 'floor');
    return {
      sameRate,
      measured: { start, end, dur, tlStart, tlEnd },
      appendEndInclusive: dur === expectInclusive,
      itemEndInclusive: end - start + 1 === dur,
      timelineEndInclusive: tlEnd - tlStart + 1 === dur,
    };
  });
  const build = caps.build;
  storage.updateSettings((s) => ({ ...s, calibration: { ...s.calibration, ...result, build, at: new Date().toISOString() } }));
  return { ...result, build, cleanupWarning: a.cleanupWarning || null };
}

/** Scratch test of SRT -> subtitle track placement; records verified status. */
async function testSubtitleImport(a, storage) {
  const caps = await capabilities(a, storage);
  const res = await withScratchTimeline(a, async ({ mediaPool, scratch }) => {
    const ctx = await timelineContext(a, scratch, storage.loadSettings().calibration || {});
    // Two frame-aligned cues at 1.0-2.0 s and 2.5-3.3 s.
    const at = (sec) => tb.quantize(tb.secondsToFlicks(sec), ctx.rate);
    const cues = [
      { start: at(1), end: at(2), text: 'Edit Suite test one' },
      { start: at(2.5), end: at(3.3), text: 'Edit Suite test two' },
    ];
    const file = storage.writeGenerated('subtitle-import-test.srt', subs.writeSrt(cues, { msRounding: 'ceil' }));
    const imported = listOf(await a.call('MediaPool', mediaPool, 'ImportMedia', [file]));
    if (!imported.length) return { ok: false, detail: 'ImportMedia did not import an .srt file.' };
    let placed;
    try {
      await a.call('MediaPool', mediaPool, 'AppendToTimeline', [{ mediaPoolItem: imported[0], recordFrame: ctx.startFrame }]);
      const n = (await a.call('Timeline', scratch, 'GetTrackCount', 'subtitle')) || 0;
      placed = n ? await trackItems(a, scratch, 'subtitle', 1) : [];
    } finally {
      // Always remove the test clip, even if a step above failed.
      const removed = await a.call('MediaPool', mediaPool, 'DeleteClips', imported).catch(() => false);
      if (!removed) a.cleanupWarning = 'The test clip "subtitle-import-test.srt" could not be removed from the Media Pool; delete it manually.';
    }
    const expected = cues.map((c) => ({ s: ctx.startFrame + tb.flicksToFrames(c.start, ctx.rate), e: ctx.startFrame + tb.flicksToFrames(c.end, ctx.rate) }));
    const ok = placed.length === 2 && placed.every((p, i) => p.start === expected[i].s && p.end === expected[i].e);
    return { ok, detail: ok ? 'Two test subtitles placed at the exact expected frames.' : `Placed ${placed.length} item(s): ${JSON.stringify(placed.map((p) => [p.start, p.end]))}; expected ${JSON.stringify(expected.map((e) => [e.s, e.e]))}.` };
  });
  storage.updateSettings((s) => ({ ...s, verified: { ...s.verified, 'captions.srtTrack': { ...res, build: caps.build, at: new Date().toISOString() } } }));
  return { ...res, cleanupWarning: a.cleanupWarning || null };
}

module.exports = { report, capabilities, calibrate, testSubtitleImport, liveObjects, SCRATCH_NAME, FEATURES };
