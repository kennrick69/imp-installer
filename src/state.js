'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const SCHEMA_VERSION = 1;

// We deliberately put state.json in the Windows user profile (USERPROFILE).
// Reasons:
// - Survives WSL reinstall / unregister.
// - The installer is a .exe; main process is on the Windows side.
// - WSL can still read it via /mnt/c/Users/<user>/.imp-installer/state.json.
function defaultStateDir() {
  const home = process.env.USERPROFILE || os.homedir();
  return path.join(home, '.imp-installer');
}

function defaultStatePath() {
  return path.join(defaultStateDir(), 'state.json');
}

function emptyState() {
  return {
    schema_version: SCHEMA_VERSION,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    rebootRequired: false,
    rebootDone: false,
    decisions: {
      // Decisões herdadas (campos antigos preservados por compat de state.json
      // pré-FASE 2 — code novo ignora).
      nodeInstallVia: 'nvm',
      claudeCliVia: 'native',
      escritorio3dStrategy: 'release-asset-on-demand',
    },
    // FASE 2 — runtime MSYS2 embarcado (Bruno 2026-05-27)
    runtimeInstalled: false,
    runtimePath: null,                // string com %LOCALAPPDATA%\IMP-Squad-Runtime\<ver>
    runtimeVersion: null,             // string versão do app
    avDetected: null,                 // { defender, real_time_active, third_party_name, exclusion_added }
    appLockerDetected: null,          // { restrictive_policy: bool }
    githubAuthMode: null,             // 'device' | 'token' | 'seed-only' | 'pending'
    // Campos LEGADOS (pré-FASE 2) preservados pra migração de state.json antigo.
    // O code novo NÃO usa, mas a migração precisa não perder.
    ubuntuUser: null,
    distro: null,
    githubAuthMethod: null,
    wslState: null,
    featuresEnabled: null,
    wslMigrationAttempted: false,
    wslMsiVersion: null,
    rebootRequiredReason: null,
    rebootCount: 0,
    distroState: null,
    steps: {}, // stepId -> 'pending' | 'running' | 'done' | 'error' | 'skipped' | 'blocked_user_action'
    stepDetails: {}, // stepId -> { startedAt, finishedAt, lastError, attempts }
    lastStepCompleted: null,
  };
}

// ---- migrations -----------------------------------------------------------
// Each migration is (state) => state for version N -> N+1.
// Keep no-op for v1 so the slot exists from day 1 (per Patricia §10.4 / §12).
const MIGRATIONS = {
  // 1: (state) => ({ ...state, schema_version: 2, /* new field */ }),
};

function migrate(state) {
  let s = state || {};
  let v = s.schema_version || 0;
  while (MIGRATIONS[v]) {
    s = MIGRATIONS[v](s);
    v = s.schema_version;
  }
  if (!s.schema_version) s.schema_version = SCHEMA_VERSION;

  // Patrícia BLOCKER #3: state.json salvo em versão antiga (ou editado à mão)
  // pode chegar sem `decisions`, `steps`, `stepDetails`. Step_13 lia
  // `ctx.state.decisions.escritorio3dStrategy` direto → NPE. Garantir shape
  // mínimo no migrate (defaults preenchem campos ausentes; campos presentes
  // sobrevivem).
  const def = emptyState();
  s.steps       = { ...def.steps,       ...(s.steps       || {}) };
  s.stepDetails = { ...def.stepDetails, ...(s.stepDetails || {}) };
  s.decisions   = { ...def.decisions,   ...(s.decisions   || {}) };

  return s;
}

// ---- atomic IO ------------------------------------------------------------
function loadState(opts = {}) {
  const file = opts.path || defaultStatePath();
  const dir = path.dirname(file);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (_) {}

  // Try primary, then .bak.
  for (const candidate of [file, file + '.bak']) {
    if (!fs.existsSync(candidate)) continue;
    try {
      const raw = fs.readFileSync(candidate, 'utf8');
      if (!raw.trim()) continue;
      const parsed = JSON.parse(raw);
      return migrate(parsed);
    } catch (err) {
      // Corrupt — rotate aside for forensics and continue.
      try {
        fs.renameSync(candidate, candidate + '.corrupt-' + Date.now());
      } catch (_) {}
    }
  }
  return emptyState();
}

// Atomic write: write tmp + fsync + rename. Keeps a .bak of previous good state.
// We also snapshot the in-memory object so callers can mutate freely without races
// affecting the on-disk copy.
function saveState(state, opts = {}) {
  const file = opts.path || defaultStatePath();
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });

  state.updatedAt = new Date().toISOString();
  const json = JSON.stringify(state, null, 2);

  // tmp file in same directory (rename is atomic only on same FS).
  const tmp = path.join(dir, `.state-${process.pid}-${crypto.randomBytes(4).toString('hex')}.tmp`);

  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, json, 'utf8');
    try { fs.fsyncSync(fd); } catch (_) { /* fsync may fail on some Windows FS */ }
  } finally {
    fs.closeSync(fd);
  }

  // Back up the previous good copy before clobbering.
  if (fs.existsSync(file)) {
    try {
      fs.copyFileSync(file, file + '.bak');
    } catch (_) {}
  }
  fs.renameSync(tmp, file);
  return file;
}

// Stdout mirror so renderer/main can stream state without re-reading disk.
// main.js wires this to webContents.send.
function emitMirror(state, events) {
  if (events && typeof events.onState === 'function') {
    try { events.onState(state); } catch (_) {}
  }
}

// ---- step helpers ---------------------------------------------------------
function setStepStatus(state, stepId, status, extra = {}) {
  state.steps[stepId] = status;
  const det = state.stepDetails[stepId] || { attempts: 0 };
  if (status === 'running') {
    det.startedAt = new Date().toISOString();
    det.attempts = (det.attempts || 0) + 1;
    delete det.lastError;
  } else if (status === 'done') {
    det.finishedAt = new Date().toISOString();
    delete det.lastError;
    state.lastStepCompleted = stepId;
  } else if (status === 'error') {
    det.finishedAt = new Date().toISOString();
    det.lastError = extra.error ? String(extra.error).slice(0, 2000) : 'unknown';
  } else if (status === 'skipped') {
    det.finishedAt = new Date().toISOString();
    det.reason = extra.reason || 'detected-already-done';
    state.lastStepCompleted = stepId;
  }
  state.stepDetails[stepId] = det;
  return state;
}

function isStepDone(state, stepId) {
  return state.steps[stepId] === 'done' || state.steps[stepId] === 'skipped';
}

module.exports = {
  SCHEMA_VERSION,
  defaultStateDir,
  defaultStatePath,
  emptyState,
  migrate,
  loadState,
  saveState,
  emitMirror,
  setStepStatus,
  isStepDone,
};
