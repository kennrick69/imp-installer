/* ════════════════════════════════════════════════════════════
   IMP Squad — Instalador (wizard.js)
   Camila (criativa) — comportamento da UI
   --------------------------------------------------------------
   Responsabilidade: animar, trocar telas, validar campos visíveis,
   refletir o estado vindo do main.js via window.api.installer.*.
   NÃO executa comandos, NÃO lê/escreve state.json — isso é do
   main.js (Claudio) e do orquestrador de passos (Bruno).
   ════════════════════════════════════════════════════════════ */

(() => {
  'use strict';

  // ───────────────────────────────────────────────────────────
  // Definição dos 17 passos (espelha o ROTEIRO-INSTALACAO-SQUAD.md)
  // O backend (Bruno/Claudio) é fonte da verdade — isto aqui é
  // só pra renderizar a sidebar imediatamente, antes do primeiro
  // onStepUpdate chegar.
  // ───────────────────────────────────────────────────────────
  const STEPS = [
    { id: 'step_00_preflight',          num: 0,  name: 'Pré-flight check',          cat: 'auto'   },
    { id: 'step_01_enable_features',    num: 1,  name: 'Habilitar features WSL',    cat: 'auto'   },
    { id: 'step_02_set_wsl_default_v2', num: 2,  name: 'WSL default version 2',     cat: 'auto'   },
    { id: 'step_03_wsl_install',        num: 3,  name: 'Instalar WSL2 + Ubuntu',    cat: 'hybrid' },
    { id: 'step_04_ubuntu_first_boot',  num: 4,  name: '1ª boot do Ubuntu',         cat: 'manual' },
    { id: 'step_05_apt_base',           num: 5,  name: 'Pacotes apt base',          cat: 'auto'   },
    { id: 'step_06_node_nvm',           num: 6,  name: 'Node 20 LTS',               cat: 'auto'   },
    { id: 'step_07_npm_prefix',         num: 7,  name: 'npm global sem sudo',       cat: 'auto'   },
    { id: 'step_08_claude_cli',         num: 8,  name: 'Claude Code CLI',           cat: 'auto'   },
    { id: 'step_09_claude_login',       num: 9,  name: 'Login Claude',              cat: 'manual' },
    { id: 'step_10_gh_auth',            num: 10, name: 'GitHub auth (Device Flow)', cat: 'hybrid' },
    { id: 'step_11_clone_squad',        num: 11, name: 'Clonar imp-squad',          cat: 'auto'   },
    { id: 'step_12_clone_orchestrator', num: 12, name: 'Clonar imp-orchestrator',   cat: 'auto'   },
    { id: 'step_13_sala3d',             num: 13, name: 'Sala 3D (opcional)',        cat: 'auto'   },
    { id: 'step_14_tmux_session',       num: 14, name: 'Sessão tmux imp (7 painéis)', cat: 'auto' },
    { id: 'step_15_download_interface', num: 15, name: 'Baixar Squad Comando.exe', cat: 'auto'   },
    { id: 'step_16_e2e',                num: 16, name: 'Validação end-to-end',      cat: 'auto'   }
  ];

  const STEP_BY_ID  = Object.fromEntries(STEPS.map(s => [s.id, s]));
  const STEP_TOTAL  = STEPS.length;

  // ───────────────────────────────────────────────────────────
  // Estado local da UI (espelho do backend; backend é a verdade)
  // ───────────────────────────────────────────────────────────
  const ui = {
    currentScreen: 'welcome',
    currentStepId: null,
    stepStates: Object.fromEntries(STEPS.map(s => [s.id, 'pending'])),
    autoScroll: true,
    startedAt: null,
    logBuffer: [],          // {ts, level, stepId, msg}
    paused: false,
    // ─── feedback visual (Camila v0.2.2) ────────────────────
    lastLogAt: 0,
    activityTimer: null,
    waitTimers: Object.create(null),   // stepId/checkId → { soft, hard }
    pfWaitTimers: Object.create(null),
    preflightRunning: false
  };

  // Atalho pra API do main.js — defensivo (se rodar standalone, vira no-op)
  const api = (window.api && window.api.installer) || makeNoopApi();

  function makeNoopApi() {
    // Modo "preview" sem backend — útil pra Camila iterar o visual sozinha.
    console.warn('[wizard] window.api.installer ausente — modo preview/noop ativo');
    const noop = () => {};
    const noopAsync = async () => ({ ok: true });
    return {
      start: noopAsync, resume: noopAsync, runStep: noopAsync,
      markManualDone: noopAsync, retry: noopAsync, skip: noopAsync,
      getState: async () => ({ steps: ui.stepStates, lastStepCompleted: null }),
      openTerminal: noop, openBrowser: noop, exportLogs: noopAsync,
      installSala3D: noopAsync, openInterface: noop, closeApp: noop,
      onLog:        (cb) => { /* noop */ },
      onStepUpdate: (cb) => { /* noop */ },
      onPreflight:  (cb) => { /* noop */ },
      onManualPrompt: (cb) => { /* noop */ },
      onError:      (cb) => { /* noop */ },
      onComplete:   (cb) => { /* noop */ },
      onScreen:     (cb) => { /* noop */ },
      onToast:      (cb) => { /* noop */ },
      onState:      (cb) => { /* noop */ },
      onSudoPrompt: (cb) => { /* noop */ },
      sudoReply:    async () => ({ ok: true })
    };
  }

  // ───────────────────────────────────────────────────────────
  // DOM helpers
  // ───────────────────────────────────────────────────────────
  const $  = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const el = (tag, props = {}, ...kids) => {
    const node = Object.assign(document.createElement(tag), props);
    kids.flat().forEach(k => node.append(k instanceof Node ? k : document.createTextNode(k)));
    return node;
  };

  // ───────────────────────────────────────────────────────────
  // Troca de tela
  // ───────────────────────────────────────────────────────────
  function showScreen(name) {
    ui.currentScreen = name;
    $$('.screen').forEach(s => s.classList.remove('active'));
    const target = $('#screen-' + name);
    if (target) target.classList.add('active');
    // foco no h1/h2 pra leitor de tela
    const heading = target && target.querySelector('h1, h2');
    if (heading) {
      heading.setAttribute('tabindex', '-1');
      heading.focus({ preventScroll: false });
    }
    // mostrar/esconder barra global + log peek conforme tela
    syncPersistentChrome();
  }

  // ───────────────────────────────────────────────────────────
  // Toast
  // ───────────────────────────────────────────────────────────
  function toast(message, kind = 'info', timeoutMs = 4000) {
    const container = $('#toast-container');
    const icons = { info: 'i', success: '✓', warn: '!', error: '×' };
    const node = el('div', { className: `toast ${kind}`, role: 'status' },
      el('span', { className: 'toast-icon' }, icons[kind] || 'i'),
      el('div',  { className: 'toast-body' }, message),
      el('button', {
        className: 'toast-close',
        ariaLabel: 'Fechar notificação',
        onclick: () => removeToast(node)
      }, '×')
    );
    container.appendChild(node);
    setTimeout(() => removeToast(node), timeoutMs);
  }
  function removeToast(node) {
    if (!node || !node.isConnected) return;
    node.classList.add('fade');
    setTimeout(() => node.remove(), 320);
  }

  // ───────────────────────────────────────────────────────────
  // Modais
  // ───────────────────────────────────────────────────────────
  function openModal(id)  { $('#' + id).classList.remove('hidden'); }
  function closeModal(id) { $('#' + id).classList.add('hidden'); }

  document.addEventListener('click', (e) => {
    const target = e.target.closest('[data-close-modal]');
    if (target) closeModal(target.dataset.closeModal);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      $$('.modal-overlay:not(.hidden)').forEach(m => m.classList.add('hidden'));
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'l') {
      e.preventDefault();
      openLogsModal();
    }
  });

  // ───────────────────────────────────────────────────────────
  // Sidebar de passos
  // ───────────────────────────────────────────────────────────
  function renderStepList() {
    const list = $('#step-list');
    list.innerHTML = '';
    STEPS.forEach(s => {
      const li = el('li', {
        className: 'step-item',
        role: 'listitem',
        title: s.name
      });
      li.dataset.stepId = s.id;
      li.dataset.state  = ui.stepStates[s.id] || 'pending';
      li.append(
        el('span', { className: 'si-num' }, String(s.num).padStart(2, '0')),
        el('span', { className: 'si-name' }, s.name),
        el('span', { className: 'si-icon', ariaHidden: 'true' })
      );
      list.appendChild(li);
    });
    refreshCounter();
    populateLogsFilter();
  }

  function setStepState(stepId, state) {
    if (!STEP_BY_ID[stepId]) return;
    ui.stepStates[stepId] = state;
    const node = $(`.step-item[data-step-id="${stepId}"]`);
    if (node) node.dataset.state = state;
    refreshCounter();
  }

  function refreshCounter() {
    const done = Object.values(ui.stepStates).filter(s => s === 'done' || s === 'skipped').length;
    $('#step-done-count').textContent  = done;
    $('#step-total-count').textContent = STEP_TOTAL;
    const pct = Math.round((done / STEP_TOTAL) * 100);
    $('#overall-fill').style.width = pct + '%';
  }

  // ───────────────────────────────────────────────────────────
  // Painel central do passo atual
  // ───────────────────────────────────────────────────────────
  function setCurrentStep(stepId, { progress, etaSeconds } = {}) {
    const meta = STEP_BY_ID[stepId];
    if (!meta) return;
    ui.currentStepId = stepId;

    $('#cur-step-num').textContent   = String(meta.num).padStart(2, '0');
    $('#cur-step-title').textContent = meta.name;
    $('#cur-step-desc').textContent  = describeStep(meta);

    const badge = $('#cur-step-cat');
    badge.dataset.cat = meta.cat;
    badge.textContent = meta.cat === 'auto'   ? 'AUTO'
                      : meta.cat === 'manual' ? 'MANUAL'
                                              : 'HÍBRIDO';

    if (typeof progress === 'number') {
      $('#step-fill').style.width = Math.max(0, Math.min(100, progress)) + '%';
    }
    if (typeof etaSeconds === 'number') {
      $('#step-eta').textContent = formatETA(etaSeconds);
    } else {
      $('#step-eta').textContent = '—';
    }
  }

  function describeStep(meta) {
    // descrições humanas curtas pro usuário — espelham o ROTEIRO
    const map = {
      step_00_preflight:         'Conferindo que seu computador está pronto.',
      step_01_enable_features:   'Habilitando os componentes do Windows que o WSL precisa.',
      step_02_set_wsl_default_v2:'Garantindo que novas distros venham na versão 2 (mais rápida).',
      step_03_wsl_install:       'Baixando o kernel WSL2 e o Ubuntu. Vai precisar reiniciar.',
      step_04_ubuntu_first_boot: 'Criando seu usuário Linux. Vou abrir o Ubuntu pra você.',
      step_05_apt_base:          'Instalando tmux, git, curl e ferramentas de build.',
      step_06_node:              'Instalando o Node 20 LTS via NodeSource.',
      step_07_npm_global:        'Configurando o npm pra instalar pacotes sem sudo.',
      step_08_claude_cli:        'Instalando o Claude Code CLI globalmente.',
      step_09_claude_login:      'Vou abrir o login do Claude pra você autenticar com sua conta Max.',
      step_10_github_auth:       'Conectando ao GitHub com Device Flow (seguro).',
      step_11_clone_squad:       'Clonando o repositório imp-squad em C:\\Projetos.',
      step_12_clone_orch:        'Clonando o imp-orchestrator e rodando npm install.',
      step_13_sala3d:            'A sala 3D é opcional — você pode instalar agora ou depois.',
      step_14_tmux_session:      'Criando a sessão tmux "imp" com os 7 painéis da squad.',
      step_15_interface_dl:      'Baixando o Squad Comando e criando atalho no Desktop.',
      step_16_e2e:               'Abrindo o Squad Comando e validando que conecta na squad.'
    };
    return map[meta.id] || '';
  }

  function formatETA(seconds) {
    if (seconds < 60) return `~${Math.ceil(seconds)}s`;
    const m = Math.floor(seconds / 60);
    const s = Math.round(seconds % 60);
    return s ? `~${m}min ${s}s` : `~${m}min`;
  }

  // ───────────────────────────────────────────────────────────
  // Logs
  // ───────────────────────────────────────────────────────────
  function appendLog({ msg, level = 'info', stepId = null, ts = Date.now() }) {
    ui.logBuffer.push({ ts, level, stepId, msg });
    if (ui.logBuffer.length > 5000) ui.logBuffer.shift();

    const body = $('#logs-body');
    const line = el('div', { className: 'log-line log-' + level });
    const time = el('span', { className: 'log-ts' }, formatClock(ts) + '  ');
    line.append(time, msg);
    body.appendChild(line);
    if (ui.autoScroll) body.scrollTop = body.scrollHeight;

    // Atualiza modal de logs também se aberto
    if (!$('#modal-logs').classList.contains('hidden')) {
      refreshLogsModal();
    }
  }

  function formatClock(ts) {
    const d = new Date(ts);
    const pad = n => String(n).padStart(2, '0');
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  function clearLiveLogs() {
    $('#logs-body').innerHTML = '';
  }

  // ───────────────────────────────────────────────────────────
  // Logs modal (detalhado)
  // ───────────────────────────────────────────────────────────
  function openLogsModal() {
    populateLogsFilter();
    refreshLogsModal();
    openModal('modal-logs');
  }
  function populateLogsFilter() {
    const sel = $('#logs-filter-step');
    if (!sel) return;
    const current = sel.value || 'all';
    sel.innerHTML = '';
    sel.appendChild(el('option', { value: 'all' }, 'Todos os passos'));
    STEPS.forEach(s => {
      sel.appendChild(el('option', { value: s.id },
        `${String(s.num).padStart(2,'0')} — ${s.name}`));
    });
    sel.value = current;
  }
  function refreshLogsModal() {
    const stepF  = $('#logs-filter-step').value;
    const levelF = $('#logs-filter-level').value;
    const pane   = $('#logs-modal-pane');
    pane.innerHTML = '';
    const filtered = ui.logBuffer.filter(e =>
      (stepF  === 'all' || e.stepId === stepF) &&
      (levelF === 'all' || e.level  === levelF)
    );
    if (filtered.length === 0) {
      pane.appendChild(el('div', { className: 'log-info' }, '(nenhum log)'));
      return;
    }
    filtered.forEach(e => {
      const tag = STEP_BY_ID[e.stepId]
        ? `[${String(STEP_BY_ID[e.stepId].num).padStart(2,'0')}] `
        : '';
      pane.appendChild(el('div', { className: 'log-line log-' + e.level },
        formatClock(e.ts) + '  ' + tag + e.msg));
    });
    pane.scrollTop = pane.scrollHeight;
  }

  // ───────────────────────────────────────────────────────────
  // Preflight cards
  // ───────────────────────────────────────────────────────────
  function setPreflightResult(checkId, state, message) {
    const card = $(`.pf-card[data-check="${checkId}"]`);
    if (!card) return;
    card.dataset.state = state;          // pending | running | ok | warn | err
    const status = card.querySelector('.pf-status') || card.querySelector('.pf-msg');
    if (status) status.textContent = message || statusFallback(state);
    const icon = card.querySelector('.pf-icon');
    if (icon && state !== 'running') {
      // estado running usa CSS-only spinner; só atualizamos ícone nos outros
      icon.textContent = state === 'ok'   ? '✓'
                       : state === 'warn' ? '!'
                       : state === 'err'  ? '×'
                                          : '⏳';
    }
    if (state === 'running') {
      ensurePfWaitNode(card);
      armPreflightWait(checkId);
    } else {
      clearPreflightWait(checkId);
    }
    evaluatePreflightGate();
    refreshPreflightProgress();
  }
  function statusFallback(state) {
    // shadow do statusFallback original — sobrescrito pra cobrir "running"
    return state === 'ok'      ? 'Tudo certo'
         : state === 'warn'    ? 'Atenção'
         : state === 'err'     ? 'Bloqueado'
         : state === 'running' ? 'Verificando agora…'
                               : 'Verificando…';
  }
  function evaluatePreflightGate() {
    const cards  = $$('.pf-card');
    const states = cards.map(c => c.dataset.state);
    const pending = states.some(s => s === 'pending');
    const hasErr  = states.some(s => s === 'err');
    const allDone = !pending;
    $('#btn-preflight-next').disabled = !allDone || hasErr;
  }

  // ───────────────────────────────────────────────────────────
  // Manual screen — prompt vindo do backend
  // ───────────────────────────────────────────────────────────
  function showManualPrompt(prompt) {
    // prompt = { stepId, title, subtitle, instructions: [{title, body, code}], terminal:{cmd}, browser:{url} }
    showScreen('manual');
    const meta = STEP_BY_ID[prompt.stepId] || {};
    $('#manual-title').textContent    = prompt.title    || `Preciso de você no passo ${meta.num || ''}`;
    $('#manual-subtitle').textContent = prompt.subtitle || 'Esse passo não dá pra automatizar com segurança. Eu te guio.';

    const list = $('#manual-steps');
    list.innerHTML = '';
    (prompt.instructions || []).forEach(ins => {
      const li = el('li', { className: 'manual-step' });
      li.append(el('h4', {}, ins.title || ''));
      if (ins.body) li.append(el('p', {}, ins.body));
      if (ins.code) {
        const p = el('p');
        p.appendChild(el('code', {}, ins.code));
        li.append(p);
      }
      list.appendChild(li);
    });

    // Botões opcionais
    const tBtn = $('#btn-manual-open-terminal');
    const bBtn = $('#btn-manual-open-browser');
    tBtn.hidden = !prompt.terminal;
    bBtn.hidden = !prompt.browser;
    tBtn.onclick = () => prompt.terminal && api.openTerminal(prompt.terminal.cmd);
    bBtn.onclick = () => prompt.browser  && api.openBrowser(prompt.browser.url);

    // Reseta confirmação
    $('#manual-done-check').checked = false;
    $('#btn-manual-next').disabled  = true;

    // Guarda stepId atual pro botão "verificar"
    $('#screen-manual').dataset.stepId = prompt.stepId;
  }

  // ───────────────────────────────────────────────────────────
  // Error screen
  // ───────────────────────────────────────────────────────────
  function showErrorScreen(payload) {
    // payload = { stepId, headline, what, suggestions: [string], canRetry, canSkip }
    showScreen('error');
    const meta = STEP_BY_ID[payload.stepId] || {};
    $('#error-step-num').textContent = String(meta.num ?? '?').padStart(2, '0');
    $('#error-headline').textContent = payload.headline || 'Algo não deu certo.';
    $('#error-what').textContent     = payload.what     || '—';

    const ul = $('#error-suggestions');
    ul.innerHTML = '';
    (payload.suggestions && payload.suggestions.length
      ? payload.suggestions
      : ['Tentar de novo — às vezes é só rede instável.']
    ).forEach(s => ul.appendChild(el('li', {}, s)));

    $('#btn-error-retry').disabled = payload.canRetry === false;
    $('#btn-error-skip').disabled  = payload.canSkip  === false;
    $('#screen-error').dataset.stepId = payload.stepId;

    setStepState(payload.stepId, 'error');
    setConnection('err', 'Travado no passo ' + (meta.num ?? '?'));
  }

  // ───────────────────────────────────────────────────────────
  // Connection pill (rodapé do progresso)
  // ───────────────────────────────────────────────────────────
  function setConnection(state, label) {
    const pill = $('#connection-pill');
    pill.classList.remove('state-paused', 'state-err');
    if (state === 'paused') pill.classList.add('state-paused');
    if (state === 'err')    pill.classList.add('state-err');
    pill.querySelector('span:last-child').textContent =
      label || (state === 'paused' ? 'Pausado' : state === 'err' ? 'Erro' : 'Trabalhando…');
  }

  // ───────────────────────────────────────────────────────────
  // FEEDBACK VISUAL GLOBAL (Camila v0.2.2)
  // Resolve o bug "tela vazia e estática por 2min" do v0.2.1
  // ───────────────────────────────────────────────────────────

  // Telas que devem mostrar a barra global + log peek
  const WORK_SCREENS = new Set(['preflight', 'progress', 'manual']);

  // Status pill (topbar) — estado global
  function setStatusPill(state, text) {
    const pill = $('#status-pill');
    if (!pill) return;
    pill.dataset.state = state;                  // idle | working | error | success
    const t = pill.querySelector('.sp-text');
    if (t && text) t.textContent = text;
    pill.title = text || '';
    // erro vira clicável (abre logs)
    pill.style.pointerEvents = state === 'error' ? 'auto' : 'none';
  }
  // Click no status pill (quando erro): abre logs
  document.addEventListener('click', (e) => {
    const pill = e.target.closest('#status-pill');
    if (pill && pill.dataset.state === 'error') openLogsModal();
  });

  // Barra global no topo
  function showGlobalProgress(show = true) {
    const bar = $('#global-progress');
    if (!bar) return;
    bar.classList.toggle('hidden', !show);
  }
  function setGlobalProgress({ text, done, total, percent }) {
    const bar = $('#global-progress');
    if (!bar) return;
    if (text) $('#gp-text').textContent = text;
    if (typeof done === 'number' && typeof total === 'number') {
      $('#gp-count').textContent = `${done}/${total}`;
      if (typeof percent !== 'number') percent = Math.round((done / total) * 100);
    }
    if (typeof percent === 'number') {
      $('#gp-fill').style.width = Math.max(0, Math.min(100, percent)) + '%';
    }
  }
  function pulseActivity() {
    const bar = $('#global-progress');
    if (!bar) return;
    bar.classList.add('activity');
    clearTimeout(ui.activityTimer);
    ui.activityTimer = setTimeout(() => bar.classList.remove('activity'), 1600);
  }

  // Log peek (painel inline embaixo das telas de work)
  function showLogPeek(show = true) {
    const peek = $('#log-peek');
    if (!peek) return;
    peek.classList.toggle('hidden', !show);
  }
  function appendLogPeek(entry) {
    const body = $('#lp-body');
    if (!body) return;
    // remove placeholder se existir
    const empty = body.querySelector('.lp-empty');
    if (empty) empty.remove();

    const line = el('div', { className: 'lp-line lp-' + (entry.level || 'info') + ' fresh' });
    line.append(
      el('span', { className: 'lp-ts' }, formatClock(entry.ts || Date.now())),
      document.createTextNode((entry.message || entry.msg) || '')
    );
    body.appendChild(line);
    // mantém até 12 linhas no peek (compacto)
    while (body.children.length > 12) body.removeChild(body.firstChild);
    // auto-scroll
    body.scrollTop = body.scrollHeight;
    // remove glow após 1s
    setTimeout(() => line.classList.remove('fresh'), 1000);

    // hint = última mensagem resumida
    const hint = $('#lp-hint');
    if (hint) hint.textContent = '— ' + ((entry.message || entry.msg) || '').slice(0, 80);

    // marca peek como ativo (ponto pulsando)
    const peek = $('#log-peek');
    if (peek) {
      peek.classList.remove('idle');
      clearTimeout(peek._idleTimer);
      peek._idleTimer = setTimeout(() => peek.classList.add('idle'), 8000);
    }
  }
  function clearLogPeek() {
    const body = $('#lp-body');
    if (body) body.innerHTML = '<div class="lp-empty">aguardando primeira mensagem…</div>';
    const hint = $('#lp-hint');
    if (hint) hint.textContent = 'aguardando primeira mensagem…';
  }

  // Atualiza visibilidade dos elementos persistentes ao trocar de tela
  function syncPersistentChrome() {
    const isWork = WORK_SCREENS.has(ui.currentScreen);
    showGlobalProgress(isWork);
    showLogPeek(isWork);
  }

  // Marca TODOS os preflight cards como "running" — chamado ao entrar na tela
  // ou após 200ms se nenhum evento backend chegou ainda (anti tela-vazia)
  function startPreflightRunning() {
    if (ui.preflightRunning) return;
    ui.preflightRunning = true;
    $$('.pf-card').forEach(card => {
      if (card.dataset.state === 'pending') {
        card.dataset.state = 'running';
        const status = card.querySelector('.pf-status') || card.querySelector('.pf-msg');
        if (status) status.textContent = 'Verificando agora…';
        // injeta long-wait notice se ainda não existe
        ensurePfWaitNode(card);
        // arma watchdog
        armPreflightWait(card.dataset.check);
      }
    });
    setStatusPill('working', 'Verificando ambiente…');
    setGlobalProgress({ text: 'Verificando ambiente…', done: 0, total: 7 });
  }
  function ensurePfWaitNode(card) {
    if (card.querySelector('.pf-wait')) return;
    const wait = el('p', { className: 'pf-wait' }, 'Esse passo pode levar alguns minutos — aguarde.');
    // posição: depois do body ou do msg
    (card.querySelector('.pf-body') || card).appendChild(wait);
  }
  function armPreflightWait(checkId) {
    clearPreflightWait(checkId);
    const card = $(`.pf-card[data-check="${checkId}"]`);
    if (!card) return;
    const soft = setTimeout(() => {
      card.classList.add('long-wait');
      const w = card.querySelector('.pf-wait');
      if (w) w.textContent = 'Esse passo pode levar alguns minutos — aguarde.';
    }, 30000);
    const hard = setTimeout(() => {
      card.classList.add('very-long-wait');
      const w = card.querySelector('.pf-wait');
      if (w) w.textContent = 'Demorou mais que o esperado — veja logs detalhados.';
    }, 5 * 60000);
    ui.pfWaitTimers[checkId] = { soft, hard };
  }
  function clearPreflightWait(checkId) {
    const t = ui.pfWaitTimers[checkId];
    if (t) { clearTimeout(t.soft); clearTimeout(t.hard); delete ui.pfWaitTimers[checkId]; }
    const card = $(`.pf-card[data-check="${checkId}"]`);
    if (card) card.classList.remove('long-wait', 'very-long-wait');
  }

  // Conta progresso do preflight (cards ok/warn/err vs total)
  function refreshPreflightProgress() {
    const cards = $$('.pf-card');
    const total = cards.length;
    const done = cards.filter(c => ['ok','warn','err'].includes(c.dataset.state)).length;
    setGlobalProgress({ text: done < total ? `Verificando ambiente… (${done}/${total})` : 'Verificações concluídas', done, total });
    if (done === total) {
      const hasErr = cards.some(c => c.dataset.state === 'err');
      setStatusPill(hasErr ? 'error' : 'success', hasErr ? 'Erro nas verificações — clique pra detalhes' : 'Ambiente pronto');
    }
  }

  // Watchdog de "demora" pros steps principais
  function armStepWait(stepId) {
    clearStepWait(stepId);
    const meta = STEP_BY_ID[stepId];
    const num = meta ? String(meta.num).padStart(2, '0') : '?';
    const name = meta ? meta.name : stepId;
    const soft = setTimeout(() => {
      appendLogPeek({ level: 'warn', msg: `[${num}] ${name}: esse passo pode levar alguns minutos — aguarde…` });
      toast('Esse passo pode levar alguns minutos — aguarde', 'info', 6000);
    }, 30000);
    const hard = setTimeout(() => {
      appendLogPeek({ level: 'error', msg: `[${num}] ${name}: demorou mais que o esperado — veja logs detalhados.` });
      toast('Demorou mais que o esperado — clique em "Logs" para detalhes', 'warn', 8000);
    }, 5 * 60000);
    ui.waitTimers[stepId] = { soft, hard };
  }
  function clearStepWait(stepId) {
    const t = ui.waitTimers[stepId];
    if (t) { clearTimeout(t.soft); clearTimeout(t.hard); delete ui.waitTimers[stepId]; }
  }

  // ───────────────────────────────────────────────────────────
  // Boas-vindas — bindings
  // ───────────────────────────────────────────────────────────
  function bindWelcome() {
    const consent = $('#consent-checkbox');
    const startBtn = $('#btn-start');
    consent.addEventListener('change', () => {
      startBtn.disabled = !consent.checked;
    });
    startBtn.addEventListener('click', async () => {
      ui.startedAt = Date.now();
      ui.preflightRunning = false;
      showScreen('preflight');
      // feedback IMEDIATO — não esperar evento backend pra parar de parecer travado
      setStatusPill('working', 'Iniciando verificações…');
      setGlobalProgress({ text: 'Iniciando verificações…', done: 0, total: 7 });
      clearLogPeek();
      // Safety net: se backend não emitir nada em 200ms, marca todos cards como running
      setTimeout(() => startPreflightRunning(), 200);
      try {
        await api.start();
      } catch (e) {
        toast('Não consegui iniciar a instalação. ' + (e?.message || ''), 'error');
        setStatusPill('error', 'Falhou ao iniciar — clique pra detalhes');
      }
    });
    $('#btn-cancel-welcome').addEventListener('click', () => {
      if (api.closeApp) api.closeApp();
      else window.close();
    });
    $('#btn-resume').addEventListener('click', async () => {
      ui.startedAt = Date.now();
      showScreen('progress');
      try { await api.resume(); }
      catch (e) { toast('Não consegui retomar. ' + (e?.message || ''), 'error'); }
    });
    $('#btn-fresh').addEventListener('click', async () => {
      // Fix Eduardo N1: reset real do state antes de começar
      if (typeof api.reset === 'function') {
        try { await api.reset(); toast('Estado anterior arquivado. Começando do zero.', 'info'); }
        catch (e) { toast('Não consegui resetar: ' + (e?.message || ''), 'error'); }
      }
      $('#resume-card').classList.add('hidden');
    });
  }

  // ───────────────────────────────────────────────────────────
  // Preflight — bindings
  // ───────────────────────────────────────────────────────────
  function bindPreflight() {
    $('#btn-preflight-recheck').addEventListener('click', async () => {
      ui.preflightRunning = false;
      $$('.pf-card').forEach(c => {
        c.classList.remove('long-wait', 'very-long-wait');
        clearPreflightWait(c.dataset.check);
        setPreflightResult(c.dataset.check, 'pending', 'Verificando…');
      });
      setStatusPill('working', 'Re-verificando ambiente…');
      setGlobalProgress({ text: 'Re-verificando ambiente…', done: 0, total: 7 });
      setTimeout(() => startPreflightRunning(), 200);
      try { await api.runStep('step_00_preflight'); }
      catch (e) {
        toast('Erro no preflight: ' + (e?.message || ''), 'error');
        setStatusPill('error', 'Erro no preflight — clique pra detalhes');
      }
    });
    $('#btn-preflight-next').addEventListener('click', () => {
      showScreen('progress');
    });
  }

  // ───────────────────────────────────────────────────────────
  // Progresso — bindings
  // ───────────────────────────────────────────────────────────
  function bindProgress() {
    $('#autoscroll-toggle').addEventListener('change', (e) => {
      ui.autoScroll = e.target.checked;
    });
    $('#btn-pause').addEventListener('click', () => {
      ui.paused = !ui.paused;
      $('#btn-pause').textContent = ui.paused ? 'Continuar' : 'Pausar';
      setConnection(ui.paused ? 'paused' : 'ok', ui.paused ? 'Pausado' : 'Trabalhando…');
      if (api.pause && ui.paused)  api.pause();
      if (api.resume && !ui.paused) api.resume();
    });
    $('#btn-skip').addEventListener('click', () => {
      if (!ui.currentStepId) return;
      $('#skip-reason').value = '';
      openModal('modal-skip');
    });
    $('#btn-skip-confirm').addEventListener('click', async () => {
      const reason = $('#skip-reason').value.trim();
      closeModal('modal-skip');
      try {
        await api.skip(ui.currentStepId, reason);
        setStepState(ui.currentStepId, 'skipped');
        toast('Passo pulado. Cuidado com efeitos colaterais.', 'warn');
      } catch (e) {
        toast('Não consegui pular: ' + (e?.message || ''), 'error');
      }
    });
  }

  // ───────────────────────────────────────────────────────────
  // Manual — bindings
  // ───────────────────────────────────────────────────────────
  function bindManual() {
    const check = $('#manual-done-check');
    check.addEventListener('change', () => {
      $('#btn-manual-next').disabled = !check.checked;
    });
    $('#btn-manual-verify').addEventListener('click', async () => {
      const stepId = $('#screen-manual').dataset.stepId;
      if (!stepId) return;
      toast('Verificando…', 'info', 2000);
      try {
        const result = await api.runStep(stepId);
        if (result && result.ok) {
          toast('Tudo certo!', 'success');
          check.checked = true;
          $('#btn-manual-next').disabled = false;
        } else {
          toast('Ainda não está pronto. Confira os passos acima.', 'warn');
        }
      } catch (e) {
        toast('Verificação falhou: ' + (e?.message || ''), 'error');
      }
    });
    $('#btn-manual-next').addEventListener('click', async () => {
      const stepId = $('#screen-manual').dataset.stepId;
      if (!stepId) return;
      try {
        await api.markManualDone(stepId);
        showScreen('progress');
      } catch (e) {
        toast('Não consegui marcar como feito: ' + (e?.message || ''), 'error');
      }
    });
    $('#btn-manual-help').addEventListener('click', () => {
      openLogsModal();
      toast('Mostre os logs pro time se precisar de ajuda.', 'info', 6000);
    });
  }

  // ───────────────────────────────────────────────────────────
  // Error — bindings
  // ───────────────────────────────────────────────────────────
  function bindError() {
    $('#btn-error-retry').addEventListener('click', async () => {
      const stepId = $('#screen-error').dataset.stepId;
      if (!stepId) return;
      showScreen('progress');
      setConnection('ok');
      try { await api.retry(stepId); }
      catch (e) { toast('Retry falhou: ' + (e?.message || ''), 'error'); }
    });
    $('#btn-error-skip').addEventListener('click', () => {
      const stepId = $('#screen-error').dataset.stepId;
      if (!stepId) return;
      ui.currentStepId = stepId;
      $('#skip-reason').value = '';
      openModal('modal-skip');
    });
    $('#btn-error-logs').addEventListener('click', openLogsModal);
    $('#btn-error-help').addEventListener('click', () => {
      toast('Exportei os logs. Mande pro time.', 'info');
      api.exportLogs && api.exportLogs();
    });
  }

  // ───────────────────────────────────────────────────────────
  // Done — bindings
  // ───────────────────────────────────────────────────────────
  function bindDone() {
    $('#btn-open-interface').addEventListener('click', () => {
      api.openInterface && api.openInterface();
    });
    $('#btn-install-sala3d').addEventListener('click', () => openModal('modal-sala3d'));
    $('#btn-close-installer').addEventListener('click', () => {
      api.closeApp ? api.closeApp() : window.close();
    });

    // Modal sala 3D
    $('#btn-sala3d-confirm').addEventListener('click', async () => {
      $('#sala3d-progress').classList.remove('hidden');
      $('#btn-sala3d-confirm').disabled = true;
      try {
        await api.installSala3D();
        toast('Sala 3D instalada!', 'success');
        closeModal('modal-sala3d');
      } catch (e) {
        toast('Falhou: ' + (e?.message || ''), 'error');
      } finally {
        $('#btn-sala3d-confirm').disabled = false;
      }
    });
  }

  // ───────────────────────────────────────────────────────────
  // Topbar — bindings (Logs / Exportar)
  // ───────────────────────────────────────────────────────────
  function bindTopbar() {
    $('#btn-open-logs').addEventListener('click', openLogsModal);
    const peekBtn = $('#btn-log-peek-open');
    if (peekBtn) peekBtn.addEventListener('click', openLogsModal);
    $('#btn-export-logs').addEventListener('click', async () => {
      try {
        const out = await api.exportLogs();
        toast('Logs exportados' + (out?.path ? ' em ' + out.path : ''), 'success');
      } catch (e) {
        toast('Não consegui exportar: ' + (e?.message || ''), 'error');
      }
    });

    // Filtros do modal de logs
    $('#logs-filter-step') .addEventListener('change', refreshLogsModal);
    $('#logs-filter-level').addEventListener('change', refreshLogsModal);
    $('#btn-logs-copy').addEventListener('click', () => {
      const text = $('#logs-modal-pane').innerText;
      navigator.clipboard.writeText(text).then(
        () => toast('Logs copiados', 'success'),
        () => toast('Não consegui copiar', 'error')
      );
    });
    $('#btn-logs-export').addEventListener('click', async () => {
      try {
        const out = await api.exportLogs();
        toast('Exportado!' + (out?.path ? ' ' + out.path : ''), 'success');
      } catch (e) {
        toast('Falha: ' + (e?.message || ''), 'error');
      }
    });
  }

  // ───────────────────────────────────────────────────────────
  // Eventos do backend (api.installer.on*)
  // ───────────────────────────────────────────────────────────
  function bindBackendEvents() {
    api.onLog && api.onLog((entry) => {
      // entry = { msg, level?, stepId?, ts? }
      if (typeof entry === 'string') entry = { msg: entry };
      appendLog(entry);
      // feedback visual — log também alimenta peek + ativa pulse
      appendLogPeek(entry);
      pulseActivity();
      ui.lastLogAt = Date.now();
      // anti tela-vazia: primeiro log já marca todos preflight cards como running
      if (ui.currentScreen === 'preflight' && !ui.preflightRunning) {
        startPreflightRunning();
      }
    });

    api.onStepUpdate && api.onStepUpdate((update) => {
      // update = { stepId, state, progress?, etaSeconds?, message? }
      if (!update || !update.stepId) return;
      if (update.state) setStepState(update.stepId, update.state);
      const meta = STEP_BY_ID[update.stepId] || {};
      const num = String(meta.num ?? '?').padStart(2, '0');
      const name = meta.name || update.stepId;

      if (update.state === 'running') {
        ui.currentStepId = update.stepId;
        setCurrentStep(update.stepId, {
          progress:   update.progress,
          etaSeconds: update.etaSeconds
        });
        setConnection('ok');
        // status pill + barra global refletem o passo atual
        setStatusPill('working', `Processando passo ${num}/${STEP_TOTAL - 1}: ${name}`);
        const done = Object.values(ui.stepStates).filter(s => s === 'done' || s === 'skipped').length;
        setGlobalProgress({
          text: `Passo ${num} de ${STEP_TOTAL - 1}: ${name}`,
          done, total: STEP_TOTAL
        });
        armStepWait(update.stepId);
        pulseActivity();
      } else {
        if (update.stepId === ui.currentStepId) {
          // refresh barra mesmo se não rolou troca
          setCurrentStep(update.stepId, {
            progress:   update.progress,
            etaSeconds: update.etaSeconds
          });
        }
        // saiu do running: limpa watchdog
        if (['done','skipped','error','manual'].includes(update.state)) {
          clearStepWait(update.stepId);
        }
        // atualiza progress count
        const done = Object.values(ui.stepStates).filter(s => s === 'done' || s === 'skipped').length;
        setGlobalProgress({ done, total: STEP_TOTAL });
        if (update.state === 'error') {
          setStatusPill('error', `Erro no passo ${num} — clique pra detalhes`);
        }
      }
    });

    api.onPreflight && api.onPreflight((res) => {
      // res = { checkId, state, message }
      setPreflightResult(res.checkId, res.state, res.message);
    });

    api.onManualPrompt && api.onManualPrompt(showManualPrompt);
    api.onError        && api.onError((payload) => {
      const meta = STEP_BY_ID[payload?.stepId] || {};
      const num = String(meta.num ?? '?').padStart(2, '0');
      setStatusPill('error', `Erro no passo ${num} — clique pra detalhes`);
      showErrorScreen(payload);
    });

    api.onComplete && api.onComplete((summary) => {
      // summary = { durationSeconds, sala3dInstalled }
      if (summary?.durationSeconds) {
        const m = Math.round(summary.durationSeconds / 60);
        $('#done-time-pill').textContent = `Levou ${m} min`;
      }
      setStatusPill('success', 'Instalação concluída');
      showGlobalProgress(false);
      showLogPeek(false);
      // limpa watchdogs
      Object.keys(ui.waitTimers).forEach(clearStepWait);
      showScreen('done');
    });

    // Eventos opcionais que o main.js pode disparar
    api.onScreen && api.onScreen((name) => showScreen(name));
    api.onToast  && api.onToast(({ message, kind }) => toast(message, kind));

    // Fix Eduardo 2.3 — modal de sudo (passos 05, 10 precisam)
    api.onSudoPrompt && api.onSudoPrompt(({ id, prompt }) => {
      const overlay = $('#modal-sudo');
      const input = $('#sudo-input');
      const ptext = $('#sudo-prompt-text');
      if (prompt) ptext.textContent = prompt;
      input.value = '';
      overlay.classList.remove('hidden');
      setTimeout(() => input.focus(), 60);

      const onConfirm = () => {
        const pwd = input.value;
        cleanup();
        overlay.classList.add('hidden');
        input.value = '';
        api.sudoReply(id, pwd, false);
      };
      const onCancel = () => {
        cleanup();
        overlay.classList.add('hidden');
        input.value = '';
        api.sudoReply(id, '', true);
      };
      const onKey = (e) => {
        if (e.key === 'Enter') onConfirm();
        if (e.key === 'Escape') onCancel();
      };
      function cleanup() {
        $('#btn-sudo-confirm').removeEventListener('click', onConfirm);
        $('#btn-sudo-cancel').removeEventListener('click', onCancel);
        overlay.querySelector('[data-close-modal="modal-sudo"]').removeEventListener('click', onCancel);
        input.removeEventListener('keydown', onKey);
      }
      $('#btn-sudo-confirm').addEventListener('click', onConfirm);
      $('#btn-sudo-cancel').addEventListener('click', onCancel);
      overlay.querySelector('[data-close-modal="modal-sudo"]').addEventListener('click', onCancel);
      input.addEventListener('keydown', onKey);
    });

    // Fix Eduardo 5.7 — versão dinâmica em vez de hardcoded
    if (window.api && window.api.version) {
      window.api.version().then(v => {
        const el = $('#installer-version');
        if (el) el.textContent = 'v' + v;
      }).catch(() => {});
    }
  }

  // ───────────────────────────────────────────────────────────
  // Bootstrap
  // ───────────────────────────────────────────────────────────
  async function init() {
    renderStepList();
    clearLogPeek();
    setStatusPill('idle', 'Aguardando…');
    bindWelcome();
    bindPreflight();
    bindProgress();
    bindManual();
    bindError();
    bindDone();
    bindTopbar();
    bindBackendEvents();

    // Detecta state.json existente pra oferecer "retomar"
    try {
      const state = await api.getState();
      if (state && state.lastStepCompleted) {
        const meta = STEP_BY_ID[state.lastStepCompleted];
        if (meta) {
          $('#resume-step-name').textContent =
            `Passo ${String(meta.num).padStart(2,'0')} — ${meta.name}`;
        }
        $('#resume-card').classList.remove('hidden');
      }
      // Hidrata sidebar com estados conhecidos
      if (state && state.steps) {
        Object.entries(state.steps).forEach(([id, st]) => {
          // backend usa 'pending|running|done|error|manual|skipped'
          setStepState(id, st);
        });
      }
    } catch (e) {
      console.warn('[wizard] getState falhou (ok no modo preview):', e);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
