'use strict';
/**
 * Workflow Integration entry point (Electron main process).
 *
 * Structure follows the sandboxed sample shipped with Resolve 19.0.2+
 * (contextIsolation + preload + IPC; the renderer has no Node access).
 * VERIFY against Developer/Workflow Integrations/Examples/SamplePlugin of
 * your installed Resolve 21.1 — tools/install.js checks the manifest
 * fields against that sample and copies WorkflowIntegration.node from it.
 */
const path = require('path');
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const { createStorage } = require('./services/storage');
const { createRouter } = require('./router');

const PLUGIN_ID = 'com.editsuite.resolve.panel';
const PLUGIN_VERSION = require('./package.json').version;

let WorkflowIntegration = null;
let resolveObj = null;
let initError = null;
let win = null;
const approvedWrites = new Set();

function loadBinding() {
  try {
    WorkflowIntegration = require('./WorkflowIntegration.node');
  } catch (e) {
    initError = `WorkflowIntegration.node could not be loaded (${e.message}). Re-run the installer, which copies it from your Resolve installation.`;
    return;
  }
  try {
    const ok = WorkflowIntegration.Initialize(PLUGIN_ID);
    if (!ok) initError = 'Resolve refused to initialise the plugin (Initialize returned false). Check that the plugin Id in manifest.xml matches.';
  } catch (e) {
    initError = `WorkflowIntegration.Initialize failed: ${e.message}`;
  }
  if (!initError && typeof WorkflowIntegration.SetAPITimeout === 'function') {
    try { WorkflowIntegration.SetAPITimeout(60); } catch { /* optional */ }
  }
}

function getResolve() {
  if (initError) return null;
  if (!resolveObj) {
    try { resolveObj = WorkflowIntegration.GetResolve(); } catch { resolveObj = null; }
  }
  return resolveObj;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#121316',
    title: 'Edit Suite',
    useContentSize: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.on('closed', () => { win = null; });
}

app.whenReady().then(() => {
  loadBinding();
  const storage = createStorage();
  const emit = (channel, payload) => { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); };
  const router = createRouter({ getResolve, storage, emit, pluginVersion: PLUGIN_VERSION });

  ipcMain.handle('suite:invoke', async (_e, op, args) => {
    if (op === 'app.initError') return { ok: true, result: initError };
    return router.invoke(op, args);
  });
  ipcMain.handle('suite:dialog', async (_e, kind, opts = {}) => {
    if (kind === 'open') {
      const r = await dialog.showOpenDialog(win, { properties: opts.directory ? ['openDirectory'] : ['openFile'], filters: opts.filters });
      return r.canceled ? null : r.filePaths[0];
    }
    if (kind === 'save') {
      const r = await dialog.showSaveDialog(win, { defaultPath: opts.defaultPath, filters: opts.filters });
      if (r.canceled) return null;
      approvedWrites.add(r.filePath);
      return r.filePath;
    }
    if (kind === 'reveal' && opts.path) { shell.showItemInFolder(opts.path); return true; }
    return null;
  });
  ipcMain.handle('suite:writeText', async (_e, file, text) => {
    // Only files the user just chose in a save dialog may be written.
    if (!approvedWrites.has(file)) throw new Error('Writing is only allowed to a location chosen in the save dialog.');
    approvedWrites.delete(file);
    require('fs').writeFileSync(file, String(text));
    return true;
  });
  createWindow();
});

app.on('window-all-closed', () => {
  if (WorkflowIntegration && typeof WorkflowIntegration.CleanUp === 'function') {
    try { WorkflowIntegration.CleanUp(); } catch { /* ignore */ }
  }
  app.quit();
});
