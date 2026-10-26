#!/usr/bin/env node
'use strict';
/**
 * Clean uninstall.
 *   node tools/uninstall.js [--yes] [--dest <WorkflowIntegrationPluginsDir>] [--purge-data]
 *
 * Removes ONLY the files listed in the install receipt. Your projects,
 * timelines (including Edit Suite backups and rough cuts, which are ordinary
 * timelines you own), imported caption bins, media, presets and Fusion
 * templates are never touched.
 * --purge-data additionally deletes the suite's own settings, operation log and
 * generated SRT files (kept by default).
 */
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const lib = require('./install-lib');
const { dataDir } = require('../plugin/services/storage');

const flags = new Set(process.argv.slice(2));
const i = process.argv.indexOf('--dest');
const pluginsDir = i > 0 ? process.argv[i + 1] : lib.defaultPaths().pluginsDir;

async function ask(q) {
  if (flags.has('--yes')) return true;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const a = await new Promise((r) => rl.question(`${q} [y/N] `, r));
  rl.close();
  return /^y(es)?$/i.test(a.trim());
}

(async () => {
  const dest = path.join(pluginsDir || '', lib.PLUGIN_FOLDER);
  if (!pluginsDir || !fs.existsSync(dest)) {
    console.log(`Edit Suite is not installed at ${dest}. Nothing to do.`);
  } else {
    console.log(`Will remove the Edit Suite plugin files listed in ${path.join(dest, lib.RECEIPT)}.`);
    if (!(await ask('Uninstall the plugin?'))) return console.log('Cancelled.');
    try {
      const r = lib.performUninstall(dest);
      console.log(`Removed ${r.removed} file(s).${r.leftover.length ? ` Kept files you added: ${r.leftover.join(', ')}` : ''}`);
    } catch (e) {
      console.error(`Uninstall stopped: ${e.message}`);
      process.exit(1);
    }
  }
  const data = dataDir();
  if (flags.has('--purge-data') && fs.existsSync(data)) {
    if (await ask(`Also delete suite settings, operation log and generated files in ${data}?`)) {
      fs.rmSync(data, { recursive: true, force: true });
      console.log('Suite data removed.');
    }
  } else if (fs.existsSync(data)) {
    console.log(`Suite data kept at ${data} (use --purge-data to remove it).`);
  }
  console.log('Your projects, media, caption presets and templates were not modified.');
})();
