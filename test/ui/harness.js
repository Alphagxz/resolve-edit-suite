'use strict';
/**
 * Development harness: serves the real renderer against the real router and
 * the MOCK Resolve, replacing the Electron preload with an HTTP shim.
 * Usage: node test/ui/harness.js [port]   (prints the URL)
 * Used by test/ui/smoke.js; also handy for UI work without Resolve.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { createRouter } = require('../../plugin/router');
const { createStorage } = require('../../plugin/services/storage');
const { createFakeResolve, MediaPoolItem, Timeline, TimelineItem } = require('../helpers/fake-resolve');
const { tmpDir, writeWav, writeZip, TEXT_PLUS_SETTING } = require('../helpers/fixtures');

function seed() {
  const fake = createFakeResolve();
  const dir = tmpDir('suite-ui-');
  const wav = path.join(dir, 'founder-take-3.wav');
  writeWav(wav, { seconds: 12, sample: (t) => ((t % 4) < 2.6 ? 0.35 * Math.sin(2 * Math.PI * 180 * t) * (0.6 + 0.4 * Math.sin(t * 7)) : 0.0004) });
  const mpi = new MediaPoolItem('founder-take-3', { FPS: 25, 'File Path': wav });
  const tl = new Timeline(fake.project, 'Founder Ad v3', { rate: '25', width: 1080, height: 1920, startFrame: 90000 });
  tl.tracks.video[0].push(new TimelineItem({ name: 'founder-take-3', start: 90000, end: 90300, mpi }));
  tl.tracks.audio[0].push(new TimelineItem({ name: 'founder-take-3', start: 90000, end: 90300, mpi }));
  fake.project.timelines.push(tl);
  fake.project.current = tl;
  fake.project.settings.timelineResolutionWidth = '1080';
  fake.project.settings.timelineResolutionHeight = '1920';
  const srt = path.join(dir, 'founder.srt');
  fs.writeFileSync(srt, '1\n00:00:00,400 --> 00:00:02,400\nWe grew revenue 300% in one quarter\n\n2\n00:00:04,100 --> 00:00:06,500\nand it started with one simple change to our onboarding\n\n3\n00:00:08,000 --> 00:00:10,400\nHere is exactly what we did\n');
  const tplRoot = path.join(dir, 'Templates');
  fs.mkdirSync(path.join(tplRoot, 'Edit/Titles/mKeynote'), { recursive: true });
  fs.writeFileSync(path.join(tplRoot, 'Edit/Titles/mKeynote/Lower Third Clean.setting'), TEXT_PLUS_SETTING);
  writeZip(path.join(tplRoot, 'mKeynote Callouts.drfx'), {
    'Edit/Titles/mKeynote Callouts/Callout Arrow.setting': TEXT_PLUS_SETTING,
    'Edit/Titles/mKeynote Callouts/Zoom Box.setting': TEXT_PLUS_SETTING,
    'Edit/Effects/mKeynote Callouts/Glow Pop.setting': TEXT_PLUS_SETTING,
  });
  const drb = path.join(dir, 'MotionText Pro.drb');
  fs.writeFileSync(drb, 'opaque-bin-export');
  const storage = createStorage(path.join(dir, 'data'));
  storage.updateSettings((s) => ({ ...s, templateRoots: [tplRoot] }));
  return { fake, dir, storage, srt, drb };
}

function start(port = 0) {
  const env = seed();
  const pending = [];
  const router = createRouter({ getResolve: () => env.fake.resolve, storage: env.storage, emit: (channel, payload) => pending.push({ channel, payload }), pluginVersion: '0.1.0-harness' });
  const rendererDir = path.join(__dirname, '../../plugin/renderer');
  const shim = `window.suite = {
    invoke: (op, args) => op === 'app.initError' ? Promise.resolve({ ok: true, result: null }) : fetch('/invoke', { method: 'POST', body: JSON.stringify({ op, args }) }).then((r) => r.json()),
    dialog: (kind, opts) => fetch('/dialog', { method: 'POST', body: JSON.stringify({ kind, opts }) }).then((r) => r.json()),
    writeText: () => Promise.resolve(true),
    on: (ch, fn) => { (window.__h = window.__h || []).push([ch, fn]); return () => {}; },
  };
  setInterval(() => fetch('/events').then((r) => r.json()).then((evs) => evs.forEach((e) => (window.__h || []).forEach(([c, f]) => c === e.channel && f(e.payload)))), 150);`;
  const server = http.createServer(async (req, res) => {
    const body = await new Promise((r) => { let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => r(b)); });
    if (req.url === '/invoke') {
      const { op, args } = JSON.parse(body);
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify(await router.invoke(op, args)));
    }
    if (req.url === '/dialog') {
      const { kind, opts } = JSON.parse(body);
      const exts = (opts && opts.filters && opts.filters[0] && opts.filters[0].extensions) || [];
      const answer = kind === 'open' ? (exts.includes('srt') ? env.srt : exts.includes('drb') ? env.drb : null) : null;
      return res.end(JSON.stringify(answer));
    }
    if (req.url === '/events') return res.end(JSON.stringify(pending.splice(0)));
    if (req.url === '/shim.js') { res.setHeader('content-type', 'text/javascript'); return res.end(shim); }
    const file = path.join(rendererDir, req.url === '/' ? 'index.html' : req.url.slice(1));
    if (!file.startsWith(rendererDir) || !fs.existsSync(file)) { res.statusCode = 404; return res.end(); }
    let content = fs.readFileSync(file);
    if (file.endsWith('index.html')) {
      content = content.toString().replace("connect-src 'none'", "connect-src 'self'").replace('<script src="ui.js"></script>', '<script src="shim.js"></script>\n  <script src="ui.js"></script>');
    }
    res.setHeader('content-type', { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript' }[path.extname(file)] || 'application/octet-stream');
    res.end(content);
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ server, env, url: `http://127.0.0.1:${server.address().port}/` })));
}

if (require.main === module) start(Number(process.argv[2]) || 5173).then(({ url }) => console.log(`Harness at ${url}`));
module.exports = { start };
