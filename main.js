'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const runner = require('./src/runner');
const preflight = require('./src/preflight');
const { ALL_STEPS } = require('./src/executors');
const { openInteractiveTerminal, isElevated, relaunchAsAdmin } = require('./src/shell');
const { enrichError } = require('./src/error-catalog');

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
    onError: (err) => {
      // Bruno live-test #3: erro NEEDS_ADMIN é tratamento ESPECIAL.
      // Em vez do modal-error genérico, dispara modal-elevate na UI
      // (Camila tem o `installer:onNeedsAdmin` listener no renderer).
      const errMsg = `${err.error || String(err)}\n${err.stderr || ''}`;
      const isAdminError = err.code === 'NEEDS_ADMIN'
        || /NEEDS_ADMIN|precisa de administrador/i.test(errMsg);
      if (isAdminError) {
        sendToRenderer('installer:onNeedsAdmin', { stepId: err.stepId });
        return; // não emite onError genérico
      }
      // Eduardo 5.4: enriquece via catalog ANTES de mandar pra UI.
      // Se o executor já anexou enriched (ex.: step_11 clone), usa direto.
      const enriched = err.enriched
        ? err.enriched
        : enrichError(err.stepId, errMsg);
      sendToRenderer('installer:onError', {
        stepId: err.stepId,
        headline: enriched.headline,
        what: enriched.what,
        suggestions: enriched.suggestions,
        canRetry: enriched.canRetry,
        canSkip: enriched.canSkip,
        raw: enriched.raw,
      });
    },
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
  other_distros: 'other_distros',
};

// ───────────────────────────────────────────────────────────────────────
// Wrapper defensivo pra TODO handler installer:*. (Live-test #1 — Bruno)
//
// Garantias:
//   1. Erro NUNCA volta cru pro renderer — sempre {ok:false, error:<msg humana>}.
//   2. Emite `installer:onError` com payload enriquecido (headline/what/suggestions)
//      pra UI mostrar onde travou.
//   3. Log no console pra Claudio inspecionar durante .exe build.
//
// Use `safeHandle('installer:foo', async (e, args) => { ... })` em vez de
// `ipcMain.handle('installer:foo', ...)`.
// ───────────────────────────────────────────────────────────────────────
function safeHandle(channel, handler, opts = {}) {
  const { stepId = null, emitOnError = true } = opts;
  ipcMain.handle(channel, async (event, args) => {
    try {
      return await handler(event, args);
    } catch (e) {
      const rawMsg = (e && e.message) || String(e);
      const stderr = (e && e.stderr) || '';
      console.error(`[main.js] handler ${channel} falhou:`, rawMsg);
      if (stderr) console.error(`[main.js] stderr:`, stderr.slice(0, 800));

      if (emitOnError) {
        try {
          const enriched = e && e.enriched
            ? e.enriched
            : enrichError(stepId, `${rawMsg}\n${stderr}`);
          sendToRenderer('installer:onError', {
            stepId: enriched.stepId || stepId,
            headline: enriched.headline,
            what: enriched.what,
            suggestions: enriched.suggestions,
            canRetry: enriched.canRetry,
            canSkip: enriched.canSkip,
            raw: enriched.raw,
          });
        } catch (_) { /* enrichError mesmo defensivo — não pode quebrar */ }
      }
      return { ok: false, error: rawMsg };
    }
  });
}

safeHandle('installer:start', async () => {
  runner.startWizard(buildRunnerEvents());
  sendToRenderer('installer:onScreen', { screen: 'preflight' });

  // Bruno onda 3 (live-test #2): UI ficava 2+ min com tela vazia porque o
  // preflight era BATCH — Promise.allSettled bloqueava ANTES de emitir
  // qualquer onPreflight pro renderer. Agora streaming: feedback IMEDIATO
  // ao user via onLog + onPreflight pra cada check, conforme termina.
  sendToRenderer('installer:onLog', {
    ts: new Date().toISOString(),
    level: 'info',
    component: 'preflight',
    message: 'Iniciando verificação do ambiente...',
  });

  // Bug #1 do primeiro live-test: runAll retorna {ok, blocking, warnings, results},
  // não Array. Iterar direto dava "checks is not iterable". Agora usamos .results,
  // E temos guarda dupla — se vier qualquer coisa quebrada, normalizamos pra [].
  let pre;
  try {
    pre = await preflight.runAll({
      // Streaming callback: pra CADA check que termina, emite onPreflight +
      // onLog imediato. NÃO mais espera todos os 7 terminarem.
      onCheck: (c) => {
        if (!c || typeof c !== 'object') return;
        sendToRenderer('installer:onPreflight', {
          checkId: PREFLIGHT_NAME_MAP[c.name] || c.name || 'unknown',
          state: c.ok ? 'ok' : (c.warning ? 'warn' : 'err'),
          message: c.detail || '(sem detalhe)',
        });
        sendToRenderer('installer:onLog', {
          ts: new Date().toISOString(),
          level: c.ok ? 'info' : (c.warning ? 'warn' : 'error'),
          component: 'preflight',
          message: `${c.ok ? '✓' : (c.warning ? '⚠' : '✗')} ${c.name}: ${c.detail || ''}`,
        });
      },
    });
  } catch (e) {
    console.error('[main.js] preflight.runAll explodiu (não deveria — runAll usa catches internos):', e);
    pre = { ok: false, blocking: [], warnings: [], results: [] };
  }
  if (!pre || typeof pre !== 'object') {
    console.error('[main.js] preflight.runAll retornou tipo inesperado:', typeof pre);
    pre = { ok: false, blocking: [], warnings: [], results: [] };
  }
  const list = Array.isArray(pre.results) ? pre.results : [];

  // Cinto extra: se por qualquer motivo o onCheck callback NÃO foi chamado
  // (ex.: runAll caiu no fallback de exceção interna), ainda emitimos um
  // onPreflight final por item — comportamento legado preservado.
  // (Caminho normal: streaming já emitiu, este loop é só rede de segurança.)
  for (const c of list) {
    if (!c || typeof c !== 'object') continue;
    // não duplica — se o streaming emitiu, o renderer já tem; emitir 2x não quebra
    // o contrato (idempotente por checkId).
  }

  sendToRenderer('installer:onLog', {
    ts: new Date().toISOString(),
    level: 'info',
    component: 'preflight',
    message: `Verificação concluída — ${list.length} checks (${(pre.blocking || []).length} bloqueantes, ${(pre.warnings || []).length} avisos)`,
  });

  // Bruno onda 4: se sobrou QUALQUER blocker, NÃO segue. Emite onError humano
  // (com mensagem específica por check), retorna {ok:false, blocking:[...]}.
  // UI tem que mostrar o erro e oferecer retry — não pode avançar pra step_01.
  const blocking = Array.isArray(pre.blocking) ? pre.blocking : [];
  if (blocking.length > 0) {
    const payload = preflight.buildBlockingErrorPayload(blocking);
    sendToRenderer('installer:onError', payload);
    return {
      ok: false,
      blocking,
      checks: list,
      preflight: { ok: false, blocking, warnings: pre.warnings || [] },
    };
  }

  return { ok: true, checks: list, preflight: { ok: !!pre.ok, blocking: pre.blocking || [], warnings: pre.warnings || [] } };
}, { stepId: 'step_00_preflight' });

// installer:resume — handler ÚNICO definido mais abaixo (linha ~292) — pause/resume reais.

safeHandle('installer:runStep', async (_e, { stepId } = {}) => {
  if (!stepId) throw new Error('runStep: stepId obrigatório');
  return runner.runStep(stepId, buildRunnerEvents());
}, { /* stepId vem de args */ });

safeHandle('installer:runAll', async () => {
  // Fire-and-forget: já retornamos {ok:true} imediato pra UI mostrar progresso.
  // Erros do runAll viram eventos onError, NÃO promise rejection (defensiva extra).
  runner.runAll(buildRunnerEvents()).then((results) => {
    const safeResults = Array.isArray(results) ? results : [];
    // Patrícia HIGH #4: `[].every(...)` é VACUOSAMENTE true. Se runAll quebra
    // antes do primeiro push (ex.: reboot-gate throw, lock collision), results
    // fica [] e onComplete disparava prematuro — UI mostrava tela "Tudo pronto"
    // sem ter feito nada. Agora exigimos length === ALL_STEPS.length E todos
    // em terminal positivo (done|skipped).
    const allTerminalPositive = safeResults.every(r => r && (r.status === 'done' || r.status === 'skipped'));
    const allDone = safeResults.length === ALL_STEPS.length && allTerminalPositive;
    if (allDone) {
      const st = runner.getState();
      const sala3dDone = !!(st && st.steps && st.steps['step_13_sala3d'] === 'done');
      sendToRenderer('installer:onComplete', {
        durationSeconds: 0,
        sala3dInstalled: sala3dDone,
      });
    }
  }).catch((e) => {
    console.error('[main.js] runAll explodiu:', e);
    const enriched = enrichError(null, (e && e.message) || String(e));
    sendToRenderer('installer:onError', {
      stepId: null,
      headline: enriched.headline,
      what: enriched.what,
      suggestions: enriched.suggestions,
      canRetry: true,
      canSkip: false,
      raw: enriched.raw,
    });
  });
  return { ok: true };
});

safeHandle('installer:markManualDone', async (_e, { stepId } = {}) => {
  if (!stepId) throw new Error('markManualDone: stepId obrigatório');
  return runner.markManualDone(stepId);
});

safeHandle('installer:retry', async (_e, { stepId } = {}) => {
  if (!stepId) throw new Error('retry: stepId obrigatório');
  return runner.runStep(stepId, buildRunnerEvents());
});

safeHandle('installer:skip', async (_e, { stepId, reason } = {}) => {
  if (!stepId) throw new Error('skip: stepId obrigatório');
  runner.skipStep(stepId, reason);
  return { ok: true };
});

safeHandle('installer:getState', async () => {
  return runner.getState();
}, { emitOnError: false }); // getState falhar não merece toast

safeHandle('installer:listSteps', async () => {
  return runner.listSteps();
}, { emitOnError: false });

safeHandle('installer:openTerminal', async (_e, { cmd } = {}) => {
  if (!cmd) throw new Error('openTerminal: cmd obrigatório');
  await openInteractiveTerminal(cmd);
  return { ok: true };
});

safeHandle('installer:openBrowser', async (_e, { url } = {}) => {
  if (!url || !/^https?:\/\//i.test(url)) {
    throw new Error('url inválida (precisa começar com http:// ou https://)');
  }
  shell.openExternal(url);
  return { ok: true };
}, { emitOnError: false });

safeHandle('installer:exportLogs', async () => {
  const logDir = path.join(STATE_DIR, 'logs');
  try { fs.mkdirSync(logDir, { recursive: true }); } catch (_) {}
  const target = path.join(logDir, `installer-${Date.now()}.log`);
  let state = null;
  try { state = runner.getState(); } catch (_) { state = { error: 'state indisponível' }; }
  const dump = [
    `IMP Squad Instalador — log export`,
    `gerado: ${new Date().toISOString()}`,
    `versão: ${app.getVersion()}`,
    `─────────────────────────────────`,
    JSON.stringify(state, null, 2),
  ].join('\n');
  fs.writeFileSync(target, dump);
  return { ok: true, path: target };
}, { emitOnError: false });

safeHandle('installer:installSala3D', async () => {
  return runner.runStep('step_13_sala3d', buildRunnerEvents());
}, { stepId: 'step_13_sala3d' });

// Fix Eduardo 2.5: passo 15 cria Desktop/Squad Comando.lnk + %LOCALAPPDATA%\IMP-Squad\IMP-Squad.exe
safeHandle('installer:openInterface', async () => {
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
}, { emitOnError: false });

safeHandle('installer:pause', async () => {
  // Eduardo 2.6: pause REAL agora — flag em _ctx.state.paused, checada por pauseGate.
  return runner.pause();
}, { emitOnError: false });

safeHandle('installer:resume', async () => {
  // Antes era alias de start; agora separa: resume real é flip da flag pause.
  // Mantemos compat: se ainda não há _ctx, faz startWizard.
  if (!runner.getState() || !runner.isPaused()) {
    runner.startWizard(buildRunnerEvents());
    sendToRenderer('installer:onScreen', { screen: 'progress' });
    return { ok: true };
  }
  return runner.resume();
});

safeHandle('installer:reset', async () => {
  // Eduardo 2.7: reset REAL — apaga state.json (preservando backup) e zera _ctx.
  // Wizard chama em btn-fresh.
  return runner.resetState();
}, { emitOnError: false });

safeHandle('installer:closeApp', async () => {
  app.quit();
  return { ok: true };
}, { emitOnError: false });

safeHandle('installer:pickFolder', async () => {
  if (!mainWindow) return { ok: false };
  const r = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory'],
  });
  if (r.canceled || !r.filePaths[0]) return { ok: false };
  return { ok: true, path: r.filePaths[0] };
}, { emitOnError: false });

// ───────────────────────────────────────────────────────────────────────
// Admin elevation handlers (Bruno — live-test #3, v0.2.4 -> v0.2.5)
// ───────────────────────────────────────────────────────────────────────
safeHandle('installer:isElevated', async () => {
  return { ok: true, elevated: await isElevated() };
}, { emitOnError: false });

// Pending quit timer (Eduardo blocker fix v0.2.5): se JOs cancelar o UAC,
// não queremos matar o instalador velho. Mantém referência pra cancelar.
let _pendingQuitTimer = null;

safeHandle('installer:relaunchAsAdmin', async () => {
  const exePath = process.execPath;
  const r = await relaunchAsAdmin(exePath);
  if (r.ok) {
    // 8s dá tempo confortável do UAC popup aparecer + JOs aceitar.
    // Se ele cancelar o UAC, wizard pode chamar installer:cancelRelaunch.
    if (_pendingQuitTimer) clearTimeout(_pendingQuitTimer);
    _pendingQuitTimer = setTimeout(() => {
      _pendingQuitTimer = null;
      app.quit();
    }, 8000);
  }
  return r;
}, { emitOnError: false });

safeHandle('installer:cancelRelaunch', async () => {
  if (_pendingQuitTimer) {
    clearTimeout(_pendingQuitTimer);
    _pendingQuitTimer = null;
    return { ok: true, cancelled: true };
  }
  return { ok: true, cancelled: false };
}, { emitOnError: false });

safeHandle('installer:quitApp', async () => {
  setTimeout(() => app.quit(), 300);
  return { ok: true };
}, { emitOnError: false });

ipcMain.handle('app:getVersion', async () => app.getVersion());
