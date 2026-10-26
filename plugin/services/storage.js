'use strict';
/**
 * Suite-owned storage: settings, operation log, generated files (SRT exports,
 * analysis caches). Lives OUTSIDE Resolve's folders so uninstalling the plugin
 * never touches projects, presets or media, and the user can delete it alone.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const APP_DIR_NAME = 'ResolveEditSuite';

function dataDir(platform = process.platform, env = process.env, home = os.homedir()) {
  if (platform === 'darwin') return path.join(home, 'Library/Application Support', APP_DIR_NAME);
  if (platform === 'win32') return path.join(env.APPDATA || path.join(home, 'AppData/Roaming'), APP_DIR_NAME);
  return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), APP_DIR_NAME);
}

const DEFAULT_SETTINGS = Object.freeze({
  schema: 1,
  captionPreset: null, // { path, sha256, size, mtimeMs, kind, confidence, validatedAt }
  captionImports: [], // [{ projectId, projectName, sha256, folders: [names], importedAt }]
  templateRoots: [], // extra roots beyond the OS defaults
  favourites: { templates: [], captionStyles: [] },
  ffmpegPath: null,
  captions: {},
  roughCut: {},
  verified: {}, // featureId -> { ok, at, build, detail } from Diagnostics scratch tests
  calibration: {}, // build -> { appendEndInclusive, getEndInclusive }
});

function createStorage(dir = dataDir()) {
  fs.mkdirSync(dir, { recursive: true });
  const settingsFile = path.join(dir, 'settings.json');
  const logFile = path.join(dir, 'operations.log.jsonl');
  const outDir = path.join(dir, 'generated');
  fs.mkdirSync(outDir, { recursive: true });

  function loadSettings() {
    try {
      const raw = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
      return { ...DEFAULT_SETTINGS, ...raw, favourites: { ...DEFAULT_SETTINGS.favourites, ...(raw.favourites || {}) } };
    } catch (e) {
      if (e.code !== 'ENOENT') {
        // Keep the unreadable file for inspection rather than overwriting it.
        const bad = `${settingsFile}.unreadable-${Date.now()}`;
        try { fs.renameSync(settingsFile, bad); } catch { /* ignore */ }
      }
      return JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
    }
  }

  function saveSettings(s) {
    const tmp = `${settingsFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
    fs.renameSync(tmp, settingsFile); // atomic replace
    return s;
  }

  function updateSettings(fn) {
    const s = loadSettings();
    const next = fn(s) || s;
    return saveSettings(next);
  }

  function appendLog(entry) {
    const line = JSON.stringify({ at: new Date().toISOString(), ...entry });
    fs.appendFileSync(logFile, line + '\n');
  }

  function readLog(limit = 200) {
    try {
      const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n');
      return lines.slice(-limit).map((l) => { try { return JSON.parse(l); } catch { return { raw: l }; } });
    } catch {
      return [];
    }
  }

  function writeGenerated(name, content) {
    const safe = name.replace(/[^\w.\- ]+/g, '_');
    const file = path.join(outDir, safe);
    fs.writeFileSync(file, content);
    return file;
  }

  return { dir, settingsFile, logFile, outDir, loadSettings, saveSettings, updateSettings, appendLog, readLog, writeGenerated };
}

function sha256File(file) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(1 << 20);
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return h.digest('hex');
}

module.exports = { APP_DIR_NAME, dataDir, createStorage, sha256File, DEFAULT_SETTINGS };
