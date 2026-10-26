#!/usr/bin/env node
'use strict';
/**
 * Edit Suite installer.
 *   node tools/install.js [--dry-run] [--yes] [--dest <WorkflowIntegrationPluginsDir>] [--sample <SamplePluginDir>]
 * macOS: the plugins folder is under /Library, so run with sudo.
 * Windows: run from an Administrator terminal.
 */
const path = require('path');
const readline = require('readline');
const lib = require('./install-lib');

function arg(name) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
}
const flags = new Set(process.argv.slice(2));

async function ask(q) {
  if (flags.has('--yes')) return true;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const a = await new Promise((r) => rl.question(`${q} [y/N] `, r));
  rl.close();
  return /^y(es)?$/i.test(a.trim());
}

(async () => {
  const pluginSrc = path.join(__dirname, '..', 'plugin');
  const version = require(path.join(pluginSrc, 'package.json')).version;
  const defaults = lib.defaultPaths();
  const pluginsDir = arg('--dest') || defaults.pluginsDir;
  const sampleDir = arg('--sample') || defaults.sampleDir;
  let plan;
  try {
    plan = lib.planInstall({ pluginSrc, pluginsDir, sampleDir, version });
  } catch (e) {
    console.error(`Cannot install: ${e.message}`);
    process.exit(1);
  }
  console.log('Edit Suite installation plan');
  console.log(`  Destination:        ${plan.dest}${plan.exists ? '  (existing install will be kept as a .previous backup)' : ''}`);
  console.log(`  Files:              ${plan.files.length} plugin files`);
  console.log(`  Binding:            ${plan.binding}  (copied from your Resolve install)`);
  console.log(`  Manifest elements:  ${plan.manifest.elements.join(', ')}`);
  console.log(`  Manifest values set:${plan.manifest.replaced.join(', ')}${plan.manifest.missing.length ? `  (not present in this Resolve's sample: ${plan.manifest.missing.join(', ')})` : ''}`);
  console.log('  Not touched:        projects, media, presets, Fusion templates, Resolve preferences');
  if (flags.has('--dry-run')) return console.log('\nDry run: nothing was written.');
  if (!(await ask('\nInstall now?'))) return console.log('Cancelled; nothing was written.');
  try {
    const r = lib.performInstall(plan, { pluginSrc });
    console.log(`\nInstalled ${r.files} files to ${r.dest}.${r.backup ? ` Previous version kept at ${r.backup}.` : ''}`);
    console.log('Restart Resolve, then open Workspace > Workflow Integrations > Edit Suite.');
    console.log('First run: Diagnostics > "Calibrate frame conventions" and "Test subtitle import".');
  } catch (e) {
    console.error(`Install failed: ${e.message}`);
    if (e.code === 'EACCES' || e.code === 'EPERM') console.error(process.platform === 'darwin' ? 'Re-run with sudo.' : 'Re-run from an Administrator terminal.');
    process.exit(1);
  }
})();
