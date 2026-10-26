'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const lib = require('../tools/install-lib');
const { tmpDir } = require('./helpers/fixtures');

const SAMPLE_MANIFEST = `<?xml version="1.0" encoding="UTF-8"?>
<BlackmagicDesign>
    <Plugin>
        <Id>com.blackmagicdesign.resolve.sampleplugin</Id>
        <Name>Sample Plugin</Name>
        <Version>1.0.0</Version>
        <Description>Sample</Description>
        <FilePath>main.js</FilePath>
    </Plugin>
</BlackmagicDesign>`;

function fixture() {
  const root = tmpDir('install-');
  const sample = path.join(root, 'SamplePlugin');
  fs.mkdirSync(sample, { recursive: true });
  fs.writeFileSync(path.join(sample, 'manifest.xml'), SAMPLE_MANIFEST);
  fs.writeFileSync(path.join(sample, 'WorkflowIntegration.node'), 'binary');
  const plugins = path.join(root, 'Workflow Integration Plugins');
  fs.mkdirSync(plugins);
  return { root, sample, plugins, pluginSrc: path.join(__dirname, '..', 'plugin') };
}

test('manifest is derived from the sample, keeping its structure', () => {
  const m = lib.manifestFromSample(SAMPLE_MANIFEST, '0.1.0');
  assert.deepEqual(m.missing, []);
  assert.match(m.xml, /<Id>com\.editsuite\.resolve\.panel<\/Id>/);
  assert.match(m.xml, /<Version>0\.1\.0<\/Version>/);
  assert.match(m.xml, /<BlackmagicDesign>/);
  assert.ok(m.elements.includes('Plugin'));
});

test('install refuses when the sample is missing or its manifest format changed', () => {
  const f = fixture();
  assert.throws(() => lib.planInstall({ pluginSrc: f.pluginSrc, pluginsDir: f.plugins, sampleDir: path.join(f.root, 'nope'), version: '0.1.0' }), /sample/);
  fs.writeFileSync(path.join(f.sample, 'manifest.xml'), '<Root><Name>x</Name></Root>');
  assert.throws(() => lib.planInstall({ pluginSrc: f.pluginSrc, pluginsDir: f.plugins, sampleDir: f.sample, version: '0.1.0' }), /format changed/);
});

test('install, reinstall with backup, uninstall removes only receipt files', () => {
  const f = fixture();
  const plan = lib.planInstall({ pluginSrc: f.pluginSrc, pluginsDir: f.plugins, sampleDir: f.sample, version: '0.1.0' });
  const r = lib.performInstall(plan, { pluginSrc: f.pluginSrc });
  assert.ok(fs.existsSync(path.join(r.dest, 'main.js')));
  assert.ok(fs.existsSync(path.join(r.dest, 'core', 'timebase.js')));
  assert.equal(fs.readFileSync(path.join(r.dest, 'WorkflowIntegration.node'), 'utf8'), 'binary');

  const plan2 = lib.planInstall({ pluginSrc: f.pluginSrc, pluginsDir: f.plugins, sampleDir: f.sample, version: '0.1.0' });
  const r2 = lib.performInstall(plan2, { pluginSrc: f.pluginSrc });
  assert.ok(r2.backup && fs.existsSync(r2.backup));

  fs.writeFileSync(path.join(r2.dest, 'my-notes.txt'), 'user file');
  const u = lib.performUninstall(r2.dest);
  assert.ok(u.removed > 10);
  assert.deepEqual(u.leftover, ['my-notes.txt']);
});

test('install will not overwrite a folder it did not create; uninstall will not delete one', () => {
  const f = fixture();
  const foreign = path.join(f.plugins, lib.PLUGIN_FOLDER);
  fs.mkdirSync(foreign);
  fs.writeFileSync(path.join(foreign, 'x.js'), '');
  const plan = lib.planInstall({ pluginSrc: f.pluginSrc, pluginsDir: f.plugins, sampleDir: f.sample, version: '0.1.0' });
  assert.throws(() => lib.performInstall(plan, { pluginSrc: f.pluginSrc }), /not installed by this installer/);
  assert.throws(() => lib.performUninstall(foreign), /refusing/);
  assert.ok(fs.existsSync(path.join(foreign, 'x.js')));
});
