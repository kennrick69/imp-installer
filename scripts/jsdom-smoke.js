#!/usr/bin/env node
/* eslint-disable no-console */
/* ============================================================================
   jsdom-smoke.js — IMP Squad Instalador
   Autora: Patrícia (QA, IMP Dev Squad) — noturna 2026-05-27
   ----------------------------------------------------------------------------
   Smoke test que carrega `renderer/index.html` + `renderer/wizard.js` em
   jsdom, mocka `window.api.installer.*` com handlers que retornam ok, e
   simula os eventos críticos do backend, verificando via querySelector que
   o DOM responde como esperado.

   Cobre cenários que JÁ causaram bug ao vivo:
     - "botão fantasma" v0.2.14 (action top-level vs nested)
     - onScreen object vs string v0.2.15
     - sidebar não-running v0.1
     - preflight não atualiza v0.1 (id mismatch)
     - modal-error sem suggestions
     - modal-elevate ao precisar de admin
     - wsl-upgrade progress não move

   Sai com exit code 0 se TODOS os checks ✓; 1 se algum ✗.

   Uso:
     node scripts/jsdom-smoke.js

   Dependência:
     jsdom (instala via `npm i --no-save jsdom` se não tiver).
     Se jsdom ausente, o script imprime instrução clara e sai com code 2.
============================================================================ */

'use strict';

const fs   = require('node:fs');
const path = require('node:path');

const RED   = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const DIM   = '\x1b[2m';
const BOLD  = '\x1b[1m';
const RESET = '\x1b[0m';

const ROOT = path.resolve(__dirname, '..');

// ─── Resolve jsdom de forma defensiva ───────────────────────────────────────
let JSDOM;
try {
  ({ JSDOM } = require('jsdom'));
} catch (_e) {
  console.error(`${RED}${BOLD}jsdom não está instalado.${RESET}`);
  console.error('');
  console.error('Instale com (não persiste em package.json):');
  console.error(`  ${BOLD}cd ${ROOT}${RESET}`);
  console.error(`  ${BOLD}npm i --no-save jsdom${RESET}`);
  console.error('');
  console.error('Depois rode de novo:');
  console.error(`  ${BOLD}node scripts/jsdom-smoke.js${RESET}`);
  process.exit(2);
}

// ─── Estado dos checks ──────────────────────────────────────────────────────
const checks = [];
function check(label, passed, detail) {
  checks.push({ label, passed: !!passed, detail: detail || '' });
}
function report() {
  console.log('');
  console.log(`${BOLD}── RESULTADOS ─${'─'.repeat(50)}${RESET}`);
  let pass = 0;
  let fail = 0;
  for (const c of checks) {
    if (c.passed) {
      console.log(`  ${GREEN}✓${RESET} ${c.label}${c.detail ? ` ${DIM}— ${c.detail}${RESET}` : ''}`);
      pass++;
    } else {
      console.log(`  ${RED}✗${RESET} ${c.label}${c.detail ? ` ${DIM}— ${c.detail}${RESET}` : ''}`);
      fail++;
    }
  }
  console.log('');
  console.log(`${BOLD}TOTAL:${RESET} ${pass} ${GREEN}pass${RESET}, ${fail} ${fail ? RED + 'fail' + RESET : 'fail'}, ${checks.length} total`);
  return fail;
}

// ─── Helpers de mock ────────────────────────────────────────────────────────
function makeMockApi() {
  // Cada listener guarda o callback pra dispararmos eventos manualmente.
  const listeners = {};
  function makeListener(name) {
    return (cb) => {
      listeners[name] = cb;
      return () => { delete listeners[name]; };
    };
  }
  const asyncOk = async () => ({ ok: true });

  const installer = {
    // métodos handle-style
    start: async () => ({ ok: true, checks: [], preflight: { ok: true } }),
    resume: asyncOk,
    runStep: asyncOk,
    runAll: asyncOk,
    markManualDone: async () => ({ status: 'done' }),
    retry: asyncOk,
    skip: asyncOk,
    getState: async () => ({ steps: {}, lastStepCompleted: null }),
    listSteps: async () => [],
    openTerminal: asyncOk,
    openBrowser: asyncOk,
    executeManualAction: async () => ({ ok: true, via: 'mock' }),
    exportLogs: async () => ({ ok: true, path: '/tmp/mock.log' }),
    installSala3D: asyncOk,
    openInterface: asyncOk,
    pause: asyncOk,
    closeApp: asyncOk,
    pickFolder: async () => ({ ok: false }),
    reset: asyncOk,
    isElevated: async () => ({ ok: true, elevated: true }),
    relaunchAsAdmin: async () => ({ ok: true, monitoring: true }),
    cancelRelaunch: asyncOk,
    quitApp: asyncOk,
    detectWslState: async () => ({ ok: true, state: 'modern' }),
    scheduleRebootAndQuit: asyncOk,
    cancelReboot: asyncOk,
    sudoReply: asyncOk,

    // listeners
    onLog:              makeListener('onLog'),
    onStepUpdate:       makeListener('onStepUpdate'),
    onPreflight:        makeListener('onPreflight'),
    onManualPrompt:     makeListener('onManualPrompt'),
    onError:            makeListener('onError'),
    onNeedsAdmin:       makeListener('onNeedsAdmin'),
    onElevateTimeout:   makeListener('onElevateTimeout'),
    onComplete:         makeListener('onComplete'),
    onState:            makeListener('onState'),
    onScreen:           makeListener('onScreen'),
    onToast:            makeListener('onToast'),
    onSudoPrompt:       makeListener('onSudoPrompt'),
    onWslUpgradeProgress: makeListener('onWslUpgradeProgress'),
  };

  const api = {
    installer,
    version: async () => '0.0.0-smoke',
  };

  return { api, listeners };
}

// ─── Boot do jsdom ──────────────────────────────────────────────────────────
async function boot() {
  const htmlPath   = path.join(ROOT, 'renderer', 'index.html');
  const wizardPath = path.join(ROOT, 'renderer', 'wizard.js');

  const html = fs.readFileSync(htmlPath, 'utf8');
  const wizardSrc = fs.readFileSync(wizardPath, 'utf8');

  const dom = new JSDOM(html, {
    url: 'file://' + htmlPath,
    pretendToBeVisual: true,
    runScripts: 'outside-only',
  });

  const { window } = dom;
  // Mocks que o wizard.js espera
  const { api, listeners } = makeMockApi();
  window.api = api;
  // clipboard mock (manual action uses it)
  if (!window.navigator.clipboard) {
    Object.defineProperty(window.navigator, 'clipboard', {
      value: { writeText: async () => {} },
      configurable: true,
    });
  }

  // jsdom não implementa scrollIntoView nem focus({preventScroll}) totalmente.
  // Polyfill no Element.prototype pra wizard.js não crashar.
  if (window.Element && !window.Element.prototype.scrollIntoView) {
    window.Element.prototype.scrollIntoView = function () { /* no-op */ };
  }
  // jsdom não implementa requestAnimationFrame em todas as versões antigas
  if (typeof window.requestAnimationFrame !== 'function') {
    window.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 16);
    window.cancelAnimationFrame = (id) => clearTimeout(id);
  }

  // Executa o wizard.js no contexto da window
  dom.window.eval(wizardSrc);

  // Dá um tick pra DOMContentLoaded / init() rodar.
  // O wizard.js tem `if (document.readyState === 'loading') addEventListener(...) else init()`.
  // Como jsdom já parseou, readyState é 'complete' → init() rodou síncrono.
  await new Promise((r) => setTimeout(r, 30));

  return { dom, window, listeners };
}

// ─── Cenários ───────────────────────────────────────────────────────────────
async function run() {
  console.log(`${BOLD}IMP Installer — jsdom Smoke${RESET} ${DIM}(Patrícia, QA)${RESET}\n`);

  const { window, listeners } = await boot();
  const { document } = window;

  // Sanidade: o wizard.js rodou e cadastrou listeners?
  check(
    'wizard.js rodou e cadastrou onStepUpdate',
    typeof listeners.onStepUpdate === 'function',
    typeof listeners.onStepUpdate === 'function' ? '' : 'init() não bateu — preload mock incompleto?'
  );
  check(
    'wizard.js cadastrou onPreflight',
    typeof listeners.onPreflight === 'function'
  );
  check(
    'wizard.js cadastrou onManualPrompt',
    typeof listeners.onManualPrompt === 'function'
  );

  // Sidebar renderizada (renderStepList rodou no init)
  const stepItems = document.querySelectorAll('#step-list .step-item');
  check(
    'sidebar renderizou 17 step-items',
    stepItems.length === 17,
    `encontrados: ${stepItems.length}`
  );

  // ─── Cenário 1: onStepUpdate → sidebar item vira running ────────────────
  if (listeners.onStepUpdate) {
    listeners.onStepUpdate({
      stepId: 'step_05_apt_base',
      state: 'running',
      title: 'Pacotes apt base',
    });
    const sidebarItem = document.querySelector(
      '.step-item[data-step-id="step_05_apt_base"]'
    );
    check(
      'onStepUpdate({running}) → sidebar do step_05 vira data-state=running',
      sidebarItem && sidebarItem.dataset.state === 'running',
      sidebarItem
        ? `data-state=${sidebarItem.dataset.state}`
        : 'sidebar item não encontrado'
    );
  }

  // ─── Cenário 2: onPreflight → card correto atualiza ──────────────────────
  if (listeners.onPreflight) {
    listeners.onPreflight({
      checkId: 'admin',
      state: 'ok',
      message: 'Você tem privilégio de administrador',
    });
    const card = document.querySelector('.pf-card[data-check="admin"]');
    check(
      'onPreflight({admin, ok}) → pf-card[admin] vira data-state=ok',
      card && card.dataset.state === 'ok',
      card ? `data-state=${card.dataset.state}` : 'card não encontrado'
    );
    const msg = card && (card.querySelector('.pf-status') || card.querySelector('.pf-msg'));
    check(
      'onPreflight → mensagem do card mostra texto recebido',
      msg && /administrador/i.test(msg.textContent),
      msg ? `texto: "${msg.textContent.slice(0, 50)}"` : '(sem .pf-status)'
    );
  }

  // ─── Cenário 3: onError → modal-error abre com headline+suggestions ─────
  if (listeners.onError) {
    listeners.onError({
      stepId: 'step_07_npm_prefix',
      headline: 'Falhei ao configurar npm',
      what: 'O comando npm config retornou erro',
      suggestions: ['Verifique se nvm está no PATH', 'Tente reabrir o terminal'],
      canRetry: true,
      canSkip: false,
      raw: 'npm ERR! ENOENT',
    });
    const modal = document.querySelector('#modal-error');
    check(
      'onError → modal-error fica visível (sem .hidden)',
      modal && !modal.classList.contains('hidden'),
      modal ? `classes: "${modal.className}"` : 'modal não encontrado'
    );
    const headline = document.querySelector('#error-headline-text');
    check(
      'onError → #error-headline-text mostra headline',
      headline && /Falhei/i.test(headline.textContent),
      headline ? `texto: "${headline.textContent}"` : '(sem #error-headline-text)'
    );
    const suggList = document.querySelector('#error-suggestions-list');
    const liCount = suggList ? suggList.querySelectorAll('li').length : 0;
    check(
      'onError → #error-suggestions-list tem 2 <li>',
      liCount === 2,
      `<li> count: ${liCount}`
    );
    // Fecha o modal pro próximo cenário não colidir visualmente
    if (modal) modal.classList.add('hidden');
  }

  // ─── Cenário 4: onNeedsAdmin → modal-elevate abre ───────────────────────
  if (listeners.onNeedsAdmin) {
    listeners.onNeedsAdmin({ stepId: 'step_01_enable_features' });
    const modal = document.querySelector('#modal-elevate');
    check(
      'onNeedsAdmin → modal-elevate fica visível',
      modal && !modal.classList.contains('hidden'),
      modal ? `classes: "${modal.className}"` : 'modal-elevate não encontrado'
    );
    const btn = document.querySelector('#btn-elevate-relaunch');
    check(
      'onNeedsAdmin → #btn-elevate-relaunch existe e está habilitado',
      btn && !btn.disabled,
      btn ? `disabled=${btn.disabled}, text="${btn.textContent.trim().slice(0, 40)}"` : '(sem botão)'
    );
    if (modal) modal.classList.add('hidden');
  }

  // ─── Cenário 5: onScreen('reboot') → screen-reboot ativa ────────────────
  if (listeners.onScreen) {
    // Bug v0.2.15: backend envia OBJECT {screen:'reboot'}, mas wizard antigo
    // tratava como string. Esse check garante que NÃO regrida.
    listeners.onScreen({ screen: 'reboot', resumeStep: 'step_03_wsl_install' });
    const screenReboot = document.querySelector('#screen-reboot');
    check(
      'onScreen({screen:"reboot"}) → #screen-reboot tem classe .active',
      screenReboot && screenReboot.classList.contains('active'),
      screenReboot ? `classes: "${screenReboot.className}"` : '(sem #screen-reboot)'
    );
  }

  // ─── Cenário 6: onScreen('wsl-upgrade') → screen-wsl-upgrade ativa ──────
  if (listeners.onScreen) {
    listeners.onScreen({ screen: 'wsl-upgrade' });
    const screenWsl = document.querySelector('#screen-wsl-upgrade');
    check(
      'onScreen({screen:"wsl-upgrade"}) → #screen-wsl-upgrade tem .active',
      screenWsl && screenWsl.classList.contains('active'),
      screenWsl ? `classes: "${screenWsl.className}"` : '(sem #screen-wsl-upgrade)'
    );
  }

  // ─── Cenário 7: onWslUpgradeProgress → progress bar atualiza ────────────
  if (listeners.onWslUpgradeProgress) {
    listeners.onWslUpgradeProgress({
      stage: '⬇ Baixando wsl_update_x64.msi…',
      pct: 47,
      detail: '24 MB de 51 MB',
      logLine: 'progresso ok',
    });
    const fill = document.querySelector('#wsl-up-fill');
    const pct = document.querySelector('#wsl-up-pct');
    const stage = document.querySelector('#wsl-up-stage');
    check(
      'onWslUpgradeProgress({pct:47}) → #wsl-up-fill width = "47%"',
      fill && fill.style.width === '47%',
      fill ? `width="${fill.style.width}"` : '(sem #wsl-up-fill)'
    );
    check(
      'onWslUpgradeProgress → #wsl-up-pct mostra 47%',
      pct && /47/.test(pct.textContent),
      pct ? `texto="${pct.textContent}"` : '(sem #wsl-up-pct)'
    );
    check(
      'onWslUpgradeProgress → #wsl-up-stage mostra texto',
      stage && /Baixando/i.test(stage.textContent),
      stage ? `texto="${stage.textContent.slice(0, 40)}"` : '(sem #wsl-up-stage)'
    );
  }

  // ─── Cenário 8: onManualPrompt c/ payload step 04 TÍPICO ────────────────
  // Este é o cenário CHAVE — pega o "botão fantasma" da v0.2.14.
  // Payload típico do step_04_ubuntu_first_boot.
  if (listeners.onManualPrompt) {
    const payload = {
      stepId: 'step_04_ubuntu_first_boot',
      title: 'Primeiro boot do Ubuntu',
      subtitle: 'Crie seu usuário Linux',
      // CRÍTICO: top-level (NÃO nested em instructions) — v0.2.14 fix.
      action: {
        label: '🚀 Abrir Ubuntu',
        hint: 'Clique pra abrir o WSL e configurar',
        kind: 'terminal',
        payload: { distro: 'Ubuntu-22.04' },
      },
      fallback: {
        title: 'A janela fechou sozinha?',
        command: 'wsl -d Ubuntu',
        steps: ['Abre o cmd', 'Cola o comando', 'Cria seu usuário'],
      },
      steps: [
        { num: 1, text: 'Vai abrir uma janela do Ubuntu' },
        { num: 2, text: 'Crie um usuário e senha' },
      ],
      commands: [
        { label: 'Verificar', code: 'whoami' },
      ],
      expected: 'whoami retorna seu usuário (não root)',
      note: 'O 1º boot pode demorar 1-2 min.',
    };
    listeners.onManualPrompt(payload);

    const screenManual = document.querySelector('#screen-manual');
    check(
      'onManualPrompt → #screen-manual tem .active',
      screenManual && screenManual.classList.contains('active'),
      screenManual ? `classes: "${screenManual.className}"` : '(sem screen-manual)'
    );

    // O bug v0.2.14: action top-level era IGNORADO; botão ficava hidden.
    const actionBtn = document.querySelector('#manual-action-btn');
    check(
      'onManualPrompt(action top-level) → #manual-action-btn NÃO está hidden (bug v0.2.14)',
      actionBtn && !actionBtn.hidden,
      actionBtn ? `hidden=${actionBtn.hidden}, text="${actionBtn.textContent.trim().slice(0, 30)}"` : '(sem botão)'
    );
    check(
      'onManualPrompt → #manual-action-btn tem label da action',
      actionBtn && /Abrir Ubuntu/i.test(actionBtn.textContent),
      actionBtn ? `texto: "${actionBtn.textContent}"` : ''
    );
    check(
      'onManualPrompt → #manual-action-btn está habilitado (kind!=none)',
      actionBtn && !actionBtn.disabled,
      actionBtn ? `disabled=${actionBtn.disabled}` : ''
    );

    // Fallback (Plano B) — bug se ficar hidden mesmo com payload
    const fb = document.querySelector('#manual-fallback');
    check(
      'onManualPrompt(fallback) → #manual-fallback aparece (sem .hidden)',
      fb && !fb.classList.contains('hidden'),
      fb ? `classes: "${fb.className}"` : '(sem #manual-fallback)'
    );
    const fbCode = document.querySelector('#manual-fallback-code');
    check(
      'onManualPrompt → #manual-fallback-code mostra o comando',
      fbCode && /wsl -d Ubuntu/.test(fbCode.textContent),
      fbCode ? `code: "${fbCode.textContent}"` : ''
    );

    // Title, subtitle, steps
    const titleEl = document.querySelector('#manual-title');
    check(
      'onManualPrompt → #manual-title mostra title',
      titleEl && /Primeiro boot/i.test(titleEl.textContent)
    );
    const stepsList = document.querySelector('#manual-steps-list');
    const liCount = stepsList ? stepsList.querySelectorAll('li').length : 0;
    check(
      'onManualPrompt → #manual-steps-list tem 2 <li>',
      liCount === 2,
      `<li> count: ${liCount}`
    );

    // Commands
    const cmdBlock = document.querySelector('#manual-commands');
    check(
      'onManualPrompt(commands) → #manual-commands aparece',
      cmdBlock && !cmdBlock.classList.contains('hidden'),
      cmdBlock ? `classes: "${cmdBlock.className}"` : ''
    );

    // Expected
    const expBlock = document.querySelector('#manual-expected');
    check(
      'onManualPrompt(expected) → #manual-expected aparece',
      expBlock && !expBlock.classList.contains('hidden'),
      expBlock ? `classes: "${expBlock.className}"` : ''
    );

    // Note
    const noteBlock = document.querySelector('#manual-note');
    check(
      'onManualPrompt(note) → #manual-note aparece',
      noteBlock && !noteBlock.classList.contains('hidden'),
      noteBlock ? `classes: "${noteBlock.className}"` : ''
    );
  }

  // ─── Cenário 9: onManualPrompt SEM action → botão escondido ─────────────
  if (listeners.onManualPrompt) {
    listeners.onManualPrompt({
      stepId: 'step_09_claude_login',
      title: 'Login Claude',
      subtitle: 'Cole o link',
      steps: [{ num: 1, text: 'Vai abrir o navegador' }],
      // sem action, sem fallback
    });
    const actionBtn = document.querySelector('#manual-action-btn');
    check(
      'onManualPrompt(sem action) → #manual-action-btn fica hidden=true',
      actionBtn && actionBtn.hidden === true,
      actionBtn ? `hidden=${actionBtn.hidden}` : ''
    );
    const fb = document.querySelector('#manual-fallback');
    check(
      'onManualPrompt(sem fallback) → #manual-fallback fica .hidden',
      fb && fb.classList.contains('hidden'),
      fb ? `classes: "${fb.className}"` : ''
    );
  }

  // ─── Cenário 10: onLog → log peek + activity pulse não crashe ───────────
  if (listeners.onLog) {
    let crashed = false;
    try {
      listeners.onLog({
        ts: new Date().toISOString(),
        level: 'info',
        component: 'preflight',
        message: 'Iniciando…',
      });
    } catch (e) {
      crashed = true;
    }
    check('onLog → handler executa sem crash', !crashed);
    // Não checa visual porque appendLog faz coisas com timestamps efêmeros.
  }

  // ─── Cenário 11: onComplete → screen-done ativa ─────────────────────────
  if (listeners.onComplete) {
    listeners.onComplete({ durationSeconds: 120, sala3dInstalled: false });
    const screenDone = document.querySelector('#screen-done');
    check(
      'onComplete → #screen-done tem .active',
      screenDone && screenDone.classList.contains('active'),
      screenDone ? `classes: "${screenDone.className}"` : ''
    );
    const timePill = document.querySelector('#done-time-pill');
    check(
      'onComplete(120s) → #done-time-pill mostra "Levou 2 min"',
      timePill && /2 min/.test(timePill.textContent),
      timePill ? `texto: "${timePill.textContent}"` : ''
    );
  }

  return report();
}

(async () => {
  try {
    const fails = await run();
    process.exit(fails === 0 ? 0 : 1);
  } catch (e) {
    console.error(`${RED}FATAL: jsdom-smoke crashou:${RESET}`);
    console.error(e && e.stack ? e.stack : e);
    process.exit(2);
  }
})();
