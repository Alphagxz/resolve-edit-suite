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
const { placeSrtVerified } = require('./captions');

const SCRATCH_NAME = 'Edit Suite Scratch (safe to delete)';
// Bump when a scratch test changes so results from a weaker earlier version
// no longer count (v1 ran on an empty timeline and could not detect an
// ignored recordFrame).
const TEST_VERSIONS = { 'captions.srtTrack': 2 };

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
  const relevant = Object.fromEntries(Object.entries(verified).filter(([id, r]) => r.build === build && (r.testVersion || 1) === (TEST_VERSIONS[id] || 1)));
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

/**
 * Scratch test of SRT -> subtitle track placement; records verified status.
 * The scratch timeline first gets ~6 s of real media, so a Resolve build that
 * ignores recordFrame (appending after existing content, as observed on
 * 21.0.0b20) fails this test instead of passing it on an empty timeline.
 * Uses the same placeSrtVerified routine as the real "Add as subtitle track".
 */
async function testSubtitleImport(a, storage) {
  const caps = await capabilities(a, storage);
  const filler = await findCalibrationClip(a);
  const calib = storage.loadSettings().calibration || {};
  const res = await withScratchTimeline(a, async ({ mediaPool, scratch }) => {
    const ctx = await timelineContext(a, scratch, calib);
    const fillerFrames = Math.min(filler.frames || 0, Math.round((6 * filler.rate.num) / filler.rate.den));
    if (fillerFrames < Math.round((4 * filler.rate.num) / filler.rate.den)) {
      return { ok: false, detail: 'The first media clip on V1/A1 is shorter than 4 seconds; the test needs a longer clip.' };
    }
    const endFrame = calib.appendEndInclusive === false ? fillerFrames : fillerFrames - 1;
    await a.call('MediaPool', mediaPool, 'AppendToTimeline', [{ mediaPoolItem: filler.mpi, startFrame: 0, endFrame, recordFrame: ctx.startFrame, trackIndex: 1 }]);
    // Two frame-aligned cues at 1.0-2.0 s and 2.5-3.3 s, inside the filler.
    const at = (sec) => tb.quantize(tb.secondsToFlicks(sec), ctx.rate);
    const cues = [
      { start: at(1), end: at(2), text: 'Edit Suite test one' },
      { start: at(2.5), end: at(3.3), text: 'Edit Suite test two' },
    ];
    const expected = cues.map((c, i) => ({ id: String(i + 1), startFrame: ctx.startFrame + tb.flicksToFrames(c.start, ctx.rate), endFrame: ctx.startFrame + tb.flicksToFrames(c.end, ctx.rate) }));
    const file = storage.writeGenerated('subtitle-import-test.srt', subs.writeSrt(cues, { msRounding: 'ceil' }));
    const imported = listOf(await a.call('MediaPool', mediaPool, 'ImportMedia', [file]));
    if (!imported.length) return { ok: false, detail: 'ImportMedia did not import an .srt file.' };
    try {
      const r = await placeSrtVerified(a, scratch, mediaPool, imported[0], ctx, expected);
      return r.verify.ok
        ? { ok: true, detail: 'Two test subtitles placed on a new subtitle track at the exact expected frames, with media already on the timeline.' }
        : { ok: false, detail: `Wrong placement: ${r.verify.problems.slice(0, 2).join(' ')} Added: ${JSON.stringify(r.added.map((x) => [x.start, x.end, `ST${x.track}`]))}.` };
    } finally {
      // Always remove the test clip, even if a step above failed.
      const removed = await a.call('MediaPool', mediaPool, 'DeleteClips', imported).catch(() => false);
      if (!removed) a.cleanupWarning = 'The test clip "subtitle-import-test.srt" could not be removed from the Media Pool; delete it manually.';
    }
  });
  storage.updateSettings((s) => ({ ...s, verified: { ...s.verified, 'captions.srtTrack': { ...res, build: caps.build, testVersion: TEST_VERSIONS['captions.srtTrack'], at: new Date().toISOString() } } }));
  return { ...res, cleanupWarning: a.cleanupWarning || null };
}

/** First media clip on V1 (or A1) of the current timeline, with its rate and length. */
async function findCalibrationClip(a) {
  const { timeline } = await a.currentTimeline();
  for (const type of ['video', 'audio']) {
    for (const it of await trackItems(a, timeline, type, 1)) {
      const mpi = await a.call('TimelineItem', it.ref, 'GetMediaPoolItem').catch(() => null);
      if (!mpi) continue;
      const rate = await mediaRate(a, mpi);
      if (rate) return { mpi, rate, frames: Number(await a.call('MediaPoolItem', mpi, 'GetClipProperty', 'Frames').then((v) => (v && typeof v === 'object' ? v.Frames : v)).catch(() => 0)) };
    }
  }
  throw new SuiteError('This test needs a media clip on V1 or A1 of the current timeline.', 'invalid-input');
}

module.exports = { TEST_VERSIONS, report, capabilities, calibrate, testSubtitleImport, liveObjects, SCRATCH_NAME, FEATURES };
