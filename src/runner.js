'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createLogger } = require('./logger');
const stateLib = require('./state');
const { ALL_STEPS } = require('./executors');

// Lock file prevents two installer processes from racing on state.json.
const LOCK_NAME = '.installer.lock';

// CRITICAL_STEPS: skipStep recusa esses (sem force:true).
// FASE 2 (Bruno 2026-05-27): novos step IDs do runtime embarcado MSYS2.
// step_x3_github_auth é OPCIONAL (squad-seed já vem embarcado) → pulável.
const CRITICAL_STEPS = new Set([
  'step_x1_copy_runtime',
  'step_x2_setup_env',
  'step_x4_launch_tmux',
  'step_x5_desktop_shortcut',
]);

function acquireLock(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const lockPath = path.join(dir, LOCK_NAME);
  if (fs.existsSync(lockPath)) {
    try {
      const pid = parseInt(fs.readFileSync(lockPath, 'utf8'), 10);
      if (Number.isFinite(pid) && pid !== process.pid) {
        // Check liveness — process.kill(pid, 0) throws if dead.
        try { process.kill(pid, 0); }
        catch (_) {
          // Stale; we can take it over.
          fs.unlinkSync(lockPath);
        }
      }
    } catch (_) { /* fall through to create */ }
  }
  if (fs.existsSync(lockPath)) {
    const pid = fs.readFileSync(lockPath, 'utf8').trim();
    throw new Error(`Outro instalador já está rodando (PID ${pid}). Feche-o antes.`);
  }
  fs.writeFileSync(lockPath, String(process.pid));
  return lockPath;
}

function releaseLock(lockPath) {
  try { fs.unlinkSync(lockPath); } catch (_) {}
}

// ---------------------------------------------------------------------------
// Public API — main.js wires these to IPC.
// ---------------------------------------------------------------------------

let _ctx = null; // module-scope singleton; the installer is a single-instance app.

function makeContext(events = {}, opts = {}) {
  const state = stateLib.loadState({ path: opts.statePath });
  const logger = createLogger({ events, logDir: opts.logDir });
  const save = () => {
    stateLib.saveState(state, { path: opts.statePath });
    stateLib.emitMirror(state, events);
  };
  return {
    state,
    save,
    logger,
    events,
    exePath: opts.exePath || process.execPath,
    // requestSudoPassword: () => Promise<string>. main.js sets this.
    requestSudoPassword: opts.requestSudoPassword || events.requestSudoPassword,
  };
}

// Aplica events recebidos no _ctx existente. Patrícia BLOCKER #2: re-bind
// precisa atualizar requestSudoPassword TAMBÉM (não só events). Sem isso, no
// fluxo pós-reboot (markRebootDone faz startWizard({}) sem events; depois o
// user clica "Começar" e o handler chama startWizard(realEvents) que cai no
// early-return), o _ctx.requestSudoPassword ficava undefined e step_05/10
// quebravam com "sudo: senha exigida e UI não forneceu passwordPromise".
function _applyEvents(ctx, events = {}, opts = {}) {
  ctx.events = events;
  // requestSudoPassword pode vir tanto em opts (jeito antigo de makeContext)
  // quanto em events (jeito que main.js usa via buildRunnerEvents).
  // Atualiza SE veio nova; preserva a antiga se não veio (não pode regredir
  // pra undefined caso re-bind seja chamado sem events.requestSudoPassword).
  const next = (opts && opts.requestSudoPassword) || (events && events.requestSudoPassword);
  if (typeof next === 'function') {
    ctx.requestSudoPassword = next;
  }
}

function startWizard(events = {}, opts = {}) {
  if (_ctx) {
    _applyEvents(_ctx, events, opts); // re-bind callbacks + requestSudoPassword
    _ctx.logger.info('runner', 'startWizard re-bind');
    return _ctx.state;
  }
  const lockDir = stateLib.defaultStateDir();
  const lockPath = acquireLock(lockDir);
  _ctx = makeContext(events, opts);
  _ctx._lockPath = lockPath;
  _ctx.save();
  _ctx.logger.info('runner', 'wizard started');
  process.on('exit', () => releaseLock(lockPath));
  return _ctx.state;
}

// getState pode ser chamado ANTES de startWizard (ex.: main.js pra detectar
// rebootDone). Quando isso acontece, carregamos do disco diretamente sem
// adquirir lock — startWizard adquire o lock depois. Esse padrão é seguro
// porque o app é single-instance (app.requestSingleInstanceLock no main.js).
function getState() {
  if (!_ctx) return stateLib.loadState();
  return _ctx.state;
}

function listSteps() {
  // Bruno v0.2.13: manualInstructions pode ser função(ctx) pra resolver
  // ctx.state.distro em runtime. Resolve aqui antes de mandar pra UI.
  // String/Array/Object passam direto.
  const ctxLike = { state: (_ctx && _ctx.state) || {} };
  return ALL_STEPS.map(s => {
    let mi = s.manualInstructions || null;
    if (typeof mi === 'function') {
      try { mi = mi(ctxLike); }
      catch (_) { mi = null; }
    }
    return {
      id: s.id,
      title: s.title,
      description: s.description,
      category: s.category,
      manualInstructions: mi,
      status: _ctx ? (_ctx.state.steps[s.id] || 'pending') : 'pending',
    };
  });
}

function emitStepUpdate(ctx, step, status, extra) {
  if (ctx.events && typeof ctx.events.onStepUpdate === 'function') {
    try {
      ctx.events.onStepUpdate({
        id: step.id,
        title: step.title,
        category: step.category,
        status,
        ...extra,
      });
    } catch (_) {}
  }
}

// Espera o usuário "retomar" caso esteja pausado. Não-bloqueante se nunca foi pausado.
async function pauseGate(ctx) {
  if (!ctx || !ctx.state || !ctx.state.paused) return;
  ctx.logger.info('runner', 'execução pausada — aguardando resume()');
  while (ctx.state.paused) {
    await new Promise(r => setTimeout(r, 500));
  }
  ctx.logger.info('runner', 'resume — voltando a rodar');
}

// Run one step. Returns { id, status, skipped, error }.
//
// Patrícia HIGH #5: validações early (step inexistente, reboot pendente) tinham
// `throw` CRU antes do try/catch interno → bypassavam o catch e o handler
// retornava rejection genérica pro renderer (toast cinza em vez de tela de
// erro estruturada). Agora retornamos `{id, status:'error', error}` igual o
// caminho normal de falha, e o handler safeHandle do main.js emite onError
// enriquecido como esperado.
async function runStep(stepId, events) {
  if (!_ctx) startWizard(events || {});
  if (events) _applyEvents(_ctx, events);

  const step = ALL_STEPS.find(s => s.id === stepId);
  if (!step) {
    // Não throw — devolve shape padrão. Emite onError pra UI ter feedback.
    const msg = `step não encontrado: ${stepId}`;
    if (_ctx && _ctx.events && typeof _ctx.events.onError === 'function') {
      try { _ctx.events.onError({ stepId, error: msg }); } catch (_) {}
    }
    return { id: stepId, status: 'error', error: msg };
  }

  await pauseGate(_ctx);

  // Reboot gate: FASE 2 (runtime MSYS2) NÃO dispara reboot por design — mas
  // mantemos o gate funcional pra retro-compat com state.json antigo (se
  // alguém migrou de v0.2.x com rebootRequired pendente, libera só o preflight
  // pra re-detectar e o user pode resetar).
  const REBOOT_GATE_EXEMPT = new Set([
    'step_00_preflight',
  ]);
  if (_ctx.state.rebootRequired && !_ctx.state.rebootDone && !REBOOT_GATE_EXEMPT.has(step.id)) {
    const msg = 'Reboot pendente — reinicie o Windows antes de continuar.';
    emitStepUpdate(_ctx, step, 'blocked_user_action', { reason: 'reboot_pending' });
    if (_ctx.events && typeof _ctx.events.onError === 'function') {
      try { _ctx.events.onError({ stepId: step.id, error: msg, reason: 'reboot_pending' }); } catch (_) {}
    }
    return { id: step.id, status: 'error', error: msg, reason: 'reboot_pending' };
  }

  emitStepUpdate(_ctx, step, 'running');
  stateLib.setStepStatus(_ctx.state, step.id, 'running');
  _ctx.save();

  // Bruno onda 3 (live-test #2): heartbeat a cada 5s enquanto step roda. Sem
  // isso, steps que demoram >30s (clones, apt, npm install) deixavam a UI
  // visualmente travada — user não sabia se tava processando ou pendurado.
  // setInterval limpo no finally (sucesso, erro, ou throw).
  const stepStart = Date.now();
  const heartbeat = setInterval(() => {
    const elapsed = Math.floor((Date.now() - stepStart) / 1000);
    try {
      _ctx.logger.info(step.id, `(ainda processando — ${elapsed}s decorridos)`);
    } catch (_) { /* logger malformado não derruba step */ }
  }, 5000);

  // Bruno (live-test #1): garante que detect/execute/validate SEMPRE rodam dentro
  // de try/catch e convertem throws estranhos (string solta, null, número) em Error
  // proper, pra que `err.message` e `err.stderr` existam consistentemente.
  const safeCall = async (kind, fn) => {
    try {
      return await fn();
    } catch (raw) {
      if (raw instanceof Error) throw raw;
      // throw 'string' / throw null / throw {code:5} — normaliza.
      const wrapped = new Error(
        typeof raw === 'string' ? raw :
        (raw && raw.message) ? raw.message :
        `${kind} lançou valor não-Error: ${JSON.stringify(raw)}`
      );
      // preserva campos comuns se vierem em objeto
      if (raw && typeof raw === 'object') {
        if (raw.stderr) wrapped.stderr = raw.stderr;
        if (raw.code) wrapped.code = raw.code;
        if (raw.enriched) wrapped.enriched = raw.enriched;
      }
      throw wrapped;
    }
  };

  try {
    _ctx.logger.info(step.id, `1/3 detectando estado de "${step.title}"...`);
    const already = await safeCall('detect', () => step.detect(_ctx));
    if (already) {
      stateLib.setStepStatus(_ctx.state, step.id, 'skipped', { reason: 'detected' });
      _ctx.save();
      emitStepUpdate(_ctx, step, 'skipped', { reason: 'detected' });
      _ctx.logger.info(step.id, 'já estava feito — pulando');
      return { id: step.id, status: 'skipped' };
    }

    _ctx.logger.info(step.id, `2/3 executando "${step.title}" (pode demorar alguns minutos)...`);
    await safeCall('execute', () => step.execute(_ctx));

    _ctx.logger.info(step.id, `3/3 validando resultado de "${step.title}"...`);
    const ok = await safeCall('validate', () => step.validate(_ctx));
    if (!ok) {
      throw new Error('validação pós-execução falhou');
    }

    stateLib.setStepStatus(_ctx.state, step.id, 'done');
    _ctx.save();
    emitStepUpdate(_ctx, step, 'done');
    _ctx.logger.info(step.id, `done em ${Math.floor((Date.now() - stepStart) / 1000)}s`);
    return { id: step.id, status: 'done' };

  } catch (err) {
    const msg = (err && err.message) || String(err);
    stateLib.setStepStatus(_ctx.state, step.id, 'error', { error: msg });
    _ctx.save();
    emitStepUpdate(_ctx, step, 'error', { error: msg });
    _ctx.logger.error(step.id, `falhou: ${msg}`, { stderr: err.stderr });
    if (_ctx.events && typeof _ctx.events.onError === 'function') {
      try {
        // Anexa enriched se o executor já preparou (step_11 faz isso).
        const payload = { stepId: step.id, error: msg, stderr: err.stderr };
        if (err.enriched) payload.enriched = err.enriched;
        _ctx.events.onError(payload);
      } catch (_) {}
    }
    return { id: step.id, status: 'error', error: msg };
  } finally {
    // Heartbeat sempre limpo, mesmo em throw inesperado.
    clearInterval(heartbeat);
  }
}

// Run all steps in order. Stops on reboot gate or first error.
async function runAll(events) {
  if (!_ctx) startWizard(events || {});
  if (events) _applyEvents(_ctx, events);
  const results = [];
  for (const step of ALL_STEPS) {
    // Pause check antes de CADA step (não-bloqueante se nunca foi pausado).
    await pauseGate(_ctx);
    // If reboot just happened (resume), step 03 might already be done; respect existing 'done' state.
    if (stateLib.isStepDone(_ctx.state, step.id)) {
      results.push({ id: step.id, status: _ctx.state.steps[step.id] });
      continue;
    }
    const r = await runStep(step.id, _ctx.events);
    results.push(r);
    if (r.status === 'error') break;
    // FASE 2: nenhum step novo dispara rebootRequired. Mantemos check genérico
    // (defesa em profundidade): se algum step setar a flag, pausa o runAll.
    if (_ctx.state.rebootRequired && !_ctx.state.rebootDone) {
      _ctx.logger.info('runner', `pausando após ${step.id} — rebootRequired flag setada`);
      break;
    }
  }
  return results;
}

// Pause/resume reais: flag em _ctx.state.paused. runAll/runStep checam via pauseGate.
// NÃO mata o passo em execução — ele termina, e o próximo bloqueia.
function pause() {
  if (!_ctx) return { ok: false, error: 'wizard ainda não iniciado' };
  _ctx.state.paused = true;
  _ctx.save();
  _ctx.logger.info('runner', 'pause solicitado pelo usuário');
  return { ok: true };
}

function resume() {
  if (!_ctx) return { ok: false, error: 'wizard ainda não iniciado' };
  _ctx.state.paused = false;
  _ctx.save();
  _ctx.logger.info('runner', 'resume solicitado pelo usuário');
  return { ok: true };
}

function isPaused() {
  return !!(_ctx && _ctx.state && _ctx.state.paused);
}

// User confirms they finished a manual step (e.g., after closing terminal).
async function markManualDone(stepId) {
  if (!_ctx) startWizard({});
  const step = ALL_STEPS.find(s => s.id === stepId);
  if (!step) throw new Error(`step não encontrado: ${stepId}`);
  const ok = await step.validate(_ctx).catch(() => false);
  if (!ok) {
    return { id: stepId, status: 'error', error: 'validação ainda não passa — repita o passo manual' };
  }
  stateLib.setStepStatus(_ctx.state, step.id, 'done');
  _ctx.save();
  emitStepUpdate(_ctx, step, 'done');
  return { id: stepId, status: 'done' };
}

// Called by main.js right after launch if we detect post-reboot resume.
function markRebootDone() {
  if (!_ctx) startWizard({});
  _ctx.state.rebootDone = true;
  _ctx.save();
  _ctx.logger.info('runner', 'reboot done — retomando');
}

// Allow user to pre-skip an optional step (e.g., Sala 3D).
// Recusa CRITICAL_STEPS a menos que force:true seja passado.
function skipStep(stepId, reason = 'user_skipped', opts = {}) {
  if (!_ctx) startWizard({});
  if (CRITICAL_STEPS.has(stepId) && !opts.force) {
    const err = new Error(`step ${stepId} é crítico — não pode ser pulado (use force:true se sabe o que está fazendo)`);
    err.code = 'CRITICAL_STEP';
    throw err;
  }
  stateLib.setStepStatus(_ctx.state, stepId, 'skipped', { reason });
  _ctx.save();
  return { ok: true };
}

// resetState: limpa state.json (preserva backup), libera lock, zera _ctx.
// Pra "btn-fresh" do wizard — começar do zero.
function resetState() {
  const stateDir = stateLib.defaultStateDir();
  const statePath = stateLib.defaultStatePath();
  const ts = Date.now();

  // Renomeia state.json pra preserved (forense + undo manual se preciso).
  try {
    if (fs.existsSync(statePath)) {
      fs.renameSync(statePath, `${statePath}.preserved-${ts}`);
    }
    const bak = statePath + '.bak';
    if (fs.existsSync(bak)) {
      fs.renameSync(bak, `${bak}.preserved-${ts}`);
    }
  } catch (e) {
    // Best-effort; se rename falhar tentamos unlink.
    try { fs.unlinkSync(statePath); } catch (_) {}
  }

  // Libera lock e zera _ctx pra startWizard reinicializar do zero.
  if (_ctx && _ctx._lockPath) releaseLock(_ctx._lockPath);
  else {
    // Lock pode existir mesmo sem _ctx (cenário de crash anterior).
    try { releaseLock(path.join(stateDir, LOCK_NAME)); } catch (_) {}
  }
  _ctx = null;
  return { ok: true, preservedAt: ts };
}

function shutdown() {
  if (_ctx && _ctx._lockPath) releaseLock(_ctx._lockPath);
  _ctx = null;
}

// Test-only inspector. NÃO usar em produção. Retorna snapshot raso do _ctx
// pra smoke tests poderem verificar requestSudoPassword/events sem reflection.
function _debugCtx() {
  if (!_ctx) return null;
  return {
    hasRequestSudoPassword: typeof _ctx.requestSudoPassword === 'function',
    requestSudoPasswordRef: _ctx.requestSudoPassword,
    eventsKeys: _ctx.events ? Object.keys(_ctx.events) : [],
  };
}

module.exports = {
  startWizard,
  runStep,
  runAll,
  markManualDone,
  markRebootDone,
  skipStep,
  listSteps,
  getState,
  shutdown,
  pause,
  resume,
  isPaused,
  resetState,
  CRITICAL_STEPS,
  _debugCtx,
};
