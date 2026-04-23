'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('kapi', {
  store: {
    get: (key) => ipcRenderer.invoke('store:get', key),
    set: (key, value) => ipcRenderer.invoke('store:set', key, value),
    delete: (key) => ipcRenderer.invoke('store:delete', key),
    getAll: () => ipcRenderer.invoke('store:getAll')
  },
  apiKeys: {
    list: () => ipcRenderer.invoke('apiKeys:list'),
    save: (keys) => ipcRenderer.invoke('apiKeys:save', keys),
    getActive: () => ipcRenderer.invoke('apiKeys:getActive')
  },
  files: {
    detectLatest: (folder, pattern) => ipcRenderer.invoke('files:detectLatest', folder, pattern),
    readText: (p) => ipcRenderer.invoke('files:readText', p),
    selectTxt: () => ipcRenderer.invoke('files:selectTxt'),
    selectFolder: (title) => ipcRenderer.invoke('files:selectFolder', title),
    selectSaveXlsx: (defaultPath) => ipcRenderer.invoke('files:selectSaveXlsx', defaultPath),
    openPath: (p) => ipcRenderer.invoke('files:openPath', p),
    showInFolder: (p) => ipcRenderer.invoke('files:showInFolder', p),
    archive: (sourcePath, mode) => ipcRenderer.invoke('files:archive', sourcePath, mode)
  },
  excel: {
    appendRows: (rows, targetPath) => ipcRenderer.invoke('excel:appendRows', rows, targetPath),
    saveAs: (rows, suggestedName) => ipcRenderer.invoke('excel:saveAs', rows, suggestedName)
  },
  notify: {
    toast: (title, body) => ipcRenderer.invoke('notify:toast', title, body)
  },
  app: {
    setAutoLaunch: (enabled) => ipcRenderer.invoke('app:setAutoLaunch', enabled),
    getAutoLaunch: () => ipcRenderer.invoke('app:getAutoLaunch'),
    setMinimizeToTray: (enabled) => ipcRenderer.invoke('app:setMinimizeToTray', enabled),
    getVersion: () => ipcRenderer.invoke('app:getVersion'),
    quit: () => ipcRenderer.invoke('app:quit'),
    openExternal: (url) => ipcRenderer.invoke('app:openExternal', url)
  },
  update: {
    check: () => ipcRenderer.invoke('update:check'),
    install: () => ipcRenderer.invoke('update:install'),
    currentVersion: () => ipcRenderer.invoke('update:current'),
    releases: () => ipcRenderer.invoke('update:releases'),
    onEvent: (type, cb) => {
      const channel = `update:${type}`;
      const handler = (_e, payload) => cb(payload);
      ipcRenderer.on(channel, handler);
      return () => ipcRenderer.removeListener(channel, handler);
    }
  }
});
