'use strict';
/**
 * Rough Cut: analyse -> review (proposals, optional markers) -> build a NEW
 * timeline from the approved keep ranges. The source timeline is never edited
 * (review markers are the only optional write, and they can be cleared).
 */
const tb = require('../core/timebase');
const silence = require('../core/silence');
const { planRoughCut, verifyPlacement } = require('../core/roughcut');
const { SuiteError } = require('../resolve/adapter');
const { timelineContext, trackItems, clipProperty, mediaRate, listOf } = require('./resolve-reads');
const { envelopeForRange } = require('../services/media-audio');
const { stamp } = require('./backup');

const MARKER_TAG = 'edit-suite:roughcut';

async function protectedFromMarkers(a, timeline, ctx, color) {
  if (!color) return [];
  const markers = (await a.call('Timeline', timeline, 'GetMarkers')) || {};
  const out = [];
  for (const [frame, m] of Object.entries(markers)) {
    if (m.color !== color) continue;
    const f = Number(frame); // marker frames are relative to the timeline start
    out.push({ start: tb.framesToFlicks(f, ctx.rate), end: tb.framesToFlicks(f + Math.max(1, Number(m.duration) || 1), ctx.rate), label: m.name || 'marker' });
  }
  return out;
}

async function analyse(a, deps, req, task) {
  const { timeline } = await a.currentTimeline();
  const ctx = await timelineContext(a, timeline, deps.calibration());
  const track = req.track || { type: 'audio', index: 1 };
  const items = await trackItems(a, timeline, track.type, track.index);
  if (!items.length) throw new SuiteError(`${track.type} track ${track.index} is empty.`, 'invalid-input');
  const settings = deps.storage.loadSettings();
  const opts = { ...silence.DEFAULTS, ...(req.options || {}) };
  const silences = [];
  const perItem = [];
  for (let i = 0; i < items.length; i++) {
    task.checkpoint();
    const it = items[i];
    task.progress((i / items.length) * 90, `Analysing "${it.name}" (${i + 1}/${items.length})`);
    const mpi = await a.call('TimelineItem', it.ref, 'GetMediaPoolItem');
    if (!mpi) { perItem.push({ name: it.name, skipped: 'no media' }); continue; }
    const rate = await mediaRate(a, mpi);
    const file = await clipProperty(a, mpi, 'File Path');
    if (!rate) { perItem.push({ name: it.name, skipped: 'unknown source frame rate' }); continue; }
    const startSec = (it.leftOffset || 0) * rate.den / rate.num;
    const durSec = (it.end - it.start) * ctx.rate.den / ctx.rate.num;
    const env = await envelopeForRange({ file, startSec, durSec, ffmpegPath: settings.ffmpegPath, task });
    const found = silence.findSilences(env, opts);
    const recStart = ctx.fromTimelineFrame(it.start);
    for (const s of found.silences) silences.push({ start: recStart + s.start, end: Math.min(recStart + s.end, ctx.fromTimelineFrame(it.end)) });
    perItem.push({ name: it.name, threshold: +found.threshold.toFixed(1), noiseFloor: found.noiseFloor === null ? null : +found.noiseFloor.toFixed(1), silences: found.silences.length });
  }
  // Merge silences that touch across item boundaries.
  silences.sort((x, y) => x.start - y.start);
  const merged = [];
  for (const s of silences) {
    const last = merged[merged.length - 1];
    if (last && s.start <= last.end) last.end = Math.max(last.end, s.end);
    else merged.push({ ...s });
  }
  const protectedRanges = await protectedFromMarkers(a, timeline, ctx, opts.protectMarkerColor);
  const cuts = silence.proposeCuts(merged, { ...opts, protectedRanges, totalFlicks: ctx.durationFlicks });
  return {
    track,
    perItem,
    cuts: cuts.map((c, i) => ({
      id: i + 1, start: c.start, end: c.end, enabled: true,
      startTc: ctx.timecodeAt(ctx.toTimelineFrame(c.start)), endTc: ctx.timecodeAt(ctx.toTimelineFrame(c.end)),
      seconds: +tb.flicksToSeconds(c.end - c.start).toFixed(2),
    })),
    protectedCount: protectedRanges.length,
    totalSeconds: +tb.flicksToSeconds(ctx.durationFlicks).toFixed(2),
    removedSeconds: +tb.flicksToSeconds(cuts.reduce((s, c) => s + c.end - c.start, 0)).toFixed(2),
  };
}

async function addReviewMarkers(a, deps, req) {
  const { timeline } = await a.currentTimeline();
  const ctx = await timelineContext(a, timeline, deps.calibration());
  const tag = `${MARKER_TAG}:${req.runId}`;
  let added = 0;
  const failed = [];
  for (const c of req.cuts.filter((x) => x.enabled)) {
    const f = ctx.markerFrame(c.start);
    const dur = Math.max(1, ctx.markerFrame(c.end) - f);
    const ok = await a.call('Timeline', timeline, 'AddMarker', f, 'Red', `Proposed cut ${c.id}`, `${c.seconds}s silence (Edit Suite rough cut)`, dur, tag);
    if (ok) added++; else failed.push(c.id);
  }
  return { added, failed, tag, summary: `${added} review marker(s) added${failed.length ? `; ${failed.length} could not be added (a marker may already exist at that frame)` : ''}.` };
}

async function clearReviewMarkers(a, deps, req) {
  const { timeline } = await a.currentTimeline();
  const ok = await a.call('Timeline', timeline, 'DeleteMarkerByCustomData', `${MARKER_TAG}:${req.runId}`);
  return { ok: Boolean(ok) };
}

async function build(a, deps, req, task) {
  const { pm, project, timeline } = await a.currentTimeline();
  const calib = deps.calibration();
  const ctx = await timelineContext(a, timeline, calib);
  const track = req.track;
  const items = await trackItems(a, timeline, track.type, track.index);
  const planItems = [];
  for (const it of items) {
    const mpi = await a.call('TimelineItem', it.ref, 'GetMediaPoolItem');
    planItems.push({
      id: it.name, name: it.name, recStart: it.start, recEnd: it.end, srcStart: it.leftOffset || 0,
      srcRate: mpi ? await mediaRate(a, mpi) : null, mediaRef: mpi,
      speed: await readSpeed(a, it.ref),
    });
  }
  // Other tracks. A track whose items are the same media at exactly the same
  // record ranges as the primary track is treated as its LINKED partner
  // (e.g. V1 picture for A1 dialogue) and rebuilt together with it.
  const sameMedia = async (x, y) => x === y || (x && y && (await a.call('MediaPoolItem', x, 'GetUniqueId')) === (await a.call('MediaPoolItem', y, 'GetUniqueId')));
  const others = [];
  let linkedTrack = null;
  const otherType = track.type === 'audio' ? 'video' : 'audio';
  for (const type of ['video', 'audio']) {
    const n = (await a.call('Timeline', timeline, 'GetTrackCount', type)) || 0;
    for (let i = 1; i <= n; i++) {
      if (type === track.type && i === track.index) continue;
      const list = [];
      for (const o of listOf(await a.call('Timeline', timeline, 'GetItemListInTrack', type, i))) {
        list.push({ track: `${type === 'video' ? 'V' : 'A'}${i}`, name: await a.call('TimelineItem', o, 'GetName'), recStart: await a.call('TimelineItem', o, 'GetStart'), recEnd: await a.call('TimelineItem', o, 'GetEnd'), mpi: await a.call('TimelineItem', o, 'GetMediaPoolItem') });
      }
      let linked = !linkedTrack && type === otherType && list.length === planItems.length && list.length > 0;
      for (let k = 0; linked && k < list.length; k++) {
        const pItem = planItems.slice().sort((x, y) => x.recStart - y.recStart)[k];
        const o = list.slice().sort((x, y) => x.recStart - y.recStart)[k];
        linked = o.recStart === pItem.recStart && o.recEnd === pItem.recEnd && (await sameMedia(o.mpi, pItem.mediaRef));
      }
      if (linked) linkedTrack = list[0].track;
      else others.push(...list);
    }
  }
  const cuts = req.cuts.filter((c) => c.enabled);
  const keep = silence.keepRangesFromCuts(cuts, ctx.durationFlicks);
  const plan = planRoughCut({ ctx, items: planItems, keep, otherTrackItems: others, endFrameInclusive: calib.appendEndInclusive !== false });
  if (linkedTrack) plan.warnings.unshift({ type: 'linked', message: `${linkedTrack} holds the linked ${otherType} of the same clips and is rebuilt together with ${track.type === 'video' ? 'V' : 'A'}${track.index}.` });
  else plan.warnings.unshift({ type: 'single', message: `Only ${track.type} is rebuilt: no track holds the matching linked ${otherType} at identical positions.` });
  if (planItems.some((p) => p.speed === null)) {
    plan.warnings.unshift({ type: 'speed-unknown', message: 'Clip speed cannot be read on this Resolve build (needs 21.1). Retimed clips would be rebuilt at 100% — check the result.' });
  }
  if (plan.blocked.length) throw new SuiteError(`Rough cut cannot be built safely: ${plan.blocked.map((b) => b.message).join(' ')}`, 'unsupported', { blocked: plan.blocked });
  if (req.dryRun) return { dryRun: true, plan: { summary: plan.summary, warnings: plan.warnings, pieces: plan.clipInfos.length, linkedTrack } };

  task.checkpoint();
  const mediaPool = await a.must('Project', project, 'GetMediaPool');
  const originalName = await a.call('Timeline', timeline, 'GetName');
  const name = `${originalName} - Rough Cut ${stamp()}`;
  const tl = await a.call('MediaPool', mediaPool, 'CreateEmptyTimeline', name);
  if (!tl) throw new SuiteError(`Could not create timeline "${name}".`, 'call-failed');
  await a.must('Project', project, 'SetCurrentTimeline', tl);
  const newCtx = await timelineContext(a, tl, calib);
  if (newCtx.rate.label !== ctx.rate.label || newCtx.width !== ctx.width || newCtx.height !== ctx.height) {
    await a.call('MediaPool', mediaPool, 'DeleteTimelines', [tl]);
    await a.call('Project', project, 'SetCurrentTimeline', timeline);
    throw new SuiteError(`New timelines in this project use ${newCtx.rate.label} fps ${newCtx.width}x${newCtx.height}, but "${originalName}" uses ${ctx.rate.label} fps ${ctx.width}x${ctx.height} (timeline-specific settings). The empty timeline was removed. Match the project settings to the timeline, or build the rough cut on a duplicate manually.`, 'unsupported');
  }
  // Rebase record frames onto the new timeline's start.
  const shift = newCtx.startFrame - ctx.startFrame;
  const infos = plan.clipInfos.map((c) => ({ ...c, recordFrame: c.recordFrame + shift }));
  // Linked partner found -> place picture and sound together (mediaType unset);
  // otherwise restrict placement to the analysed kind (1 = video, 2 = audio).
  const mediaTypeFor = linkedTrack ? undefined : track.type === 'audio' ? 2 : 1;
  const BATCH = 50;
  for (let i = 0; i < infos.length; i += BATCH) {
    task.checkpoint();
    task.progress(10 + (i / infos.length) * 70, `Placing ${i + 1}-${Math.min(i + BATCH, infos.length)} of ${infos.length}`);
    const chunk = infos.slice(i, i + BATCH).map((c) => {
      const o = { mediaPoolItem: c.mediaRef, startFrame: c.startFrame, endFrame: c.endFrame, recordFrame: c.recordFrame, trackIndex: 1 };
      if (mediaTypeFor) o.mediaType = mediaTypeFor;
      return o;
    });
    await a.call('MediaPool', mediaPool, 'AppendToTimeline', chunk);
  }
  task.progress(85, 'Verifying');
  const readBack = async (type) => (await trackItems(a, tl, type, 1)).map((x) => ({ start: x.start, end: x.end }));
  const verifyAll = async () => {
    const primary = verifyPlacement(infos, await readBack(track.type), calib.itemEndInclusive === true);
    if (!linkedTrack) return primary;
    const partner = verifyPlacement(infos, await readBack(otherType), calib.itemEndInclusive === true);
    return { ok: primary.ok && partner.ok, problems: [...primary.problems, ...partner.problems.map((p) => `Linked ${otherType}: ${p}`)] };
  };
  let verify = await verifyAll();
  let saved = null;
  if (req.saveAndReverify !== false) {
    saved = Boolean(await a.call('ProjectManager', pm, 'SaveProject'));
    // Third-party evidence: placements from an errored call can vanish on save.
    verify = await verifyAll();
  }
  return {
    timelineName: name,
    original: originalName,
    verify,
    saved,
    warnings: plan.warnings,
    summary: `${infos.length} piece(s) placed on "${name}"; removed ${tb.flicksToSeconds(tb.framesToFlicks(plan.summary.removedFrames, ctx.rate)).toFixed(1)}s; ${verify.ok ? 'continuity verified' : 'verification found problems'}.`,
  };
}

/**
 * Clip speed via the native 21.1 GetSpeed reader. On older builds speed is
 * not readable through the API; returns null so the plan can warn.
 */
async function readSpeed(a, item) {
  if (typeof item.GetSpeed !== 'function') return null;
  try {
    const s = await a.call('TimelineItem', item, 'GetSpeed');
    const n = Number(s && s.Percentage);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

module.exports = { analyse, addReviewMarkers, clearReviewMarkers, build, MARKER_TAG };
