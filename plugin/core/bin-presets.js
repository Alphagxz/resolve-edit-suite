'use strict';
/**
 * Read-only inspection of the presets inside a Resolve bin export (.drb).
 *
 * Layout measured on a real Resolve 20.3 export (MotionText Pro):
 *   MediaPool/Master/<NNN_folder>/MpFolder.xml holds one element per pool
 *   item (e.g. <Sm2MpGenerator>, <Sm2MpTimelineClip>) with its <Name> and,
 *   for Fusion items, <CompositionBA>: hex of [4-byte length][zlib(header
 *   "Composition { … Compressed = true, }" … [zlib(tool graph)])].
 *
 * The tool graph tells us where a preset's words actually live:
 *   - 'direct'   Text+ StyledText holds the text
 *   - 'follower' Text+ StyledText is driven by a StyledTextFollower, whose
 *                Text input holds the text (word-by-word animations)
 *   - 'none'     no Text+ at all (zooms, adjustment clips) — not a caption style
 *   - 'unknown'  could not decode
 * Nothing is extracted to disk and the .drb is never modified.
 */
const zlib = require('zlib');
const { listZip, readZipEntry } = require('./zip');

/** Decode a CompositionBA hex string to the Fusion tool-graph text (or null). */
function decodeCompositionBA(hex) {
  let outer;
  try {
    outer = zlib.inflateSync(Buffer.from(hex, 'hex').subarray(4));
  } catch {
    return null;
  }
  const header = /Composition \{[\s\S]*?Compressed = true, \}/.exec(outer.toString('latin1'));
  const format = header ? /FrameFormat = \{ Width = (\d+), Height = (\d+), Rate = ([\d.]+)/.exec(header[0]) : null;
  // The tool graph is the first nested zlib stream that inflates to a Lua table.
  for (let i = 0; i < outer.length - 1; i++) {
    if (outer[i] !== 0x78 || ![0x01, 0x5e, 0x9c, 0xda].includes(outer[i + 1])) continue;
    try {
      const text = zlib.inflateSync(outer.subarray(i)).toString('utf8');
      if (text.trimStart().startsWith('{')) {
        return { tools: text, format: format ? { width: Number(format[1]), height: Number(format[2]), rate: Number(format[3]) } : null };
      }
    } catch {
      /* not a stream boundary; keep scanning */
    }
  }
  return null;
}

/** Classify where the text of a decoded tool graph lives. */
function textWiring(tools) {
  const textPlus = [...tools.matchAll(/(\w+) = TextPlus \{/g)].map((m) => m[1]);
  if (!textPlus.length) return { wiring: 'none', textTools: [], followers: [] };
  const followers = [...tools.matchAll(/(\w+) = StyledTextFollower \{/g)].map((m) => m[1]);
  const drivers = [...tools.matchAll(/StyledText = Input \{ SourceOp = "(\w+)"/g)].map((m) => m[1]);
  if (!drivers.length) return { wiring: 'direct', textTools: textPlus, followers };
  if (drivers.every((d) => followers.includes(d))) return { wiring: 'follower', textTools: textPlus, followers };
  return { wiring: 'unknown', textTools: textPlus, followers, drivers };
}

/**
 * @returns {Array<{ folder, name, itemType, wiring, textTools, followers, format }>}
 */
function inspectBinPresets(file) {
  const entries = listZip(file);
  const out = [];
  for (const e of entries) {
    const m = /^MediaPool\/Master\/(.+)\/MpFolder\.xml$/i.exec(e.name);
    if (!m) continue;
    const folder = m[1].split('/').map((seg) => seg.replace(/^\d{3}_/, '')).join(' / ');
    const xml = readZipEntry(file, e, 64 * 1024 * 1024).toString('utf8');
    for (const item of xml.matchAll(/<(Sm2Mp(?!Folder)[A-Za-z]+) DbId="[^"]+">([\s\S]*?)<\/\1>/g)) {
      const name = (/<Name>([^<]*)<\/Name>/.exec(item[2]) || [])[1];
      if (!name) continue;
      const ba = /<CompositionBA>([0-9a-f]+)<\/CompositionBA>/.exec(item[2]);
      const decoded = ba ? decodeCompositionBA(ba[1]) : null;
      const w = decoded ? textWiring(decoded.tools) : { wiring: ba ? 'unknown' : 'none', textTools: [], followers: [] };
      out.push({ folder, name, itemType: item[1].replace(/^Sm2Mp/, ''), ...w, format: decoded ? decoded.format : null });
    }
  }
  return out;
}

module.exports = { decodeCompositionBA, textWiring, inspectBinPresets };
