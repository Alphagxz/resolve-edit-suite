'use strict';
/**
 * SRT / WebVTT parsing and writing, plus a loader for Resolve 21.1
 * MediaPoolItem.GetTranscription() payloads.
 *
 * Cue model (suite-wide):
 *   { id, start, end, text, words?: [{ text, start, end, emphasis? }] }
 * where start/end are flicks relative to the media/timeline origin and `end`
 * is exclusive.
 */
const tb = require('./timebase');
const tc = require('./timecode');

class SubtitleParseError extends Error {
  constructor(message, line) {
    super(line ? `${message} (line ${line})` : message);
    this.name = 'SubtitleParseError';
    this.code = 'SUBTITLE_PARSE';
    this.line = line;
  }
}

const SRT_TIME = /(\d{1,3}):(\d{2}):(\d{2})[,.](\d{1,3})/;
const VTT_TIME = /(?:(\d{1,3}):)?(\d{2}):(\d{2})\.(\d{3})/;

function clockToFlicks(h, m, s, msText) {
  const ms = Number(msText.padEnd(3, '0'));
  if (Number(m) > 59 || Number(s) > 59) throw new SubtitleParseError(`Invalid time ${h}:${m}:${s}`);
  return tb.msToFlicks(((Number(h) * 60 + Number(m)) * 60 + Number(s)) * 1000 + ms);
}

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function splitBlocks(text) {
  return stripBom(text).replace(/\r\n?/g, '\n').split(/\n{2,}/).map((b) => b.replace(/^\n+|\n+$/g, '')).filter(Boolean);
}

function parseSrt(text) {
  const cues = [];
  const warnings = [];
  const lines = stripBom(text).replace(/\r\n?/g, '\n').split('\n');
  let i = 0;
  while (i < lines.length) {
    while (i < lines.length && lines[i].trim() === '') i++;
    if (i >= lines.length) break;
    const blockStart = i + 1;
    let timingLine = lines[i];
    let id = null;
    if (!timingLine.includes('-->')) {
      id = timingLine.trim();
      i++;
      timingLine = lines[i] ?? '';
    }
    const parts = timingLine.split('-->');
    if (parts.length !== 2) throw new SubtitleParseError('Expected "start --> end" timing line', i + 1);
    const a = SRT_TIME.exec(parts[0]);
    const b = SRT_TIME.exec(parts[1]);
    if (!a || !b) throw new SubtitleParseError(`Invalid SRT timing "${timingLine.trim()}"`, i + 1);
    i++;
    const textLines = [];
    while (i < lines.length && lines[i].trim() !== '') textLines.push(lines[i++]);
    const start = clockToFlicks(a[1], a[2], a[3], a[4]);
    const end = clockToFlicks(b[1], b[2], b[3], b[4]);
    if (end <= start) warnings.push(`Cue at line ${blockStart} has non-positive duration`);
    cues.push({ id: id || String(cues.length + 1), start, end, text: textLines.join('\n') });
  }
  return { cues, warnings, format: 'srt' };
}

function parseVtt(text) {
  const blocks = splitBlocks(text);
  if (!blocks.length || !/^WEBVTT(\s|$)/.test(blocks[0])) throw new SubtitleParseError('Missing WEBVTT header', 1);
  const cues = [];
  const warnings = [];
  for (const block of blocks.slice(1)) {
    if (/^(NOTE|STYLE|REGION)(\s|$)/.test(block)) continue;
    const lines = block.split('\n');
    let idx = 0;
    let id = null;
    if (!lines[0].includes('-->')) {
      id = lines[0].trim();
      idx = 1;
    }
    const timing = lines[idx] || '';
    const [left, right = ''] = timing.split('-->');
    const a = VTT_TIME.exec(left);
    const b = VTT_TIME.exec(right);
    if (!a || !b) throw new SubtitleParseError(`Invalid WebVTT timing "${timing.trim()}"`);
    const start = clockToFlicks(a[1] || '0', a[2], a[3], a[4]);
    const end = clockToFlicks(b[1] || '0', b[2], b[3], b[4]);
    if (end <= start) warnings.push(`Cue "${id || cues.length + 1}" has non-positive duration`);
    const body = lines.slice(idx + 1).join('\n').replace(/<[^>]+>/g, '');
    cues.push({ id: id || String(cues.length + 1), start, end, text: body });
  }
  return { cues, warnings, format: 'vtt' };
}

/**
 * msRounding 'ceil' is used for frame-aligned cues: a frame boundary written
 * 0-1 ms late lands on the same frame whether the reader rounds or floors,
 * whereas a nearest-ms value can fall just before the boundary and floor to
 * the previous frame (e.g. 29.97 fps frame 1 = 33.37 ms).
 */
function formatClock(flicks, sep, msRounding = 'round') {
  if (flicks < 0) throw new SubtitleParseError('Cannot write a negative subtitle time');
  const totalMs = msRounding === 'ceil' ? Math.ceil(tb.flicksToMs(flicks) - 1e-9) : Math.round(tb.flicksToMs(flicks));
  const ms = totalMs % 1000;
  const s = Math.floor(totalMs / 1000) % 60;
  const m = Math.floor(totalMs / 60000) % 60;
  const h = Math.floor(totalMs / 3600000);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(h)}:${p(m)}:${p(s)}${sep}${p(ms, 3)}`;
}

function writeSrt(cues, { msRounding = 'round' } = {}) {
  return cues
    .map((c, i) => `${i + 1}\n${formatClock(c.start, ',', msRounding)} --> ${formatClock(c.end, ',', msRounding)}\n${c.text}\n`)
    .join('\n');
}

function writeVtt(cues) {
  return 'WEBVTT\n\n' + cues.map((c) => `${formatClock(c.start, '.')} --> ${formatClock(c.end, '.')}\n${c.text}\n`).join('\n');
}

function parseSubtitleFile(name, text) {
  const lower = String(name).toLowerCase();
  if (lower.endsWith('.vtt') || /^﻿?WEBVTT/.test(text)) return parseVtt(text);
  if (lower.endsWith('.srt') || /-->/.test(text)) return parseSrt(text);
  throw new SubtitleParseError(`Unrecognised subtitle format for "${name}" (supported: .srt, .vtt, Resolve transcription JSON)`);
}

/**
 * Parse a time from a Resolve 21.1 GetTranscription payload. The third-party
 * evidence says these are "timecode strings rather than frame numbers"; the
 * exact shape on your build is captured by tools/discover.py. Accepted:
 *   HH:MM:SS:FF / HH:MM:SS;FF  (frames at the clip's rate)
 *   HH:MM:SS.mmm / HH:MM:SS,mmm (milliseconds)
 *   plain number (seconds)
 * Times are returned relative to `originFrames` (the clip's start timecode
 * as frames) when given.
 */
function transcriptTimeToFlicks(value, rate, originFrames = 0) {
  if (typeof value === 'number') return tb.secondsToFlicks(value);
  const s = String(value).trim();
  const ms = /^(\d{1,3}):(\d{2}):(\d{2})[.,](\d{3})$/.exec(s);
  if (ms) return clockToFlicks(ms[1], ms[2], ms[3], ms[4]) - (originFrames ? tb.framesToFlicks(originFrames, rate) : 0);
  if (/^\d+(\.\d+)?$/.test(s)) return tb.secondsToFlicks(Number(s));
  if (!rate) throw new SubtitleParseError(`Timecode "${s}" needs the clip frame rate to convert`);
  const frames = tc.timecodeToFrames(s, rate);
  return tb.framesToFlicks(frames - originFrames, rate);
}

/**
 * Convert a GetTranscription() dict into word-timed segments.
 * Shape (per third-party 21.1.0.14 evidence, to be confirmed by discovery):
 *   { language, segments: [{ start, end, text, speaker, words: [{ start, end, text }] }] }
 */
function fromResolveTranscription(payload, rate, originFrames = 0) {
  if (!payload || !Array.isArray(payload.segments)) {
    throw new SubtitleParseError('Transcription payload has no "segments" array — Resolve may not have finished transcribing, or this build returns a different shape (run Diagnostics).');
  }
  const conv = (v) => transcriptTimeToFlicks(v, rate, originFrames);
  return {
    language: payload.language || null,
    segments: payload.segments.map((seg, i) => ({
      id: String(i + 1),
      start: conv(seg.start),
      end: conv(seg.end),
      text: String(seg.text || '').trim(),
      speaker: seg.speaker ?? null,
      words: Array.isArray(seg.words)
        ? seg.words.map((w) => ({ text: String(w.text).trim(), start: conv(w.start), end: conv(w.end) })).filter((w) => w.text)
        : null,
    })),
  };
}

module.exports = {
  SubtitleParseError,
  parseSrt,
  parseVtt,
  writeSrt,
  writeVtt,
  parseSubtitleFile,
  formatClock,
  transcriptTimeToFlicks,
  fromResolveTranscription,
};
