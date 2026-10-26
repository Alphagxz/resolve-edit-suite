'use strict';
/**
 * Premium asset setup: locate/validate the caption preset file, import a
 * Media Pool bin export exactly once per project, relink if moved, and
 * catalogue installed Fusion templates.
 *
 * Originals are never modified: the bin export is only read by Resolve's own
 * ImportFolderFromFile, and template folders are only listed.
 */
const fs = require('fs');
const { identifyAsset } = require('../core/assets');
const { catalogueTemplates, defaultTemplateRoots } = require('../core/templates');
const { sha256File } = require('../services/storage');
const { SuiteError } = require('../resolve/adapter');
const { listOf } = require('./resolve-reads');

/** Validate a user-selected caption preset path and store it. */
function setCaptionPreset(storage, file) {
  if (!file || !fs.existsSync(file)) throw new SuiteError(`File not found: ${file}`, 'asset-missing');
  const info = identifyAsset(file);
  const st = fs.statSync(file);
  const record = {
    path: file,
    sha256: st.isFile() ? sha256File(file) : null,
    size: st.size,
    mtimeMs: st.mtimeMs,
    kind: info.kind,
    confidence: info.confidence,
    recommendedImport: info.recommendedImport,
    warnings: info.warnings,
    contents: info.details && info.details.binFolders ? { binFolders: info.details.binFolders, writtenBy: info.details.writtenBy || null, basis: info.details.basis || null } : null,
    validatedAt: new Date().toISOString(),
  };
  storage.updateSettings((s) => ({ ...s, captionPreset: record }));
  return { record, info };
}

/** Status of the stored preset: ok | moved | changed | not-set. */
function captionPresetStatus(storage) {
  const s = storage.loadSettings();
  const r = s.captionPreset;
  if (!r) return { status: 'not-set' };
  if (!fs.existsSync(r.path)) return { status: 'moved', record: r, message: `The caption preset file is no longer at ${r.path}. Use "Relink" to locate it.` };
  const st = fs.statSync(r.path);
  if (st.isFile() && (st.size !== r.size || st.mtimeMs !== r.mtimeMs) && sha256File(r.path) !== r.sha256) {
    return { status: 'changed', record: r, message: 'The caption preset file has changed since it was validated. Re-validate before importing.' };
  }
  return { status: 'ok', record: r };
}

/** Relink: accept a new path only if it is byte-identical to the validated file (or the user confirms a different one). */
function relinkCaptionPreset(storage, file, { acceptDifferent = false } = {}) {
  const s = storage.loadSettings();
  if (!s.captionPreset) return setCaptionPreset(storage, file);
  if (!fs.existsSync(file)) throw new SuiteError(`File not found: ${file}`, 'asset-missing');
  const same = fs.statSync(file).isFile() && sha256File(file) === s.captionPreset.sha256;
  if (!same && !acceptDifferent) {
    return { needsConfirmation: true, message: 'This file is not identical to the preset file you validated before. Confirm to use it instead.' };
  }
  return setCaptionPreset(storage, file);
}

async function folderNames(a, folder) {
  const subs = listOf(await a.call('Folder', folder, 'GetSubFolderList'));
  const names = [];
  for (const f of subs) names.push(await a.call('Folder', f, 'GetName'));
  return { subs, names };
}

/**
 * Import the validated bin export into the current project's Media Pool root,
 * unless this exact file was already imported into this project and its
 * folders are still present.
 */
async function importCaptionBin(a, storage, { force = false } = {}) {
  const st = captionPresetStatus(storage);
  if (st.status === 'not-set') throw new SuiteError('Choose the caption preset file in Setup first.', 'asset-missing');
  if (st.status !== 'ok') throw new SuiteError(st.message, 'asset-missing');
  const rec = st.record;
  if (rec.kind === 'resolve-project-archive' || rec.kind === 'resolve-project-archive-folder') {
    throw new SuiteError('This file is a Resolve PROJECT archive, not a bin export. Use the Project Migration workflow (it imports into a separate project and never touches your current one).', 'unsupported');
  }
  if (rec.kind !== 'resolve-bin-export') {
    throw new SuiteError(`This file was identified as "${rec.kind}", which cannot be imported as a Media Pool bin. See Setup for the recommended method.`, 'unsupported');
  }

  const { project } = await a.currentProject();
  const projectId = (await a.call('Project', project, 'GetUniqueId')) || null;
  const projectName = await a.call('Project', project, 'GetName');
  const mediaPool = await a.must('Project', project, 'GetMediaPool');
  const root = await a.must('MediaPool', mediaPool, 'GetRootFolder');
  const before = await folderNames(a, root);

  const settings = storage.loadSettings();
  const prior = settings.captionImports.find((x) => x.sha256 === rec.sha256 && (projectId ? x.projectId === projectId : x.projectName === projectName));
  if (prior && !force) {
    const stillThere = prior.folders.filter((n) => before.names.includes(n));
    if (stillThere.length) {
      return { skipped: true, message: `Already imported into this project (${stillThere.join(', ')}). Nothing was imported again.`, folders: stillThere };
    }
  }

  const ok = await a.call('MediaPool', mediaPool, 'ImportFolderFromFile', rec.path);
  if (!ok) throw new SuiteError('Resolve could not import the bin file. Check that the file opens via Media Pool > right-click > Import Bin in this Resolve version.', 'call-failed');
  const after = await folderNames(a, root);
  const added = after.names.filter((n) => !before.names.includes(n) || after.names.filter((x) => x === n).length > before.names.filter((x) => x === n).length);
  if (!added.length) {
    throw new SuiteError('Resolve reported success but no new Media Pool folder appeared. The import may have gone into the current folder; check the Media Pool.', 'verification-failed');
  }
  storage.updateSettings((s) => ({
    ...s,
    captionImports: [...s.captionImports.filter((x) => x !== prior), { projectId, projectName, sha256: rec.sha256, folders: [...new Set(added)], importedAt: new Date().toISOString() }],
  }));
  return { skipped: false, folders: [...new Set(added)], message: `Imported ${added.join(', ')}.` };
}

/** List Media Pool items under the imported caption folders (for the style picker). */
async function captionStyles(a, storage) {
  const { project } = await a.currentProject();
  const projectId = await a.call('Project', project, 'GetUniqueId');
  const projectName = await a.call('Project', project, 'GetName');
  const s = storage.loadSettings();
  const imp = s.captionImports.filter((x) => (projectId ? x.projectId === projectId : x.projectName === projectName));
  if (!imp.length) return { styles: [], message: 'No caption presets imported into this project yet.' };
  const mediaPool = await a.must('Project', project, 'GetMediaPool');
  const root = await a.must('MediaPool', mediaPool, 'GetRootFolder');
  const wanted = new Set(imp.flatMap((x) => x.folders));
  const styles = [];
  async function walk(folder, trail) {
    for (const clip of listOf(await a.call('Folder', folder, 'GetClipList'))) {
      const name = await a.call('MediaPoolItem', clip, 'GetName');
      const props = (await a.call('MediaPoolItem', clip, 'GetClipProperty')) || {};
      const id = (await a.call('MediaPoolItem', clip, 'GetUniqueId')) || `${trail.join('/')}/${name}`;
      styles.push({ id, name, folder: trail.join(' / '), type: props.Type || null, duration: props.Duration || null, fps: props.FPS || null });
    }
    for (const sub of listOf(await a.call('Folder', folder, 'GetSubFolderList'))) {
      await walk(sub, [...trail, await a.call('Folder', sub, 'GetName')]);
    }
  }
  for (const f of listOf(await a.call('Folder', root, 'GetSubFolderList'))) {
    const n = await a.call('Folder', f, 'GetName');
    if (wanted.has(n)) await walk(f, [n]);
  }
  return { styles };
}

function templates(storage) {
  const s = storage.loadSettings();
  const roots = [...defaultTemplateRoots(), ...(s.templateRoots || [])];
  const cat = catalogueTemplates(roots);
  return { ...cat, roots, favourites: s.favourites.templates };
}

module.exports = { setCaptionPreset, captionPresetStatus, relinkCaptionPreset, importCaptionBin, captionStyles, templates };
