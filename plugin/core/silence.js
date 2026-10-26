'use strict';
/**
 * Silence / pause detection and cut proposals.
 *
 * Proposals are data only. Nothing here touches a timeline; the plugin shows
 * them for review and builds a NEW timeline from the approved keep ranges.
 */
const tb = require('./timebase');
const { windowStart } = require('./audio');

const DEFAULTS = Object.freeze({
  thresholdDb: 'auto', // number (dBFS) or 'auto' (noise floor + autoMarginDb)
  autoMarginDb: 10,
  minSilenceMs: 500, // shorter pauses are treated as intentional and kept
  paddingMs: 120, // speech protected on each side of a cut
  keepPauseMs: 0, // leave this much of each removed pause in place (natural rhythm)
});

function percentile(values, p) {
  const arr = Array.from(values).sort((a, b) => a - b);
  if (!arr.length) return -120;
  return arr[Math.min(arr.length - 1, Math.max(0, Math.floor(p * (arr.length - 1))))];
}

function resolveThreshold(env, o) {
  if (typeof o.thresholdDb === 'number') {
    if (o.thresholdDb > 0 || o.thresholdDb < -100) throw new RangeError('thresholdDb must be between -100 and 0 dBFS');
    return { threshold: o.thresholdDb, noiseFloor: null };
  }
  const noiseFloor = percentile(env.db.filter((d) => d > -119), 0.1);
  const threshold = Math.min(-25, Math.max(-60, noiseFloor + o.autoMarginDb));
  return { threshold, noiseFloor };
}

/** Raw silent regions [{start, end}] in flicks from the envelope origin. */
function findSilences(env, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const { threshold, noiseFloor } = resolveThreshold(env, o);
  const minSil = tb.msToFlicks(o.minSilenceMs);
  const out = [];
  let runStart = -1;
  for (let i = 0; i <= env.db.length; i++) {
    const silent = i < env.db.length && env.db[i] < threshold;
    if (silent && runStart < 0) runStart = i;
    if (!silent && runStart >= 0) {
      const start = windowStart(env, runStart);
      const end = i < env.db.length ? windowStart(env, i) : env.durationFlicks;
      if (end - start >= minSil) out.push({ start, end });
      runStart = -1;
    }
  }
  return { silences: out, threshold, noiseFloor };
}

function subtractRanges(range, blockers) {
  let pieces = [range];
  for (const b of blockers) {
    const next = [];
    for (const p of pieces) {
      if (b.end <= p.start || b.start >= p.end) next.push(p);
      else {
        if (b.start > p.start) next.push({ ...p, end: b.start });
        if (b.end < p.end) next.push({ ...p, start: b.end });
      }
    }
    pieces = next;
  }
  return pieces;
}

/**
 * Turn silences into cut proposals.
 * @param {Array<{start,end}>} silences
 * @param {object} opts  DEFAULTS + { protectedRanges: [{start,end,label}], totalFlicks }
 */
function proposeCuts(silences, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const pad = tb.msToFlicks(o.paddingMs);
  const keepPause = tb.msToFlicks(o.keepPauseMs);
  const minSil = tb.msToFlicks(o.minSilenceMs);
  const protectedRanges = (o.protectedRanges || []).slice().sort((a, b) => a.start - b.start);
  const cuts = [];
  for (const s of silences) {
    const atStart = s.start <= 0;
    const atEnd = o.totalFlicks !== undefined && s.end >= o.totalFlicks;
    // Pad into the silence so word onsets/tails are never clipped; split the
    // retained pause evenly before and after the cut.
    const half = Math.floor(keepPause / 2);
    const start = atStart ? s.start : s.start + pad + half;
    const end = atEnd ? s.end : s.end - pad - (keepPause - half);
    if (end - start <= 0) continue;
    for (const piece of subtractRanges({ start, end, reason: 'silence' }, protectedRanges)) {
      if (piece.end - piece.start >= Math.min(minSil, tb.msToFlicks(100))) {
        cuts.push({ ...piece, sourceSilence: { start: s.start, end: s.end } });
      }
    }
  }
  return cuts;
}

/** Complement of cuts within [0, total). */
function keepRangesFromCuts(cuts, totalFlicks) {
  const sorted = cuts.slice().sort((a, b) => a.start - b.start);
  const keep = [];
  let t = 0;
  for (const c of sorted) {
    if (c.start > t) keep.push({ start: t, end: Math.min(c.start, totalFlicks) });
    t = Math.max(t, c.end);
  }
  if (t < totalFlicks) keep.push({ start: t, end: totalFlicks });
  return keep.filter((k) => k.end > k.start);
}

module.exports = { DEFAULTS, findSilences, proposeCuts, keepRangesFromCuts, subtractRanges, percentile };
