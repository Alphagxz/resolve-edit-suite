'use strict';
/**
 * Internal timebase.
 *
 * Every time value inside the suite is an integer number of FLICKS
 * (1 flick = 1/705,600,000 s). A frame at every supported rate is an exact
 * integer number of flicks, including the NTSC 1000/1001 rates:
 *
 *   23.976 (24000/1001) -> 29,429,400 flicks/frame
 *   29.97  (30000/1001) -> 23,543,520 flicks/frame
 *   59.94  (60000/1001) -> 11,771,760 flicks/frame
 *
 * so frame <-> time conversion is exact in both directions, and converting an
 * absolute time never depends on previous conversions (no cumulative drift).
 *
 * Frame rates are rationals {num, den}. Floating-point rates coming from
 * Resolve ("23.976", "29.97") are mapped to their exact rational through a
 * table, never by float arithmetic. Unknown rates are rejected.
 *
 * Multiplications go through BigInt because t * num exceeds 2^53 for long
 * timelines at high rates.
 */

const FLICKS_PER_SECOND = 705600000;

class TimebaseError extends Error {
  constructor(message, code = 'TIMEBASE') {
    super(message);
    this.name = 'TimebaseError';
    this.code = code;
  }
}

/** Exact rationals for every rate the suite claims to handle. */
const KNOWN_RATES = [
  { label: '23.976', num: 24000, den: 1001 },
  { label: '24', num: 24, den: 1 },
  { label: '25', num: 25, den: 1 },
  { label: '29.97', num: 30000, den: 1001 },
  { label: '30', num: 30, den: 1 },
  { label: '47.952', num: 48000, den: 1001 },
  { label: '48', num: 48, den: 1 },
  { label: '50', num: 50, den: 1 },
  { label: '59.94', num: 60000, den: 1001 },
  { label: '60', num: 60, den: 1 },
  { label: '95.904', num: 96000, den: 1001 },
  { label: '96', num: 96, den: 1 },
  { label: '100', num: 100, den: 1 },
  { label: '119.88', num: 120000, den: 1001 },
  { label: '120', num: 120, den: 1 },
];

/**
 * Parse a frame rate as reported by Resolve (number or string such as
 * "23.976", "29.97", "29.97 DF", "25") or a {num, den} object.
 * Tolerance is 0.0005 fps, enough to tell 23.976 from 24 but to accept
 * 23.98 / 23.9760 / 23.97602397 renderings of the same NTSC rate.
 */
function parseFrameRate(value) {
  if (value && typeof value === 'object' && Number.isInteger(value.num) && Number.isInteger(value.den)) {
    if (value.num <= 0 || value.den <= 0) throw new TimebaseError(`Invalid frame rate ${value.num}/${value.den}`, 'BAD_RATE');
    const known = KNOWN_RATES.find((r) => r.num * value.den === value.num * r.den);
    if (!known) throw new TimebaseError(`Unsupported frame rate ${value.num}/${value.den}`, 'UNSUPPORTED_RATE');
    return { num: known.num, den: known.den, label: known.label };
  }
  const text = String(value ?? '').trim().replace(/\s*(fps|DF|NDF)$/i, '').trim();
  const f = Number(text);
  if (!Number.isFinite(f) || f <= 0) throw new TimebaseError(`Cannot parse frame rate "${value}"`, 'BAD_RATE');
  let best = null;
  for (const r of KNOWN_RATES) {
    const diff = Math.abs(r.num / r.den - f);
    if (diff < 0.0005 && (!best || diff < best.diff)) best = { r, diff };
  }
  // 23.98 is a common rounded rendering of 23.976; accept it explicitly.
  if (!best && Math.abs(f - 23.98) < 1e-9) best = { r: KNOWN_RATES[0], diff: 0 };
  if (!best && Math.abs(f - 59.94) < 1e-9) best = { r: KNOWN_RATES[8], diff: 0 };
  if (!best) throw new TimebaseError(`Unsupported frame rate "${value}". Supported: ${KNOWN_RATES.map((r) => r.label).join(', ')}`, 'UNSUPPORTED_RATE');
  return { num: best.r.num, den: best.r.den, label: best.r.label };
}

function rateToFloat(rate) {
  return rate.num / rate.den;
}

function isNtsc(rate) {
  return rate.den === 1001;
}

/** Exact flicks per frame (always an integer for KNOWN_RATES). */
function flicksPerFrame(rate) {
  const n = FLICKS_PER_SECOND * rate.den;
  if (n % rate.num !== 0) throw new TimebaseError(`Rate ${rate.num}/${rate.den} has no exact flick duration`, 'INEXACT_RATE');
  return n / rate.num;
}

const ROUNDING = new Set(['floor', 'ceil', 'round']);

function bigDivRound(n, d, mode) {
  // n, d BigInt, d > 0. n may be negative.
  const q = n / d;
  const r = n % d;
  if (r === 0n) return q;
  const negative = n < 0n;
  if (mode === 'floor') return negative ? q - 1n : q;
  if (mode === 'ceil') return negative ? q : q + 1n;
  // round half away from zero
  const twice = (r < 0n ? -r : r) * 2n;
  if (twice >= d) return negative ? q - 1n : q + 1n;
  return q;
}

/** Convert absolute flicks to a frame index at `rate`. */
function flicksToFrames(flicks, rate, mode = 'round') {
  if (!Number.isSafeInteger(flicks)) throw new TimebaseError(`Time must be an integer number of flicks, got ${flicks}`, 'BAD_TIME');
  if (!ROUNDING.has(mode)) throw new TimebaseError(`Unknown rounding mode ${mode}`);
  const n = BigInt(flicks) * BigInt(rate.num);
  const d = BigInt(FLICKS_PER_SECOND) * BigInt(rate.den);
  return Number(bigDivRound(n, d, mode));
}

/** Exact: frames -> flicks. */
function framesToFlicks(frames, rate) {
  if (!Number.isSafeInteger(frames)) throw new TimebaseError(`Frame count must be an integer, got ${frames}`, 'BAD_FRAME');
  return frames * flicksPerFrame(rate);
}

function secondsToFlicks(seconds) {
  if (!Number.isFinite(seconds)) throw new TimebaseError(`Invalid seconds value ${seconds}`, 'BAD_TIME');
  return Math.round(seconds * FLICKS_PER_SECOND);
}

function msToFlicks(ms) {
  if (!Number.isFinite(ms)) throw new TimebaseError(`Invalid millisecond value ${ms}`, 'BAD_TIME');
  return Math.round(ms * (FLICKS_PER_SECOND / 1000));
}

function flicksToSeconds(flicks) {
  return flicks / FLICKS_PER_SECOND;
}

function flicksToMs(flicks) {
  return flicks / (FLICKS_PER_SECOND / 1000);
}

/**
 * Convert a frame index at one rate to a frame index at another rate,
 * through exact rational arithmetic (no intermediate float).
 */
function convertFrames(frames, fromRate, toRate, mode = 'round') {
  if (!Number.isSafeInteger(frames)) throw new TimebaseError(`Frame count must be an integer, got ${frames}`, 'BAD_FRAME');
  const n = BigInt(frames) * BigInt(fromRate.den) * BigInt(toRate.num);
  const d = BigInt(fromRate.num) * BigInt(toRate.den);
  return Number(bigDivRound(n, d, mode));
}

/** Snap a time to the nearest frame boundary of `rate`. */
function quantize(flicks, rate, mode = 'round') {
  return framesToFlicks(flicksToFrames(flicks, rate, mode), rate);
}

/** True if `flicks` sits exactly on a frame boundary of `rate`. */
function isOnFrame(flicks, rate) {
  return flicks % flicksPerFrame(rate) === 0;
}

module.exports = {
  FLICKS_PER_SECOND,
  KNOWN_RATES,
  TimebaseError,
  parseFrameRate,
  rateToFloat,
  isNtsc,
  flicksPerFrame,
  flicksToFrames,
  framesToFlicks,
  secondsToFlicks,
  msToFlicks,
  flicksToSeconds,
  flicksToMs,
  convertFrames,
  quantize,
  isOnFrame,
};
