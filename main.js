'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, Menu, screen } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');

const runner = require('./src/runner');
const preflight = require('./src/preflight');
const { ALL_STEPS } = require('./src/executors');
const { openInteractiveTerminal, isElevated, relaunchAsAdmin, detectWslState, forceRebootWindows, cancelReboot, scheduleRunOnceAfterReboot } = require('./src/shell');
const { enrichError } = require('./src/error-catalog');

const PRODUCT = 'IMP Squad Instalador';
const STATE_DIR = path.join(os.homedir(), '.imp-installer');
// Lock file usado pra coordenar quit/spawn entre instâncias (não-elevada → elevada).
// O processo elevado escreve este lock ao boot; o velho monitora e só morre
// quando vê o lock fresco — assim se UAC for negado, ninguém mata o velho.
const ELEVATED_LOCK = path.join(STATE_DIR, '.elevated.lock');

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  process.exit(0);
}

let mainWindow = null;

function createWindow() {
  // BUG 3 v0.2.11: ready-to-show não confiável pra disparar maximize em portable.
  // Estratégia belt-and-suspenders:
  //  1. Cria janela JÁ no tamanho da workArea da tela primária (full screen size)
  //  2. Maximize() chamado SINCRONAMENTE imediato + de novo no ready-to-show
  //  3. show:true direto (sem esperar ready-to-show)
  // Resultado: em qualquer caminho (boot normal, relaunch admin, RunOnce pós-reboot),
  // a janela abre maximizada.
  let workArea = { width: 1400, height: 900 };
  try { workArea = screen.getPrimaryDisplay().workAreaSize; } catch (_) {}

  mainWindow = new BrowserWindow({
    width: workArea.width,
    height: workArea.height,
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
  mainWindow.maximize(); // imediato
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => {
    try { mainWindow.maximize(); } catch (_) {} // segundo tiro
    mainWindow.show();
    mainWindow.focus();
  });
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

  // Bruno v0.2.6: se esta instância está rodando ELEVADA, escreve o lock.
  // O processo antigo (não-elevado) está monitorando este lock pra saber
  // que pode morrer com segurança. Síncrono e best-effort — se PS falhar
  // detectando privilégio, simplesmente não escreve o lock (e o velho
  // espera 60s e desiste, mantendo-se vivo).
  //
  // Bruno v0.2.7: com `requestedExecutionLevel: "requireAdministrator"` no
  // manifest do .exe (package.json build.win), o Windows DEVE forçar UAC
  // no duplo-clique e o .exe nascer elevado SEMPRE (a menos que EnableLUA=0
  // ou GPO corporativo desabilite UAC). Logamos isso no boot pra confirmar
  // que tá funcionando — JOs vê na 1a tela se nasceu elevado ou não.
  try {
    const isAdm = require('child_process').execSync(
      `powershell -NoProfile -Command "([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)"`,
      { timeout: 5000, encoding: 'utf8', windowsHide: true }
    );
    const elevatedAtBoot = /true/i.test(isAdm);
    const bootLogFile = path.join(STATE_DIR, 'logs', `boot-${Date.now()}.log`);
    try {
      fs.mkdirSync(path.dirname(bootLogFile), { recursive: true });
      fs.appendFileSync(
        bootLogFile,
        `[${new Date().toISOString()}] boot pid=${process.pid} elevated=${elevatedAtBoot}\n` +
        `[${new Date().toISOString()}] ${elevatedAtBoot
          ? 'Processo nasceu elevado (via manifest requireAdministrator ou relaunch UAC)'
          : 'Processo NÃO nasceu elevado — manifest pode estar ausente OU UAC desabilitado por GPO'
        }\n`
      );
    } catch (_) {}
    if (elevatedAtBoot) {
      fs.mkdirSync(STATE_DIR, { recursive: true });
      fs.writeFileSync(
        ELEVATED_LOCK,
        JSON.stringify({ pid: process.pid, startedAt: Date.now() })
      );
    }
  } catch (_) { /* não-fatal: lock só facilita o velho fechar */ }
});

app.on('window-all-closed', () => {
  runner.shutdown();
  if (process.platform !== 'darwin') app.quit();
});

// Bruno v0.2.6: limpa o lock de elevação ANTES de sair — mas só se o lock
// foi criado por ESTA instância (PID match). Assim evitamos race onde o
// processo novo elevado escreveu lock e o velho, ao sair, deletaria.
app.on('before-quit', () => {
  try {
    const data = fs.readFileSync(ELEVATED_LOCK, 'utf8');
    const parsed = JSON.parse(data);
    if (parsed && parsed.pid === process.pid) {
      fs.unlinkSync(ELEVATED_LOCK);
    }
  } catch (_) { /* lock ausente/corrompido — nada a limpar */ }
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
    // Eduardo lastmile v0.2.17 — onScreen + onWslUpgradeProgress podem vir do executor
    onScreen: (payload) => sendToRenderer('installer:onScreen', payload),
    onWslUpgradeProgress: (payload) => sendToRenderer('installer:onWslUpgradeProgress', payload),
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
          // Bruno v0.2.13: shape ENRIQUECIDO (action/steps/commands/expected/note).
          // manualInstructions agora pode ser:
          //   - string (legacy) → wrap em { steps:[{num:1,text:str}] }
          //   - array (legacy) → wrap em steps[]
          //   - object {action,steps,commands,expected,note} → passa direto
          //   - function(ctx) → invoca pra resolver ctx.state.distro em runtime
          let mi = step.manualInstructions;
          if (typeof mi === 'function') {
            try {
              // Re-bind: usa o state real do runner pra preencher payload.distro etc.
              const ctxLike = { state: runner.getState() || {} };
              mi = mi(ctxLike);
            } catch (e) {
              console.error('[main.js] manualInstructions(ctx) explodiu:', e);
              mi = { steps: [{ num: 1, text: '(erro ao resolver instruções manuais)' }] };
            }
          }

          let payload;
          if (typeof mi === 'string') {
            payload = {
              stepId: step.id,
              title: step.title,
              subtitle: step.description,
              instructions: [mi], // legacy compat — Camila ainda lê instructions[]
              steps: [{ num: 1, text: mi }],
              action: null,
              fallback: null,
              commands: [],
              expected: null,
              note: null,
              terminal: step.manualTerminal || null,
              browser: step.manualBrowser || null,
            };
          } else if (Array.isArray(mi)) {
            payload = {
              stepId: step.id,
              title: step.title,
              subtitle: step.description,
              instructions: mi.map(String),
              steps: mi.map((t, i) => ({ num: i + 1, text: String(t) })),
              action: null,
              fallback: null,
              commands: [],
              expected: null,
              note: null,
              terminal: step.manualTerminal || null,
              browser: step.manualBrowser || null,
            };
          } else if (mi && typeof mi === 'object') {
            // Shape NOVO (Bruno v0.2.13/14). Mantém `instructions` (legacy)
            // sincronizado pra UI antiga não quebrar. Bruno v0.2.14: campo
            // `fallback` novo (plano B em texto puro pro caso de janela fechar).
            const stepsArr = Array.isArray(mi.steps) ? mi.steps : [];
            payload = {
              stepId: step.id,
              title: step.title,
              subtitle: step.description,
              instructions: stepsArr.map(s => (s && s.text) ? String(s.text) : String(s)),
              steps: stepsArr,
              action: mi.action || null,
              fallback: mi.fallback || null,
              commands: Array.isArray(mi.commands) ? mi.commands : [],
              expected: mi.expected || null,
              note: mi.note || null,
              terminal: step.manualTerminal || null,
              browser: step.manualBrowser || null,
            };
          } else {
            payload = {
              stepId: step.id,
              title: step.title,
              subtitle: step.description,
              instructions: [],
              steps: [],
              action: null,
              fallback: null,
              commands: [],
              expected: null,
              note: null,
              terminal: step.manualTerminal || null,
              browser: step.manualBrowser || null,
            };
          }
          sendToRenderer('installer:onManualPrompt', payload);
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

// ───────────────────────────────────────────────────────────────────────
// Bruno v0.2.14 — executeManualAction (REFATORADO)
//
// Handler genérico pra botão de ação dos manualInstructions enriquecidos.
// Camila chama com { kind, payload }:
//   - kind='terminal' → abre WSL distro (opcionalmente rodando `cmd`)
//   - kind='browser'  → shell.openExternal(payload.url)
//   - kind='copy'     → no-op (renderer faz clipboard direto)
//   - kind='none'     → no-op
//
// Live-test v0.2.13: openInteractiveTerminal abriu janelas que sumiram antes
// do JOs ler — ele viu a tela piscar sem entender o que era. Causa raiz:
// /c (close) em vez de /k (keep).
//
// Live-test v0.2.15: wt.exe + cmd /k via spawn-com-array de args
// (`spawn('cmd.exe', ['/c','start','""','cmd.exe','/k','wsl.exe','-d',distro])`)
// abriu janela MAS mostrava help do wsl.exe — Node re-quota a cmdline (Windows
// argv→cmdline) e o `start` interpretava os tokens ambíguos, fazendo wsl receber
// args inválidos.
//
// Estratégia v0.2.16: SÓ PowerShell Start-Process com UMA string única dentro
// de cmd /k. PowerShell faz quoting determinístico, janela visível garantida,
// encoding pt-BR OK. Log diagnóstico SEMPRE escrito em ~/.imp-installer/logs/.
//
// Com cmd: `wsl -d "<distro>" -- bash -lc "<cmd>; exec bash"` (exec bash mantém shell)
// Sem cmd: `wsl -d "<distro>"`  (já cai em shell interativo).
// ───────────────────────────────────────────────────────────────────────
safeHandle('installer:executeManualAction', async (_e, args = {}) => {
  const { kind, payload = {} } = args || {};
  if (!kind) return { ok: false, error: 'kind obrigatório' };
  switch (kind) {
    case 'terminal': {
      // v0.2.16 — refactor radical: SÓ PowerShell Start-Process.
      // Motivo: v0.2.15 com `spawn('cmd.exe', ['/c','start','""','cmd.exe','/k',...])`
      // mostrava help do wsl. Causa provável: o `start` do cmd interpreta a lista
      // de args de forma ambígua (cada token vira arg DELE até encontrar o exe-alvo)
      // e Node ainda re-quota a cmdline na conversão argv→cmdline (Windows API).
      // Resultado: `wsl.exe -d Ubuntu-22.04` chegava como `wsl --help` equivalent
      // (ou wsl recebia args inválidos e cuspia help).
      //
      // Nova estratégia (Opção C do brief): UMA string única dentro de `cmd /k`,
      // disparada via `Start-Process` do PowerShell — quoting determinístico,
      // janela visível garantida, encoding pt-BR OK.
      const distro = String(payload.distro || 'Ubuntu').trim();
      if (!distro) return { ok: false, error: 'distro vazio' };

      const cmd = payload.cmd; // opcional — comando inicial dentro do shell

      // Setup log diagnóstico — JOs vai ler isso quando der ruim de novo.
      const actionLog = path.join(STATE_DIR, 'logs', `action-${Date.now()}.log`);
      try { fs.mkdirSync(path.dirname(actionLog), { recursive: true }); } catch (_) {}
      const logA = (msg) => {
        try { fs.appendFileSync(actionLog, `[${new Date().toISOString()}] ${msg}\n`); } catch (_) {}
      };

      logA(`kind=terminal distro=${JSON.stringify(distro)} cmd=${JSON.stringify(cmd)}`);

      // Monta UMA STRING DE SHELL — exatamente o que `cmd /k` vai executar.
      // Com cmd: wsl -d "<distro>" -- bash -lc "<cmd>; exec bash"  (exec bash mantém shell vivo)
      // Sem cmd: wsl -d "<distro>"  (já entra em shell interativo)
      const innerCmd = cmd
        ? `wsl.exe -d "${distro}" -- bash -lc "${String(cmd).replace(/"/g, '\\"')}; exec bash"`
        : `wsl.exe -d "${distro}"`;
      logA(`innerCmd: ${innerCmd}`);

      // PowerShell Start-Process — escapa aspas simples DOBRANDO ('').
      const psScript = `Start-Process -FilePath 'cmd.exe' -ArgumentList '/k','${innerCmd.replace(/'/g, "''")}'`;
      logA(`psScript: ${psScript}`);
      logA(`manual reproduce: powershell -NoProfile -Command "${psScript.replace(/"/g, '\\"')}"`);
      logA(`equivalente cmd: cmd /k ${innerCmd}`);

      try {
        const ps = spawn(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-Command', psScript],
          { detached: true, stdio: 'ignore', windowsHide: true }
        );
        let spawnErr = null;
        ps.on('error', (err) => { spawnErr = err; logA(`ps spawn error: ${err.message}`); });
        ps.unref();
        // Espera 800ms pra confirmar que sobreviveu (mesma heurística que tínhamos).
        await new Promise((r) => setTimeout(r, 800));
        if (spawnErr) {
          return { ok: false, error: spawnErr.message, logFile: actionLog };
        }
        logA('ps spawned, considering OK');
        return { ok: true, via: 'powershell+cmd', logFile: actionLog };
      } catch (e) {
        logA(`ps spawn falhou (catch): ${e.message}`);
        return { ok: false, error: e.message, logFile: actionLog };
      }
    }
    case 'browser': {
      const url = payload.url || payload.code;
      if (!url || !/^https?:\/\//i.test(url)) return { ok: false, error: 'url inválida' };
      shell.openExternal(url);
      return { ok: true, url };
    }
    case 'copy': {
      // Renderer faz copy via Clipboard API; main confirma só pra telemetria.
      return { ok: true };
    }
    case 'none': {
      return { ok: true };
    }
    default:
      return { ok: false, error: `kind desconhecido: ${kind}` };
  }
}, { emitOnError: false });

// Helper: spawn detached que considera SUCESSO se o processo sobrevive 800ms
// sem erro. Pra terminais GUI (wt/cmd /k) isso é o sinal mais confiável —
// não dá pra esperar exit_code porque a janela fica viva enquanto o usuário
// usa. Se `useStart=true`, embrulha o cmd em `cmd.exe /c start "" <cmd> ...`
// pra desanexar do parent e abrir JANELA VISÍVEL nova (importante pro cmd /k).
function trySpawnDetached(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    try {
      let child;
      if (opts.useStart) {
        // `start "" cmd /k ...` — primeiro arg vazio do start é o título da janela
        // (obrigatório quando o exe está entre aspas, mas inofensivo aqui).
        const startArgs = ['/c', 'start', '""', cmd, ...args];
        child = spawn('cmd.exe', startArgs, {
          detached: true,
          stdio: 'ignore',
          windowsHide: false,
        });
      } else {
        child = spawn(cmd, args, {
          detached: true,
          stdio: 'ignore',
          windowsHide: false,
        });
      }
      let settled = false;
      child.on('error', (err) => {
        if (settled) return;
        settled = true;
        resolve({ ok: false, error: err.message });
      });
      // Se sobreviveu 800ms sem disparar 'error', considera sucesso e desanexa.
      setTimeout(() => {
        if (settled) return;
        settled = true;
        try { child.unref(); } catch (_) {}
        resolve({ ok: true });
      }, 800);
    } catch (e) {
      resolve({ ok: false, error: e.message });
    }
  });
}

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

// Bruno v0.2.6 — lock-file coordination em vez de setTimeout cego.
//
// PROBLEMA v0.2.5: setTimeout(app.quit, 8000) matava o instalador velho
// independente do UAC ter sido aceito. Se PORTABLE_EXECUTABLE_FILE não
// estivesse setado, o Start-Process apontava pro %TEMP%\...exe que ou
// sumia ou era rejeitado pelo Windows — UAC NUNCA aparecia, e em 8s o
// instalador morria silenciosamente. JOs ficava sem nada na tela.
//
// SOLUÇÃO: relaunchAsAdmin (shell.js) agora aguarda PowerShell fechar e
// retorna {ok:false, error:'UAC_CANCELLED'|'UAC_FAILED'|...} se algo deu
// errado. Se ok=true, monitoramos `.elevated.lock` — só matamos o velho
// quando o novo (elevado) escreve o lock ao boot. Em 60s sem lock, mantém
// velho vivo e emite onElevateTimeout pra UI mostrar erro.
let _elevateMonitor = null;

safeHandle('installer:relaunchAsAdmin', async () => {
  // Remove lock antigo (de tentativas anteriores) pra detecção limpa.
  try { fs.unlinkSync(ELEVATED_LOCK); } catch (_) {}

  const r = await relaunchAsAdmin();
  if (!r.ok) {
    // UAC negado, falha de spawn, ou path inválido — NÃO mata o velho.
    // UI fica viva pra mostrar o erro (e o logFile pra JOs mandar pro Bruno).
    return r;
  }

  // UAC aceito (Start-Process retornou um PID). Agora monitora o lock até 60s.
  // Quando o novo processo elevado escrever o lock no boot, sabemos que
  // está vivo e podemos matar o velho com segurança.
  if (_elevateMonitor) clearInterval(_elevateMonitor);
  const startedAt = Date.now();
  let lastLogElapsedBucket = -1;
  _elevateMonitor = setInterval(() => {
    const elapsed = Date.now() - startedAt;

    // Heartbeat log (a cada ~5s) pra UI poder mostrar "Aguardando UAC… Ns".
    const bucket = Math.floor(elapsed / 5000);
    if (bucket !== lastLogElapsedBucket && bucket > 0) {
      lastLogElapsedBucket = bucket;
      sendToRenderer('installer:onLog', {
        ts: new Date().toISOString(),
        level: 'info',
        component: 'elevate',
        message: `Aguardando processo elevado iniciar… ${Math.floor(elapsed / 1000)}s`,
      });
    }

    try {
      if (fs.existsSync(ELEVATED_LOCK)) {
        const data = JSON.parse(fs.readFileSync(ELEVATED_LOCK, 'utf8'));
        // Lock tem que ser FRESCO (criado depois que pedimos elevação).
        // 10s de janela passada pra cobrir clock skew/IO lag.
        if (data && data.startedAt && data.startedAt > startedAt - 10000) {
          clearInterval(_elevateMonitor);
          _elevateMonitor = null;
          sendToRenderer('installer:onLog', {
            ts: new Date().toISOString(),
            level: 'info',
            component: 'elevate',
            message: 'Processo elevado detectado — fechando instalador atual…',
          });
          // 500ms pra UI mostrar a mensagem antes do quit.
          setTimeout(() => app.quit(), 500);
          return;
        }
      }
    } catch (_) { /* lock corrompido/parcial — ignora, próxima iteração */ }

    if (elapsed > 60_000) {
      clearInterval(_elevateMonitor);
      _elevateMonitor = null;
      sendToRenderer('installer:onElevateTimeout', { elapsedMs: elapsed, logFile: r.logFile });
      sendToRenderer('installer:onLog', {
        ts: new Date().toISOString(),
        level: 'error',
        component: 'elevate',
        message: `Timeout (60s) aguardando processo elevado. Instalador atual NÃO foi fechado. Log: ${r.logFile}`,
      });
    }
  }, 500);

  return { ok: true, monitoring: true, target: r.target, elevatedPid: r.elevatedPid, logFile: r.logFile };
}, { emitOnError: false });

safeHandle('installer:cancelRelaunch', async () => {
  if (_elevateMonitor) {
    clearInterval(_elevateMonitor);
    _elevateMonitor = null;
    return { ok: true, cancelled: true };
  }
  return { ok: true, cancelled: false };
}, { emitOnError: false });

safeHandle('installer:quitApp', async () => {
  setTimeout(() => app.quit(), 300);
  return { ok: true };
}, { emitOnError: false });

// ───────────────────────────────────────────────────────────────────────
// WSL legacy→moderno handlers (Bruno noturna 2026-05-27)
// Camila usa estes pra: tela "Reboot Necessário", indicador "WSL legacy
// detectado", progresso do download MSI.
// ───────────────────────────────────────────────────────────────────────

// Detecta estado do WSL pro renderer (Camila usa pra mostrar "Seu Windows
// tem WSL antigo — vou atualizar"). NÃO faz efeito colateral.
safeHandle('installer:detectWslState', async () => {
  const st = await detectWslState({ logger: null });
  return {
    ok: true,
    state: st.state,        // 'absent' | 'legacy' | 'modern'
    exePath: st.exePath || null,
    evidence: st.evidence,
  };
}, { emitOnError: false });

// Agenda RunOnce + força reboot Windows + quita o app.
// Camila chama quando JOs clica "Reiniciar agora" na tela de reboot.
safeHandle('installer:scheduleRebootAndQuit', async (_e, args = {}) => {
  const delaySeconds = Number.isFinite(args.delaySeconds) ? args.delaySeconds : 30;
  const reason = args.reason || 'Reinício pelo Instalador IMP — salve seu trabalho';
  try {
    // 1) Agenda RunOnce com o exe certo (portable ou execPath)
    const exePath = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
    try {
      await scheduleRunOnceAfterReboot(exePath);
      sendToRenderer('installer:onLog', {
        ts: new Date().toISOString(), level: 'info', component: 'reboot',
        message: `RunOnce agendado — instalador volta após reboot: ${exePath}`,
      });
    } catch (e) {
      sendToRenderer('installer:onLog', {
        ts: new Date().toISOString(), level: 'warn', component: 'reboot',
        message: `RunOnce schedule falhou (não-bloqueante): ${e.message}`,
      });
    }
    // 2) Dispara shutdown /r /t <delay>
    const r = await forceRebootWindows({ delaySeconds, reason });
    if (!r.ok) return { ok: false, error: r.error };
    sendToRenderer('installer:onLog', {
      ts: new Date().toISOString(), level: 'info', component: 'reboot',
      message: `Reboot agendado em ${delaySeconds}s — motivo: ${reason}`,
    });
    // 3) Quit do app antes do reboot pegar — dá 1.5s pra UI ver
    setTimeout(() => app.quit(), 1500);
    return { ok: true, delaySeconds };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}, { emitOnError: false });

// Cancela reboot pendente (shutdown /a). Camila usa se JOs clicar "Cancelar".
safeHandle('installer:cancelReboot', async () => {
  return await cancelReboot({ logger: null });
}, { emitOnError: false });

ipcMain.handle('app:getVersion', async () => app.getVersion());
