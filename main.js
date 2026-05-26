'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const runner = require('./src/runner');
const preflight = require('./src/preflight');
const { ALL_STEPS } = require('./src/executors');
const { openInteractiveTerminal } = require('./src/shell');

const PRODUCT = 'IMP Squad Instalador';
const STATE_DIR = path.join(os.homedir(), '.imp-installer');

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  process.exit(0);
}

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 900,
    minHeight: 640,
    backgroundColor: '#0E1015',
    title: PRODUCT,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false,
    },
  });
  Menu.setApplicationMenu(null);
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.on('closed', () => { mainWindow = null; });
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.whenReady().then(() => {
  createWindow();

  // Post-reboot resume detection: if state says rebootRequired but rebootDone=false,
  // we know this launch is the post-reboot one. Flip the flag.
  try {
    const st = runner.getState();
    if (st && st.rebootRequired && !st.rebootDone) {
      runner.markRebootDone();
    }
  } catch (_) { /* state not initialized yet — ok */ }
});

app.on('window-all-closed', () => {
  runner.shutdown();
  if (process.platform !== 'darwin') app.quit();
});

// ───────────────────────────────────────────────────────────────────────
// Pending sudo password requests. The renderer fulfills them via IPC.
// ───────────────────────────────────────────────────────────────────────
const pendingSudo = new Map();
let sudoSeq = 0;

function requestSudoPassword() {
  const id = `sudo_${++sudoSeq}`;
  return new Promise((resolve, reject) => {
    pendingSudo.set(id, { resolve, reject });
    sendToRenderer('installer:sudoPrompt', { id, prompt: 'A instalação precisa da sua senha do Ubuntu (sudo).' });
  });
}

ipcMain.handle('installer:sudoReply', (_e, { id, password, cancelled }) => {
  const slot = pendingSudo.get(id);
  if (!slot) return { ok: false, error: 'sudo request expired' };
  pendingSudo.delete(id);
  if (cancelled) slot.reject(new Error('senha cancelada pelo usuário'));
  else slot.resolve(password);
  return { ok: true };
});

// ───────────────────────────────────────────────────────────────────────
// Adapter: bridge runner events → renderer IPC events
// (Camila spec: onLog, onStepUpdate, onPreflight, onManualPrompt, onError,
//  onComplete, onState, onToast, onScreen)
// ───────────────────────────────────────────────────────────────────────
function sendToRenderer(channel, payload) {
  if (mainWindow && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

// Fix Eduardo 2.1: runner emits {id,status}; wizard expects {stepId,state}
function buildRunnerEvents() {
  return {
    onLog: (entry) => sendToRenderer('installer:onLog', entry),
    onStepUpdate: (upd) => {
      sendToRenderer('installer:onStepUpdate', {
        stepId: upd.id,
        state: upd.status,
        title: upd.title,
        category: upd.category,
        ...upd,
      });
      if (upd.status === 'running') {
        const step = ALL_STEPS.find(s => s.id === upd.id);
        if (step && step.manualInstructions) {
          sendToRenderer('installer:onManualPrompt', {
            stepId: step.id,
            title: step.title,
            subtitle: step.description,
            instructions: Array.isArray(step.manualInstructions)
              ? step.manualInstructions
              : [String(step.manualInstructions)],
            terminal: step.manualTerminal || null,
            browser: step.manualBrowser || null,
          });
        }
      }
    },
    onError: (err) => sendToRenderer('installer:onError', {
      stepId: err.stepId,
      headline: 'Algo deu errado',
      what: err.error || String(err),
      suggestions: err.suggestions || ['Tente novamente — pode ser instabilidade temporária.'],
      canRetry: true,
      canSkip: err.canSkip !== false,
    }),
    onState: (state) => sendToRenderer('installer:onState', state),
    requestSudoPassword,
  };
}

// ───────────────────────────────────────────────────────────────────────
// IPC handlers — matches `window.api.installer.*` contract
// ───────────────────────────────────────────────────────────────────────

// Fix Eduardo 2.2: preflight backend usa {name,ok,warning,detail}; renderer espera {checkId,state,message}
const PREFLIGHT_NAME_MAP = {
  windows_build: 'windows',
  admin: 'admin',
  disk_c_free_gb: 'disk',
  internet_github: 'internet',
  virtualization: 'virtualization',
  antivirus: 'antivirus',
};

ipcMain.handle('installer:start', async () => {
  runner.startWizard(buildRunnerEvents());
  sendToRenderer('installer:onScreen', { screen: 'preflight' });

  const checks = await preflight.runAll();
  for (const c of checks) {
    sendToRenderer('installer:onPreflight', {
      checkId: PREFLIGHT_NAME_MAP[c.name] || c.name,
      state: c.ok ? 'ok' : (c.warning ? 'warn' : 'err'),
      message: c.detail,
    });
  }
  return { ok: true, checks };
});

ipcMain.handle('installer:resume', async () => {
  const state = runner.startWizard(buildRunnerEvents());
  sendToRenderer('installer:onScreen', { screen: 'progress' });
  return { ok: true, state };
});

ipcMain.handle('installer:runStep', async (_e, { stepId }) => {
  return runner.runStep(stepId, buildRunnerEvents());
});

ipcMain.handle('installer:runAll', async () => {
  runner.runAll(buildRunnerEvents()).then((results) => {
    const allDone = results.every(r => r.status === 'done' || r.status === 'skipped');
    if (allDone) {
      sendToRenderer('installer:onComplete', {
        durationSeconds: 0,
        sala3dInstalled: runner.getState().steps['step_13_sala3d'] === 'done',
      });
    }
  }).catch((e) => {
    sendToRenderer('installer:onError', {
      stepId: null,
      headline: 'Falha geral',
      what: e.message,
      suggestions: ['Veja os logs detalhados', 'Tente retomar'],
      canRetry: true,
      canSkip: false,
    });
  });
  return { ok: true };
});

ipcMain.handle('installer:markManualDone', async (_e, { stepId }) => {
  return runner.markManualDone(stepId);
});

ipcMain.handle('installer:retry', async (_e, { stepId }) => {
  return runner.runStep(stepId, buildRunnerEvents());
});

ipcMain.handle('installer:skip', async (_e, { stepId, reason }) => {
  runner.skipStep(stepId, reason);
  return { ok: true };
});

ipcMain.handle('installer:getState', async () => {
  return runner.getState();
});

ipcMain.handle('installer:listSteps', async () => {
  return runner.listSteps();
});

ipcMain.handle('installer:openTerminal', async (_e, { cmd }) => {
  try {
    await openInteractiveTerminal(cmd);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('installer:openBrowser', async (_e, { url }) => {
  if (!/^https?:\/\//i.test(url)) return { ok: false, error: 'url inválida' };
  shell.openExternal(url);
  return { ok: true };
});

ipcMain.handle('installer:exportLogs', async () => {
  const logDir = path.join(STATE_DIR, 'logs');
  try { fs.mkdirSync(logDir, { recursive: true }); } catch (_) {}
  const target = path.join(logDir, `installer-${Date.now()}.log`);
  const state = runner.getState();
  const dump = [
    `IMP Squad Instalador — log export`,
    `gerado: ${new Date().toISOString()}`,
    `versão: ${app.getVersion()}`,
    `─────────────────────────────────`,
    JSON.stringify(state, null, 2),
  ].join('\n');
  fs.writeFileSync(target, dump);
  return { ok: true, path: target };
});

ipcMain.handle('installer:installSala3D', async () => {
  return runner.runStep('step_13_sala3d', buildRunnerEvents());
});

// Fix Eduardo 2.5: passo 15 cria Desktop/Squad Comando.lnk + %LOCALAPPDATA%\IMP-Squad\IMP-Squad.exe
ipcMain.handle('installer:openInterface', async () => {
  const candidates = [
    path.join(os.homedir(), 'Desktop', 'Squad Comando.lnk'),
    path.join(process.env.LOCALAPPDATA || '', 'IMP-Squad', 'IMP-Squad.exe'),
    path.join(os.homedir(), 'Desktop', 'IMP Squad Comando.exe'),
  ];
  for (const p of candidates) {
    if (p && fs.existsSync(p)) {
      shell.openPath(p);
      return { ok: true, opened: p };
    }
  }
  return { ok: false, error: 'imp-interface.exe não encontrado — instale o passo 15 primeiro' };
});

ipcMain.handle('installer:pause', async () => {
  return { ok: true };
});

ipcMain.handle('installer:closeApp', async () => {
  app.quit();
  return { ok: true };
});

ipcMain.handle('installer:pickFolder', async () => {
  if (!mainWindow) return { ok: false };
  const r = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory'],
  });
  if (r.canceled || !r.filePaths[0]) return { ok: false };
  return { ok: true, path: r.filePaths[0] };
});

ipcMain.handle('app:getVersion', async () => app.getVersion());
