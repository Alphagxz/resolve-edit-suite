'use strict';
/**
 * Plugin logic against the MOCK Resolve (test/helpers/fake-resolve.js).
 * These prove the router/operations behave as designed given the API
 * semantics the mock encodes; they are not evidence about real Resolve.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createRouter } = require('../plugin/router');
const { createStorage } = require('../plugin/services/storage');
const { createFakeResolve, MediaPoolItem, Timeline, TimelineItem } = require('./helpers/fake-resolve');
const { tmpDir, writeWav } = require('./helpers/fixtures');

function setup(opts) {
  const fake = createFakeResolve(opts);
  const dir = tmpDir();
  const storage = createStorage(path.join(dir, 'data'));
  const events = [];
  const router = createRouter({ getResolve: () => fake.resolve, storage, emit: (c, p) => events.push([c, p]), pluginVersion: 'test' });
  const tl = new Timeline(fake.project, 'Main Edit', { rate: '25', startFrame: 90000 });
  fake.project.timelines.push(tl);
  fake.project.current = tl;
  return { fake, dir, storage, router, tl, events };
}

async function ok(router, op, args) {
  const r = await router.invoke(op, args);
  if (!r.ok) assert.fail(`${op} failed: ${JSON.stringify(r.error)}`);
  return r.result;
}

test('project summary and capability evaluation (mock 21.1 Studio)', async () => {
  const { router, tl } = setup();
  const mpi = new MediaPoolItem('A001', { FPS: 25 });
  tl.tracks.video[0].push(new TimelineItem({ name: 'A001', start: 90000, end: 90250, mpi }));
  const s = await ok(router, 'project.summary');
  assert.equal(s.timeline.rate, '25');
  assert.equal(s.timeline.durationFrames, 250);
  assert.equal(s.timeline.startTimecode, '01:00:00:00');
  assert.equal(s.capabilities['captions.transcription'].status, 'available');
  // SRT placement has only a single report: disabled until the scratch test passes here
  assert.equal(s.capabilities['captions.srtTrack'].status, 'needs-verification');
  assert.equal(s.capabilities['captions.srtTrack'].evidence, 'reported');
});

test('capabilities on an older / free build are honest', async () => {
  const { router } = setup({ version: [20, 3, 2, 9, ''], studio: false });
  const s = await ok(router, 'project.summary');
  assert.equal(s.capabilities['captions.transcription'].status, 'unavailable');
  assert.ok(s.capabilities['captions.transcription'].reasons.some((r) => /Studio/.test(r)));
  assert.equal(s.capabilities['item.fades'].status, 'unavailable');
});

test('writes require confirmation', async () => {
  const { router } = setup();
  const r = await router.invoke('assets.importBin', {});
  assert.equal(r.ok, false);
  assert.match(r.error.message, /confirmation/);
  assert.equal(r.error.source, 'Input');
});

test('caption preset: validate, import once, dedupe, detect move, relink', async () => {
  const { router, dir, fake } = setup();
  const file = path.join(dir, 'Rayan Herrick Captions.drb');
  fs.writeFileSync(file, Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 9, 9, 9, 9]));
  const set = await ok(router, 'assets.setPreset', { path: file });
  assert.equal(set.record.kind, 'resolve-bin-export');
  assert.equal(set.record.confidence, 'extension');
  const first = await ok(router, 'assets.importBin', { confirm: true });
  assert.equal(first.skipped, false);
  assert.deepEqual(first.folders, ['Rayan Herrick Captions']);
  const second = await ok(router, 'assets.importBin', { confirm: true });
  assert.equal(second.skipped, true);
  assert.equal(fake.project.mediaPool.root.subs.length, 1);
  const styles = await ok(router, 'assets.captionStyles');
  assert.deepEqual(styles.styles.map((s) => s.name), ['Pop Caption', 'Pop Caption Highlight']);

  const moved = path.join(dir, 'moved.drb');
  fs.renameSync(file, moved);
  assert.equal((await ok(router, 'assets.presetStatus')).status, 'moved');
  const r = await router.invoke('assets.importBin', { confirm: true });
  assert.equal(r.ok, false);
  assert.equal(r.error.category, 'asset-missing');
  assert.equal((await ok(router, 'assets.relinkPreset', { path: moved })).record.path, moved);
  assert.equal((await ok(router, 'assets.presetStatus')).status, 'ok');
});

test('project archives are refused for bin import', async () => {
  const { router, dir } = setup();
  const { writeZip } = require('./helpers/fixtures');
  const file = path.join(dir, 'Captions.drp');
  writeZip(file, { 'project.xml': '<Project/>' });
  await ok(router, 'assets.setPreset', { path: file });
  const r = await router.invoke('assets.importBin', { confirm: true });
  assert.equal(r.ok, false);
  assert.match(r.error.message, /PROJECT archive/);
});

function srtFile(dir) {
  const f = path.join(dir, 'in.srt');
  fs.writeFileSync(f, '1\n00:00:01,000 --> 00:00:02,500\nHello there everyone\n\n2\n00:00:03,000 --> 00:00:04,000\nThis is the second line\n');
  return f;
}

test('captions: preview, gated SRT placement, verified after diagnostics test', async () => {
  const { router, dir, tl, fake } = setup();
  tl.minLength = 250;
  const preview = await ok(router, 'captions.prepare', { source: { kind: 'file', path: srtFile(dir) }, options: { maxCharsPerLine: 20 } });
  assert.ok(preview.cues.length >= 2);
  assert.equal(preview.cues[0].startFrame, 90025);
  assert.equal(preview.cues[0].startTc, '01:00:01:00');
  const srt = await ok(router, 'captions.srtText', { previewId: preview.previewId });
  assert.match(srt, /00:00:01,000 -->/);

  const blocked = await router.invoke('captions.applySubtitleTrack', { previewId: preview.previewId, confirm: true });
  assert.equal(blocked.ok, false, 'blocked before verification');
  assert.match(blocked.error.message, /Test subtitle import/);
  const t = await ok(router, 'diag.testSubtitles', { confirm: true });
  assert.equal(t.ok, true, t.detail);
  assert.equal(fake.project.timelines.length, 1, 'scratch timeline removed');
  assert.equal(fake.project.current, tl, 'original timeline restored');

  const summary = await ok(router, 'project.summary');
  assert.equal(summary.capabilities['captions.srtTrack'].status, 'available');
  assert.equal(summary.capabilities['captions.srtTrack'].evidence, 'verified-here');
  const applied = await ok(router, 'captions.applySubtitleTrack', { previewId: preview.previewId, confirm: true });
  assert.equal(applied.verify.ok, true, JSON.stringify(applied.verify));
  assert.match(applied.backup.backupName, /backup/);
  assert.equal(fake.project.current, tl, 'original timeline still current after backup');
});

test('captions: styled placement from imported preset, test-one-first then batch', async () => {
  const { router, dir, tl } = setup();
  tl.minLength = 250;
  const file = path.join(dir, 'Styles.drb');
  fs.writeFileSync(file, 'opaque');
  await ok(router, 'assets.setPreset', { path: file });
  await ok(router, 'assets.importBin', { confirm: true });
  const { styles } = await ok(router, 'assets.captionStyles');
  const preview = await ok(router, 'captions.prepare', { source: { kind: 'file', path: srtFile(dir) }, options: { maxWordsPerCue: 2, emphasis: { words: ['second'] } } });
  const one = await ok(router, 'captions.applyStyled', { previewId: preview.previewId, styleId: styles[0].id, limit: 1, confirm: true });
  assert.equal(one.verify.ok, true, JSON.stringify(one.verify));
  assert.equal(one.textFailures.length, 0);
  const all = await ok(router, 'captions.applyStyled', { previewId: preview.previewId, styleId: styles[0].id, emphasisStyleId: styles[1].id, confirm: true });
  assert.equal(all.verify.ok, true, JSON.stringify(all.verify));
  const track = tl.tracks.video[all.trackIndex - 1];
  assert.equal(track.length, preview.cues.length);
  assert.deepEqual(track.map((i) => i.comp.tool.inputs.StyledText), preview.cues.map((c) => c.text));
  assert.ok(track.some((i) => i.mpi.name === 'Pop Caption Highlight'));
});

test('rough cut: analyse real WAV, review markers, build verified new timeline, original untouched', async () => {
  const { router, dir, tl, fake } = setup();
  const wav = path.join(dir, 'interview.wav');
  // speech 0-2 s, silence 2-4 s, speech 4-6 s
  writeWav(wav, { seconds: 6, sample: (t) => (t < 2 || t >= 4 ? 0.4 * Math.sin(2 * Math.PI * 200 * t) : 0.0003) });
  const mpi = new MediaPoolItem('interview', { FPS: 25, 'File Path': wav });
  tl.tracks.video[0].push(new TimelineItem({ name: 'interview', start: 90000, end: 90150, mpi }));
  tl.tracks.audio[0].push(new TimelineItem({ name: 'interview', start: 90000, end: 90150, mpi }));
  const before = JSON.stringify(tl.tracks.video[0].map((i) => [i.start, i.end]));

  const an = await ok(router, 'roughcut.analyse', { track: { type: 'video', index: 1 }, options: { thresholdDb: -40, paddingMs: 100 } });
  assert.equal(an.cuts.length, 1);
  assert.ok(Math.abs(an.cuts[0].seconds - 1.8) < 0.05, `cut ${an.cuts[0].seconds}s`);

  const m = await ok(router, 'roughcut.markers', { runId: an.runId, enabledIds: [1], confirm: true });
  assert.equal(m.added, 1);
  assert.equal(Object.keys(tl.markers).length, 1);
  await ok(router, 'roughcut.clearMarkers', { runId: an.runId, confirm: true });
  assert.equal(Object.keys(tl.markers).length, 0);

  const dry = await ok(router, 'roughcut.build', { runId: an.runId, enabledIds: [1], dryRun: true });
  assert.equal(dry.dryRun, true);
  assert.equal(dry.plan.pieces, 2);

  const built = await ok(router, 'roughcut.build', { runId: an.runId, enabledIds: [1], confirm: true });
  assert.equal(built.verify.ok, true, JSON.stringify(built.verify));
  assert.equal(fake.project.timelines.length, 2);
  const rc = fake.project.current;
  assert.notEqual(rc, tl);
  const pieces = rc.tracks.video[0].sort((a, b) => a.start - b.start);
  assert.equal(pieces.length, 2);
  assert.equal(pieces[0].end, pieces[1].start, 'continuous');
  assert.equal(pieces[1].end - pieces[0].start, 150 - 45);
  assert.equal(JSON.stringify(tl.tracks.video[0].map((i) => [i.start, i.end])), before, 'original untouched');
  assert.equal(tl.tracks.audio[0].length, 1);
});

test('rough cut on an audio track rebuilds the linked picture track with it', async () => {
  const { router, dir, tl, fake } = setup();
  const wav = path.join(dir, 'linked.wav');
  writeWav(wav, { seconds: 6, sample: (t) => (t < 2 || t >= 4 ? 0.4 * Math.sin(2 * Math.PI * 200 * t) : 0.0003) });
  const mpi = new MediaPoolItem('linked', { FPS: 25, 'File Path': wav });
  tl.tracks.video[0].push(new TimelineItem({ name: 'linked', start: 90000, end: 90150, mpi }));
  tl.tracks.audio[0].push(new TimelineItem({ name: 'linked', start: 90000, end: 90150, mpi }));
  const an = await ok(router, 'roughcut.analyse', { track: { type: 'audio', index: 1 }, options: { thresholdDb: -40 } });
  const b = await ok(router, 'roughcut.build', { runId: an.runId, enabledIds: an.cuts.map((c) => c.id), confirm: true });
  assert.equal(b.verify.ok, true, JSON.stringify(b.verify));
  assert.ok(b.warnings.some((w) => w.type === 'linked'));
  assert.ok(!b.warnings.some((w) => w.type === 'other-track'), 'linked V1 is not reported as dropped');
  const rc = fake.project.current;
  assert.equal(rc.tracks.video[0].length, 2);
  assert.equal(rc.tracks.audio[0].length, 2);
});

test('rough cut with unrelated picture rebuilds audio only and says so', async () => {
  const { router, dir, tl, fake } = setup();
  const wav = path.join(dir, 'pod.wav');
  writeWav(wav, { seconds: 6, sample: (t) => (t < 2 || t >= 4 ? 0.4 * Math.sin(2 * Math.PI * 200 * t) : 0.0003) });
  const mpi = new MediaPoolItem('pod', { FPS: 25, 'File Path': wav });
  tl.tracks.audio[0].push(new TimelineItem({ name: 'pod', start: 90000, end: 90150, mpi }));
  tl.tracks.video[0].push(new TimelineItem({ name: 'broll', start: 90000, end: 90100, mpi: new MediaPoolItem('broll', { FPS: 25 }) }));
  const an = await ok(router, 'roughcut.analyse', { track: { type: 'audio', index: 1 }, options: { thresholdDb: -40 } });
  const b = await ok(router, 'roughcut.build', { runId: an.runId, enabledIds: an.cuts.map((c) => c.id), confirm: true });
  assert.equal(b.verify.ok, true);
  assert.ok(b.warnings.some((w) => w.type === 'single'));
  assert.ok(b.warnings.some((w) => w.type === 'other-track' && /broll/.test(w.message)));
  assert.equal(fake.project.current.tracks.video[0].length, 0);
});

test('rough cut refuses when new timelines would not match the source timeline settings', async () => {
  const { router, dir, tl, fake } = setup();
  const wav = path.join(dir, 'a.wav');
  writeWav(wav, { seconds: 4, sample: (t) => (t < 1 || t > 3 ? 0.4 * Math.sin(1000 * t) : 0) });
  const mpi = new MediaPoolItem('a', { FPS: 25, 'File Path': wav });
  tl.tracks.audio[0].push(new TimelineItem({ name: 'a', start: 90000, end: 90100, mpi }));
  fake.project.settings.timelineFrameRate = '24';
  const an = await ok(router, 'roughcut.analyse', { track: { type: 'audio', index: 1 } });
  const r = await router.invoke('roughcut.build', { runId: an.runId, enabledIds: an.cuts.map((c) => c.id), confirm: true });
  assert.equal(r.ok, false);
  assert.match(r.error.message, /timeline-specific settings/);
  assert.equal(fake.project.timelines.length, 1, 'empty timeline removed');
  assert.equal(fake.project.current, tl);
});

test('calibration measures conventions and cleans up', async () => {
  const { router, tl, fake, storage } = setup();
  const mpi = new MediaPoolItem('A', { FPS: 25 });
  tl.tracks.video[0].push(new TimelineItem({ name: 'A', start: 90000, end: 90100, mpi }));
  const c = await ok(router, 'diag.calibrate', { confirm: true });
  assert.equal(c.appendEndInclusive, true);
  assert.equal(c.itemEndInclusive, false);
  assert.equal(c.timelineEndInclusive, false);
  assert.equal(fake.project.timelines.length, 1);
  assert.equal(storage.loadSettings().calibration.build, '21.1.0.14');
});

test('operation log records successes and classified failures', async () => {
  const { router, storage } = setup();
  await router.invoke('assets.setPreset', { path: '/nope/missing.drb' });
  const log = await ok(router, 'diag.log');
  const last = log[log.length - 1];
  assert.equal(last.result, 'error');
  assert.equal(last.error.category, 'asset-missing');
  assert.equal(last.error.source, 'Missing asset');
  assert.ok(fs.existsSync(storage.logFile));
});

test('no Resolve connection gives an actionable error', async () => {
  const storage = createStorage(path.join(tmpDir(), 'd'));
  const router = createRouter({ getResolve: () => null, storage });
  const r = await router.invoke('project.summary');
  assert.equal(r.ok, false);
  assert.equal(r.error.category, 'resolve-not-connected');
  assert.match(r.error.message, /Workflow Integrations/);
});

test('setup checklist reflects real state', async () => {
  const { router, tl } = setup();
  tl.tracks.video[0].push(new TimelineItem({ name: 'A', start: 90000, end: 90100, mpi: new MediaPoolItem('A', { FPS: 25 }) }));
  let c = await ok(router, 'setup.checklist');
  const byId = (id) => c.steps.find((x) => x.id === id);
  assert.equal(byId('connect').done, true);
  assert.equal(byId('calibrate').done, false);
  assert.equal(byId('preset').done, false);
  await ok(router, 'diag.calibrate', { confirm: true });
  c = await ok(router, 'setup.checklist');
  assert.equal(byId('calibrate').done, true);
});
