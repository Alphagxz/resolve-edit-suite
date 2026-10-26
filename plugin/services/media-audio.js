'use strict';
/**
 * Decode a time range of a media file's first audio stream to a level
 * envelope. WAV is read directly; anything else needs the user's FFmpeg
 * (located in Settings or on PATH). Nothing is written next to the media.
 */
const fs = require('fs');
const { spawn, spawnSync } = require('child_process');
const audio = require('../core/audio');
const { SuiteError } = require('../resolve/adapter');

function findFfmpeg(configured) {
  const candidates = [configured, 'ffmpeg'].filter(Boolean);
  for (const c of candidates) {
    try {
      const r = spawnSync(c, ['-hide_banner', '-version'], { encoding: 'utf8', timeout: 5000 });
      if (r.status === 0) return { path: c, version: (r.stdout.split('\n')[0] || '').trim() };
    } catch { /* try next */ }
  }
  return null;
}

function wavEnvelope(file, startSec, durSec, windowMs) {
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(1 << 16);
    fs.readSync(fd, head, 0, head.length, 0);
    const fmt = audio.parseWavHeader(head);
    const env = new audio.EnvelopeBuilder(fmt.sampleRate, windowMs);
    const first = Math.max(0, Math.round(startSec * fmt.sampleRate));
    const last = Math.min(fmt.frames, first + Math.round(durSec * fmt.sampleRate));
    const chunkFrames = 1 << 16;
    for (let f = first; f < last; f += chunkFrames) {
      const n = Math.min(chunkFrames, last - f);
      const buf = Buffer.alloc(n * fmt.blockAlign);
      fs.readSync(fd, buf, 0, buf.length, fmt.dataOffset + f * fmt.blockAlign);
      env.push(audio.decodeWavChunk(buf, fmt));
    }
    return env.finish();
  } finally {
    fs.closeSync(fd);
  }
}

function ffmpegEnvelope(ffmpeg, file, startSec, durSec, windowMs, task) {
  const sampleRate = 16000;
  return new Promise((resolve, reject) => {
    const args = ['-v', 'error', '-nostdin', '-ss', startSec.toFixed(6), '-t', durSec.toFixed(6), '-i', file, '-map', '0:a:0', '-ac', '1', '-ar', String(sampleRate), '-f', 'f32le', '-'];
    const proc = spawn(ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const env = new audio.EnvelopeBuilder(sampleRate, windowMs);
    let carry = Buffer.alloc(0);
    let err = '';
    const timer = setInterval(() => { if (task && task.cancelled) proc.kill(); }, 200);
    proc.stdout.on('data', (d) => {
      const buf = carry.length ? Buffer.concat([carry, d]) : d;
      const usable = buf.length - (buf.length % 4);
      const view = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + usable));
      env.push(view);
      carry = buf.subarray(usable);
    });
    proc.stderr.on('data', (d) => { err += d; });
    proc.on('error', (e) => { clearInterval(timer); reject(new SuiteError(`Could not run FFmpeg: ${e.message}`, 'asset-missing')); });
    proc.on('close', (code) => {
      clearInterval(timer);
      if (task && task.cancelled) return reject(new SuiteError('Cancelled.', 'cancelled'));
      if (code !== 0) {
        const noAudio = /matches no streams|does not contain any stream/i.test(err);
        return reject(new SuiteError(noAudio ? `${file} has no audio stream.` : `FFmpeg could not decode ${file}: ${err.trim().split('\n').pop()}`, noAudio ? 'invalid-input' : 'asset-missing'));
      }
      resolve(env.finish());
    });
  });
}

async function envelopeForRange({ file, startSec, durSec, windowMs = 10, ffmpegPath, task }) {
  if (!file || !fs.existsSync(file)) throw new SuiteError(`Media file is offline or missing: ${file || '(no path)'}`, 'asset-missing');
  if (/\.wav$/i.test(file)) {
    try {
      return wavEnvelope(file, startSec, durSec, windowMs);
    } catch (e) {
      if (!(e instanceof audio.AudioFormatError)) throw e;
      // Fall through to FFmpeg for WAV variants we do not read directly.
    }
  }
  const ff = findFfmpeg(ffmpegPath);
  if (!ff) throw new SuiteError('Analysing this media type needs FFmpeg. Install FFmpeg and set its path in Settings (WAV files work without it).', 'asset-missing');
  return ffmpegEnvelope(ff.path, file, startSec, durSec, windowMs, task);
}

module.exports = { findFfmpeg, envelopeForRange, wavEnvelope };
