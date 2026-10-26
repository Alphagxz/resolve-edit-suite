'use strict';
/**
 * Caption segmentation: word-timed transcript -> readable caption cues.
 *
 * Input words: [{ text, start, end, speaker? }] (flicks). When only
 * segment-level timing exists (SRT import), estimateWordTimings() spreads the
 * segment duration over its words by character weight and flags the result
 * as estimated so the UI can say so.
 */
const tb = require('./timebase');

const DEFAULTS = Object.freeze({
  maxCharsPerLine: 32,
  maxLines: 2,
  maxWordsPerCue: 0, // 0 = no limit; 1-3 gives "word pop" captions
  maxDurationMs: 6000,
  minDurationMs: 700,
  maxGapMs: 600, // a pause longer than this starts a new cue
  lingerMs: 250, // hold after the last word if there is room
  maxCps: 20, // reading speed warning threshold (characters/second)
  breakOnSentence: true,
  keepSourceBreaks: true, // never merge words across entries of an imported subtitle file
  breakOnSpeaker: true,
  caseMode: 'as-is', // 'as-is' | 'upper' | 'lower'
  stripPunctuation: false,
  emphasis: { words: [], numbers: false, allCaps: false, longestPerCue: false },
});

const FUNCTION_WORDS = new Set(
  'a an the of to in on at for and or but nor with by from as is are was were be it its this that these those my your our their his her i you we they he she'.split(' ')
);

function normaliseOptions(opts = {}) {
  const o = { ...DEFAULTS, ...opts, emphasis: { ...DEFAULTS.emphasis, ...(opts.emphasis || {}) } };
  const intOpt = (k, min, max) => {
    if (!Number.isInteger(o[k]) || o[k] < min || o[k] > max) throw new RangeError(`${k} must be an integer between ${min} and ${max}`);
  };
  intOpt('maxCharsPerLine', 8, 80);
  intOpt('maxLines', 1, 4);
  intOpt('maxWordsPerCue', 0, 50);
  for (const k of ['maxDurationMs', 'minDurationMs', 'maxGapMs', 'lingerMs', 'maxCps']) {
    if (!Number.isFinite(o[k]) || o[k] < 0) throw new RangeError(`${k} must be a non-negative number`);
  }
  if (o.minDurationMs > o.maxDurationMs) throw new RangeError('minDurationMs cannot exceed maxDurationMs');
  return o;
}

function displayText(word, o) {
  let t = word.text;
  if (o.stripPunctuation) t = t.replace(/[.,!?;:"“”]+/g, '');
  if (o.caseMode === 'upper') t = t.toUpperCase();
  else if (o.caseMode === 'lower') t = t.toLowerCase();
  return t;
}

/**
 * Break a list of word strings into at most maxLines lines of at most
 * maxChars characters, choosing the most balanced split with linguistic
 * penalties. Returns null if the words cannot fit.
 */
function breakLines(words, maxChars, maxLines) {
  const n = words.length;
  if (!n) return [];
  const lineLen = (i, j) => words.slice(i, j).join(' ').length;
  // Dynamic programming over break positions; cost = squared slack + penalties.
  const memo = new Map();
  function best(i, linesLeft) {
    if (i === n) return { cost: 0, breaks: [] };
    if (linesLeft === 0) return null;
    const key = i * 8 + linesLeft;
    if (memo.has(key)) return memo.get(key);
    let result = null;
    for (let j = i + 1; j <= n; j++) {
      const len = lineLen(i, j);
      if (len > maxChars) break;
      const rest = best(j, linesLeft - 1);
      if (!rest) continue;
      let cost = (maxChars - len) ** 2;
      if (j < n) {
        const last = words[j - 1].toLowerCase().replace(/[^a-z']/g, '');
        if (FUNCTION_WORDS.has(last)) cost += 60; // avoid dangling "the", "and"...
        if (/[,;:]$/.test(words[j - 1])) cost -= 40; // prefer breaking after commas
        if (/[.!?]$/.test(words[j - 1])) cost -= 60;
      }
      cost += rest.cost;
      if (!result || cost < result.cost) result = { cost, breaks: [j, ...rest.breaks] };
    }
    memo.set(key, result);
    return result;
  }
  // Prefer fewer lines only when that does not hurt balance much: evaluate
  // 1..maxLines and pick the lowest cost, where a single line that fits is free.
  if (lineLen(0, n) <= maxChars) return [words.join(' ')];
  const r = best(0, maxLines);
  if (!r) return null;
  const lines = [];
  let i = 0;
  for (const j of r.breaks) {
    lines.push(words.slice(i, j).join(' '));
    i = j;
  }
  return lines;
}

function markEmphasis(cueWords, o) {
  const list = new Set((o.emphasis.words || []).map((w) => String(w).toLowerCase()));
  let longest = null;
  for (const w of cueWords) {
    const bare = w.text.replace(/[^\p{L}\p{N}'%$]/gu, '');
    const low = bare.toLowerCase();
    w.emphasis = Boolean(
      (list.size && list.has(low)) ||
        (o.emphasis.numbers && /\d/.test(bare)) ||
        (o.emphasis.allCaps && bare.length > 1 && bare === bare.toUpperCase() && /\p{L}/u.test(bare))
    );
    if (o.emphasis.longestPerCue && !FUNCTION_WORDS.has(low) && (!longest || bare.length > longest.len)) longest = { w, len: bare.length };
  }
  if (longest) longest.w.emphasis = true;
}

/**
 * Words -> cues. Returns { cues, warnings }.
 * Times stay in flicks; frame quantisation happens in cues.finalizeCues()
 * once the target timeline is known.
 */
function segmentWords(inputWords, options) {
  const o = normaliseOptions(options);
  const words = inputWords
    .filter((w) => w && String(w.text || '').trim())
    .map((w) => ({ ...w, text: String(w.text).trim() }))
    .sort((a, b) => a.start - b.start);
  const maxDur = tb.msToFlicks(o.maxDurationMs);
  const maxGap = tb.msToFlicks(o.maxGapMs);
  const cues = [];
  const warnings = [];
  let current = [];

  const flush = () => {
    if (!current.length) return;
    const shown = current.map((w) => displayText(w, o));
    const lines = breakLines(shown, o.maxCharsPerLine, o.maxLines) || [shown.join(' ')];
    const cueWords = current.map((w, i) => ({ text: shown[i], start: w.start, end: w.end }));
    markEmphasis(cueWords, o);
    cues.push({
      id: String(cues.length + 1),
      start: current[0].start,
      end: current[current.length - 1].end,
      text: lines.join('\n'),
      lines,
      words: cueWords,
      speaker: current[0].speaker ?? null,
      estimated: current.some((w) => w.estimated),
    });
    current = [];
  };

  for (const w of words) {
    if (w.end < w.start) {
      warnings.push(`Word "${w.text}" ends before it starts; skipped.`);
      continue;
    }
    if (current.length) {
      const prev = current[current.length - 1];
      const tentative = [...current, w].map((x) => displayText(x, o));
      const fits = breakLines(tentative, o.maxCharsPerLine, o.maxLines) !== null;
      const tooLong = w.end - current[0].start > maxDur;
      const gap = w.start - prev.end > maxGap;
      const sentence = o.breakOnSentence && /[.!?]["”']?$/.test(prev.text);
      const sourceBreak = o.keepSourceBreaks && prev.cueEnd === true;
      const speaker = o.breakOnSpeaker && (w.speaker ?? null) !== (prev.speaker ?? null);
      const wordCap = o.maxWordsPerCue > 0 && current.length >= o.maxWordsPerCue;
      if (!fits || tooLong || gap || sentence || sourceBreak || speaker || wordCap) flush();
    }
    if (displayText(w, o).length > o.maxCharsPerLine) {
      warnings.push(`Word "${w.text}" is longer than ${o.maxCharsPerLine} characters and will overflow its line.`);
    }
    current.push(w);
  }
  flush();

  // Linger and minimum duration, bounded by the next cue.
  const linger = tb.msToFlicks(o.lingerMs);
  const minDur = tb.msToFlicks(o.minDurationMs);
  for (let i = 0; i < cues.length; i++) {
    const c = cues[i];
    const limit = i + 1 < cues.length ? cues[i + 1].start : Infinity;
    const target = Math.max(c.end + linger, c.start + minDur);
    c.end = Math.min(Math.max(c.end, target), limit);
    const seconds = tb.flicksToSeconds(c.end - c.start);
    const cps = seconds > 0 ? c.text.replace(/\n/g, '').length / seconds : Infinity;
    if (cps > o.maxCps) warnings.push(`Cue ${c.id} reads at ${cps.toFixed(1)} chars/s (limit ${o.maxCps}).`);
  }
  return { cues, warnings };
}

/** Spread segment time over words by character weight (marked estimated). */
function estimateWordTimings(segments) {
  const out = [];
  for (const seg of segments) {
    if (Array.isArray(seg.words) && seg.words.length) {
      out.push(...seg.words.map((w) => ({ ...w, speaker: seg.speaker ?? null })));
      continue;
    }
    const tokens = String(seg.text || '').split(/\s+/).filter(Boolean);
    const total = tokens.reduce((s, t) => s + t.length + 1, 0);
    const span = seg.end - seg.start;
    let acc = 0;
    tokens.forEach((t, i) => {
      const s = seg.start + Math.round((span * acc) / total);
      acc += t.length + 1;
      const e = seg.start + Math.round((span * acc) / total);
      out.push({ text: t, start: s, end: e, speaker: seg.speaker ?? null, estimated: true, cueEnd: i === tokens.length - 1 });
    });
  }
  return out;
}

module.exports = { DEFAULTS, normaliseOptions, breakLines, segmentWords, estimateWordTimings };
