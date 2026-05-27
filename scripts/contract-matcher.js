#!/usr/bin/env node
/* eslint-disable no-console */
/* ============================================================================
   contract-matcher.js — IMP Squad Instalador
   Autora: Patrícia (QA, IMP Dev Squad) — noturna 2026-05-27
   ----------------------------------------------------------------------------
   Cruza, em ~5s, o contrato IPC entre os 3 arquivos críticos:

     main.js     ←→  preload.js  ←→  renderer/wizard.js

   Detecta 4 famílias de mismatch (cada uma já causou bug ao vivo):

     1. `ipcMain.handle('installer:X')` em main.js que NÃO tem
        `ipcRenderer.invoke('installer:X')` correspondente em preload.js
        (handler órfão — chamada via wizard nunca rola).
     2. `ipcRenderer.invoke('installer:X')` em preload.js que NÃO tem
        `ipcMain.handle('installer:X')` em main.js
        (invoke pra handler inexistente — Promise pende eterna).
     3. `sendToRenderer('installer:onY', ...)` em main.js que NÃO tem
        listener `on('installer:onY')` em preload.js
        (evento sai do main mas wizard nunca vê).
     4. `api.installer.Z(...)` ou `api.Z(...)` em wizard.js que NÃO tem
        declaração de `Z` em preload.js (preload.installer.Z ausente).

   Sai com exit code 0 se zero mismatch; 1 se há ≥1.
   Saída humana (✓/✗) — não JSON. Pronto pra pre-commit hook e CI.

   Uso:
     node scripts/contract-matcher.js
============================================================================ */

'use strict';

const fs   = require('node:fs');
const path = require('node:path');

// ─── Cores ANSI ─────────────────────────────────────────────────────────────
const RED   = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const DIM   = '\x1b[2m';
const BOLD  = '\x1b[1m';
const RESET = '\x1b[0m';

const ROOT = path.resolve(__dirname, '..');

// ─── Helpers ────────────────────────────────────────────────────────────────
function read(p) {
  return fs.readFileSync(path.join(ROOT, p), 'utf8');
}

// Remove comentários // e /* */ pra evitar matches falsos em docstrings.
// (Não tira string-literal-quoted — comentário em string fica.)
function stripComments(src) {
  return src
    // block comments
    .replace(/\/\*[\s\S]*?\*\//g, '')
    // line comments — preserva quebras pra grep continuar batendo linhas certas
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function uniq(arr) {
  return Array.from(new Set(arr)).sort();
}

// Extrai todos matches de um regex global, retornando o capture group 1.
function extractAll(src, re) {
  const out = [];
  let m;
  // assert global flag pra não rodar infinito
  if (!re.flags.includes('g')) throw new Error('regex precisa flag g: ' + re);
  while ((m = re.exec(src)) !== null) {
    if (m[1] != null) out.push(m[1]);
  }
  return uniq(out);
}

// ─── Coleta de canais e métodos ─────────────────────────────────────────────

/**
 * main.js — handlers e eventos:
 *   - `ipcMain.handle('installer:X', ...)` (handler raw)
 *   - `safeHandle('installer:X', ...)`     (wrapper que internamente chama handle)
 *   - `sendToRenderer('installer:onY', ...)` (event emit pro renderer)
 */
function parseMain(srcRaw) {
  const src = stripComments(srcRaw);
  const handles = [
    ...extractAll(src, /ipcMain\.handle\(\s*['"`]([^'"`]+)['"`]/g),
    ...extractAll(src, /safeHandle\(\s*['"`]([^'"`]+)['"`]/g),
  ];
  const events = extractAll(src, /sendToRenderer\(\s*['"`]([^'"`]+)['"`]/g);
  return {
    handles: uniq(handles),
    events: uniq(events),
  };
}

/**
 * preload.js — invokes e listeners:
 *   - `ipcRenderer.invoke('installer:X')` — handler que será chamado em main
 *   - `on('installer:onY')` — listener pra evento que main emite
 *   - métodos expostos no objeto `installer` (chaves antes de `:` no objeto)
 *     ex: `relaunchAsAdmin: () => ipcRenderer.invoke(...)` → método `relaunchAsAdmin`
 *
 * IMPORTANTE: ele usa AST-less parsing — regex por linha. Funciona pq o
 * preload.js segue padrão consistente.
 */
function parsePreload(srcRaw) {
  const src = stripComments(srcRaw);
  const invokes = extractAll(src, /ipcRenderer\.invoke\(\s*['"`]([^'"`]+)['"`]/g);

  // Listeners declarados via helper `on('installer:onY')`
  // — assume função local `on(channel) { return cb => ipcRenderer.on(channel, ...) }`.
  // Captura QUALQUER chamada `on('...')` que comece com 'installer:on' (convenção).
  const listeners = extractAll(
    src,
    /\bon\(\s*['"`](installer:[^'"`]+)['"`]\s*\)/g
  );

  // Métodos expostos. Procuramos por linhas no formato:
  //   nome: <expressão>
  // dentro do bloco `const installer = { ... };` (ou após `installer = {`).
  const methods = [];
  // Heurística simples: pegar conteúdo do bloco `installer = {` até o `};` MATCHING.
  const idx = src.indexOf('installer = {');
  if (idx >= 0) {
    // varre balanced braces a partir do { após o =
    const startBrace = src.indexOf('{', idx);
    let depth = 0;
    let end = -1;
    for (let i = startBrace; i < src.length; i++) {
      const ch = src[i];
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) { end = i; break; }
      }
    }
    if (end > startBrace) {
      const block = src.slice(startBrace + 1, end);
      // Cada chave: identificador seguido de ':' no início de linha (com indent).
      // Aceita aspas opcionais (raro), mas preload usa sem aspas.
      const re = /^\s*([a-zA-Z_$][\w$]*)\s*:/gm;
      let m;
      while ((m = re.exec(block)) !== null) {
        methods.push(m[1]);
      }
    }
  }

  return {
    invokes: uniq(invokes),
    listeners: uniq(listeners),
    methods: uniq(methods),
  };
}

/**
 * wizard.js — uso da api exposta pelo preload:
 *   - `api.X(...)` (api é window.api.installer)
 *   - `api.onY(cb)` (listeners de eventos)
 *
 * Captura QUALQUER chamada `api.<nome>(` ou `api.<nome>.bind(`.
 * Ignora `window.api.version()` (declarado em api top-level, não installer).
 */
function parseWizard(srcRaw) {
  const src = stripComments(srcRaw);

  // Métodos usados como `api.X(`, `api.X.bind(`, `api.X.then(`, `await api.X(`
  // Captura X SÓ se for chamado (seguido de `(`) ou referenciado como callback
  // via `.bind(`. Acessos como `window.api.installer` (property chain) ficam de fora.
  //
  // Padrão aceito:
  //   api.foo(...)
  //   api.foo.bind(...)
  //   ?.api.foo(...)
  //   await api.foo(...)
  //
  // Não bate:
  //   api.installer  (acesso a sub-namespace; é o objeto, não método)
  //   api.foo.bar     (chain — `foo` aqui não é "chamado")
  //
  // Por que exigir `(` ou `.bind(`? Pra evitar matches em strings de docstring
  // e em chains de propriedade que não invocam função.
  const used = new Set();
  const re = /\bapi\.([a-zA-Z_$][\w$]*)(?=\s*\(|\.bind\b)/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    used.add(m[1]);
  }

  // Separa listeners (começam com `on` minúsculo + Maiúscula) dos métodos.
  // Convenção do preload: onLog, onStepUpdate, onPreflight, ..., e métodos
  // comuns: start, resume, runStep, etc. Tudo que começa com `on[A-Z]` é
  // considerado listener.
  const methods = [];
  const listeners = [];
  used.forEach((name) => {
    if (/^on[A-Z]/.test(name)) listeners.push(name);
    else methods.push(name);
  });

  return {
    methods: uniq(methods),
    listeners: uniq(listeners),
  };
}

// ─── Cross-check ────────────────────────────────────────────────────────────
function diff(a, b) {
  // elementos de `a` que NÃO estão em `b`
  const setB = new Set(b);
  return a.filter((x) => !setB.has(x));
}

function header(title) {
  return `${BOLD}── ${title} ${'─'.repeat(Math.max(0, 60 - title.length))}${RESET}`;
}

// ─── Main ──────────────────────────────────────────────────────────────────
function main() {
  console.log(`${BOLD}IMP Installer — Contract Matcher${RESET} ${DIM}(Patrícia, QA)${RESET}\n`);

  let mainSrc, preloadSrc, wizardSrc;
  try {
    mainSrc    = read('main.js');
    preloadSrc = read('preload.js');
    wizardSrc  = read('renderer/wizard.js');
  } catch (e) {
    console.error(`${RED}FATAL: não consegui ler arquivos do projeto.${RESET}`);
    console.error(`  ${e.message}`);
    console.error(`  esperado: ${ROOT}/{main.js, preload.js, renderer/wizard.js}`);
    process.exit(2);
  }

  const m = parseMain(mainSrc);
  const p = parsePreload(preloadSrc);
  const w = parseWizard(wizardSrc);

  // ─── 1. handlers main ↔ invokes preload ────────────────────────────────
  console.log(header('1. ipcMain.handle ↔ ipcRenderer.invoke'));
  const orphanHandlers = diff(m.handles, p.invokes);
  const orphanInvokes  = diff(p.invokes, m.handles);
  const handlerMatchCount = m.handles.length - orphanHandlers.length;

  if (orphanHandlers.length === 0 && orphanInvokes.length === 0) {
    console.log(`  ${GREEN}✓${RESET} ${m.handles.length} handlers / ${p.invokes.length} invokes — match`);
  } else {
    console.log(`  ${DIM}${handlerMatchCount}/${m.handles.length} handlers casam com invoke${RESET}`);
  }
  orphanHandlers.forEach((ch) => {
    console.log(`  ${RED}✗ MISMATCH:${RESET} main.js expõe handler '${ch}' mas preload.js não tem invoke`);
  });
  orphanInvokes.forEach((ch) => {
    console.log(`  ${RED}✗ MISMATCH:${RESET} preload.js invoca '${ch}' mas main.js não tem handler`);
  });
  console.log('');

  // ─── 2. eventos main ↔ listeners preload ───────────────────────────────
  console.log(header('2. sendToRenderer ↔ on() listener'));
  const orphanEvents     = diff(m.events, p.listeners);
  const orphanListeners  = diff(p.listeners, m.events);
  const eventMatchCount  = m.events.length - orphanEvents.length;

  if (orphanEvents.length === 0 && orphanListeners.length === 0) {
    console.log(`  ${GREEN}✓${RESET} ${m.events.length} eventos / ${p.listeners.length} listeners — match`);
  } else {
    console.log(`  ${DIM}${eventMatchCount}/${m.events.length} eventos têm listener no preload${RESET}`);
  }
  orphanEvents.forEach((ev) => {
    console.log(`  ${RED}✗ MISMATCH:${RESET} main.js envia '${ev}' mas preload.js não expõe listener (on)`);
  });
  orphanListeners.forEach((ev) => {
    console.log(`  ${YELLOW}⚠ ÓRFÃO:${RESET} preload.js escuta '${ev}' mas main.js nunca envia (talvez intencional/futuro)`);
  });
  console.log('');

  // ─── 3. api.X usados em wizard ↔ métodos em preload.installer ──────────
  console.log(header('3. api.X em wizard.js ↔ métodos em preload.installer'));
  // Ignorar nomes globais do api top-level (não estão em installer):
  //   - `version` (window.api.version, não installer.version)
  // Ignorar nomes que vêm do escopo local (apesar do regex pegar `api.foo` raros):
  const IGNORED_WIZARD_METHODS = new Set([
    'version',   // window.api.version() — top-level, não em installer
  ]);
  const wizardMethods = w.methods.filter((n) => !IGNORED_WIZARD_METHODS.has(n));
  const orphanWizardMethods = diff(wizardMethods, p.methods);
  const methodMatchCount = wizardMethods.length - orphanWizardMethods.length;

  if (orphanWizardMethods.length === 0) {
    console.log(`  ${GREEN}✓${RESET} ${wizardMethods.length} métodos usados / todos declarados no preload`);
  } else {
    console.log(`  ${DIM}${methodMatchCount}/${wizardMethods.length} métodos casam${RESET}`);
  }
  orphanWizardMethods.forEach((name) => {
    console.log(`  ${RED}✗ MISMATCH:${RESET} wizard.js usa api.${name}(...) mas preload.js não declara`);
  });

  // ─── 3b. listeners api.onX em wizard ↔ métodos preload ──────────────────
  console.log('');
  console.log(header('4. api.onX em wizard.js ↔ listeners em preload.installer'));
  const orphanWizardListeners = diff(w.listeners, p.methods);
  const listenerMatchCount = w.listeners.length - orphanWizardListeners.length;

  if (orphanWizardListeners.length === 0) {
    console.log(`  ${GREEN}✓${RESET} ${w.listeners.length} listeners usados / todos declarados no preload`);
  } else {
    console.log(`  ${DIM}${listenerMatchCount}/${w.listeners.length} listeners casam${RESET}`);
  }
  orphanWizardListeners.forEach((name) => {
    console.log(`  ${RED}✗ MISMATCH:${RESET} wizard.js usa api.${name}(cb) mas preload.js não declara listener`);
  });
  console.log('');

  // ─── Sumário ───────────────────────────────────────────────────────────
  const totalMismatches =
    orphanHandlers.length +
    orphanInvokes.length +
    orphanEvents.length +
    orphanWizardMethods.length +
    orphanWizardListeners.length;
  // listeners órfãos no preload são AVISO, não erro (intencional pra futuro/legacy).

  console.log(header('SUMÁRIO'));
  console.log(`  main.js:    ${m.handles.length} handlers, ${m.events.length} eventos`);
  console.log(`  preload.js: ${p.invokes.length} invokes, ${p.listeners.length} listeners, ${p.methods.length} chaves expostas`);
  console.log(`  wizard.js:  ${wizardMethods.length} api.X(...), ${w.listeners.length} api.onX(...)`);
  console.log('');
  if (totalMismatches === 0) {
    console.log(`${GREEN}${BOLD}✓ PASS${RESET} ${GREEN}— 0 mismatches.${RESET}`);
    if (orphanListeners.length) {
      console.log(`${YELLOW}  (${orphanListeners.length} listener(s) órfão(s) no preload — não bloqueia)${RESET}`);
    }
    process.exit(0);
  } else {
    console.log(`${RED}${BOLD}✗ FAIL${RESET} ${RED}— ${totalMismatches} mismatch(es) detectado(s).${RESET}`);
    console.log(`${DIM}  Corrija e rode de novo. Em CI, este script bloqueia o merge.${RESET}`);
    process.exit(1);
  }
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    console.error(`${RED}FATAL: contract-matcher crashou:${RESET}`, e);
    process.exit(2);
  }
}

module.exports = { parseMain, parsePreload, parseWizard };
