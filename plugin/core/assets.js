'use strict';
/**
 * Identify premium asset files by CONTENT (magic bytes and structure) before
 * choosing an import method. Extensions are used only as a fallback and the
 * result says so (`confidence: 'extension'`).
 *
 * Never modifies, moves or extracts the inspected file.
 */
const fs = require('fs');
const path = require('path');
const { listZip, readZipEntry } = require('./zip');

const IMPORT = Object.freeze({
  BIN: 'MediaPool.ImportFolderFromFile',
  PROJECT: 'ProjectManager.ImportProject (separate migration workflow — never into the working project)',
  FUSION_INSTALL: 'Install into Fusion Templates folder (or double-click .drfx in Resolve), then insert by name',
  FUSION_COMP: 'TimelineItem.ImportFusionComp on a target clip',
  NONE: null,
});

function sniffHead(file, n = 4096) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(n);
    const read = fs.readSync(fd, buf, 0, n, 0);
    return buf.subarray(0, read);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Lightweight structural read of a Fusion .setting / .comp Lua table.
 * Returns tool types, macro kind and exposed (published) inputs.
 */
function inspectFusionSetting(text) {
  const tools = [];
  const toolRe = /^\s*([A-Za-z_][\w]*)\s*=\s*([A-Za-z_][\w]*)\s*\{/gm;
  let m;
  while ((m = toolRe.exec(text))) {
    if (!['ordered', 'Input', 'InstanceInput', 'InstanceOutput', 'Output', 'ViewInfo', 'Polyline', 'BezierSpline', 'StyledText', 'Gradient', 'FuID'].includes(m[2])) {
      tools.push({ name: m[1], type: m[2] });
    }
  }
  const macro = tools.find((t) => t.type === 'MacroOperator' || t.type === 'GroupOperator') || null;
  const published = [];
  const instRe = /InstanceInput\s*\{([^}]*)\}/g;
  while ((m = instRe.exec(text))) {
    const src = /Source\s*=\s*"([^"]+)"/.exec(m[1]);
    const op = /SourceOp\s*=\s*"([^"]+)"/.exec(m[1]);
    const name = /Name\s*=\s*"([^"]+)"/.exec(m[1]);
    if (src) published.push({ sourceOp: op ? op[1] : null, source: src[1], name: name ? name[1] : null });
  }
  const types = new Set(tools.map((t) => t.type));
  return {
    isFusion: /Tools\s*=\s*ordered\(\)/.test(text),
    macro: macro ? { name: macro.name, type: macro.type } : null,
    toolTypes: [...types],
    hasTextPlus: types.has('TextPlus'),
    hasText3D: types.has('Text3D'),
    publishedInputs: published,
    editableText: published.filter((p) => p.source === 'StyledText'),
  };
}

function classifyZipEntries(entries) {
  const names = entries.map((e) => e.name);
  const settings = names.filter((n) => /\.setting$/i.test(n));
  if (settings.length && names.some((n) => /(^|\/)(Edit|Fusion|Templates)\//i.test(n) || /\.setting$/i.test(n))) {
    return { kind: 'fusion-template-bundle', note: `${settings.length} Fusion template(s) inside`, settings };
  }
  if (names.some((n) => /(^|\/)project\.xml$/i.test(n))) {
    return { kind: 'resolve-project-archive', note: 'Contains project.xml — a Resolve project export (.drp-style), not a bin export.' };
  }
  return null;
}

/**
 * @returns {{
 *   path, sizeBytes, kind, confidence: 'content'|'extension'|'unknown',
 *   recommendedImport, details, warnings
 * }}
 */
function identifyAsset(file) {
  const warnings = [];
  const stat = fs.statSync(file);
  const ext = path.extname(file).toLowerCase();
  const base = { path: file, sizeBytes: stat.size, warnings };

  if (stat.isDirectory()) {
    const list = fs.readdirSync(file);
    if (list.some((n) => n.toLowerCase().endsWith('.drp')) && list.some((n) => /^MediaFiles$/i.test(n) || /media/i.test(n))) {
      return { ...base, kind: 'resolve-project-archive-folder', confidence: 'content', recommendedImport: IMPORT.PROJECT, details: { entries: list.slice(0, 50) } };
    }
    if (ext === '.dra') {
      return { ...base, kind: 'resolve-project-archive-folder', confidence: 'extension', recommendedImport: IMPORT.PROJECT, details: { entries: list.slice(0, 50) } };
    }
    return { ...base, kind: 'directory', confidence: 'unknown', recommendedImport: IMPORT.NONE, details: { entries: list.slice(0, 50) } };
  }

  const head = sniffHead(file);
  const magic = head.subarray(0, 16);

  if (magic.toString('latin1', 0, 15) === 'SQLite format 3') {
    return { ...base, kind: 'sqlite-database', confidence: 'content', recommendedImport: IMPORT.NONE,
      details: { note: 'This is a database file (possibly a Resolve project library). The suite never reads or writes Resolve databases.' } };
  }

  const sig = magic.length >= 4 ? magic.readUInt32LE(0) : 0;
  if (sig === 0x04034b50 || sig === 0x06054b50) {
    let entries;
    try {
      entries = listZip(file);
    } catch (e) {
      return { ...base, kind: 'zip-unreadable', confidence: 'content', recommendedImport: IMPORT.NONE, details: { error: e.message } };
    }
    const cls = classifyZipEntries(entries);
    const sample = entries.slice(0, 40).map((e) => e.name);
    if (cls && cls.kind === 'fusion-template-bundle') {
      const templates = [];
      for (const s of cls.settings.slice(0, 200)) {
        const entry = entries.find((e) => e.name === s);
        try {
          templates.push({ entry: s, ...inspectFusionSetting(readZipEntry(file, entry).toString('utf8')) });
        } catch (e) {
          templates.push({ entry: s, error: e.message });
        }
      }
      return { ...base, kind: 'fusion-template-bundle', confidence: 'content', recommendedImport: IMPORT.FUSION_INSTALL, details: { entryCount: entries.length, sample, templates } };
    }
    if (cls && cls.kind === 'resolve-project-archive') {
      return { ...base, kind: 'resolve-project-archive', confidence: 'content', recommendedImport: IMPORT.PROJECT, details: { entryCount: entries.length, sample } };
    }
    // A ZIP we do not recognise structurally: fall back to the extension, flagged.
    if (ext === '.drb') {
      warnings.push('ZIP-based .drb with an unrecognised layout; treat as a bin export only after a test import into a scratch project.');
      return { ...base, kind: 'resolve-bin-export', confidence: 'extension', recommendedImport: IMPORT.BIN, details: { entryCount: entries.length, sample } };
    }
    if (ext === '.drp') return { ...base, kind: 'resolve-project-archive', confidence: 'extension', recommendedImport: IMPORT.PROJECT, details: { entryCount: entries.length, sample } };
    return { ...base, kind: 'zip-archive', confidence: 'content', recommendedImport: IMPORT.NONE, details: { entryCount: entries.length, sample } };
  }

  const text = head.toString('utf8');
  if (/^\s*\{/.test(text) && /Tools\s*=\s*ordered\(\)/.test(fs.readFileSync(file, 'utf8').slice(0, 2 * 1024 * 1024))) {
    const info = inspectFusionSetting(fs.readFileSync(file, 'utf8'));
    const kind = ext === '.comp' ? 'fusion-composition' : 'fusion-setting';
    return { ...base, kind, confidence: 'content', recommendedImport: kind === 'fusion-composition' ? IMPORT.FUSION_COMP : IMPORT.FUSION_INSTALL, details: info };
  }
  if (/^\s*<\?xml/.test(text) || /^\s*</.test(text)) {
    const root = /<\s*([A-Za-z_][\w:.-]*)/.exec(text.replace(/<\?xml[^>]*\?>/, '').replace(/<!--[\s\S]*?-->/g, ''));
    return { ...base, kind: 'xml', confidence: 'content', recommendedImport: IMPORT.NONE, details: { rootElement: root ? root[1] : null } };
  }

  // Unknown binary: report magic bytes; use extension only as a labelled hint.
  const hex = magic.toString('hex').replace(/(..)/g, '$1 ').trim();
  if (ext === '.drb') {
    warnings.push('Not a ZIP, database, Fusion or XML file. The .drb extension suggests a Resolve bin export; this cannot be confirmed by inspection.');
    return { ...base, kind: 'resolve-bin-export', confidence: 'extension', recommendedImport: IMPORT.BIN, details: { magic: hex } };
  }
  return { ...base, kind: 'unknown', confidence: 'unknown', recommendedImport: IMPORT.NONE, details: { magic: hex, extension: ext } };
}

module.exports = { IMPORT, identifyAsset, inspectFusionSetting, classifyZipEntries };
