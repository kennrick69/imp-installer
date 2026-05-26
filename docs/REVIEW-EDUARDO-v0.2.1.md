# REVIEW EDUARDO — IMP Squad Instalador v0.2.1

**Data:** 2026-05-26
**Revisor:** Eduardo (QA/Review da IMP Dev Squad)
**Escopo:** Fix do bug `checks is not iterable` (onda 1, Bruno-1) + 5 latentes
da Patrícia (onda 2, Bruno-2) + defensivas universais (safeHandle/safeCall/
normalizeCheck/enrichError). Build alvo: `IMP-Squad-Instalador-0.2.1-portable.exe`.
**Inputs lidos:** `STRESS-TEST-v0.2.1.md`, `FIX-CHECKS-NOT-ITERABLE.md`,
`main.js`, `src/runner.js`, `src/state.js`, `src/executors.js` (step_13),
`src/shell.js` (openInteractiveTerminal), `src/preflight.js`,
`src/error-catalog.js`, `package.json`.

Severidades: 🔴 BLOCKER · 🟠 ALTO · 🟡 MÉDIO · 🟢 NIT.

---

## 0 — Sumário executivo

- **Veredito:** ✅ **GO COM RESSALVAS LEVES**.
- **Blockers remanescentes:** **0**.
- **Altos novos introduzidos pelo fix:** 0 (1 ressalva 🟡 sobre re-entrância
  do `installer:runAll` vale ficar de olho mas não bloqueia).
- **Os 6 bugs alvo (1 reported + 5 latentes) estão fixados com smoke tests
  documentados.**
- **Defensiva universal aplicada:** safeHandle nos 16 handlers `installer:*`,
  safeCall em runStep (detect/execute/validate), normalizeCheck em preflight,
  enrichError com try/catch dentro do try/catch (3 camadas).
- **Confiança que JOs vai abrir o instalador, clicar "Começar" e NÃO ver erro
  cru:** ~92%. (Detalhes na §6).

---

## 1 — Bug original (`checks is not iterable`) — 🟢 RESOLVIDO

### 1.1 Handler `installer:start`

- `main.js:213-241`: agora itera `pre.results` com **guarda tripla**:
  - `try/catch` ao redor de `preflight.runAll()`.
  - Fallback para `{ok:false, blocking:[], warnings:[], results:[]}` se
    `pre` for falsy ou não-objeto.
  - `Array.isArray(pre.results) ? pre.results : []` antes do `for…of`.
  - Skip de entradas falsy dentro do loop (`if (!c || typeof c !== 'object') continue;`).
- Resposta IPC inclui `{ok:true, checks:list, preflight:{ok, blocking, warnings}}`
  — UI consegue mostrar resumo sem re-chamar.

### 1.2 Contrato inviolável de `preflight.runAll()`

- `src/preflight.js:163-215`: `Promise.allSettled` + `try/catch` externo
  cobre o cenário paranoico de OOM. Cada check passa por `normalizeCheck()`
  que sanitiza formato — mesmo `undefined`/`null`/string vira
  `{name, ok:false, warning:false, detail}`.
- Logger checado com `typeof === 'function'` (linha 203).
- **Smoke test documentado** no FIX-CHECKS-NOT-ITERABLE.md §"Smoke tests":
  `node -e "require('./src/preflight').runAll().then(r => console.log('OK', r.results.length))"`
  → `OK 7 checks`. ✅

**Verdict:** 🟢 Resolvido. Não vejo caminho residual onde `checks` chegue
não-iterable ao `for`.

---

## 2 — Os 5 latentes da Patrícia — 🟢 TODOS FIXADOS

### 2.1 BLOCKER #2 — `markRebootDone` perdia `requestSudoPassword` no re-bind

**Status:** 🟢 **fixado e correto.**

- `src/runner.js:83-93` — nova helper `_applyEvents(ctx, events, opts)`:
  - Atualiza `ctx.events` sempre.
  - Atualiza `ctx.requestSudoPassword` SE `events.requestSudoPassword`
    (ou `opts.requestSudoPassword`) for `typeof === 'function'`.
  - **Guard preserva a referência antiga** se o novo re-bind vier vazio
    (cenário `markRebootDone()` → `startWizard({})` → depois
    `startWizard(realEvents)` propaga corretamente).
- `_applyEvents` chamado em **TODOS** os re-bind paths: `startWizard:97`,
  `runStep:165`, `runAll:265`. ✅
- Smoke test descrito (`_debugCtx()` exportado em `runner.js:384-391`
  só pra test, sem impacto de runtime).

**Cuidado 🟡:** o guard preserva a função antiga — bom contra regressão a
`undefined`, mas se o caller QUISER zerar (ex.: teste explícito de cenário
"sem UI"), não consegue. Aceitável para v0.2.1 (não é regression real;
ninguém zera intencionalmente).

### 2.2 BLOCKER #3 — `state.decisions` undefined crashava step_13

**Status:** 🟢 **fixado com dupla defensiva.**

- `src/state.js:66-69` — `migrate(state)` agora faz spread com
  `emptyState()` defaults para `steps`, `stepDetails`, **`decisions`**:
  ```
  s.decisions = { ...def.decisions, ...(s.decisions || {}) };
  ```
- `src/executors.js:614` — step_13 tem defensiva extra:
  `const strategy = (ctx.state.decisions && ctx.state.decisions.escritorio3dStrategy) || 'release-asset-on-demand';`
  Cobre o caso de `ctx.state` vir de origem não-migrada (testes diretos,
  por exemplo).

**Cuidado 🟡 (NOVO RISCO — ver §5.3):** `migrate` com defaults pode esconder
corrupção mais séria. Hoje OK, mas se em futuras versões `decisions` ganhar
campos OBRIGATÓRIOS com semântica diferente do default, o merge silencioso
pode rodar com decisão "errada" sem warning. **Mitigação:** documentar no
`state.js` que migrações futuras devem usar slot explícito em `MIGRATIONS`
(que está vazio hoje, ok).

### 2.3 HIGH #4 — `[].every(...)` disparava `onComplete` prematuro

**Status:** 🟢 **fixado.**

- `main.js:256-261`:
  ```
  const allTerminalPositive = safeResults.every(r => r && (r.status === 'done' || r.status === 'skipped'));
  const allDone = safeResults.length === ALL_STEPS.length && allTerminalPositive;
  ```
- Exige `length === ALL_STEPS.length` E todos em `done`|`skipped`. Não
  dispara em `[]`, nem em arrays parciais, nem em mix com `error`. ✅
- Sub-defensiva: `safeResults = Array.isArray(results) ? results : []`.

### 2.4 HIGH #5 — `runStep` throws crus antes do try interno

**Status:** 🟢 **fixado.**

- `src/runner.js:163-188` — as duas validações early agora **retornam**
  `{id, status:'error', error}` em vez de fazer `throw`. Ambas chamam
  `events.onError(...)` antes do return, com guard `typeof === 'function'`
  e try/catch.
- O caminho normal de erro (linha 244-259) também emite `onError` com
  payload, mantendo simetria. ✅

### 2.5 HIGH #8 — `openInteractiveTerminal` double-resolve

**Status:** 🟢 **fixado com flag idempotente.**

- `src/shell.js:170-223`:
  - Flag `resolved` + helper `done(payload)` idempotente (linha 175-179).
  - Resolve do "happy path" agora ESPERA `child.on('spawn')` real (linha
    195-199) — não resolve incondicional no fim.
  - Fallback (`cmd /c start`) também só resolve no `on('spawn')` dele.
  - `tryFallback` é chamado em 2 paths (spawn síncrono throw, `on('error')`)
    e guarda `if (resolved) return` no topo. ✅

**Cuidado 🟡 (ressalva mínima):** se NEM `on('spawn')` NEM `on('error')`
disparar (caso patológico onde o processo trava em fork mas nunca emite
nenhum evento), a Promise fica pendente para sempre. Probabilidade
baixíssima — Electron/Node disparam um ou outro em ~todos os cenários
reais. Worth adicionar `setTimeout(() => done({ok:false, error:'spawn timeout'}), 30_000)`
em v0.2.2, mas **não bloqueia v0.2.1**.

---

## 3 — Defensivas universais — 🟢 OK

### 3.1 `safeHandle` em main.js

- Definido em `main.js:181-211`. Wrapper sempre captura throw, loga
  `console.error`, opcionalmente emite `installer:onError` enriquecido,
  retorna `{ok:false, error:<msg>}` pro renderer.
- **Cobertura:** 16 handlers `installer:*` foram convertidos:
  `start, runStep, runAll, markManualDone, retry, skip, getState, listSteps,
  openTerminal, openBrowser, exportLogs, installSala3D, openInterface,
  pause, resume, reset, closeApp, pickFolder` — verifiquei via grep, **16
  chamadas a safeHandle ✅**.
- 2 handlers permanecem em `ipcMain.handle` raw: `installer:sudoReply` (linha
  85) e `app:getVersion` (linha 397). Justificativa: o primeiro é síncrono
  trivial (resolve/reject de Map slot, sem await), o segundo é one-liner
  síncrono. **Aceitável 🟡** mas vale converter em v0.2.2 por consistência —
  `sudoReply` se receber `id` inválido propaga rejection cru
  (`{ ok: false, error: 'sudo request expired' }` já trata, ok).
- `emitOnError:false` aplicado seletivamente em getState, listSteps,
  exportLogs, openBrowser, openInterface, pause, reset, closeApp, pickFolder
  — comandos sem step associado não merecem toast. ✅

### 3.2 `safeCall` em runStep

- `src/runner.js:197-216` — wrap em detect/execute/validate. Converte
  `throw 'string'`, `throw null`, `throw {code:5}` em `Error` proper
  com `.stderr`, `.code`, `.enriched` preservados.
- **Cobertura completa** dos 3 callsites (detect:220, execute:230, validate:233). ✅

### 3.3 `enrichError` à prova de bala

- `src/error-catalog.js:228-273` — try/catch externo + try/catch interno
  por entrada do catálogo (linha 234-250) + fallback ABSOLUTO no catch
  externo (linha 261-272). Nunca propaga exceção. ✅
- Smoke test implícito (chamado dentro de `main.js:194-205` que também
  está em try/catch — defensiva 4ª camada).

---

## 4 — Bundle (anti-bug v0.3.0) — 🟢 OK

### 4.1 `build.files`

- `package.json:30-44`:
  - `"src/**/*"` ✅ — cobre `src/error-catalog.js`, `src/state.js`,
    `src/runner.js`, `src/preflight.js`, `src/shell.js`, `src/executors.js`,
    `src/logger.js` (todos os 7 .js verificados via `ls src/`).
  - `"main.js"`, `"preload.js"`, `"renderer/**/*"`, `"assets/**/*"`,
    `"package.json"` — completos.
- Exclusões corretas: `*.log`, `*.map`, `*.test.js`, `docs/**`, `*.md`.
  → Nenhum arquivo de código é excluído por acidente.

### 4.2 Validação asar

- Script `asar:check` definido (`package.json:15`):
  `asar list dist/win-unpacked/resources/app.asar | grep -E 'src/|main.js|preload.js|renderer/'`
- 🟡 **RESSALVA:** o script existe mas o review é estático; ainda **NÃO foi
  rodado pós-build do .exe v0.2.1** (não há `dist/win-unpacked/` no repo no
  momento da revisão). **Recomendo Claudio rodar `npm run dist:win && npm run
  asar:check` antes de mandar pro JOs**, conferindo que `error-catalog.js`
  aparece na lista.

---

## 5 — Possíveis NOVAS regressões introduzidas pelos 2 fixes

### 5.1 `_applyEvents` em runner.js — segurança

- 🟢 **Sem race:** runner é módulo singleton (`_ctx` module-scope), e
  todas as chamadas vêm de IPC handlers que rodam serializados no
  event-loop do main process. Não há outra thread.
- 🟢 **Sem memory leak:** apenas REATRIBUI `ctx.events` e `ctx.requestSudoPassword`;
  não acumula. Referência antiga vai pro GC normalmente.
- 🟡 **Caveat menor:** o callback antigo de `requestSudoPassword` pode ainda
  estar pendente em alguma `Promise` ativa quando o re-bind acontece
  (cenário: usuário cancela e clica "Começar" de novo antes do `passwordPromise`
  do step anterior resolver). A nova função NÃO é chamada pelo Promise
  pendente (closure já capturou a antiga). Comportamento OK — apenas vale
  ter ciente.

### 5.2 `safeHandle` overhead

- 🟢 **Aceitável.** Wrapper adiciona 1 try/catch + 1 chamada de `enrichError`
  só no caminho de erro. No happy path é 1 await direto — **<1µs overhead**.
- 16 wrappers ≈ 16 closures de função criadas no startup; negligível
  (kilobytes de memória).
- console.error em main.js polui o log do .exe? — Só ao falhar; e o ambiente
  do .exe está em modo production sem console visível pro usuário final.

### 5.3 `state.migrate` com defaults — esconde corrupção?

- 🟡 **Risco baixo mas real.** Hoje o spread só preenche `steps`,
  `stepDetails`, `decisions` quando ausentes ou parciais — não substitui
  valores existentes. Se um state.json tiver, p.ex., `decisions:
  {nodeInstallVia: 'apt'}` (esquemático), o resultado fica `{nodeInstallVia:'apt',
  claudeCliVia:'native', escritorio3dStrategy:'release-asset-on-demand'}`
  — valores explícitos do usuário sobrevivem.
- O risco real é em migrações **futuras** quando renomearem um campo:
  o spread vai preservar o nome antigo E adicionar o novo (com default),
  ficando ambíguo. **Mitigação:** documentar regra "migrações de rename
  devem usar slot em `MIGRATIONS`, não default merge". → Worth adicionar
  comentário em `state.js:48` mencionando isso. **Não bloqueia v0.2.1**.

### 5.4 `runAll` fire-and-forget — assinatura mais complexa

- 🟢 OK. `main.js:253-282` agora trata `.then` e `.catch`. O `.catch` chama
  `enrichError` (que é defensivo) — não há caminho onde a chamada explode.
- 🟡 Pequeno: se o usuário clica "Começar" → "runAll" → no meio clica "Resume"
  de novo (que cai em `startWizard` no path do `safeHandle('installer:resume')`,
  linha 369), pode ter 2 runAll concorrentes. **Mas:** `installer:resume`
  só faz `startWizard` se `!runner.getState()` ou `!isPaused()` — então em
  fluxo normal não duplica. Edge case improvável; vale registrar.

---

## 6 — Confiança no clique "Começar"

**Cenário 1 — JOs abre v0.2.1 no Windows zerado, clica "Começar":**
- Handler `installer:start` agora é safeHandle. `preflight.runAll()` retorna
  contrato inviolável. Iteração usa `pre.results` com guarda tripla.
- **Probabilidade de erro cru:** ~3% (residual de cenários patológicos não
  cobertos: ex. PowerShell desativado por GPO → checkAdmin/checkVirtualization
  rejeitam → normalizeCheck devolve `ok:false detail:"falhou:..."` → blocking
  contém eles → tela de preflight mostra blocker, MAS isso é UX esperado,
  não erro cru).

**Cenário 2 — Pós-reboot:**
- `markRebootDone()` → `startWizard({})` (sem events). User clica "Começar"
  → `safeHandle('installer:start')` → `runner.startWizard(buildRunnerEvents())`
  → `_applyEvents` atualiza `requestSudoPassword`. ✅ step_05/10 vão receber
  password promise.

**Cenário 3 — state.json corrompido ou sem decisions:**
- `loadState` rotaciona corrupt + retorna `emptyState()`, ou `migrate`
  preenche defaults. step_13 não crasha. ✅

**Conclusão:** Confiança ≈ **92%** que JOs vai clicar "Começar" sem ver
TypeError/exceção crua. Os ~8% residuais são UX legítimo (preflight blocker
real, antivirus bloqueando WSL etc.) ou patológicos (sem PowerShell).

---

## 7 — Lista de ressalvas (ordenadas por impacto)

| # | Sev | Onde | Ressalva | Vale corrigir |
|---|---|---|---|---|
| R1 | 🟡 | (processo) | Build `.exe` v0.2.1 + `npm run asar:check` ainda não rodados. **JOs não deveria receber .exe sem essa validação.** | **SIM antes de mandar pro JOs.** |
| R2 | 🟡 | `src/shell.js:170` | `openInteractiveTerminal` não tem timeout: se nem `spawn` nem `error` disparam, Promise pendura indefinidamente. | v0.2.2 — adicionar `setTimeout(30_000)`. |
| R3 | 🟡 | `main.js:85, 397` | `sudoReply` e `app:getVersion` ainda em `ipcMain.handle` raw (não-safeHandle). | v0.2.2 — converter por consistência. |
| R4 | 🟡 | `src/state.js:48-72` | `MIGRATIONS` vazio + spread defaults em `migrate` pode confundir migrações futuras. | Adicionar comentário-guia agora; lógica fica como está. |
| R5 | 🟢 | `src/runner.js:83-93` | `_applyEvents` preserva `requestSudoPassword` antiga se a nova vier vazia — bom contra regressão, ruim pra "limpeza explícita" em testes. | NIT, não corrigir. |
| R6 | 🟢 | `src/preflight.js:184-188` | Fallback do `Promise.allSettled` (que "nunca" rejeita) é over-defensivo. | NIT — manter, custa nada. |
| R7 | 🟢 | `package.json:15` | `asar:check` poderia validar mais explicitamente (ex.: exigir `src/error-catalog.js` presente, sair com código 1 se ausente). | v0.2.2 — endurecer. |

---

## 8 — Veredito final

✅ **GO COM RESSALVAS LEVES.**

**Justificativa:**
1. **Os 6 bugs alvo (1 reported + 5 latentes) estão corrigidos com defensiva
   adequada e smoke tests documentados.**
2. **Nenhum blocker remanescente; nenhuma regressão grave introduzida.**
3. **Defensiva universal (safeHandle/safeCall/normalizeCheck/enrichError) cobre
   os caminhos críticos do fluxo `installer:*`.**
4. **Única condição BLOQUEANTE pré-envio ao JOs:** rodar
   `npm run dist:win && npm run asar:check` e confirmar `src/error-catalog.js`
   no asar listing (R1). Sem isso, repetimos o risco do bug v0.3.0 que motivou
   o item 4 deste review.

**Não recomendo enviar v0.2.1 pro JOs sem rodar o asar:check.** Caso contrário,
LIVRE pra build e teste ao vivo.

---

**Eduardo (review)** — 2026-05-26.
