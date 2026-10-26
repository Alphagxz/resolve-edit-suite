'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

function tmpDir(prefix = 'res-suite-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Write a real ZIP (deflate) so the inspector is tested against genuine bytes. */
function writeZip(file, entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of Object.entries(entries)) {
    const data = Buffer.from(content);
    const comp = zlib.deflateRawSync(data);
    const nameBuf = Buffer.from(name);
    const crc = zlib.crc32(data);
    const loc = Buffer.alloc(30);
    loc.writeUInt32LE(0x04034b50, 0); loc.writeUInt16LE(20, 4); loc.writeUInt16LE(0, 6); loc.writeUInt16LE(8, 8);
    loc.writeUInt32LE(crc >>> 0, 14); loc.writeUInt32LE(comp.length, 18); loc.writeUInt32LE(data.length, 22); loc.writeUInt16LE(nameBuf.length, 26);
    locals.push(loc, nameBuf, comp);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(8, 10);
    cen.writeUInt32LE(crc >>> 0, 16); cen.writeUInt32LE(comp.length, 20); cen.writeUInt32LE(data.length, 24); cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, nameBuf);
    offset += 30 + nameBuf.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(entries).length, 8); eocd.writeUInt16LE(Object.keys(entries).length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  fs.writeFileSync(file, Buffer.concat([...locals, cd, eocd]));
}

/** Mono/stereo 16-bit WAV from a per-sample function. */
function writeWav(file, { sampleRate = 48000, channels = 1, seconds, sample }) {
  const frames = Math.round(sampleRate * seconds);
  const data = Buffer.alloc(frames * channels * 2);
  for (let i = 0; i < frames; i++) {
    const v = Math.max(-1, Math.min(1, sample(i / sampleRate)));
    for (let c = 0; c < channels; c++) data.writeInt16LE(Math.round(v * 32767), (i * channels + c) * 2);
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(sampleRate, 24); h.writeUInt32LE(sampleRate * channels * 2, 28); h.writeUInt16LE(channels * 2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  fs.writeFileSync(file, Buffer.concat([h, data]));
}

const TEXT_PLUS_SETTING = `{
	Tools = ordered() {
		Caption = MacroOperator {
			Inputs = ordered() {
				Input1 = InstanceInput {
					SourceOp = "Template",
					Source = "StyledText",
					Name = "Text",
				},
			},
			Tools = ordered() {
				Template = TextPlus {
					Inputs = {
						StyledText = Input { Value = "Caption", },
					},
				},
			},
		},
	},
}`;

/**
 * Build a CompositionBA hex string in the layout measured on a real Resolve
 * 20.3 .drb: [4-byte length][zlib(header text + [4 bytes] + zlib(tool graph))].
 */
function makeCompositionBA(tools, { width = 2160, height = 3840, rate = 24 } = {}) {
  const header = Buffer.from(`Composition { CurrentTime = 0, Prefs = { Comp = { FrameFormat = { Width = ${width}, Height = ${height}, Rate = ${rate}, }, } }, Compressed = true, }`, 'latin1');
  const outer = Buffer.concat([Buffer.from([0, 0, 0, 1]), header, Buffer.from([0, 0, 0, 0]), zlib.deflateSync(Buffer.from(tools))]);
  const inner = zlib.deflateSync(outer);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(outer.length);
  return Buffer.concat([len, inner]).toString('hex');
}

const TOOLS_FOLLOWER = '{ Template = TextPlus { Inputs = { StyledText = Input { SourceOp = "Follower1", Source = "StyledText", }, }, }, Follower1 = StyledTextFollower { Inputs = { Text = Input { Value = StyledText { Value = "Smooth Word Up" }, }, }, }, MediaOut1 = MediaOut { } }';
const TOOLS_DIRECT = '{ Template = TextPlus { Inputs = { StyledText = Input { Value = "Glitch Text", }, }, }, MediaOut1 = MediaOut { } }';
const TOOLS_NONE = '{ Transform1 = Transform { }, MediaOut1 = MediaOut { } }';

/** A .drb with the real bin-export layout and generator items carrying compositions. */
function writeBinExport(file, folder, items) {
  const el = items.map(([name, tools]) => `  <Element>\n   <Sm2MpGenerator DbId="${name}-id">\n    <Name>${name}</Name>\n    <CompositionTable><Sm2TiCompositionTable DbId="c"><CompositionBA>${makeCompositionBA(tools)}</CompositionBA></Sm2TiCompositionTable></CompositionTable>\n   </Sm2MpGenerator>\n  </Element>`).join('\n');
  writeZip(file, {
    'project.xml': '<?xml version="1.0" encoding="UTF-8"?>\n<!--DbAppVer="20.3.0.0010" DbPrjVer="15"-->\n<SM_Project DbId="x"></SM_Project>',
    [`MediaPool/Master/000_${folder}/MpFolder.xml`]: `<Sm2MpFolder DbId="f"><Name>${folder}</Name><MediaVec>\n${el}\n</MediaVec></Sm2MpFolder>`,
    'MediaPool/Master/MpFolder.xml': '<Sm2MpFolder DbId="m"><Name>Master</Name></Sm2MpFolder>',
  });
}

module.exports = { tmpDir, writeZip, writeWav, TEXT_PLUS_SETTING, makeCompositionBA, writeBinExport, TOOLS_FOLLOWER, TOOLS_DIRECT, TOOLS_NONE };
