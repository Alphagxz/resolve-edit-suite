'use strict';
/**
 * Shared install/uninstall logic (pure functions + fs), testable without Resolve.
 */
const fs = require('fs');
const path = require('path');

const PLUGIN_FOLDER = 'EditSuite';
const RECEIPT = 'edit-suite-install-receipt.json';
const PLUGIN = {
  Id: 'com.editsuite.resolve.panel',
  Name: 'Edit Suite',
  Description: 'Captions, rough cut, motion graphics and diagnostics for DaVinci Resolve Studio',
  FilePath: 'main.js',
};

function defaultPaths(platform = process.platform, env = process.env) {
  if (platform === 'darwin') {
    const base = '/Library/Application Support/Blackmagic Design/DaVinci Resolve';
    return { pluginsDir: path.join(base, 'Workflow Integration Plugins'), sampleDir: path.join(base, 'Developer/Workflow Integrations/Examples/SamplePlugin') };
  }
  if (platform === 'win32') {
    const base = path.join(env.PROGRAMDATA || 'C:\\ProgramData', 'Blackmagic Design', 'DaVinci Resolve', 'Support');
    return { pluginsDir: path.join(base, 'Workflow Integration Plugins'), sampleDir: path.join(base, 'Developer', 'Workflow Integrations', 'Examples', 'SamplePlugin') };
  }
  return { pluginsDir: null, sampleDir: null }; // Workflow Integrations are not documented for Linux
}

/**
 * Derive our manifest from the sample's, keeping its exact element structure
 * and replacing only the identifying values. Returns { xml, replaced, missing, elements }.
 */
function manifestFromSample(sampleXml, version) {
  const values = { ...PLUGIN, Version: version };
  const replaced = [];
  const missing = [];
  let xml = sampleXml;
  for (const [tag, value] of Object.entries(values)) {
    const re = new RegExp(`(<${tag}>)([\\s\\S]*?)(</${tag}>)`);
    if (re.test(xml)) {
      xml = xml.replace(re, `$1${escapeXml(value)}$3`);
      replaced.push(tag);
    } else missing.push(tag);
  }
  const elements = [...new Set([...sampleXml.matchAll(/<([A-Za-z][\w.-]*)[\s>]/g)].map((m) => m[1]))];
  return { xml, replaced, missing, elements };
}

function escapeXml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function findNodeBinding(sampleDir) {
  const found = [];
  const walk = (d, depth) => {
    if (depth > 4) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory() && e.name !== 'node_modules') walk(p, depth + 1);
      else if (e.isFile() && e.name === 'WorkflowIntegration.node') found.push(p);
    }
  };
  walk(sampleDir, 0);
  return found;
}

function listFiles(dir, base = dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(p, base));
    else out.push(path.relative(base, p));
  }
  return out;
}

/**
 * Plan an installation. Throws with an actionable message if prerequisites
 * are missing. Does not write anything.
 */
function planInstall({ pluginSrc, pluginsDir, sampleDir, version }) {
  if (!pluginsDir) throw new Error('Workflow Integration plugins are only supported by Resolve on macOS and Windows. Pass --dest to override if your install differs.');
  if (!sampleDir || !fs.existsSync(sampleDir)) throw new Error(`Resolve's sample Workflow Integration plugin was not found at ${sampleDir}. It ships with Resolve Studio under Developer/Workflow Integrations. Pass --sample <folder> if it is elsewhere.`);
  const manifestPath = path.join(sampleDir, 'manifest.xml');
  if (!fs.existsSync(manifestPath)) throw new Error(`No manifest.xml in ${sampleDir}; cannot derive a manifest for this Resolve version.`);
  const bindings = findNodeBinding(sampleDir);
  if (!bindings.length) throw new Error(`WorkflowIntegration.node not found in ${sampleDir}. It is required and is copied from your own Resolve install (it is not redistributed with the suite).`);
  const manifest = manifestFromSample(fs.readFileSync(manifestPath, 'utf8'), version);
  if (manifest.missing.includes('Id') || manifest.missing.includes('FilePath')) {
    throw new Error(`The sample manifest for this Resolve version has no <Id> or <FilePath> element (elements: ${manifest.elements.join(', ')}). The manifest format changed; installation stopped rather than guessing.`);
  }
  const dest = path.join(pluginsDir, PLUGIN_FOLDER);
  const files = listFiles(pluginSrc).filter((f) => !/(^|[\\/])(test|\.git)([\\/]|$)/.test(f));
  return { dest, files, binding: bindings[0], manifest, exists: fs.existsSync(dest) };
}

function performInstall(plan, { pluginSrc, now = new Date() }) {
  let backup = null;
  if (plan.exists) {
    const receipt = path.join(plan.dest, RECEIPT);
    if (!fs.existsSync(receipt)) throw new Error(`${plan.dest} exists but was not installed by this installer (no receipt). Remove or rename it yourself; nothing was changed.`);
    backup = `${plan.dest}.previous-${now.toISOString().replace(/[:.]/g, '-')}`;
    fs.renameSync(plan.dest, backup);
  }
  fs.mkdirSync(plan.dest, { recursive: true });
  for (const f of plan.files) {
    const to = path.join(plan.dest, f);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(pluginSrc, f), to);
  }
  fs.writeFileSync(path.join(plan.dest, 'manifest.xml'), plan.manifest.xml);
  fs.copyFileSync(plan.binding, path.join(plan.dest, 'WorkflowIntegration.node'));
  const installed = [...plan.files, 'manifest.xml', 'WorkflowIntegration.node', RECEIPT];
  fs.writeFileSync(path.join(plan.dest, RECEIPT), JSON.stringify({ installedAt: now.toISOString(), id: PLUGIN.Id, files: installed, previous: backup }, null, 2));
  return { dest: plan.dest, backup, files: installed.length };
}

/** Remove exactly what the receipt lists; never anything else. */
function performUninstall(dest) {
  const receiptPath = path.join(dest, RECEIPT);
  if (!fs.existsSync(receiptPath)) throw new Error(`No install receipt in ${dest}; refusing to delete a folder this installer did not create.`);
  const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
  let removed = 0;
  for (const f of receipt.files) {
    const p = path.resolve(dest, f);
    if (!p.startsWith(path.resolve(dest) + path.sep)) continue; // never escape the plugin folder
    if (fs.existsSync(p)) { fs.unlinkSync(p); removed++; }
  }
  // Remove now-empty directories bottom-up; keep anything the user added.
  const prune = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) if (e.isDirectory()) prune(path.join(d, e.name));
    if (fs.readdirSync(d).length === 0) fs.rmdirSync(d);
  };
  prune(dest);
  return { removed, leftover: fs.existsSync(dest) ? listFiles(dest) : [] };
}

module.exports = { PLUGIN, PLUGIN_FOLDER, RECEIPT, defaultPaths, manifestFromSample, planInstall, performInstall, performUninstall, findNodeBinding };
