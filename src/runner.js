'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createLogger } = require('./logger');
const stateLib = require('./state');
const { ALL_STEPS } = require('./executors');

// Lock file prevents two installer processes from racing on state.json.
const LOCK_NAME = '.installer.lock';

// CRITICAL_STEPS: skipStep recusa esses (sem force:true). Pular qualquer um quebra
// downstream — ex.: pular step_05 (apt) garante que step_06 (node via nvm via apt deps)
// falhe; pular step_03 (wsl_install) deixa o sistema sem distro Linux.
const CRITICAL_STEPS = new Set([
  'step_03_wsl_install',
  'step_05_apt_base',
  'step_06_node_nvm',
  'step_08_claude_cli',
  'step_10_gh_auth',
  'step_11_clone_squad',
  'step_14_tmux_session',
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

function startWizard(events = {}, opts = {}) {
  if (_ctx) {
    _ctx.events = events; // re-bind callbacks (e.g., after reload)
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
  return ALL_STEPS.map(s => ({
    id: s.id,
    title: s.title,
    description: s.description,
    category: s.category,
    manualInstructions: s.manualInstructions || null,
    status: _ctx ? (_ctx.state.steps[s.id] || 'pending') : 'pending',
  }));
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
async function runStep(stepId, events) {
  if (!_ctx) startWizard(events || {});
  if (events) _ctx.events = events;
  const step = ALL_STEPS.find(s => s.id === stepId);
  if (!step) throw new Error(`step não encontrado: ${stepId}`);

  await pauseGate(_ctx);

  // Reboot gate: step 03 sets rebootRequired=true. Subsequent steps cannot run
  // until rebootDone is also true. main.js flips rebootDone on next launch.
  if (_ctx.state.rebootRequired && !_ctx.state.rebootDone && step.id !== 'step_03_wsl_install') {
    const err = new Error('Reboot pendente — reinicie o Windows antes de continuar.');
    emitStepUpdate(_ctx, step, 'blocked_user_action', { reason: 'reboot_pending' });
    throw err;
  }

  emitStepUpdate(_ctx, step, 'running');
  stateLib.setStepStatus(_ctx.state, step.id, 'running');
  _ctx.save();

  try {
    _ctx.logger.info(step.id, `detect ${step.title}`);
    const already = await step.detect(_ctx);
    if (already) {
      stateLib.setStepStatus(_ctx.state, step.id, 'skipped', { reason: 'detected' });
      _ctx.save();
      emitStepUpdate(_ctx, step, 'skipped', { reason: 'detected' });
      _ctx.logger.info(step.id, 'já estava feito — skip');
      return { id: step.id, status: 'skipped' };
    }

    _ctx.logger.info(step.id, `execute ${step.title}`);
    await step.execute(_ctx);

    _ctx.logger.info(step.id, `validate ${step.title}`);
    const ok = await step.validate(_ctx);
    if (!ok) {
      throw new Error('validação pós-execução falhou');
    }

    stateLib.setStepStatus(_ctx.state, step.id, 'done');
    _ctx.save();
    emitStepUpdate(_ctx, step, 'done');
    _ctx.logger.info(step.id, 'done');
    return { id: step.id, status: 'done' };

  } catch (err) {
    const msg = (err && err.message) || String(err);
    stateLib.setStepStatus(_ctx.state, step.id, 'error', { error: msg });
    _ctx.save();
    emitStepUpdate(_ctx, step, 'error', { error: msg });
    _ctx.logger.error(step.id, `falhou: ${msg}`, { stderr: err.stderr });
    if (_ctx.events && typeof _ctx.events.onError === 'function') {
      try { _ctx.events.onError({ stepId: step.id, error: msg, stderr: err.stderr }); } catch (_) {}
    }
    return { id: step.id, status: 'error', error: msg };
  }
}

// Run all steps in order. Stops on reboot gate or first error.
async function runAll(events) {
  if (!_ctx) startWizard(events || {});
  if (events) _ctx.events = events;
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
    // After step 03, halt; user must reboot.
    if (step.id === 'step_03_wsl_install' && _ctx.state.rebootRequired && !_ctx.state.rebootDone) {
      _ctx.logger.info('runner', 'pausando — aguardando reboot do usuário');
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
};
