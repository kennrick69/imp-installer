'use strict';

const { contextBridge, ipcRenderer } = require('electron');

function on(channel) {
  return (cb) => {
    if (typeof cb !== 'function') return () => {};
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  };
}

const installer = {
  start: () => ipcRenderer.invoke('installer:start'),
  resume: () => ipcRenderer.invoke('installer:resume'),
  runStep: (stepId) => ipcRenderer.invoke('installer:runStep', { stepId }),
  runAll: () => ipcRenderer.invoke('installer:runAll'),
  markManualDone: (stepId) => ipcRenderer.invoke('installer:markManualDone', { stepId }),
  retry: (stepId) => ipcRenderer.invoke('installer:retry', { stepId }),
  skip: (stepId, reason) => ipcRenderer.invoke('installer:skip', { stepId, reason }),
  getState: () => ipcRenderer.invoke('installer:getState'),
  listSteps: () => ipcRenderer.invoke('installer:listSteps'),
  openTerminal: (cmd) => ipcRenderer.invoke('installer:openTerminal', { cmd }),
  openBrowser: (url) => ipcRenderer.invoke('installer:openBrowser', { url }),
  exportLogs: () => ipcRenderer.invoke('installer:exportLogs'),
  installSala3D: () => ipcRenderer.invoke('installer:installSala3D'),
  openInterface: () => ipcRenderer.invoke('installer:openInterface'),
  pause: () => ipcRenderer.invoke('installer:pause'),
  closeApp: () => ipcRenderer.invoke('installer:closeApp'),
  pickFolder: () => ipcRenderer.invoke('installer:pickFolder'),
  reset: () => ipcRenderer.invoke('installer:reset'),

  // Admin elevation (Bruno live-test #3)
  isElevated: () => ipcRenderer.invoke('installer:isElevated'),
  relaunchAsAdmin: () => ipcRenderer.invoke('installer:relaunchAsAdmin'),
  cancelRelaunch: () => ipcRenderer.invoke('installer:cancelRelaunch'),
  quitApp: () => ipcRenderer.invoke('installer:quitApp'),

  sudoReply: (id, password, cancelled = false) =>
    ipcRenderer.invoke('installer:sudoReply', { id, password, cancelled }),

  onLog: on('installer:onLog'),
  onStepUpdate: on('installer:onStepUpdate'),
  onPreflight: on('installer:onPreflight'),
  onManualPrompt: on('installer:onManualPrompt'),
  onError: on('installer:onError'),
  onNeedsAdmin: on('installer:onNeedsAdmin'),
  onElevateTimeout: on('installer:onElevateTimeout'),
  onComplete: on('installer:onComplete'),
  onState: on('installer:onState'),
  onScreen: on('installer:onScreen'),
  onToast: on('installer:onToast'),
  onSudoPrompt: on('installer:sudoPrompt'),
};

contextBridge.exposeInMainWorld('api', {
  installer,
  version: () => ipcRenderer.invoke('app:getVersion'),
});
