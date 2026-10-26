#!/usr/bin/env node
'use strict';
/**
 * Identify a caption preset / template file by content. Read-only.
 *   node tools/sniff-asset.js "/path/to/MotionText Pro.drb"
 */
const { identifyAsset } = require('../plugin/core/assets');

const file = process.argv[2];
if (!file) {
  console.error('Usage: node tools/sniff-asset.js <file-or-folder>');
  process.exit(2);
}
try {
  const r = identifyAsset(file);
  console.log(JSON.stringify(r, null, 2));
  console.error(`\n${r.kind} (${r.confidence === 'content' ? 'identified by content' : r.confidence === 'extension' ? 'extension only — NOT confirmed by content' : 'unknown'})`);
  console.error(r.recommendedImport ? `Recommended: ${r.recommendedImport}` : 'No automatic import method for this format.');
} catch (e) {
  console.error(`Could not inspect ${file}: ${e.message}`);
  process.exit(1);
}
