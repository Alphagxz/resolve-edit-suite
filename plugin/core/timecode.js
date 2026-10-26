'use strict';
/**
 * SMPTE timecode <-> frame index, drop-frame (DF) and non-drop-frame (NDF).
 *
 * Timecode labels count frames at the NOMINAL integer rate (30 for 29.97,
 * 24 for 23.976). Drop-frame skips labels ;00 and ;01 (;00-;03 at 59.94) at
 * the start of every minute except multiples of ten, which keeps the label
 * within ~1 frame/day of wall-clock time. DF is only defined for 29.97 and
 * 59.94; requesting it for any other rate throws instead of guessing.
 */
const { TimebaseError } = require('./timebase');

function nominalFps(rate) {
  return Math.round(rate.num / rate.den);
}

function dropFramesPerMinute(rate) {
  if (rate.den !== 1001 || (rate.num !== 30000 && rate.num !== 60000)) return 0;
  return nominalFps(rate) / 15; // 2 at 29.97, 4 at 59.94
}

function supportsDropFrame(rate) {
  return dropFramesPerMinute(rate) > 0;
}

function assertDf(rate, dropFrame) {
  if (dropFrame && !supportsDropFrame(rate)) {
    throw new TimebaseError(`Drop-frame timecode is only defined for 29.97 and 59.94 fps, not ${rate.label || rate.num + '/' + rate.den}`, 'DF_UNSUPPORTED');
  }
}

/** Frame index (from 00:00:00:00) -> timecode string. */
function framesToTimecode(frames, rate, dropFrame = false) {
  if (!Number.isSafeInteger(frames)) throw new TimebaseError(`Frame index must be an integer, got ${frames}`, 'BAD_FRAME');
  assertDf(rate, dropFrame);
  const negative = frames < 0;
  let f = Math.abs(frames);
  const fps = nominalFps(rate);
  if (dropFrame) {
    const d = dropFramesPerMinute(rate);
    const per10 = fps * 600 - d * 9;
    const perMin = fps * 60 - d;
    const tens = Math.floor(f / per10);
    const rem = f % per10;
    f += d * 9 * tens + (rem > d ? d * Math.floor((rem - d) / perMin) : 0);
  }
  const ff = f % fps;
  const totalSeconds = Math.floor(f / fps);
  const ss = totalSeconds % 60;
  const mm = Math.floor(totalSeconds / 60) % 60;
  const hh = Math.floor(totalSeconds / 3600);
  const sep = dropFrame ? ';' : ':';
  const ffWidth = fps >= 100 ? 3 : 2;
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${negative ? '-' : ''}${p(hh)}:${p(mm)}:${p(ss)}${sep}${p(ff, ffWidth)}`;
}

const TC_RE = /^(-)?(\d{1,3}):(\d{2}):(\d{2})([:;.,])(\d{2,3})$/;

/**
 * Timecode string -> frame index. `dropFrame` defaults to whether the string
 * uses a ';' or ',' separator (the conventional DF marker).
 */
function timecodeToFrames(tc, rate, dropFrame) {
  const m = TC_RE.exec(String(tc).trim());
  if (!m) throw new TimebaseError(`Invalid timecode "${tc}"`, 'BAD_TIMECODE');
  const [, neg, H, M, S, sep, F] = m;
  const df = dropFrame === undefined ? sep === ';' || sep === ',' : dropFrame;
  assertDf(rate, df);
  const hh = Number(H), mm = Number(M), ss = Number(S), ff = Number(F);
  const fps = nominalFps(rate);
  if (mm > 59 || ss > 59 || ff >= fps) throw new TimebaseError(`Timecode "${tc}" is out of range at ${fps} fps`, 'BAD_TIMECODE');
  let frames = (hh * 3600 + mm * 60 + ss) * fps + ff;
  if (df) {
    const d = dropFramesPerMinute(rate);
    if (ss === 0 && ff < d && mm % 10 !== 0) {
      throw new TimebaseError(`Timecode "${tc}" does not exist in drop-frame (dropped label)`, 'BAD_TIMECODE');
    }
    const totalMinutes = hh * 60 + mm;
    frames -= d * (totalMinutes - Math.floor(totalMinutes / 10));
  }
  return neg ? -frames : frames;
}

module.exports = { nominalFps, dropFramesPerMinute, supportsDropFrame, framesToTimecode, timecodeToFrames };
