'use strict';
/** The only bridge between the sandboxed renderer and the main process. */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('suite', {
  invoke: (op, args) => ipcRenderer.invoke('suite:invoke', op, args),
  dialog: (kind, opts) => ipcRenderer.invoke('suite:dialog', kind, opts),
  writeText: (file, text) => ipcRenderer.invoke('suite:writeText', file, text),
  on: (channel, fn) => {
    if (!['suite:progress', 'suite:task-started'].includes(channel)) return () => {};
    const h = (_e, payload) => fn(payload);
    ipcRenderer.on(channel, h);
    return () => ipcRenderer.removeListener(channel, h);
  },
});
