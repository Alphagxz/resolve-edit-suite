'use strict';
/**
 * Caption pipeline:
 *   1. source  -> word-timed transcript in TIMELINE time
 *        - subtitle file (.srt/.vtt), placed at the timeline start + offset
 *        - Resolve 21.1 transcription of the clips on a chosen track
 *   2. segment -> cues (core/segmenter)
 *   3. finalize against the active timeline (core/cues) -> PREVIEW
 *   4. apply, after the user approves the preview:
 *        a. subtitle track via SRT import (capability-gated, verified)
 *        b. styled captions using an imported preset item (test-one-first)
 *   An SRT export of every preview is always available and is the
 *   preserved "original subtitle version" before any transformation.
 */
const fs = require('fs');
const path = require('path');
const tb = require('../core/timebase');
const subs = require('../core/subtitles');
const { segmentWords, estimateWordTimings } = require('../core/segmenter');
const { finalizeCues, validateCues, cuesToRelative } = require('../core/cues');
const { captionLayout } = require('../core/layout');
const { SuiteError } = require('../resolve/adapter');
const { isAvailable } = require('../resolve/capabilities');
const { timelineContext, trackItems, clipProperty, mediaRate, listOf } = require('./resolve-reads');
const { backupTimeline, stamp } = require('./backup');

function loadFileWords(file) {
  if (!fs.existsSync(file)) throw new SuiteError(`Subtitle file not found: ${file}`, 'asset-missing');
  const text = fs.readFileSync(file, 'utf8');
  let parsed;
  try {
    parsed = subs.parseSubtitleFile(file, text);
  } catch (e) {
    throw new SuiteError(`Could not read ${path.basename(file)}: ${e.message}`, 'invalid-input');
  }
  const words = estimateWordTimings(parsed.cues.map((c) => ({ ...c, text: c.text.replace(/\n/g, ' ') })));
  return { words, warnings: [...parsed.warnings, 'Word timings were estimated from subtitle cue timing (the file has no per-word times).'] };
}

/**
 * Collect word timings from Resolve's transcription of the media under each
 * item of a track, mapped into timeline time. Words outside the portion of
 * the source used by the item are dropped.
 */
async function transcriptWords(a, timeline, ctx, track, task) {
  const items = await trackItems(a, timeline, track.type, track.index);
  if (!items.length) throw new SuiteError(`${track.type} track ${track.index} has no clips.`, 'invalid-input');
  const words = [];
  const warnings = [];
  const missing = [];
  for (let i = 0; i < items.length; i++) {
    task.checkpoint();
    task.progress((i / items.length) * 100, `Reading transcription ${i + 1}/${items.length}`);
    const it = items[i];
    const mpi = await a.call('TimelineItem', it.ref, 'GetMediaPoolItem');
    if (!mpi) { warnings.push(`"${it.name}" has no media (title/generator); skipped.`); continue; }
    const rate = await mediaRate(a, mpi);
    if (!rate) { warnings.push(`"${it.name}": unreadable source frame rate; skipped.`); continue; }
    const status = await clipProperty(a, mpi, 'Transcription Status');
    if (status !== 'Transcribed') { missing.push(it.name); continue; }
    const payload = await a.call('MediaPoolItem', mpi, 'GetTranscription', false);
    const startTc = await clipProperty(a, mpi, 'Start TC');
    let origin = 0;
    try { origin = startTc ? require('../core/timecode').timecodeToFrames(startTc, rate) : 0; } catch { origin = 0; }
    let t;
    try {
      t = subs.fromResolveTranscription(payload, rate, origin);
    } catch (e) {
      throw new SuiteError(`Transcription of "${it.name}" has an unexpected shape: ${e.message}`, 'unsupported');
    }
    const srcIn = it.sourceStartTime !== null && it.sourceStartTime !== undefined ? tb.secondsToFlicks(it.sourceStartTime) : tb.framesToFlicks(it.leftOffset || 0, rate);
    const recStart = ctx.fromTimelineFrame(it.start);
    const recEnd = ctx.fromTimelineFrame(it.end);
    for (const seg of t.segments) {
      for (const w of seg.words || estimateWordTimings([seg])) {
        const s = recStart + (w.start - srcIn);
        const e = recStart + (w.end - srcIn);
        if (s >= recStart && e <= recEnd) words.push({ text: w.text, start: s, end: e, speaker: seg.speaker, estimated: Boolean(w.estimated) });
      }
    }
  }
  if (missing.length) {
    warnings.push(`Not transcribed yet: ${missing.join(', ')}. Use "Transcribe clips" (Studio) or transcribe them in the Media Pool, then reload.`);
  }
  return { words, warnings, missing };
}

async function transcribeTrack(a, timeline, track, task) {
  const items = await trackItems(a, timeline, track.type, track.index);
  const started = [];
  for (const it of items) {
    task.checkpoint();
    const mpi = await a.call('TimelineItem', it.ref, 'GetMediaPoolItem');
    if (!mpi) continue;
    if ((await clipProperty(a, mpi, 'Transcription Status')) === 'Transcribed') continue;
    const ok = await a.call('MediaPoolItem', mpi, 'TranscribeAudio');
    started.push({ name: it.name, ok: Boolean(ok) });
  }
  return { started, message: started.length ? 'Transcription started in Resolve. Reload when the clips show as transcribed.' : 'All clips are already transcribed.' };
}

async function prepare(a, deps, req, task) {
  const { timeline } = await a.currentTimeline();
  const calib = deps.calibration();
  const ctx = await timelineContext(a, timeline, calib);
  let source;
  if (req.source.kind === 'file') source = loadFileWords(req.source.path);
  else if (req.source.kind === 'transcription') source = await transcriptWords(a, timeline, ctx, req.source.track, task);
  else throw new SuiteError('Choose a caption source.', 'invalid-input');
  if (!source.words.length) throw new SuiteError('No words found in the selected source.', 'invalid-input');

  let seg;
  try {
    seg = segmentWords(source.words, req.options || {});
  } catch (e) {
    throw new SuiteError(e.message, 'invalid-input');
  }
  const offset = req.source.kind === 'file' ? tb.msToFlicks(req.source.offsetMs || 0) : 0;
  const fin = finalizeCues(seg.cues, ctx, { offset, minGapFrames: req.minGapFrames ?? 0, timingShiftMs: req.timingShiftMs || 0 });
  const problems = validateCues(fin.cues, ctx);
  if (problems.length) throw new SuiteError(`Internal timing validation failed: ${problems.slice(0, 5).join('; ')}`, 'plugin');
  const layout = captionLayout(ctx, req.layout || {});
  return {
    timeline: { rate: ctx.rate.label, dropFrame: ctx.dropFrame, width: ctx.width, height: ctx.height, aspect: ctx.aspect, startFrame: ctx.startFrame, endFrame: ctx.endFrameExclusive },
    cues: fin.cues.map((c) => ({
      id: c.id, text: c.text, lines: c.lines, startFrame: c.startFrame, endFrame: c.endFrame,
      startTc: ctx.timecodeAt(c.startFrame), endTc: ctx.timecodeAt(c.endFrame), estimated: c.estimated,
      emphasis: (c.words || []).filter((w) => w.emphasis).map((w) => w.text),
    })),
    report: fin.report,
    warnings: [...source.warnings, ...seg.warnings, ...ctx.problems],
    layout,
  };
}

/** Write the preview as SRT relative to the timeline start (frame-safe ms rounding). */
function srtFromPreview(preview) {
  const rate = tb.parseFrameRate(preview.timeline.rate);
  return subs.writeSrt(
    preview.cues.map((c) => ({ text: c.text, start: tb.framesToFlicks(c.startFrame - preview.timeline.startFrame, rate), end: tb.framesToFlicks(c.endFrame - preview.timeline.startFrame, rate) })),
    { msRounding: 'ceil' }
  );
}

async function ensureBin(a, mediaPool, names) {
  let folder = await a.must('MediaPool', mediaPool, 'GetRootFolder');
  for (const n of names) {
    const subsList = listOf(await a.call('Folder', folder, 'GetSubFolderList'));
    let next = null;
    for (const f of subsList) if ((await a.call('Folder', f, 'GetName')) === n) next = f;
    folder = next || (await a.must('MediaPool', mediaPool, 'AddSubFolder', folder, n));
  }
  return folder;
}

async function applySubtitleTrack(a, deps, preview, task) {
  if (!isAvailable(deps.capabilities(), 'captions.srtTrack')) {
    throw new SuiteError('Placing an SRT on a subtitle track is not enabled for this Resolve build. Run Diagnostics > "Test subtitle import", or export the SRT and import it via File > Import > Subtitle.', 'unsupported');
  }
  const { project, timeline } = await a.currentTimeline();
  const ctx = await timelineContext(a, timeline, deps.calibration());
  if (ctx.startFrame !== preview.timeline.startFrame || ctx.rate.label !== preview.timeline.rate) {
    throw new SuiteError('The active timeline changed since the preview was made. Regenerate the preview.', 'invalid-input');
  }
  task.progress(5, 'Backing up timeline');
  const backup = await backupTimeline(a, project, timeline, 'captions');
  const srtPath = deps.storage.writeGenerated(`captions ${stamp()}.srt`, srtFromPreview(preview));
  task.checkpoint();
  const mediaPool = await a.must('Project', project, 'GetMediaPool');
  const prevFolder = await a.call('MediaPool', mediaPool, 'GetCurrentFolder');
  const bin = await ensureBin(a, mediaPool, ['Edit Suite', 'Subtitles']);
  await a.must('MediaPool', mediaPool, 'SetCurrentFolder', bin);
  let imported;
  try {
    imported = listOf(await a.call('MediaPool', mediaPool, 'ImportMedia', [srtPath]));
  } finally {
    if (prevFolder) await a.call('MediaPool', mediaPool, 'SetCurrentFolder', prevFolder);
  }
  if (!imported.length) throw new SuiteError('Resolve did not import the generated SRT file.', 'call-failed', { srtPath });
  task.progress(50, 'Placing subtitles');
  const r = await placeSrtVerified(a, timeline, mediaPool, imported[0], ctx, preview.cues);
  if (r.verify.ok) {
    return { backup, srtPath, subtitleTrack: r.trackIndex, verify: r.verify, summary: `${r.added.length} subtitle(s) on new subtitle track ${r.trackIndex}; timings verified` };
  }
  // A real failure on this build outranks the earlier scratch-test pass: switch the feature off.
  const caps = deps.capabilities();
  deps.storage.updateSettings((s) => ({ ...s, verified: { ...s.verified, 'captions.srtTrack': { ok: false, build: caps && caps.build, testVersion: 2, at: new Date().toISOString(), detail: r.verify.problems.slice(0, 2).join(' ') } } }));
  throw new SuiteError(`Resolve did not place the subtitles at the right frames (${r.verify.problems.slice(0, 2).join(' ')}). ${r.rolledBack ? 'Everything it added was removed again, so the timeline is unchanged. ' : ''}The SRT file is kept at ${srtPath}; you can import it with File > Import > Subtitle. Backup: ${backup.backupName}.`, 'verification-failed', { srtPath, verify: r.verify });
}

/**
 * Place an imported SRT pool item on a NEW subtitle track and verify it.
 *
 * Observed on 21.0.0b20: given only recordFrame, Resolve ignored it and
 * appended the subtitles after the existing timeline content. So this names
 * the target track explicitly, identifies exactly the items the call added
 * (by unique id, on any subtitle track), and removes them again — plus the
 * track it created — if their frames are not the expected ones.
 */
async function placeSrtVerified(a, timeline, mediaPool, srtItem, ctx, expectedCues) {
  const snapshot = async () => {
    const n = (await a.call('Timeline', timeline, 'GetTrackCount', 'subtitle')) || 0;
    const items = [];
    for (let i = 1; i <= n; i++) for (const it of await trackItems(a, timeline, 'subtitle', i)) items.push({ ...it, track: i });
    return { n, items };
  };
  const before = await snapshot();
  const known = new Set(before.items.map((x) => x.id));
  await a.must('Timeline', timeline, 'AddTrack', 'subtitle');
  const trackIndex = (await a.call('Timeline', timeline, 'GetTrackCount', 'subtitle')) || 0;
  if (trackIndex !== before.n + 1) throw new SuiteError('Could not create a new subtitle track.', 'call-failed');
  await a.call('MediaPool', mediaPool, 'AppendToTimeline', [{ mediaPoolItem: srtItem, recordFrame: ctx.startFrame, trackIndex }]);
  const after = await snapshot();
  const added = after.items.filter((x) => !known.has(x.id)).sort((x, y) => x.start - y.start);
  let verify = verifyCuePlacement(expectedCues, added);
  if (verify.ok && added.some((x) => x.track !== trackIndex)) verify = { ok: false, problems: ['Subtitles went to a different subtitle track than requested.'] };
  let rolledBack = false;
  if (!verify.ok) {
    if (added.length) await a.call('Timeline', timeline, 'DeleteClips', added.map((x) => x.ref), false);
    const left = listOf(await a.call('Timeline', timeline, 'GetItemListInTrack', 'subtitle', trackIndex));
    if (!left.length) await a.call('Timeline', timeline, 'DeleteTrack', 'subtitle', trackIndex);
    const check = await snapshot();
    rolledBack = check.items.every((x) => known.has(x.id)) && check.n === before.n;
  }
  return { trackIndex, added: added.map((x) => ({ start: x.start, end: x.end, track: x.track })), verify, rolledBack };
}

/** Text wiring of the chosen preset items, from the validated .drb (when available). */
async function presetHints(a, storage, items) {
  const hints = new Map();
  const rec = storage.loadSettings().captionPreset;
  if (!rec || !rec.path || !fs.existsSync(rec.path)) return hints;
  let presets;
  try {
    presets = require('../core/bin-presets').inspectBinPresets(rec.path);
  } catch {
    return hints;
  }
  for (const it of items.filter(Boolean)) {
    const name = await a.call('MediaPoolItem', it, 'GetName');
    const p = presets.find((x) => x.name === name && x.wiring !== 'none') || presets.find((x) => x.name === name);
    if (p) hints.set(it, p);
  }
  return hints;
}

function verifyCuePlacement(cues, placed, tolerance = 0) {
  const problems = [];
  if (placed.length !== cues.length) problems.push(`Expected ${cues.length} caption(s), found ${placed.length}.`);
  const n = Math.min(cues.length, placed.length);
  for (let i = 0; i < n; i++) {
    const c = cues[i];
    const p = placed[i];
    if (Math.abs(p.start - c.startFrame) > tolerance || Math.abs(p.end - c.endFrame) > tolerance) {
      problems.push(`Caption ${i + 1}: placed ${p.start}-${p.end}, expected ${c.startFrame}-${c.endFrame}.`);
    }
  }
  return { ok: problems.length === 0, problems };
}

async function findPoolItem(a, mediaPool, uniqueId) {
  const root = await a.must('MediaPool', mediaPool, 'GetRootFolder');
  const stack = [root];
  while (stack.length) {
    const f = stack.pop();
    for (const clip of listOf(await a.call('Folder', f, 'GetClipList'))) {
      if ((await a.call('MediaPoolItem', clip, 'GetUniqueId')) === uniqueId) return clip;
    }
    stack.push(...listOf(await a.call('Folder', f, 'GetSubFolderList')));
  }
  return null;
}

const textOf = (v) => (v && typeof v === 'object' && 'Value' in v ? v.Value : v);

/**
 * Set a placed preset's words where they actually live. Measured on
 * MotionText Pro: in 30 of its 39 text presets Text+ StyledText is driven by a
 * StyledTextFollower (the word-by-word animation), so the words are the
 * follower's "Text" input and setting StyledText is ignored. In the other 9,
 * Text+ StyledText holds the words. Every write is read back.
 * @param {object} [hint] wiring from the .drb inspection: { wiring, followers }
 */
async function setCaptionText(a, item, text, hint = null) {
  const count = await a.call('TimelineItem', item, 'GetFusionCompCount');
  if (!count) return { ok: false, reason: 'The placed preset has no Fusion composition, so its text cannot be set through the API.' };
  const comp = await a.call('TimelineItem', item, 'GetFusionCompByIndex', 1);
  const textTools = comp ? listOf(await a.call('Composition', comp, 'GetToolList', false, 'TextPlus')) : [];
  if (!textTools.length) return { ok: false, reason: 'This preset has no Text+ node, so it is not a text preset (for example a zoom or adjustment clip).' };
  let followers = listOf(await a.call('Composition', comp, 'GetToolList', false, 'StyledTextFollower').catch(() => []));
  if (!followers.length && hint && hint.followers) {
    for (const name of hint.followers) {
      const t = await a.call('Composition', comp, 'FindTool', name).catch(() => null);
      if (t) followers.push(t);
    }
  }
  if (!followers.length && hint && hint.wiring === 'follower') {
    return { ok: false, reason: 'This is an animated (follower) preset, but its animation node could not be reached through the API, so its words were not changed.' };
  }
  if (followers.length) {
    for (const f of followers) await a.call('Tool', f, 'SetInput', 'Text', text);
    const back = [];
    for (const f of followers) back.push(textOf(await a.call('Tool', f, 'GetInput', 'Text')));
    return back.every((b) => b === text) ? { ok: true, via: 'follower' } : { ok: false, reason: `Animated text read back as "${back.find((b) => b !== text)}" after setting it.` };
  }
  const tool = textTools[0];
  await a.call('Tool', tool, 'SetInput', 'StyledText', text);
  const back = textOf(await a.call('Tool', tool, 'GetInput', 'StyledText'));
  return back === text ? { ok: true, via: 'text+' } : { ok: false, reason: `Text read back as "${back}" after setting it (its text may be driven by another node).` };
}

/**
 * Styled captions from an imported preset item: one placement per cue on a
 * NEW video track (so nothing existing can collide), text set via Text+,
 * every placement and text value verified. `limit` lets the UI place a
 * single test caption before committing to the batch.
 */
async function applyStyled(a, deps, preview, req, task) {
  const { project, timeline } = await a.currentTimeline();
  const ctx = await timelineContext(a, timeline, deps.calibration());
  if (ctx.startFrame !== preview.timeline.startFrame || ctx.rate.label !== preview.timeline.rate) {
    throw new SuiteError('The active timeline changed since the preview was made. Regenerate the preview.', 'invalid-input');
  }
  const mediaPool = await a.must('Project', project, 'GetMediaPool');
  const style = await findPoolItem(a, mediaPool, req.styleId);
  if (!style) throw new SuiteError('The selected caption style is no longer in the Media Pool. Re-import the preset bin in Setup.', 'asset-missing');
  const emphasisStyle = req.emphasisStyleId ? await findPoolItem(a, mediaPool, req.emphasisStyleId) : null;
  const hints = await presetHints(a, deps.storage, [style, emphasisStyle]);
  const styleRate = (await mediaRate(a, style)) || ctx.rate;
  const styleDurFrames = Number(await clipProperty(a, style, 'Frames')) || null;

  const cues = req.limit ? preview.cues.slice(0, req.limit) : preview.cues;
  task.progress(2, 'Backing up timeline');
  const backup = await backupTimeline(a, project, timeline, 'captions');
  task.checkpoint();
  await a.must('Timeline', timeline, 'AddTrack', 'video');
  const trackIndex = await a.must('Timeline', timeline, 'GetTrackCount', 'video');
  const endInclusive = deps.calibration().appendEndInclusive !== false;

  const infos = [];
  const skipped = [];
  for (const c of cues) {
    const recFrames = c.endFrame - c.startFrame;
    const srcFrames = tb.convertFrames(recFrames, ctx.rate, styleRate, 'ceil');
    if (styleDurFrames && srcFrames > styleDurFrames) {
      skipped.push(`Caption ${c.id} needs ${srcFrames} frames but the preset clip is only ${styleDurFrames} frames long.`);
      continue;
    }
    infos.push({
      cue: c,
      info: { mediaPoolItem: c.emphasis.length && emphasisStyle ? emphasisStyle : style, startFrame: 0, endFrame: endInclusive ? srcFrames - 1 : srcFrames, recordFrame: c.startFrame, trackIndex },
    });
  }
  const textResults = [];
  const BATCH = 25;
  for (let i = 0; i < infos.length; i += BATCH) {
    task.checkpoint();
    task.progress(5 + (i / infos.length) * 80, `Placing captions ${i + 1}-${Math.min(i + BATCH, infos.length)} of ${infos.length}`);
    const chunk = infos.slice(i, i + BATCH);
    const placedItems = listOf(await a.call('MediaPool', mediaPool, 'AppendToTimeline', chunk.map((x) => x.info)));
    for (let j = 0; j < chunk.length; j++) {
      const item = placedItems[j];
      if (!item) { textResults.push({ id: chunk[j].cue.id, ok: false, reason: 'Not placed.' }); continue; }
      textResults.push({ id: chunk[j].cue.id, ...(await setCaptionText(a, item, chunk[j].cue.text, hints.get(chunk[j].info.mediaPoolItem))) });
    }
  }
  task.progress(90, 'Verifying');
  const placed = await trackItems(a, timeline, 'video', trackIndex);
  const verify = verifyCuePlacement(infos.map((x) => x.cue), placed, 1);
  const textFailures = textResults.filter((r) => !r.ok);
  return {
    backup, trackIndex, skipped, verify, textFailures,
    summary: `${placed.length}/${infos.length} caption(s) on V${trackIndex}; ${verify.ok ? 'placement verified' : 'placement differences found'}; ${textFailures.length ? textFailures.length + ' text update(s) failed' : 'all text verified'}.`,
  };
}

module.exports = { prepare, srtFromPreview, applySubtitleTrack, placeSrtVerified, applyStyled, transcribeTrack, verifyCuePlacement, loadFileWords };
