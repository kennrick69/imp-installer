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
  // FASE 2 (Camila 2026-05-27): 17 → 5 steps
  // Sidebar redesenhada pra virada autossuficiente (MSYS2 portable
  // embarcado, sem WSL). Vide DECISAO-FASE1.md + MARCOS-EMBARCAR.md.
  // O backend (Bruno) é fonte da verdade — isto aqui é só pra
  // renderizar a sidebar imediatamente, antes do primeiro
  // onStepUpdate chegar.
  // ───────────────────────────────────────────────────────────
  const STEPS = [
    { id: 'step_x1_copy_runtime',  num: 1, name: 'Instalar runtime',           cat: 'auto'   },
    { id: 'step_x2_setup_env',     num: 2, name: 'Configurar ambiente',        cat: 'auto'   },
    { id: 'step_x3_github_auth',   num: 3, name: 'Login GitHub',               cat: 'hybrid' },
    { id: 'step_x4_launch_tmux',   num: 4, name: 'Iniciar squad (7 painéis)',  cat: 'auto'   },
    { id: 'step_x5_desktop',       num: 5, name: 'Atalho no Desktop',          cat: 'auto'   }
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
    preflightRunning: false,
    // Bug 3 fix v0.2.3 — guarda último payload de erro pra status-pill re-abrir modal
    lastErrorPayload: null,
    // Bruno v0.2.4 — auto-advance de preflight { timer, origLabel }
    preflightAdvance: null
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
      sudoReply:    async () => ({ ok: true }),
      // Camila noturna 2026-05-27 — handlers e eventos das telas novas
      scheduleRebootAndQuit: noopAsync,
      onWslUpgradeProgress:  (cb) => { /* noop */ },
      // Camila FASE 2 2026-05-27 — copy runtime + AV exclusion
      applyAvExclusion:      noopAsync,
      onCopyRuntimeProgress: (cb) => { /* noop */ },
      onNeedsAvExclusion:    (cb) => { /* noop */ }
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
    // Camila v0.2.11: quando um passo entra em running/manual/blocked,
    // rola a sidebar pra que o passo atual fique sempre visível.
    if (['running', 'manual', 'blocked_user_action', 'error'].includes(state)) {
      scrollStepIntoView(stepId);
    }
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
    // Camila v0.2.11: garante que o passo atual está visível na sidebar
    scrollStepIntoView(stepId);
  }

  function describeStep(meta) {
    // descrições humanas curtas pro usuário — FASE 2: 5 steps autossuficientes
    const map = {
      step_x1_copy_runtime: 'Copiando o ambiente Linux pra dentro do seu PC. Só acontece uma vez.',
      step_x2_setup_env:    'Ajustando paths, HOME e validando tmux, git, node e claude.',
      step_x3_github_auth:  'Conectando ao GitHub com Device Flow (seguro, sem digitar senha).',
      step_x4_launch_tmux:  'Criando a sessão tmux "imp" com os 7 painéis da squad.',
      step_x5_desktop:      'Atalho no Desktop pra reabrir a squad com um clique.'
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
  function appendLog(entry = {}) {
    // BUG 2 fix: aceita backend novo (message) e legacy (msg).
    // Sempre normaliza pra .msg internamente pra refreshLogsModal continuar funcionando.
    const msg     = (entry.message != null ? entry.message : entry.msg) || '';
    const level   = entry.level   || 'info';
    const stepId  = entry.stepId  || null;
    const ts      = entry.ts      || Date.now();

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
      // BUG 2 fix: defensivo — se algum entry escapou sem normalizar, lê message OU msg
      const text = (e.message != null ? e.message : e.msg) || '';
      pane.appendChild(el('div', { className: 'log-line log-' + e.level },
        formatClock(e.ts) + '  ' + tag + text));
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
  function evaluatePreflightGate({ force = false } = {}) {
    // Fix Eduardo/Patrícia: se countdown ativo, NÃO mexe no botão
    // (onPreflight atrasado podia re-disabilitar e quebrar o flow).
    if (ui.preflightAdvance && ui.preflightAdvance.timer) return;
    const cards  = $$('.pf-card');
    const states = cards.map(c => c.dataset.state);
    const pending = states.some(s => s === 'pending' || s === 'running');
    const hasErr  = states.some(s => s === 'err');
    const allDone = force || !pending;
    $('#btn-preflight-next').disabled = !allDone || hasErr;
  }

  // ───────────────────────────────────────────────────────────
  // Manual screen — prompt vindo do backend
  // ───────────────────────────────────────────────────────────
  function showManualPrompt(prompt) {
    // prompt = {stepId, title, subtitle, instructions: {action, steps, commands, expected, note}}
    // Mantém backward-compat: se `instructions` vier como array antigo, normaliza pra { steps: [...] }.
    showScreen('manual');
    const meta = STEP_BY_ID[prompt.stepId] || {};
    setCurrentStep(prompt.stepId);

    // Guarda stepId atual no elemento (útil pra debugger / contexto)
    $('#screen-manual').dataset.stepId = prompt.stepId;

    $('#manual-title').textContent    = prompt.title    || `Preciso de você no passo ${meta.num || ''}`;
    $('#manual-subtitle').textContent = prompt.subtitle || 'Este passo precisa que você faça algo no Windows ou no Ubuntu. Eu te guio.';

    // BUG v0.2.14: main.js envia action/fallback/steps/commands/etc TOP-LEVEL no prompt
    // (não dentro de prompt.instructions). Antes a gente lia prompt.instructions e
    // perdia tudo — botão fantasma garantido.
    // Fix v0.2.15: lê PRIORITARIAMENTE top-level + fallback pra prompt.instructions
    // (compat com shape legacy + smoke test passa).
    const ins = prompt.instructions || {};
    const insIsArray = Array.isArray(ins);
    const insIsObj = !insIsArray && ins && typeof ins === 'object';
    const data = {
      action:   prompt.action   || (insIsObj && ins.action)   || null,
      fallback: prompt.fallback || (insIsObj && ins.fallback) || null,
      commands: Array.isArray(prompt.commands) ? prompt.commands :
                (insIsObj && Array.isArray(ins.commands)) ? ins.commands : [],
      expected: prompt.expected || (insIsObj && ins.expected) || null,
      note:     prompt.note     || (insIsObj && ins.note)     || null,
      steps:    Array.isArray(prompt.steps) ? prompt.steps :
                (insIsObj && Array.isArray(ins.steps)) ? ins.steps :
                insIsArray ? ins.map((t, i) => ({
                  num: i + 1,
                  text: typeof t === 'string' ? t : (t.title || t.body || t.text || '')
                })) : [],
    };

    // ─── Ação principal (Camila v0.2.14: garante visibilidade) ──
    const actionBtn  = $('#manual-action-btn');
    const actionRow  = actionBtn.closest('.manual-action-row');
    const actionHint = $('#manual-action-hint');
    if (data.action && data.action.label) {
      if (actionRow) actionRow.classList.remove('hidden');
      actionBtn.hidden = false;
      actionBtn.textContent = data.action.label;
      actionHint.textContent = data.action.hint || 'Clique pra começar este passo.';

      // kind 'none' = label informativa, sem onClick (ex: "Aguardando…" nos steps 01/03)
      if (data.action.kind === 'none') {
        actionBtn.disabled = true;
        actionBtn.onclick = null;
        actionBtn.classList.add('btn-passive');
      } else {
        actionBtn.disabled = false;
        actionBtn.classList.remove('btn-passive');
        actionBtn.onclick = async () => {
          const originalLabel = data.action.label;
          actionBtn.disabled = true;
          actionBtn.textContent = '⏳ Abrindo…';
          try {
            const fn = (api && typeof api.executeManualAction === 'function')
              ? api.executeManualAction.bind(api)
              : null;
            if (!fn) {
              toast('Não consegui abrir: ação não suportada pelo backend.', 'error');
              actionBtn.disabled = false;
              actionBtn.textContent = originalLabel;
              return;
            }
            const r = await fn(data.action.kind, data.action.payload || {});
            if (r && r.ok) {
              actionBtn.textContent = '✓ Abri pra você — volte aqui depois';
              setTimeout(() => {
                actionBtn.disabled = false;
                actionBtn.textContent = originalLabel;
              }, 8000);
            } else {
              toast('Não consegui abrir: ' + ((r && r.error) || 'erro'), 'error');
              actionBtn.disabled = false;
              actionBtn.textContent = originalLabel;
            }
          } catch (e) {
            toast('Erro: ' + (e?.message || ''), 'error');
            actionBtn.disabled = false;
            actionBtn.textContent = originalLabel;
          }
        };
      }
    } else {
      // Sem shape de action — esconde de verdade.
      actionBtn.hidden = true;
      if (actionRow) actionRow.classList.add('hidden');
      actionHint.textContent = '';
      actionBtn.onclick = null;
    }

    // ─── Passos numerados ─────────────────────────────────
    const stepsList = $('#manual-steps-list');
    stepsList.innerHTML = '';
    (data.steps || []).forEach((s) => {
      const li = el('li', {});
      li.textContent = typeof s === 'string' ? s : (s.text || '');
      stepsList.appendChild(li);
    });

    // ─── Comandos copiáveis ───────────────────────────────
    const cmdBlock = $('#manual-commands');
    const cmdList  = $('#manual-cmd-list');
    cmdList.innerHTML = '';
    if (data.commands && data.commands.length) {
      cmdBlock.classList.remove('hidden');
      data.commands.forEach((c) => {
        const item = el('li', { className: 'manual-cmd-item' });
        item.appendChild(el('span', { className: 'mci-label' }, c.label || 'Comando'));
        item.appendChild(el('code', { className: 'mci-code' }, c.code || ''));
        const copyBtn = el('button', { className: 'mci-copy', type: 'button' }, 'Copiar');
        copyBtn.onclick = async () => {
          try {
            await navigator.clipboard.writeText(c.code || '');
            copyBtn.textContent = '✓ Copiado';
            copyBtn.classList.add('copied');
            setTimeout(() => {
              copyBtn.textContent = 'Copiar';
              copyBtn.classList.remove('copied');
            }, 1800);
          } catch (e) {
            toast('Não consegui copiar: ' + (e?.message || ''), 'error');
          }
        };
        item.appendChild(copyBtn);
        cmdList.appendChild(item);
      });
    } else {
      cmdBlock.classList.add('hidden');
    }

    // ─── Expected ─────────────────────────────────────────
    const expBlock = $('#manual-expected');
    if (data.expected) {
      expBlock.classList.remove('hidden');
      $('#manual-expected-text').textContent = data.expected;
    } else {
      expBlock.classList.add('hidden');
    }

    // ─── Note ─────────────────────────────────────────────
    const noteBlock = $('#manual-note');
    if (data.note) {
      noteBlock.classList.remove('hidden');
      $('#manual-note-text').textContent = data.note;
    } else {
      noteBlock.classList.add('hidden');
    }

    // ─── PLANO B / fallback (Camila v0.2.14) ──────────────
    // Se o botão automático falhar (UAC negado, janela fechou sozinha,
    // sem permissão), JOs precisa de um caminho copiável manual.
    const fb = data.fallback;
    const fbBlock = $('#manual-fallback');
    if (fbBlock) {
      if (fb && (fb.command || (fb.steps && fb.steps.length))) {
        fbBlock.classList.remove('hidden');
        if (fb.title) $('#manual-fallback-title').textContent = fb.title;
        const codeEl = $('#manual-fallback-code');
        codeEl.textContent = fb.command || '';
        const copyBtn = $('#manual-fallback-copy');
        copyBtn.onclick = async () => {
          try {
            await navigator.clipboard.writeText(fb.command || '');
            copyBtn.textContent = '✓ Copiado';
            copyBtn.classList.add('copied');
            setTimeout(() => {
              copyBtn.textContent = 'Copiar';
              copyBtn.classList.remove('copied');
            }, 1800);
          } catch (e) {
            toast('Não consegui copiar: ' + (e?.message || ''), 'error');
          }
        };
        const fbSteps = $('#manual-fallback-steps');
        fbSteps.innerHTML = '';
        (fb.steps || []).forEach(s => {
          const li = el('li');
          li.textContent = typeof s === 'string' ? s : (s.text || '');
          fbSteps.appendChild(li);
        });
      } else {
        fbBlock.classList.add('hidden');
      }
    }

    // ─── Reset verify ─────────────────────────────────────
    const status = $('#manual-verify-status');
    status.textContent = '';
    status.removeAttribute('data-tone');
    $('#manual-done-btn').disabled = true;

    // ─── Bind: Verify ─────────────────────────────────────
    $('#manual-verify-btn').onclick = async () => {
      status.textContent = '⏳ Verificando…';
      status.removeAttribute('data-tone');
      try {
        const r = await api.markManualDone(prompt.stepId);
        if (r && r.status === 'done') {
          status.textContent = '✓ Verificado! Pode continuar.';
          status.dataset.tone = 'ok';
          $('#manual-done-btn').disabled = false;
        } else {
          status.textContent = '✗ Ainda não detectei. ' + ((r && r.error) || 'Faz o passo manual e tenta de novo.');
          status.dataset.tone = 'err';
        }
      } catch (e) {
        status.textContent = '✗ Erro: ' + (e?.message || '');
        status.dataset.tone = 'err';
      }
    };

    // ─── Bind: Done (avança pro próximo passo) ────────────
    $('#manual-done-btn').onclick = () => {
      const nextId = getNextStepId(prompt.stepId);
      if (nextId && api.runStep) {
        api.runStep(nextId);
      } else {
        // sem próximo / sem runStep — apenas volta pro progress
        showScreen('progress');
      }
    };

    // ─── Bind: Skip ───────────────────────────────────────
    $('#manual-skip-btn').onclick = () => {
      if (confirm('Pular este passo manual pode quebrar passos seguintes. Continuar?')) {
        if (api.skip) api.skip(prompt.stepId, 'usuário pulou manual');
      }
    };
  }

  function getNextStepId(currentId) {
    const idx = STEPS.findIndex(s => s.id === currentId);
    if (idx < 0) return null;
    const next = STEPS[idx + 1];
    return next ? next.id : null;
  }

  // ───────────────────────────────────────────────────────────
  // Modal de erro (Bug 3 fix v0.2.3)
  // payload backend = { stepId, headline, what, suggestions[], canRetry, canSkip, raw? }
  // Cobre erros de preflight (blocking) E erros de step normais.
  // ───────────────────────────────────────────────────────────
  function showErrorModal(payload = {}) {
    const {
      stepId = '',
      headline,
      what,
      suggestions = [],
      canRetry = true,
      canSkip = false,
      raw = ''
    } = payload;

    const meta = STEP_BY_ID[stepId] || {};
    const num = meta.num != null ? String(meta.num).padStart(2, '0') : null;

    // Cabeçalho com fallback amigável
    const headlineText = headline
      || (num ? `Travei no passo ${num}` : 'Algo deu errado');
    $('#error-headline-text').textContent = headlineText;
    $('#error-what-text').textContent = what || '—';

    // Sugestões — pelo menos uma sempre
    const list = $('#error-suggestions-list');
    list.innerHTML = '';
    const items = (suggestions && suggestions.length)
      ? suggestions
      : ['Tentar de novo — às vezes é só rede instável.'];
    items.forEach(s => list.appendChild(el('li', {}, s)));

    // Detalhes técnicos só se houver raw
    const rawWrap = $('.error-raw-wrap');
    if (raw) {
      $('#error-raw-pre').textContent = raw;
      rawWrap.hidden = false;
    } else {
      $('#error-raw-pre').textContent = '';
      rawWrap.hidden = true;
    }

    // ─── PLANO B no modal-error (Camila noturna 2026-05-27) ─────
    // Se payload.fallback existe, renderiza bloco amber com comando
    // copiável + steps opcionais + libera botão "Tentei manual, verifica".
    renderErrorFallback(payload.fallback, stepId);

    // Botões: skip só se canSkip, retry só se canRetry
    $('#btn-error-skip').hidden  = !canSkip;
    $('#btn-error-retry').hidden = !canRetry;
    $('#btn-error-retry').dataset.stepId = stepId;
    $('#btn-error-skip').dataset.stepId  = stepId;

    // Guarda payload pra re-abrir via status pill
    ui.lastErrorPayload = payload;

    // Erro aberto cancela qualquer auto-advance de preflight em curso
    cancelPreflightAdvance();

    // Reflete estado no sidebar / connection pill (preserva tela atual)
    if (stepId && STEP_BY_ID[stepId]) {
      setStepState(stepId, 'error');
    }
    setConnection('err', num ? 'Travado no passo ' + num : 'Erro');

    openModal('modal-error');
  }

  // ───────────────────────────────────────────────────────────
  // Plano B dentro do modal de erro (Camila noturna 2026-05-27)
  // fallback = { command, steps?: [string|{text}], terminalKind? }
  // Quando presente, renderiza bloco amber e libera botão "Tentei manual, verifica".
  // ───────────────────────────────────────────────────────────
  function renderErrorFallback(fallback, stepId) {
    const block = $('#error-fallback');
    const verifyBtn = $('#btn-error-fallback-verify');
    if (!block) return;

    if (!fallback || !fallback.command) {
      block.classList.add('hidden');
      if (verifyBtn) verifyBtn.hidden = true;
      return;
    }

    block.classList.remove('hidden');

    const codeEl = $('#error-fallback-code');
    if (codeEl) codeEl.textContent = fallback.command || '';

    const copyBtn = $('#error-fallback-copy');
    if (copyBtn) {
      copyBtn.onclick = async () => {
        try {
          await navigator.clipboard.writeText(fallback.command || '');
          copyBtn.textContent = '✓ Copiado';
          copyBtn.classList.add('copied');
          setTimeout(() => {
            copyBtn.textContent = 'Copiar';
            copyBtn.classList.remove('copied');
          }, 1800);
        } catch (e) {
          toast('Não consegui copiar: ' + (e?.message || ''), 'error');
        }
      };
    }

    // Steps opcionais
    const stepsEl = $('#error-fallback-steps');
    if (stepsEl) {
      stepsEl.innerHTML = '';
      const steps = Array.isArray(fallback.steps) ? fallback.steps : [];
      if (steps.length) {
        steps.forEach(s => {
          const li = el('li');
          li.textContent = typeof s === 'string' ? s : (s.text || '');
          stepsEl.appendChild(li);
        });
        stepsEl.hidden = false;
      } else {
        stepsEl.hidden = true;
      }
    }

    // Libera botão de verify e guarda stepId pro bind
    if (verifyBtn) {
      verifyBtn.hidden = false;
      verifyBtn.dataset.stepId = stepId || '';
    }
  }

  // ───────────────────────────────────────────────────────────
  // Modal elevate (Camila v0.2.5) — UAC re-launch
  // Aparece em dois cenários:
  //   (a) pre-check no clique de "Começar" (welcome → preflight)
  //   (b) backend emite installer:onNeedsAdmin nos steps 1/2/3
  // ───────────────────────────────────────────────────────────
  function showElevateModal(_payload = {}) {
    // Cancela auto-advance se ativo (segurança: não pode pular pra progress
    // enquanto pedimos elevação)
    if (typeof cancelPreflightAdvance === 'function') {
      try { cancelPreflightAdvance(); } catch (_) {}
    }
    // Garante botão CTA num estado limpo caso modal reabra
    const btn = $('#btn-elevate-relaunch');
    if (btn) {
      btn.disabled = false;
      btn.textContent = '🛡 Reabrir como administrador';
    }
    // Limpa status/countdown de tentativa anterior
    if (typeof hideElevateStatus === 'function') {
      try { hideElevateStatus(); } catch (_) {}
    }
    openModal('modal-elevate');
  }

  // ─── status helpers do modal-elevate (Camila v0.2.6) ─────────
  let _elevateCountdownTimer = null;
  function showElevateStatus(text, tone = 'info') {
    const el = $('#elevate-status');
    // BUG Patrícia v0.2.15: classe `.hidden` (display:none !important) sobrescreve
    // el.hidden=false. Remove classe pra status do modal-elevate aparecer.
    if (el) el.classList.remove('hidden');
    const txt = $('#elevate-status-text');
    if (!el || !txt) return;
    el.hidden = false;
    el.dataset.tone = tone;
    txt.textContent = text;
  }
  function hideElevateStatus() {
    const el = $('#elevate-status');
    const cd = $('#elevate-countdown');
    if (el) { el.hidden = true; el.classList.add('hidden'); }
    if (cd) cd.textContent = '';
    if (_elevateCountdownTimer) { clearInterval(_elevateCountdownTimer); _elevateCountdownTimer = null; }
  }
  function startElevateCountdown() {
    const cd = $('#elevate-countdown');
    if (!cd) return;
    let seconds = 0;
    cd.textContent = ' (0s)';
    if (_elevateCountdownTimer) clearInterval(_elevateCountdownTimer);
    _elevateCountdownTimer = setInterval(() => {
      seconds++;
      cd.textContent = ` (${seconds}s)`;
      if (seconds > 60) {
        clearInterval(_elevateCountdownTimer);
        _elevateCountdownTimer = null;
      }
    }, 1000);
  }

  function bindElevateModal() {
    $('#btn-elevate-relaunch').addEventListener('click', async () => {
      const btn = $('#btn-elevate-relaunch');
      const manualBtn = $('#btn-elevate-manual');
      const cancelBtn = $('#btn-elevate-cancel');
      btn.disabled = true;
      btn.innerHTML = '<span class="imp-spinner"></span> Aguardando UAC…';
      // Eduardo blocker fix v0.2.5: troca botões pra permitir cancelar
      // se JOs clicar Não no UAC (ou demorar pra abrir popup).
      if (manualBtn) manualBtn.hidden = true;
      if (cancelBtn) {
        cancelBtn.textContent = 'Cancelei o UAC — voltar';
        cancelBtn.dataset.cancelRelaunch = '1';
      }
      // Mostra área de status dentro do modal
      showElevateStatus('Aguardando você aceitar no UAC do Windows…');

      try {
        const r = api.relaunchAsAdmin ? await api.relaunchAsAdmin() : null;
        if (r && r.ok && r.monitoring) {
          // UAC disparou, backend está monitorando lock. Começa countdown visual local.
          startElevateCountdown();
        } else if (r && r.error === 'UAC_CANCELLED') {
          resetElevateModalButtons();
          showElevateStatus('Você cancelou o UAC. Tente de novo ou faça manual.', 'warn');
        } else if (r && !r.ok) {
          resetElevateModalButtons();
          showElevateStatus(`Erro: ${r.error || 'desconhecido'}. Tenta de novo.`, 'error');
        } else {
          resetElevateModalButtons();
          showElevateStatus('Não consegui solicitar elevação.', 'error');
        }
      } catch (e) {
        resetElevateModalButtons();
        showElevateStatus('Erro: ' + (e?.message || ''), 'error');
      }
    });

    $('#btn-elevate-manual').addEventListener('click', () => {
      closeModal('modal-elevate');
      toast('Feche este instalador e abra com botão direito → Executar como administrador.', 'info', 9000);
    });

    $('#btn-elevate-cancel').addEventListener('click', async () => {
      const cancelBtn = $('#btn-elevate-cancel');
      if (cancelBtn && cancelBtn.dataset.cancelRelaunch === '1') {
        try { if (api.cancelRelaunch) await api.cancelRelaunch(); } catch (_) {}
        resetElevateModalButtons();
        showElevateStatus('Cancelado. Pode tentar de novo ou fazer manual.', 'warn');
        return;
      }
      closeModal('modal-elevate');
    });
  }

  function resetElevateModalButtons() {
    const btn = $('#btn-elevate-relaunch');
    const manualBtn = $('#btn-elevate-manual');
    const cancelBtn = $('#btn-elevate-cancel');
    if (btn) { btn.disabled = false; btn.textContent = '🛡 Reabrir como administrador'; }
    if (manualBtn) manualBtn.hidden = false;
    if (cancelBtn) { cancelBtn.textContent = 'Cancelar'; delete cancelBtn.dataset.cancelRelaunch; }
    hideElevateStatus();
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
  // Camila FASE 2 2026-05-27: + 'copying-runtime' (1 min de cópia precisa de chrome)
  const WORK_SCREENS = new Set(['preflight', 'progress', 'manual', 'copying-runtime']);

  // Telas em que a sidebar global dos 5 passos deve aparecer
  // Camila v0.2.11: sidebar virou persistente — visível em preflight, progress,
  // manual e error. Esconde só no welcome e no done.
  // Camila noturna 2026-05-27: + 'reboot' e 'wsl-upgrade' pra sidebar continuar
  // visível durante o gate de reboot e a migração WSL legado.
  // Camila FASE 2 2026-05-27: + 'copying-runtime' pra JOs ver Step 1/5 destacado
  // enquanto a barra de cópia anda.
  const SIDEBAR_SCREENS = new Set([
    'preflight', 'progress', 'manual', 'error',
    'reboot',          // tela de reboot forçado (legado WSL, pode sair na FASE 3)
    'wsl-upgrade',     // tela de migração WSL legado→moderno (legado)
    'copying-runtime'  // FASE 2 — cópia MSYS2 portable pra LOCALAPPDATA
  ]);

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
  // Click no status pill (quando erro): abre modal de detalhes do erro
  // (Bug 3 fix v0.2.3) — antes abria modal de logs genérico.
  document.addEventListener('click', (e) => {
    const pill = e.target.closest('#status-pill');
    if (!pill || pill.dataset.state !== 'error') return;
    if (ui.lastErrorPayload) {
      showErrorModal(ui.lastErrorPayload);
    } else {
      // fallback: sem payload guardado, ainda mostra logs
      openLogsModal();
    }
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
    syncStepSidebar();
  }

  // Mostra/esconde a sidebar global dos 17 passos conforme tela atual.
  // Camila v0.2.11: antes a sidebar vivia DENTRO de #screen-progress,
  // então sumia em preflight/manual/error. Agora é global e persistente.
  function syncStepSidebar() {
    const sb = $('#step-sidebar');
    if (!sb) return;
    const show = SIDEBAR_SCREENS.has(ui.currentScreen);
    sb.classList.toggle('hidden', !show);
    if (show && ui.currentStepId) scrollStepIntoView(ui.currentStepId);
  }

  // Rola o passo atual pra dentro da viewport da sidebar (suave, sem
  // mexer no scroll da página).
  function scrollStepIntoView(stepId) {
    const li = $(`.step-item[data-step-id="${stepId}"]`);
    if (!li) return;
    // scrollIntoView com block:'nearest' evita pular se já está visível
    try { li.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
    catch { li.scrollIntoView(); }
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
  // Preflight flow + auto-advance (Bruno v0.2.4 — fix tela travada)
  // CAUSA RAIZ v0.2.3: evaluatePreflightGate() era chamada só dentro de
  // setPreflightResult(); se algum card não recebia onPreflight (race ou
  // check ausente), ficava 'pending'/'running' pra sempre e o botão
  // #btn-preflight-next nunca habilitava. Agora usamos o return de
  // api.start() como FONTE DA VERDADE: se ok===true, libera o gate
  // mesmo que UI tenha card travado, mostra countdown 3s e auto-advance.
  // ───────────────────────────────────────────────────────────
  async function runPreflightFlow() {
    ui.startedAt = Date.now();
    ui.preflightRunning = false;
    cancelPreflightAdvance(); // limpa qualquer timer pendente de tentativa anterior
    showScreen('preflight');
    setStatusPill('working', 'Iniciando verificações…');
    setGlobalProgress({ text: 'Iniciando verificações…', done: 0, total: 7 });
    clearLogPeek();
    // Safety net: se backend não emitir nada em 200ms, marca todos cards como running
    setTimeout(() => startPreflightRunning(), 200);
    try {
      const res = await api.start();
      // Backend retorna {ok, checks, preflight:{ok,blocking,warnings}}.
      // ok===false significa que onError já foi emitido com modal — só atualiza pill e sai.
      if (res && res.ok === false) {
        setStatusPill('error', 'Verificação detectou bloqueantes — clique pra detalhes');
        return;
      }
      // ok===true → preflight passou (0 blockers). Agenda auto-advance.
      schedulePreflightAdvance(res && res.preflight);
    } catch (e) {
      toast('Não consegui iniciar a instalação. ' + (e?.message || ''), 'error');
      setStatusPill('error', 'Falhou ao iniciar — clique pra detalhes');
    }
  }

  // Schedule countdown 3s + auto-advance. JOs pode clicar pra adiantar
  // ou navegar/recheck pra cancelar.
  function schedulePreflightAdvance(preflightResult) {
    renderPreflightWarnings(preflightResult); // Camila — BUG 1 v0.2.4: painel visível de avisos
    cancelPreflightAdvance();
    evaluatePreflightGate({ force: true }); // backend confirmou ok — libera botão já
    const warnings = (preflightResult && preflightResult.warnings || []).length;
    const baseLabel = warnings > 0
      ? `Ambiente pronto com ${warnings} aviso(s). Avançando em 3s…`
      : 'Ambiente pronto! Avançando em 3s…';
    toast(baseLabel, 'info', 3500);
    setStatusPill('success', warnings > 0 ? `Ambiente pronto (${warnings} aviso)` : 'Ambiente pronto');

    const btn = $('#btn-preflight-next');
    if (!btn) return;
    if (!ui.preflightAdvance) ui.preflightAdvance = {};

    // Fix Eduardo: hint do footer + data-state countdown + aria-live
    const hint = $('#preflight-footer-hint');
    const hintText = $('#preflight-footer-hint-text');
    if (hint && hintText) {
      hint.hidden = false;
      hint.dataset.tone = warnings > 0 ? 'warn' : 'ok';
      hintText.textContent = warnings > 0
        ? `${warnings} aviso${warnings > 1 ? 's' : ''} — instalador resolve no caminho. Pode continuar.`
        : 'Ambiente pronto. Quando quiser, avança pra instalação.';
    }
    btn.dataset.state = 'countdown';
    btn.setAttribute('aria-live', 'polite');

    // Label: usa span filho se existir (não destrói estrutura interna)
    const labelEl = $('#btn-preflight-next-label') || btn;
    ui.preflightAdvance.origLabel = labelEl.textContent || 'Avançar →';
    btn.disabled = false;
    let count = 3;
    labelEl.textContent = `Continuar agora (${count})`;
    const iv = setInterval(() => {
      count--;
      if (count <= 0) {
        cancelPreflightAdvance({ keepBtnLabel: false });
        advanceToProgress();
      } else {
        labelEl.textContent = `Continuar agora (${count})`;
      }
    }, 1000);
    ui.preflightAdvance.timer = iv;
  }

  function cancelPreflightAdvance({ keepBtnLabel = true, keepWarnings = true } = {}) {
    const adv = ui.preflightAdvance;
    if (!adv) return;
    if (adv.timer) { clearInterval(adv.timer); adv.timer = null; }
    if (keepBtnLabel && adv.origLabel) {
      const labelEl = $('#btn-preflight-next-label') || $('#btn-preflight-next');
      if (labelEl) labelEl.textContent = adv.origLabel;
    }
    const btn = $('#btn-preflight-next');
    if (btn) btn.dataset.state = 'waiting';
    const hint = $('#preflight-footer-hint');
    if (hint && !keepWarnings) hint.hidden = true;
    if (!keepWarnings) clearPreflightWarnings();
  }

  // Camila — BUG 1 v0.2.4: painel de avisos visível na tela preflight
  function renderPreflightWarnings(checks) {
    const panel = $('#preflight-warnings');
    const list = $('#pw-list');
    const count = $('#pw-count');
    if (!panel || !list) return;
    const warnings = (checks && checks.warnings) || [];
    if (warnings.length === 0) {
      panel.hidden = true;
      list.innerHTML = '';
      return;
    }
    if (count) count.textContent = String(warnings.length);
    list.innerHTML = '';
    // Mapa: name → {title amigável, resolução}
    const FRIENDLY = {
      admin:          { title: 'Sem privilégio de administrador', resolve: 'Vou pedir UAC quando precisar (Passo 1)' },
      virtualization: { title: 'Virtualização não detectada no firmware', resolve: 'Se falhar no Passo 3, abro o que fazer na BIOS' },
      antivirus:      { title: 'Antivírus de terceiros detectado', resolve: 'Vou seguir; se algo bloquear, te aviso' },
      other_distros:  { title: 'Estado do WSL incerto', resolve: 'Vou instalar/ajustar Ubuntu 22.04 no Passo 3' }
    };
    warnings.forEach(w => {
      const meta = FRIENDLY[w.name] || { title: w.name, resolve: 'Vou tratar durante a instalação' };
      const li = el('li', { className: 'pw-item' },
        el('span', { className: 'pw-item-ico' }, '⚠'),
        el('div', { className: 'pw-item-body' },
          el('span', { className: 'pw-item-title' }, meta.title),
          el('span', { className: 'pw-item-detail' }, w.detail || ''),
          el('span', { className: 'pw-item-resolve' }, '→ ' + meta.resolve)
        )
      );
      list.appendChild(li);
    });
    panel.hidden = false;
  }

  function clearPreflightWarnings() {
    const panel = $('#preflight-warnings');
    if (panel) panel.hidden = true;
    const list = $('#pw-list');
    if (list) list.innerHTML = '';
  }

  function advanceToProgress() {
    cancelPreflightAdvance({ keepBtnLabel: false });
    showScreen('progress');
    // Dispara os 17 passos (backend fire-and-forget, eventos vêm via onStepUpdate/onLog)
    try {
      if (api.runAll) api.runAll();
    } catch (e) {
      toast('Não consegui iniciar os passos: ' + (e?.message || ''), 'error');
    }
  }

  // ───────────────────────────────────────────────────────────
  // Tela REBOOT FORÇADO (Camila noturna 2026-05-27)
  // Mostrada quando backend emite onScreen('reboot', payload).
  // Payload opcional: { reason, resumeStep }
  // ───────────────────────────────────────────────────────────
  function showRebootScreen(payload = {}) {
    if (payload && payload.resumeStep) {
      const meta = STEP_BY_ID[payload.resumeStep];
      const numTxt = meta ? String(meta.num).padStart(2, '0') : '03';
      const el = $('#reboot-resume-step');
      if (el) el.textContent = numTxt;
    }
    showScreen('reboot');
    setStatusPill('working', 'Aguardando reboot do Windows…');
  }

  function bindReboot() {
    const btnNow = $('#btn-reboot-now');
    const btnLater = $('#btn-reboot-later');
    const btnCopy = $('#reboot-fallback-copy');
    if (!btnNow || !btnLater || !btnCopy) return;

    btnNow.addEventListener('click', async () => {
      btnNow.disabled = true;
      btnNow.innerHTML = '<span class="imp-spinner"></span> Salvando progresso e agendando reboot…';
      try {
        const fn = (api && typeof api.scheduleRebootAndQuit === 'function')
          ? api.scheduleRebootAndQuit.bind(api)
          : null;
        const r = fn ? await fn() : { ok: false, error: 'scheduleRebootAndQuit não disponível' };
        if (r && r.ok) {
          btnNow.innerHTML = '✓ Pronto. Windows reinicia em 10s…';
          toast('Reboot agendado. Vou reabrir sozinho depois.', 'success', 8000);
          // backend chamará app.quit() — não fazemos nada além disso
        } else {
          btnNow.disabled = false;
          btnNow.innerHTML = '💾 Salvar progresso e reiniciar agora';
          toast('Não consegui agendar o reboot: ' + ((r && r.error) || 'erro') +
                '. Use o Plano B abaixo.', 'error', 9000);
        }
      } catch (e) {
        btnNow.disabled = false;
        btnNow.innerHTML = '💾 Salvar progresso e reiniciar agora';
        toast('Erro: ' + (e?.message || ''), 'error');
      }
    });

    btnLater.addEventListener('click', () => {
      toast('Beleza. Quando reiniciar, clique no atalho da IMP Squad — eu retomo do passo 03.',
            'info', 9000);
      setTimeout(() => {
        if (api.closeApp) api.closeApp();
        else window.close();
      }, 1500);
    });

    btnCopy.addEventListener('click', async () => {
      const code = $('#reboot-fallback-code').textContent;
      try {
        await navigator.clipboard.writeText(code);
        btnCopy.textContent = '✓ Copiado';
        btnCopy.classList.add('copied');
        setTimeout(() => { btnCopy.textContent = 'Copiar'; btnCopy.classList.remove('copied'); }, 1800);
      } catch (e) {
        toast('Não consegui copiar: ' + (e?.message || ''), 'error');
      }
    });
  }

  // ───────────────────────────────────────────────────────────
  // Tela MIGRAÇÃO WSL legado→moderno (Camila noturna 2026-05-27)
  // ───────────────────────────────────────────────────────────
  function showWslUpgradeScreen(_payload = {}) {
    // Reseta visual ao entrar (caso reabra após falha)
    const stage = $('#wsl-up-stage');
    const pct = $('#wsl-up-pct');
    const fill = $('#wsl-up-fill');
    const detail = $('#wsl-up-detail');
    const logBody = $('#wsl-up-log-body');
    if (stage) stage.textContent = '⏳ Verificando link…';
    if (pct) pct.textContent = '0%';
    if (fill) fill.style.width = '0%';
    if (detail) detail.textContent = '0 MB de 51 MB';
    if (logBody) logBody.innerHTML = '';

    showScreen('wsl-upgrade');
    setStatusPill('working', 'Atualizando WSL…');
  }

  function updateWslUpgrade({ stage, pct, detail, logLine } = {}) {
    if (stage) {
      const s = $('#wsl-up-stage');
      if (s) s.textContent = stage;
    }
    if (typeof pct === 'number') {
      const pctEl = $('#wsl-up-pct');
      const fillEl = $('#wsl-up-fill');
      if (pctEl) pctEl.textContent = Math.round(pct) + '%';
      if (fillEl) fillEl.style.width = Math.max(0, Math.min(100, pct)) + '%';
    }
    if (detail) {
      const d = $('#wsl-up-detail');
      if (d) d.textContent = detail;
    }
    if (logLine) {
      const body = $('#wsl-up-log-body');
      if (body) {
        const line = el('div', {},
          el('span', { className: 'lp-ts' }, formatClock(Date.now())),
          logLine
        );
        body.appendChild(line);
        while (body.children.length > 30) body.removeChild(body.firstChild);
        body.scrollTop = body.scrollHeight;
      }
    }
    // Quando chega 100%, transita pro progress depois de 2s (graceful)
    if (typeof pct === 'number' && pct >= 100) {
      setTimeout(() => {
        if (ui.currentScreen === 'wsl-upgrade') showScreen('progress');
      }, 2000);
    }
  }

  // ───────────────────────────────────────────────────────────
  // Tela COPY RUNTIME — FASE 2 (Camila 2026-05-27)
  // Cópia do MSYS2 portable (~680MB) pra %LOCALAPPDATA%\IMP-Squad-Runtime
  // Dura ~1 min e só acontece na 1ª execução. Barra REAL alimentada
  // pelo backend via api.onCopyRuntimeProgress({pct, bytesDone, totalBytes, eta, dest?}).
  // Se nada mexer em 60s: mostra aviso AV (#cr-av-warn) sugerindo antivírus.
  // ───────────────────────────────────────────────────────────
  let _crStallTimer = null;
  let _crLastPct = -1;

  function showCopyRuntimeScreen(payload = {}) {
    // Reseta visual ao entrar
    const fill = $('#cr-fill');
    const pct = $('#cr-pct');
    const bytes = $('#cr-bytes');
    const eta = $('#cr-eta');
    const dest = $('#cr-dest');
    const warn = $('#cr-av-warn');
    if (fill) fill.style.width = '0%';
    if (pct) pct.textContent = '0%';
    if (bytes) bytes.textContent = '0 MB de 680 MB';
    if (eta) eta.textContent = 'calculando...';
    if (warn) warn.classList.add('hidden');
    if (dest && payload.dest) dest.textContent = payload.dest;

    _crLastPct = -1;
    armCopyRuntimeStallWatch();

    // Marca step 1 como running na sidebar (visual coerente)
    setStepState('step_x1_copy_runtime', 'running');
    setCurrentStep('step_x1_copy_runtime', { progress: 0 });

    showScreen('copying-runtime');
    setStatusPill('working', 'Preparando ambiente (cópia única)…');
    setGlobalProgress({ text: 'Copiando runtime (uma vez só)…', done: 0, total: STEP_TOTAL, percent: 0 });
  }

  function updateCopyRuntime({ pct, bytesDone, totalBytes, eta, dest } = {}) {
    const fillEl = $('#cr-fill');
    const pctEl = $('#cr-pct');
    const bytesEl = $('#cr-bytes');
    const etaEl = $('#cr-eta');
    const destEl = $('#cr-dest');
    if (typeof pct === 'number') {
      const p = Math.max(0, Math.min(100, pct));
      if (fillEl) fillEl.style.width = p + '%';
      if (pctEl) pctEl.textContent = Math.round(p) + '%';
      // se o pct mexeu, esconde o aviso AV e reinicia watchdog
      if (p !== _crLastPct) {
        const warn = $('#cr-av-warn');
        if (warn) warn.classList.add('hidden');
        _crLastPct = p;
        armCopyRuntimeStallWatch();
      }
      // mantém step bar central em sync
      if (ui.currentStepId === 'step_x1_copy_runtime') {
        const stepFill = $('#step-fill');
        if (stepFill) stepFill.style.width = p + '%';
      }
    }
    if (typeof bytesDone === 'number' && typeof totalBytes === 'number' && bytesEl) {
      const mbDone = Math.round(bytesDone / (1024 * 1024));
      const mbTotal = Math.round(totalBytes / (1024 * 1024));
      bytesEl.textContent = `${mbDone} MB de ${mbTotal} MB`;
    } else if (typeof bytesDone === 'number' && bytesEl) {
      bytesEl.textContent = `${Math.round(bytesDone / (1024 * 1024))} MB copiados`;
    }
    if (etaEl) {
      if (typeof eta === 'string') etaEl.textContent = eta;
      else if (typeof eta === 'number') etaEl.textContent = formatETA(eta);
    }
    if (dest && destEl) destEl.textContent = dest;

    // 100% → desarma watchdog (backend vai mandar onScreen pra próxima)
    if (typeof pct === 'number' && pct >= 100) {
      clearCopyRuntimeStallWatch();
    }
  }

  function armCopyRuntimeStallWatch() {
    clearCopyRuntimeStallWatch();
    _crStallTimer = setTimeout(() => {
      const warn = $('#cr-av-warn');
      if (warn) warn.classList.remove('hidden');
    }, 60 * 1000);
  }
  function clearCopyRuntimeStallWatch() {
    if (_crStallTimer) { clearTimeout(_crStallTimer); _crStallTimer = null; }
  }

  // ───────────────────────────────────────────────────────────
  // Modal AV EXCLUSION — FASE 2 (Camila 2026-05-27)
  // Pede ao Windows Defender pra liberar a pasta IMP-Squad-Runtime
  // como exclusão. Backend dispara api.onNeedsAvExclusion({path}).
  // Botão primary chama api.applyAvExclusion(path); skip = toast.
  // ───────────────────────────────────────────────────────────
  function showAvExclusionModal(payload = {}) {
    const pathEl = $('#av-exclusion-path');
    const path = payload.path || '%LOCALAPPDATA%\\IMP-Squad-Runtime';
    if (pathEl) pathEl.textContent = path;
    const applyBtn = $('#btn-av-apply');
    if (applyBtn) {
      applyBtn.disabled = false;
      applyBtn.dataset.path = path;
      applyBtn.innerHTML = '🛡 Liberar pasta agora';
    }
    openModal('modal-av-exclusion');
  }

  function bindAvExclusion() {
    const applyBtn = $('#btn-av-apply');
    const skipBtn = $('#btn-av-skip');
    if (applyBtn) {
      applyBtn.addEventListener('click', async () => {
        const path = applyBtn.dataset.path || '%LOCALAPPDATA%\\IMP-Squad-Runtime';
        applyBtn.disabled = true;
        applyBtn.innerHTML = '<span class="imp-spinner"></span> Aguardando UAC…';
        try {
          const fn = (api && typeof api.applyAvExclusion === 'function')
            ? api.applyAvExclusion.bind(api)
            : null;
          const r = fn ? await fn(path) : { ok: false, error: 'applyAvExclusion não disponível' };
          if (r && r.ok) {
            applyBtn.innerHTML = '✓ Liberada';
            toast('Pasta liberada no Defender. Vai escanear bem mais rápido.', 'success', 6000);
            setTimeout(() => closeModal('modal-av-exclusion'), 900);
          } else if (r && r.error === 'UAC_CANCELLED') {
            applyBtn.disabled = false;
            applyBtn.innerHTML = '🛡 Liberar pasta agora';
            toast('Você cancelou o UAC. Vai funcionar, só mais lento.', 'warn', 6000);
          } else {
            applyBtn.disabled = false;
            applyBtn.innerHTML = '🛡 Liberar pasta agora';
            toast('Não consegui liberar: ' + ((r && r.error) || 'erro'), 'error', 7000);
          }
        } catch (e) {
          applyBtn.disabled = false;
          applyBtn.innerHTML = '🛡 Liberar pasta agora';
          toast('Erro: ' + (e?.message || ''), 'error');
        }
      });
    }
    if (skipBtn) {
      skipBtn.addEventListener('click', () => {
        closeModal('modal-av-exclusion');
        toast('Vai funcionar, só mais lento.', 'info', 5000);
      });
    }
  }

  function bindWslUpgrade() {
    const openLink = $('#btn-wsl-up-open-link');
    const manualDone = $('#btn-wsl-up-manual-done');
    if (openLink) {
      openLink.addEventListener('click', () => {
        if (api.openBrowser) api.openBrowser('https://aka.ms/wsl2kernel');
        else window.open('https://aka.ms/wsl2kernel', '_blank');
      });
    }
    if (manualDone) {
      manualDone.addEventListener('click', async () => {
        try {
          const r = api.markManualDone ? await api.markManualDone('step_03_wsl_install') : null;
          if (r && r.status === 'done') {
            toast('Verificado! Seguindo pra próxima etapa.', 'success');
            showScreen('progress');
          } else {
            toast('Ainda não detectei o WSL moderno. Reinicia o Windows e tenta de novo.', 'warn', 8000);
          }
        } catch (e) {
          toast('Erro: ' + (e?.message || ''), 'error');
        }
      });
    }
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
      // Pre-check elevate (Camila v0.2.5): se backend expõe isElevated e
      // o processo NÃO está elevado, abre modal UAC antes de seguir.
      // Mantém retro-compat: se api.isElevated não existir, segue direto.
      if (typeof api.isElevated === 'function') {
        try {
          const r = await api.isElevated();
          if (r && r.ok && r.elevated === false) {
            showElevateModal();
            return;
          }
        } catch (e) {
          // se a checagem falhar, não bloqueia — segue pro preflight
          console.warn('[wizard] isElevated falhou, seguindo sem pre-check:', e);
        }
      }
      runPreflightFlow();
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
      cancelPreflightAdvance({ keepWarnings: false }); // user pediu recheck — cancela auto-advance e limpa painel
      ui.preflightRunning = false;
      $$('.pf-card').forEach(c => {
        c.classList.remove('long-wait', 'very-long-wait');
        clearPreflightWait(c.dataset.check);
        setPreflightResult(c.dataset.check, 'pending', 'Verificando…');
      });
      setStatusPill('working', 'Re-verificando ambiente…');
      setGlobalProgress({ text: 'Re-verificando ambiente…', done: 0, total: 7 });
      setTimeout(() => startPreflightRunning(), 200);
      try {
        const res = await api.runStep('step_00_preflight');
        // runStep também retorna ok=true se passou — re-agenda auto-advance.
        if (res && res.ok !== false) {
          schedulePreflightAdvance(res && res.preflight);
        }
      } catch (e) {
        toast('Erro no preflight: ' + (e?.message || ''), 'error');
        setStatusPill('error', 'Erro no preflight — clique pra detalhes');
      }
    });
    $('#btn-preflight-next').addEventListener('click', () => {
      // Click manual: cancela timer e avança imediato.
      advanceToProgress();
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
  // v0.3: bindings vivem dentro do showManualPrompt() porque cada
  // prompt traz seu próprio stepId/action. Mantemos bindManual()
  // como hook reservado pra futuros listeners globais.
  // ───────────────────────────────────────────────────────────
  function bindManual() {
    // intencionalmente vazio — vide showManualPrompt()
  }

  // ───────────────────────────────────────────────────────────
  // Modal de erro — bindings (Bug 3 fix v0.2.3)
  // ───────────────────────────────────────────────────────────
  function bindError() {
    // Tentar de novo: retry step ou, se sem stepId (preflight), reinicia
    $('#btn-error-retry').addEventListener('click', async () => {
      const stepId = $('#btn-error-retry').dataset.stepId;
      closeModal('modal-error');
      setConnection('ok');
      try {
        if (stepId) {
          await api.retry(stepId);
        } else {
          // erro de preflight sem stepId → reinicia o start()
          await api.start();
        }
      } catch (e) {
        toast('Retry falhou: ' + (e?.message || ''), 'error');
      }
    });
    // Ignorar e continuar — só quando canSkip (botão escondido senão)
    $('#btn-error-skip').addEventListener('click', async () => {
      const stepId = $('#btn-error-skip').dataset.stepId;
      closeModal('modal-error');
      if (!stepId) return;
      try {
        await api.skip(stepId, 'usuário ignorou bloqueante');
        setStepState(stepId, 'skipped');
        toast('Passo ignorado. Cuidado com efeitos colaterais.', 'warn');
      } catch (e) {
        toast('Não consegui pular: ' + (e?.message || ''), 'error');
      }
    });
    // Ver logs detalhados — fecha este modal e abre o de logs
    $('#btn-error-logs').addEventListener('click', () => {
      closeModal('modal-error');
      openLogsModal();
    });

    // Camila noturna 2026-05-27 — "Tentei manual, verifica":
    // após JOs rodar o comando do plano B, valida via markManualDone.
    const verifyBtn = $('#btn-error-fallback-verify');
    if (verifyBtn) {
      verifyBtn.addEventListener('click', async () => {
        const stepId = verifyBtn.dataset.stepId;
        if (!stepId) {
          toast('Sem stepId pra verificar.', 'warn');
          return;
        }
        verifyBtn.disabled = true;
        const origLabel = verifyBtn.textContent;
        verifyBtn.innerHTML = '<span class="imp-spinner"></span> Verificando…';
        try {
          const fn = (api && typeof api.markManualDone === 'function')
            ? api.markManualDone.bind(api)
            : null;
          const r = fn ? await fn(stepId) : { status: 'unknown' };
          if (r && r.status === 'done') {
            toast('✓ Detectei! Seguindo pro próximo passo.', 'success');
            closeModal('modal-error');
            setStepState(stepId, 'done');
          } else {
            toast('Ainda não detectei. ' + ((r && r.error) || 'Confirma que rodou e tenta de novo.'), 'warn', 7000);
            verifyBtn.disabled = false;
            verifyBtn.textContent = origLabel;
          }
        } catch (e) {
          toast('Erro: ' + (e?.message || ''), 'error');
          verifyBtn.disabled = false;
          verifyBtn.textContent = origLabel;
        }
      });
    }
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
        setStatusPill('working', `Processando passo ${num}/${STEP_TOTAL}: ${name}`);
        const done = Object.values(ui.stepStates).filter(s => s === 'done' || s === 'skipped').length;
        setGlobalProgress({
          text: `Passo ${num} de ${STEP_TOTAL}: ${name}`,
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
      // Cobre erro normal de step E erro de preflight (Bruno envia via mesmo canal)
      const meta = STEP_BY_ID[payload?.stepId] || {};
      const label = meta.num != null
        ? `Erro no passo ${String(meta.num).padStart(2, '0')} — clique pra detalhes`
        : 'Erro — clique pra detalhes';
      setStatusPill('error', label);
      showErrorModal(payload || {});
    });

    // Bruno v0.2.5 — backend pede UAC quando steps 1/2/3 detectam falta de admin
    api.onNeedsAdmin && api.onNeedsAdmin((payload) => {
      showElevateModal(payload);
    });

    // Bruno v0.2.6 — backend avisa que 60s passaram sem detectar lock file
    api.onElevateTimeout && api.onElevateTimeout((payload) => {
      resetElevateModalButtons();
      showElevateStatus('Esperei 1 minuto mas o UAC não respondeu. Tente de novo ou abra manualmente como administrador.', 'error');
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
    // Eduardo v0.2.15: main envia {screen:'preflight'} mas wizard tratava como string.
    // showScreen({screen:'preflight'}) virava showScreen({}) → quebra silente.
    // Camila noturna 2026-05-27: 'reboot' e 'wsl-upgrade' precisam de setup
    // próprio (status pill, reset visual) — roteamos antes do showScreen genérico.
    api.onScreen && api.onScreen((payload) => {
      const isObj = payload && typeof payload === 'object';
      const name = isObj ? payload.screen : payload;
      if (!name) return;
      const data = isObj ? payload : {};
      if (name === 'reboot') {
        showRebootScreen(data);
        return;
      }
      if (name === 'wsl-upgrade') {
        showWslUpgradeScreen(data);
        return;
      }
      // Camila FASE 2 2026-05-27 — cópia do runtime MSYS2 portable
      if (name === 'copying-runtime' || name === 'copy-runtime') {
        showCopyRuntimeScreen(data);
        return;
      }
      showScreen(name);
    });
    api.onToast  && api.onToast(({ message, kind }) => toast(message, kind));

    // Camila noturna 2026-05-27 — progresso da migração WSL legado→moderno
    // payload = { stage, pct, detail, logLine }
    api.onWslUpgradeProgress && api.onWslUpgradeProgress((payload) => {
      updateWslUpgrade(payload || {});
    });

    // Camila FASE 2 2026-05-27 — progresso da cópia do runtime MSYS2
    // payload = { pct, bytesDone, totalBytes, eta, dest? }
    api.onCopyRuntimeProgress && api.onCopyRuntimeProgress((payload) => {
      updateCopyRuntime(payload || {});
    });

    // Camila FASE 2 2026-05-27 — backend pede exclusão Defender pra acelerar cópia
    // payload = { path }
    api.onNeedsAvExclusion && api.onNeedsAvExclusion((payload) => {
      showAvExclusionModal(payload || {});
    });

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
    bindElevateModal();
    bindReboot();         // Camila noturna 2026-05-27 — tela #screen-reboot
    bindWslUpgrade();     // Camila noturna 2026-05-27 — tela #screen-wsl-upgrade
    bindAvExclusion();    // Camila FASE 2 2026-05-27 — modal #modal-av-exclusion
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
