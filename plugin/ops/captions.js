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
const { patchCompText, readCompText } = require('../core/comp-text');
const { SuiteError } = require('../resolve/adapter');
const { isAvailable } = require('../resolve/capabilities');
const { timelineContext, trackItems, clipProperty, mediaRate, listOf } = require('./resolve-reads');
const { backupTimeline, stamp } = require('./backup');

/** Timeline copies only when the user turned on "Back up timeline before edits" (off by default). */
async function maybeBackup(a, deps, project, timeline) {
  return deps.storage.loadSettings().backupBeforeEdits ? backupTimeline(a, project, timeline, 'captions') : null;
}

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
  else if (req.source.kind === 'resolveAudio') source = await audioWords(a, deps, timeline, ctx, req.source, task);
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
  task.progress(5, 'Preparing subtitles');
  const backup = await maybeBackup(a, deps, project, timeline);
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
  throw new SuiteError(`Resolve did not place the subtitles at the right frames (${r.verify.problems.slice(0, 2).join(' ')}). ${r.rolledBack ? 'Everything it added was removed again, so the timeline is unchanged. ' : ''}The SRT file is kept at ${srtPath}; you can import it with File > Import > Subtitle.${backup ? ` Backup: ${backup.backupName}.` : ''}`, 'verification-failed', { srtPath, verify: r.verify });
}

/** All subtitle items on all subtitle tracks, with their track numbers and ids. */
async function snapshotSubtitles(a, timeline) {
  const n = (await a.call('Timeline', timeline, 'GetTrackCount', 'subtitle')) || 0;
  const items = [];
  for (let i = 1; i <= n; i++) for (const it of await trackItems(a, timeline, 'subtitle', i)) items.push({ ...it, track: i });
  return { n, items };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PLACEHOLDER_NAME = /^(subtitle|caption)?\s*\d*$/i;

/**
 * Captions from the timeline's own audio, using Resolve Studio's speech-to-text
 * (Timeline.CreateSubtitlesFromAudio) on the CURRENT timeline — no copy. The
 * subtitles Resolve generates are read (text = item name, timing = start/end)
 * and then removed again unless the user keeps them; only their text and
 * timing feed the caption pipeline.
 */
async function audioWords(a, deps, timeline, ctx, source, task) {
  const caps = deps.capabilities();
  if (caps && caps.isStudio === false) throw new SuiteError('Captions from audio use Resolve Studio\'s speech recognition, which is not available in the free edition.', 'edition');
  if (caps && !isAvailable(caps, 'captions.autoSubtitles')) {
    const f = caps.features['captions.autoSubtitles'];
    throw new SuiteError(`Resolve's speech-to-text is not available here: ${f ? f.reasons.join(' ') : 'unknown reason'}`, 'unsupported');
  }
  const before = await snapshotSubtitles(a, timeline);
  const known = new Set(before.items.map((x) => x.id));
  const newItems = (snap) => snap.items.filter((x) => !known.has(x.id));

  task.progress(5, 'Resolve is transcribing the timeline audio…');
  const restoreTimeout = deps.setApiTimeout ? deps.setApiTimeout(30 * 60) : null;
  let reported;
  let callError = null;
  try {
    reported = await a.call('Timeline', timeline, 'CreateSubtitlesFromAudio');
  } catch (e) {
    callError = e; // the call may time out while Resolve keeps working; polling decides
  } finally {
    if (restoreTimeout) restoreTimeout();
  }

  // The returned boolean is unreliable: success = new subtitle items, stable across two polls.
  const deadline = Date.now() + (source.timeoutSec || 15 * 60) * 1000;
  const graceEnd = Date.now() + (source.emptyGraceMs ?? 30000);
  let added = newItems(await snapshotSubtitles(a, timeline));
  let stable = 0;
  while (Date.now() < deadline) {
    task.checkpoint();
    if (added.length) {
      await sleep(source.pollMs ?? 2000);
      const again = newItems(await snapshotSubtitles(a, timeline));
      if (again.length === added.length) stable++;
      else stable = 0;
      added = again;
      if (stable >= 1) break;
    } else {
      if (reported === false || callError) break;
      // Resolve may report success before its subtitles appear: allow a grace period.
      if (Date.now() >= graceEnd) break;
      task.progress(10, 'Waiting for Resolve to finish transcribing…');
      await sleep(source.pollMs ?? 2000);
      added = newItems(await snapshotSubtitles(a, timeline));
    }
  }
  if (!added.length) {
    if (callError) throw new SuiteError(`Resolve's speech-to-text did not run: ${callError.message}`, callError.category || 'exception');
    throw new SuiteError(reported === false
      ? 'Resolve reported that it could not create subtitles from this timeline\'s audio (no speech found, audio disabled, or the AI model is unavailable).'
      : 'Resolve finished but produced no subtitles: no speech was found in the timeline audio.', 'call-failed');
  }
  added.sort((x, y) => x.start - y.start);
  const texts = added.map((x) => String(x.name || '').trim());
  const placeholder = texts.every((t) => !t || PLACEHOLDER_NAME.test(t)) || (texts.length > 2 && new Set(texts).size === 1);
  if (placeholder) {
    throw new SuiteError(`Resolve created ${added.length} subtitle(s), but this Resolve build does not expose their text through the API (items read back as "${texts[0]}"). Resolve's subtitle track was kept so you can see them.`, 'unsupported');
  }

  const warnings = ['Captions come from Resolve\'s speech recognition of the mixed timeline audio; word timing inside each line is estimated.'];
  if (!source.keepResolveTrack) {
    const tracks = [...new Set(added.map((x) => x.track))];
    await a.call('Timeline', timeline, 'DeleteClips', added.map((x) => x.ref), false);
    for (const t of tracks.sort((x, y) => y - x)) {
      const left = listOf(await a.call('Timeline', timeline, 'GetItemListInTrack', 'subtitle', t));
      if (!left.length && t > before.n) await a.call('Timeline', timeline, 'DeleteTrack', 'subtitle', t);
    }
    const after = await snapshotSubtitles(a, timeline);
    if (newItems(after).length || after.n !== before.n) warnings.push('Resolve\'s generated subtitle track could not be fully removed; delete it from the timeline if you do not need it.');
    else warnings.push('Resolve\'s generated subtitle track was removed again.');
  } else {
    warnings.push(`Resolve's subtitle track was kept (subtitle track ${added[0].track}).`);
  }
  const segments = added.map((x, i) => ({ id: String(i + 1), start: ctx.fromTimelineFrame(x.start), end: ctx.fromTimelineFrame(x.end), text: texts[i] }));
  return { words: estimateWordTimings(segments), warnings, lines: segments.length };
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
  const snapshot = () => snapshotSubtitles(a, timeline);
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

/**
 * Remove exactly the caption items one placement added (matched by unique id
 * on any video track), then the track it created if that is now empty.
 */
async function removePlaced(a, placement) {
  const { timeline } = await a.currentTimeline();
  const tlId = await a.call('Timeline', timeline, 'GetUniqueId').catch(() => null);
  if (placement.timelineId && tlId && placement.timelineId !== tlId) {
    throw new SuiteError(`These captions were placed on "${placement.timelineName}". Open that timeline first.`, 'invalid-input');
  }
  const ids = new Set(placement.itemIds);
  const find = async () => {
    const n = (await a.call('Timeline', timeline, 'GetTrackCount', 'video')) || 0;
    const found = [];
    for (let i = 1; i <= n; i++) for (const it of await trackItems(a, timeline, 'video', i)) if (ids.has(it.id)) found.push({ ...it, track: i });
    return found;
  };
  const ours = await find();
  if (!ours.length) return { removed: 0, trackRemoved: false, summary: 'Those captions are no longer on the timeline.' };
  await a.call('Timeline', timeline, 'DeleteClips', ours.map((x) => x.ref), false);
  const remaining = await find();
  let trackRemoved = false;
  const track = ours[0].track;
  if (!remaining.length && !listOf(await a.call('Timeline', timeline, 'GetItemListInTrack', 'video', track)).length) {
    trackRemoved = Boolean(await a.call('Timeline', timeline, 'DeleteTrack', 'video', track));
  }
  return {
    removed: ours.length - remaining.length,
    remaining: remaining.length,
    trackRemoved,
    summary: remaining.length ? `${ours.length - remaining.length} caption(s) removed; ${remaining.length} could not be removed.` : `${ours.length} caption(s) removed${trackRemoved ? ` and track V${track} deleted` : ''}.`,
  };
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
/**
 * Fallback that needs no access to individual Fusion nodes: export the placed
 * item's composition (Resolve writes the file), replace the words in it,
 * import it back as a new composition, make it active, and verify by exporting
 * again. Uses only documented TimelineItem methods (21.0 README).
 */
async function setTextViaCompFile(a, item, text, dir) {
  const workDir = path.join(dir, 'comps');
  fs.mkdirSync(workDir, { recursive: true });
  const base = path.join(workDir, `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
  const files = [`${base}-orig.comp`, `${base}.comp`, `${base}-check.comp`];
  try {
    const exported = await a.call('TimelineItem', item, 'ExportFusionComp', files[0], 1);
    if (!exported || !fs.existsSync(files[0])) return { ok: false, reason: 'Resolve could not export the preset\'s composition (ExportFusionComp).' };
    const patched = patchCompText(fs.readFileSync(files[0], 'utf8'), text);
    if (!patched.ok) return { ok: false, reason: patched.reason };
    fs.writeFileSync(files[1], patched.lua);
    const before = listOf(await a.call('TimelineItem', item, 'GetFusionCompNameList'));
    const imported = await a.call('TimelineItem', item, 'ImportFusionComp', files[1]);
    if (!imported) return { ok: false, reason: 'Resolve did not accept the edited composition (ImportFusionComp).' };
    const after = listOf(await a.call('TimelineItem', item, 'GetFusionCompNameList'));
    const newName = after.find((n) => !before.includes(n)) || after[after.length - 1];
    if (!(await a.call('TimelineItem', item, 'LoadFusionCompByName', newName))) return { ok: false, reason: `Resolve imported the edited composition but did not make "${newName}" active.` };
    await a.call('TimelineItem', item, 'ExportFusionComp', files[2], after.indexOf(newName) + 1);
    const readBack = fs.existsSync(files[2]) ? readCompText(fs.readFileSync(files[2], 'utf8')) : null;
    const debug = { path: 'comp-file', target: patched.target, readBack };
    return readBack === text ? { ok: true, via: 'comp-file', debug } : { ok: false, reason: `After loading the edited composition, Resolve's copy reads "${readBack}".`, debug };
  } finally {
    for (const f of files) fs.rmSync(f, { force: true });
  }
}

async function setCaptionText(a, item, text, hint = null, opts = {}) {
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
    // Observed on 21.0.0b20: follower modifiers are not reachable through the API.
    if (opts.dir) return setTextViaCompFile(a, item, text, opts.dir);
    return { ok: false, reason: 'This is an animated (follower) preset, but its animation node could not be reached through the API, so its words were not changed.' };
  }
  if (followers.length) {
    for (const f of followers) await a.call('Tool', f, 'SetInput', 'Text', text);
    const back = [];
    for (const f of followers) back.push(textOf(await a.call('Tool', f, 'GetInput', 'Text')));
    const debug = { path: 'follower', textTools: textTools.length, followers: followers.length, readBack: back[0] };
    if (!back.every((b) => b === text) && opts.dir) return setTextViaCompFile(a, item, text, opts.dir);
    return back.every((b) => b === text) ? { ok: true, via: 'follower', debug } : { ok: false, reason: `Animated text read back as "${back.find((b) => b !== text)}" after setting it.`, debug };
  }
  const tool = textTools[0];
  await a.call('Tool', tool, 'SetInput', 'StyledText', text);
  const back = textOf(await a.call('Tool', tool, 'GetInput', 'StyledText'));
  const debug = { path: 'text+', textTools: textTools.length, followers: 0, readBack: back };
  if (back !== text && opts.dir) return setTextViaCompFile(a, item, text, opts.dir);
  return back === text ? { ok: true, via: 'text+', debug } : { ok: false, reason: `Text read back as "${back}" after setting it (its text may be driven by another node).`, debug };
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
  task.progress(2, 'Preparing');
  const backup = await maybeBackup(a, deps, project, timeline);
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
      textResults.push({ id: chunk[j].cue.id, ...(await setCaptionText(a, item, chunk[j].cue.text, hints.get(chunk[j].info.mediaPoolItem), { dir: deps.storage.outDir })) });
    }
  }
  task.progress(90, 'Verifying');
  const placed = await trackItems(a, timeline, 'video', trackIndex);
  const verify = verifyCuePlacement(infos.map((x) => x.cue), placed, 1);
  const textFailures = textResults.filter((r) => !r.ok);
  const placement = {
    timelineId: await a.call('Timeline', timeline, 'GetUniqueId').catch(() => null),
    timelineName: await a.call('Timeline', timeline, 'GetName'),
    trackIndex,
    itemIds: placed.map((x) => x.id).filter(Boolean),
  };
  const first = textResults[0];
  return {
    backup, trackIndex, skipped, verify, textFailures, placement,
    textDebug: first ? { ok: first.ok, via: first.via || null, ...(first.debug || {}) } : null,
    summary: `${placed.length}/${infos.length} caption(s) on V${trackIndex}; ${verify.ok ? 'placement verified' : 'placement differences found'}; ${textFailures.length ? textFailures.length + ' text update(s) failed' : 'all text verified'}.`,
  };
}

module.exports = { prepare, srtFromPreview, applySubtitleTrack, placeSrtVerified, removePlaced, snapshotSubtitles, audioWords, applyStyled, transcribeTrack, verifyCuePlacement, loadFileWords };
