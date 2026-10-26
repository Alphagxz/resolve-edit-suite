'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { identifyAsset, inspectFusionSetting } = require('../plugin/core/assets');
const { catalogueTemplates, searchTemplates } = require('../plugin/core/templates');
const { tmpDir, writeZip, TEXT_PLUS_SETTING, writeBinExport, TOOLS_FOLLOWER, TOOLS_DIRECT, TOOLS_NONE } = require('./helpers/fixtures');
const { inspectBinPresets } = require('../plugin/core/bin-presets');

test('Fusion setting inspection finds Text+ and published text input', () => {
  const info = inspectFusionSetting(TEXT_PLUS_SETTING);
  assert.equal(info.isFusion, true);
  assert.equal(info.macro.type, 'MacroOperator');
  assert.equal(info.hasTextPlus, true);
  assert.deepEqual(info.editableText, [{ sourceOp: 'Template', source: 'StyledText', name: 'Text' }]);
});

test('identifies files by content, not extension', () => {
  const dir = tmpDir();
  const drfx = path.join(dir, 'Pack.drb'); // misleading extension
  writeZip(drfx, { 'Edit/Titles/Pack/Pop Caption.setting': TEXT_PLUS_SETTING, 'Edit/Titles/Pack/Pop Caption.png': 'x' });
  const a = identifyAsset(drfx);
  assert.equal(a.kind, 'fusion-template-bundle');
  assert.equal(a.confidence, 'content');
  assert.equal(a.details.templates[0].hasTextPlus, true);

  const proj = path.join(dir, 'Captions.drp');
  writeZip(proj, { 'project.xml': '<Project/>' });
  assert.equal(identifyAsset(proj).kind, 'resolve-project-archive');

  const db = path.join(dir, 'Project.db');
  fs.writeFileSync(db, Buffer.concat([Buffer.from('SQLite format 3\0'), Buffer.alloc(100)]));
  assert.equal(identifyAsset(db).kind, 'sqlite-database');
  assert.equal(identifyAsset(db).recommendedImport, null);

  const setting = path.join(dir, 'Title.setting');
  fs.writeFileSync(setting, TEXT_PLUS_SETTING);
  assert.equal(identifyAsset(setting).kind, 'fusion-setting');

  const opaque = path.join(dir, 'Caption Pack.drb');
  fs.writeFileSync(opaque, Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 1, 2, 3, 4]));
  const o = identifyAsset(opaque);
  assert.equal(o.kind, 'resolve-bin-export');
  assert.equal(o.confidence, 'extension');
  assert.ok(o.warnings.length > 0);

  const unknown = path.join(dir, 'thing.bin');
  fs.writeFileSync(unknown, Buffer.from([1, 2, 3]));
  assert.equal(identifyAsset(unknown).kind, 'unknown');
});

test('Resolve XML archives: real .drb bin-export layout is a bin, not a project', () => {
  const dir = tmpDir();
  // Entry layout of a real Resolve 20.3 bin export (names only; synthetic contents).
  const layout = {
    'project.xml': '<?xml version="1.0" encoding="UTF-8"?>\n<!--DbAppVer="20.3.0.0010" DbPrjVer="15"-->\n<SM_Project DbId="x"></SM_Project>',
    'MediaPool/Master/000_Pack/000_Timeline/MpFolder.xml': '<Sm2MpFolder/>',
    'MediaPool/Master/000_Pack/001_Text Animation/MpFolder.xml': '<Sm2MpFolder/>',
    'MediaPool/Master/000_Pack/MpFolder.xml': '<Sm2MpFolder/>',
    'MediaPool/Master/MpFolder.xml': '<Sm2MpFolder/>',
    'SeqContainer/a.xml': '<Sm2SequenceContainer/>',
  };
  const drb = path.join(dir, 'Pack.drb');
  writeZip(drb, layout);
  const b = identifyAsset(drb);
  assert.equal(b.kind, 'resolve-bin-export');
  assert.equal(b.confidence, 'content');
  assert.equal(b.recommendedImport, 'MediaPool.ImportFolderFromFile');
  assert.equal(b.details.writtenBy, '20.3.0.0010');
  assert.equal(b.details.sequences, 1);
  assert.deepEqual(b.details.binFolders, ['Pack', 'Pack / Text Animation', 'Pack / Timeline']);

  const drp = path.join(dir, 'Pack.drp');
  writeZip(drp, layout);
  assert.equal(identifyAsset(drp).kind, 'resolve-project-archive');

  const bare = path.join(dir, 'Pack.zip');
  writeZip(bare, layout);
  const u = identifyAsset(bare);
  assert.equal(u.kind, 'resolve-archive-unknown');
  assert.equal(u.recommendedImport, null);
});

test('template catalogue reads folders and .drfx bundles, flags duplicates and insert support', () => {
  const root = tmpDir();
  fs.mkdirSync(path.join(root, 'Edit/Titles/mKeynote'), { recursive: true });
  fs.mkdirSync(path.join(root, 'Edit/Effects'), { recursive: true });
  fs.writeFileSync(path.join(root, 'Edit/Titles/mKeynote/Lower Third 01.setting'), TEXT_PLUS_SETTING);
  fs.writeFileSync(path.join(root, 'Edit/Titles/mKeynote/Lower Third 01.png'), 'png');
  fs.writeFileSync(path.join(root, 'Edit/Effects/Glow Pop.setting'), TEXT_PLUS_SETTING);
  writeZip(path.join(root, 'mKeynote Pack.drfx'), {
    'Edit/Titles/mKeynote Pack/Callout Arrow.setting': TEXT_PLUS_SETTING,
    'Edit/Titles/mKeynote Pack/Lower Third 01.setting': TEXT_PLUS_SETTING,
  });
  const { templates, duplicates, errors } = catalogueTemplates([root, path.join(root, 'missing')]);
  assert.equal(errors.length, 0);
  assert.equal(templates.length, 4);
  const lt = templates.find((t) => t.name === 'Lower Third 01' && !t.bundle);
  assert.equal(lt.category, 'Titles');
  assert.equal(lt.insertSupported, true);
  assert.ok(lt.thumbnail.file.endsWith('.png'));
  assert.equal(lt.ambiguousName, true);
  assert.equal(duplicates.length, 1);
  const fx = templates.find((t) => t.name === 'Glow Pop');
  assert.equal(fx.insertSupported, false);
  assert.match(fx.insertNote, /Manual workflow/);
  assert.deepEqual(searchTemplates(templates, 'callout').map((t) => t.name), ['Callout Arrow']);
  assert.equal(searchTemplates(templates, '', { category: 'Effects' }).length, 1);
});

test('bin presets: decode embedded compositions and classify where the words live', () => {
  const file = path.join(tmpDir(), 'MotionText Pro.drb');
  writeBinExport(file, 'MotionText Pro', [['Smooth Word Up', TOOLS_FOLLOWER], ['Glitch Text', TOOLS_DIRECT], ['slow zoomout', TOOLS_NONE]]);
  const p = inspectBinPresets(file);
  const by = Object.fromEntries(p.map((x) => [x.name, x]));
  assert.equal(by['Smooth Word Up'].wiring, 'follower');
  assert.deepEqual(by['Smooth Word Up'].followers, ['Follower1']);
  assert.equal(by['Glitch Text'].wiring, 'direct');
  assert.equal(by['slow zoomout'].wiring, 'none');
  assert.deepEqual(by['Glitch Text'].format, { width: 2160, height: 3840, rate: 24 });
  assert.equal(by['Glitch Text'].folder, 'MotionText Pro');
  assert.equal(by['Glitch Text'].itemType, 'Generator');
});
