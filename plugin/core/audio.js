'use strict';
/**
 * Audio level analysis for silence detection.
 *
 * The Resolve scripting API exposes no audio samples, so the suite reads the
 * source media itself: WAV directly (parseWavHeader + decodeWavChunk), any
 * other container through the user's own FFmpeg (plugin side), which feeds
 * mono float samples into EnvelopeBuilder. Analysis never writes to media.
 */
const tb = require('./timebase');

class AudioFormatError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AudioFormatError';
    this.code = 'AUDIO_FORMAT';
  }
}

const WAVE_FORMAT_PCM = 1;
const WAVE_FORMAT_FLOAT = 3;
const WAVE_FORMAT_EXTENSIBLE = 0xfffe;

/** Parse a RIFF/WAVE header from the first bytes of a file. */
function parseWavHeader(buf) {
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    if (buf.toString('ascii', 0, 4) === 'RF64') throw new AudioFormatError('RF64 (>4 GB) WAV is not read directly; it will be decoded through FFmpeg.');
    throw new AudioFormatError('Not a RIFF/WAVE file');
  }
  let off = 12;
  let fmt = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ') {
      let format = buf.readUInt16LE(body);
      const channels = buf.readUInt16LE(body + 2);
      const sampleRate = buf.readUInt32LE(body + 4);
      const blockAlign = buf.readUInt16LE(body + 12);
      const bitsPerSample = buf.readUInt16LE(body + 14);
      if (format === WAVE_FORMAT_EXTENSIBLE && size >= 40) format = buf.readUInt16LE(body + 24);
      fmt = { format, channels, sampleRate, blockAlign, bitsPerSample };
    } else if (id === 'data') {
      if (!fmt) throw new AudioFormatError('WAV data chunk appears before fmt chunk');
      if (![WAVE_FORMAT_PCM, WAVE_FORMAT_FLOAT].includes(fmt.format)) throw new AudioFormatError(`Unsupported WAV encoding ${fmt.format} (only PCM and IEEE float)`);
      if (fmt.format === WAVE_FORMAT_PCM && ![8, 16, 24, 32].includes(fmt.bitsPerSample)) throw new AudioFormatError(`Unsupported PCM bit depth ${fmt.bitsPerSample}`);
      if (fmt.format === WAVE_FORMAT_FLOAT && ![32, 64].includes(fmt.bitsPerSample)) throw new AudioFormatError(`Unsupported float bit depth ${fmt.bitsPerSample}`);
      return { ...fmt, dataOffset: body, dataBytes: size, frames: Math.floor(size / fmt.blockAlign) };
    }
    off = body + size + (size % 2);
  }
  throw new AudioFormatError('WAV data chunk not found in header bytes (read more of the file or use FFmpeg)');
}

/** Decode whole sample frames from a data-chunk slice into a mono Float32Array (mean-square mix). */
function decodeWavChunk(buf, fmt) {
  const frames = Math.floor(buf.length / fmt.blockAlign);
  const out = new Float32Array(frames);
  const bytes = fmt.bitsPerSample / 8;
  const read = (o) => {
    if (fmt.format === WAVE_FORMAT_FLOAT) return bytes === 4 ? buf.readFloatLE(o) : buf.readDoubleLE(o);
    switch (bytes) {
      case 1: return (buf.readUInt8(o) - 128) / 128;
      case 2: return buf.readInt16LE(o) / 32768;
      case 3: return buf.readIntLE(o, 3) / 8388608;
      default: return buf.readInt32LE(o) / 2147483648;
    }
  };
  for (let f = 0; f < frames; f++) {
    let sumSq = 0;
    for (let c = 0; c < fmt.channels; c++) {
      const v = read(f * fmt.blockAlign + c * bytes);
      sumSq += v * v;
    }
    // Store RMS across channels with sign of nothing: envelope only needs energy.
    out[f] = Math.sqrt(sumSq / fmt.channels);
  }
  return out;
}

/** Accumulates mono samples into fixed windows of RMS level in dBFS. */
class EnvelopeBuilder {
  constructor(sampleRate, windowMs = 10) {
    if (!(sampleRate > 0)) throw new RangeError('sampleRate must be positive');
    this.sampleRate = sampleRate;
    this.windowSamples = Math.max(1, Math.round((sampleRate * windowMs) / 1000));
    this.levels = [];
    this._acc = 0;
    this._n = 0;
    this.totalSamples = 0;
  }
  push(samples) {
    for (let i = 0; i < samples.length; i++) {
      const v = samples[i];
      this._acc += v * v;
      if (++this._n === this.windowSamples) this._emit();
    }
    this.totalSamples += samples.length;
  }
  _emit() {
    const rms = Math.sqrt(this._acc / this._n);
    this.levels.push(rms > 0 ? 20 * Math.log10(rms) : -120);
    this._acc = 0;
    this._n = 0;
  }
  finish() {
    if (this._n > 0) this._emit();
    // Window length expressed exactly in flicks via the sample rate.
    const windowFlicks = Math.round((this.windowSamples * tb.FLICKS_PER_SECOND) / this.sampleRate);
    return {
      sampleRate: this.sampleRate,
      windowSamples: this.windowSamples,
      windowFlicks,
      durationFlicks: Math.round((this.totalSamples * tb.FLICKS_PER_SECOND) / this.sampleRate),
      db: Float32Array.from(this.levels),
    };
  }
}

/** Window index -> flicks, computed from sample counts (no accumulation). */
function windowStart(env, i) {
  return Math.round((i * env.windowSamples * tb.FLICKS_PER_SECOND) / env.sampleRate);
}

module.exports = { AudioFormatError, parseWavHeader, decodeWavChunk, EnvelopeBuilder, windowStart };
