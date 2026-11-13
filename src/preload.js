'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  isDesktop: true,
  info: () => ipcRenderer.invoke('app:info'),
  loadLibrary: () => ipcRenderer.invoke('library:load'),
  saveLibrary: (data) => ipcRenderer.invoke('library:save', data),
  flushLibrary: () => ipcRenderer.invoke('library:flush'),
  openFile: () => ipcRenderer.invoke('file:open'),
  saveFile: (options) => ipcRenderer.invoke('file:save', options),
  exportPDF: (options) => ipcRenderer.invoke('pdf:export', options),
  print: () => ipcRenderer.invoke('app:print'),
  setTitle: (title) => ipcRenderer.invoke('win:title', title),
  setDirty: (dirty) => ipcRenderer.invoke('win:dirty', dirty),
  setTheme: (theme) => ipcRenderer.invoke('theme:set', theme),
  workspace: {
    get: () => ipcRenderer.invoke('workspace:get'),
    choose: () => ipcRenderer.invoke('workspace:choose'),
    set: (dir) => ipcRenderer.invoke('workspace:set', dir),
    reset: () => ipcRenderer.invoke('workspace:reset'),
    reveal: () => ipcRenderer.invoke('workspace:reveal')
  },
  ai: {
    getConfig: () => ipcRenderer.invoke('ai:getConfig'),
    saveConfig: (cfg) => ipcRenderer.invoke('ai:saveConfig', cfg),
    test: () => ipcRenderer.invoke('ai:test'),
    run: (payload) => ipcRenderer.invoke('ai:run', payload),
    stop: () => ipcRenderer.invoke('ai:stop'),
    agent: (payload) => ipcRenderer.invoke('ai:agent', payload),
    pickFiles: () => ipcRenderer.invoke('file:pick'),
    inline: (payload) => ipcRenderer.invoke('ai:inline', payload),
    inlineStop: () => ipcRenderer.invoke('ai:inline:stop'),
    onChunk: (cb) => {
      if (globalThis.__aiChunkHandler) ipcRenderer.removeListener('ai:chunk', globalThis.__aiChunkHandler);
      globalThis.__aiChunkHandler = (_event, text) => cb(text);
      ipcRenderer.on('ai:chunk', globalThis.__aiChunkHandler);
      return true;
    },
    onStep: (cb) => {
      if (globalThis.__aiStepHandler) ipcRenderer.removeListener('ai:step', globalThis.__aiStepHandler);
      globalThis.__aiStepHandler = (_event, step) => cb(step);
      ipcRenderer.on('ai:step', globalThis.__aiStepHandler);
      return true;
    },
    onLibrary: (cb) => {
      if (globalThis.__aiLibraryHandler) ipcRenderer.removeListener('ai:library', globalThis.__aiLibraryHandler);
      globalThis.__aiLibraryHandler = (_event, library) => cb(library);
      ipcRenderer.on('ai:library', globalThis.__aiLibraryHandler);
      return true;
    },
    onPlan: (cb) => {
      if (globalThis.__aiPlanHandler) ipcRenderer.removeListener('ai:plan', globalThis.__aiPlanHandler);
      globalThis.__aiPlanHandler = (_event, steps) => cb(steps);
      ipcRenderer.on('ai:plan', globalThis.__aiPlanHandler);
      return true;
    },
    sessions: {
      load: () => ipcRenderer.invoke('ai:sessions:load'),
      save: (store) => ipcRenderer.invoke('ai:sessions:save', store)
    }
  },
  minimize: () => ipcRenderer.invoke('window:minimize'),
  maximize: () => ipcRenderer.invoke('window:maximize'),
  close: () => ipcRenderer.invoke('window:close')
});
