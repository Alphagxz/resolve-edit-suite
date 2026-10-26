'use strict';
/**
 * Minimal read-only ZIP reader (central directory + stored/deflate entries).
 * Used only to INSPECT bundles (.drfx, .drp and similar) without extracting
 * them to disk or modifying them.
 */
const fs = require('fs');
const zlib = require('zlib');

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;

function readTail(fd, size, n) {
  const len = Math.min(size, n);
  const buf = Buffer.alloc(len);
  fs.readSync(fd, buf, 0, len, size - len);
  return { buf };
}

/** List entries: [{ name, compressedSize, size, method, localOffset }] */
function listZip(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const { buf } = readTail(fd, size, 65557);
    let eocd = -1;
    for (let i = buf.length - 22; i >= 0; i--) {
      if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('ZIP end-of-central-directory not found');
    const count = buf.readUInt16LE(eocd + 10);
    const cdSize = buf.readUInt32LE(eocd + 12);
    const cdOffset = buf.readUInt32LE(eocd + 16);
    if (cdOffset === 0xffffffff || count === 0xffff) throw new Error('ZIP64 archives are not supported by the inspector');
    const cd = Buffer.alloc(cdSize);
    fs.readSync(fd, cd, 0, cdSize, cdOffset);
    const entries = [];
    let p = 0;
    for (let i = 0; i < count; i++) {
      if (cd.readUInt32LE(p) !== CEN_SIG) throw new Error('Corrupt ZIP central directory');
      const method = cd.readUInt16LE(p + 10);
      const compressedSize = cd.readUInt32LE(p + 20);
      const sizeU = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      const localOffset = cd.readUInt32LE(p + 42);
      const name = cd.toString('utf8', p + 46, p + 46 + nameLen);
      entries.push({ name, compressedSize, size: sizeU, method, localOffset });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
  } finally {
    fs.closeSync(fd);
  }
}

/** Read one entry's bytes (stored or deflate). Refuses entries over maxBytes. */
function readZipEntry(file, entry, maxBytes = 8 * 1024 * 1024) {
  if (entry.size > maxBytes) throw new Error(`Entry ${entry.name} is larger than the ${maxBytes}-byte inspection limit`);
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(30);
    fs.readSync(fd, head, 0, 30, entry.localOffset);
    if (head.readUInt32LE(0) !== LOC_SIG) throw new Error(`Bad local header for ${entry.name}`);
    const dataStart = entry.localOffset + 30 + head.readUInt16LE(26) + head.readUInt16LE(28);
    const raw = Buffer.alloc(entry.compressedSize);
    fs.readSync(fd, raw, 0, raw.length, dataStart);
    if (entry.method === 0) return raw;
    if (entry.method === 8) return zlib.inflateRawSync(raw);
    throw new Error(`Unsupported ZIP compression method ${entry.method} for ${entry.name}`);
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = { listZip, readZipEntry };
