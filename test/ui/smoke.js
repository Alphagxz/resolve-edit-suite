'use strict';
/**
 * UI smoke test in Chromium against the harness (mock Resolve).
 * Walks every view, drives the main flows, fails on console errors and
 * writes screenshots to the directory given as argv[2].
 */
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');
const { start } = require('./harness');

(async () => {
  const outDir = process.argv[2] || path.join(__dirname, 'screens');
  fs.mkdirSync(outDir, { recursive: true });
  const { server, url } = await start(0);
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, colorScheme: 'dark' });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => d.accept());
  const shot = (name) => page.screenshot({ path: path.join(outDir, `${name}.png`), fullPage: false });
  const nav = async (view) => { await page.click(`[data-view=${view}]`); await page.waitForTimeout(400); };
  const confirm = async () => { await page.click('#confirm-ok'); await page.waitForTimeout(500); };
  const toastText = async () => (await page.$$eval('.toast', (els) => els.map((e) => e.textContent))).join(' | ');

  await page.goto(url);
  await page.waitForSelector('.chip b');
  await page.waitForTimeout(500);
  await shot('01-overview');

  await nav('setup');
  await page.click('text=Locate preset file…');
  await page.waitForSelector('text=Import into current project');
  await page.click('text=Import into current project');
  await confirm();
  await page.waitForTimeout(400);
  if (!/Imported/.test(await toastText())) throw new Error('bin import toast missing: ' + (await toastText()));
  await shot('02-setup');

  await nav('captions');
  // Default source: captions from the timeline's audio (Resolve speech-to-text).
  await page.waitForSelector("text=Keep Resolve's subtitle track");
  await page.check('text=Numbers');
  await page.click('button:has-text("Generate preview")');
  await page.waitForSelector('.frame .capbox', { timeout: 15000 });
  await page.waitForTimeout(400);
  await shot('03-captions-preview');
  await page.selectOption('label.field:has-text("Caption style") select', { index: 1 });
  await page.click('text=Place first caption (test)');
  await confirm();
  await page.waitForTimeout(600);
  if (!/placement verified/.test(await toastText())) throw new Error('styled caption toast missing: ' + (await toastText()));
  await page.waitForSelector('text=Last placement');
  if (!/Resolve read back/.test(await page.textContent('body'))) throw new Error('text diagnostics missing');
  await shot('04-captions-applied');
  await page.click('text=Remove these captions');
  await confirm();
  await page.waitForTimeout(500);
  if (!/caption\(s\) removed/.test(await toastText())) throw new Error('removal toast missing: ' + (await toastText()));
  // The subtitle-file source still works.
  await page.click('.seg button:has-text("Subtitle file")');
  await page.click('text=Browse…');
  await page.waitForTimeout(300);
  await page.click('button:has-text("Regenerate preview")');
  await page.waitForTimeout(800);

  await nav('roughcut');
  await page.click('button:has-text("Analyse")');
  await page.waitForSelector('text=proposed cuts');
  await page.waitForTimeout(300);
  await shot('05-roughcut-review');
  await page.click('text=Build rough-cut timeline');
  await confirm();
  await page.waitForTimeout(800);
  if (!/continuity verified/.test(await toastText())) throw new Error('rough cut toast missing: ' + (await toastText()));

  await nav('motion');
  await page.waitForSelector('.tile');
  await page.waitForTimeout(500);
  await shot('06-motion');
  await page.fill('input[placeholder="Search templates"]', 'arrow');
  await page.waitForTimeout(500);
  const tiles = await page.$$eval('.tile .name', (els) => els.map((e) => e.textContent));
  if (tiles.length !== 1 || tiles[0] !== 'Callout Arrow') throw new Error('template search failed: ' + tiles.join(','));

  await nav('diagnostics');
  await page.waitForSelector('text=Verify on this machine');
  await page.waitForTimeout(400);
  await shot('07-diagnostics');
  await nav('settings');
  await page.waitForTimeout(400);
  await shot('08-settings');

  await page.setViewportSize({ width: 920, height: 700 });
  await nav('captions');
  await page.waitForTimeout(400);
  await shot('09-narrow');

  await browser.close();
  server.close();
  if (errors.length) {
    console.error('Console errors:\n' + errors.join('\n'));
    process.exit(1);
  }
  console.log(`UI smoke passed; screenshots in ${outDir}`);
})().catch((e) => { console.error(e); process.exit(1); });
