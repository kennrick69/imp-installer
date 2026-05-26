# Fix — `TypeError: checks is not iterable`

**Data:** 2026-05-26
**Versão alvo:** v0.2.1
**Autor:** Bruno (dev IMP Squad)
**Origem:** Primeiro teste ao vivo no desktop real do JOs (v0.2.0). Ao clicar
"Começar instalação" no wizard, o handler `installer:start` morria com
`TypeError: checks is not iterable` antes mesmo de mostrar tela de pré-flight.

---

## Causa raiz

`preflight.runAll()` retorna um **objeto** `{ ok, blocking, warnings, results }`,
mas o handler `installer:start` em `main.js` iterava o retorno como se fosse
**array** (`for (const c of checks)`). O contrato divergia silenciosamente
porque o handler nunca havia sido testado ponta-a-ponta antes do build .exe —
e o tipo "Array iterable on object" só falha em runtime (não pega em
`node --check`).

## Fix aplicado

### `main.js` — handler `installer:start`
- Passou a usar `pre.results` em vez de `checks` direto.
- Triplo cinto: `try/catch` ao redor de `runAll`; fallback pra estrutura vazia
  se vier tipo inesperado; `Array.isArray(pre.results)` antes de iterar; skip
  de entradas falsy dentro do loop.
- Resposta IPC agora inclui `preflight: {ok, blocking, warnings}` pra UI
  poder mostrar resumo sem re-chamar.

### `src/preflight.js` — `runAll()`
- Promete contrato inviolável: SEMPRE retorna
  `{ ok:bool, blocking:Array, warnings:Array, results:Array<{name,ok,detail,warning?}> }`.
- Cada check passa por `normalizeCheck()` que sanitiza formato — mesmo se o
  check retornar `undefined`, `null`, string solta, vira um objeto válido
  marcado como `ok:false`.
- `Promise.allSettled` envolto em try/catch externo (defesa em profundidade
  contra cenários impossíveis tipo OOM).
- Logger checado com `typeof === 'function'` antes de chamar.

### `src/runner.js` — `runStep()`
- Novo helper `safeCall(kind, fn)` envolve `detect`, `execute` e `validate`.
  Se algum lançar coisa **não-Error** (`throw 'string'`, `throw null`,
  `throw {code:5}`), vira `Error` proper com `.message`, `.stderr`, `.code`
  preservados.
- onError payload agora propaga `err.enriched` se o executor já enriqueceu
  (caso step_11 clone).

### `src/error-catalog.js` — `enrichError()`
- Função inteira embrulhada em try/catch externo. NUNCA propaga exceção.
  Cada entrada do catálogo é avaliada em try interno (entrada malformada =
  pula, não derruba).
- Fallback ABSOLUTO se até o catch externo quebrar (cenário paranoico).

## Defensiva aplicada (lista completa)

1. **Wrapper `safeHandle()` em `main.js`** — substitui `ipcMain.handle` em
   TODOS os canais `installer:*`. Captura qualquer throw, devolve
   `{ok:false, error:<msg>}` pro renderer, e (opcionalmente) emite
   `installer:onError` com payload enriquecido. Console.error pra Claudio
   ver durante .exe build.
2. **Handlers com `emitOnError:false`** — `getState`, `listSteps`,
   `exportLogs`, `openBrowser`, `pause`, `reset`, `pickFolder`, `closeApp`,
   `openInterface` não disparam toast quando falham (são consultas/comandos
   sem step associado).
3. **`runAll` em `installer:runAll`** — `runner.runAll().catch` agora chama
   `enrichError` pra mensagem amigável (era texto cru antes).
4. **Validação de args** — handlers que recebem `stepId`, `url`, `cmd`
   conferem presença antes de chamar runner.
5. **`runStep` blinda detect/execute/validate** — converte non-Error throws
   em Error proper.
6. **`preflight.runAll` formato inviolável** — `normalizeCheck` garante que
   cada item de `.results` tem `{name:string, ok:bool, detail:string,
   warning?:bool}`, mesmo se o check individual retornou lixo.
7. **`enrichError` à prova de bala** — try/catch dentro do try/catch.
   Cenário paranoico mas barato.

## Smoke tests (todos passando)

```bash
node --check main.js src/preflight.js src/runner.js src/error-catalog.js
# → todos OK

node -e "require('./src/preflight').runAll().then(r => console.log('OK', r.results.length, 'checks'))"
# → OK 7 checks (mesmo rodando em WSL — checks Windows falham mas não derrubam)

node -e "console.log(typeof require('./src/preflight').runAll())"
# → object (Promise)
```

## Recomendação pra próxima onda

1. **Smoke test E2E no Electron antes de buildar .exe** — Claudio deveria
   rodar `npm start` e clicar "Começar" no WSL/dev box antes de cada release.
   Esse bug pegou só porque `node --check` não roda lógica.
2. **Contract tests** entre handlers IPC e renderer — escrever
   `tests/contracts.test.js` que stubba `preflight.runAll` e confirma que o
   handler `installer:start` emite o evento `installer:onPreflight` no
   formato `{checkId, state, message}`.
3. **Padronizar todo `throw 'string'` em executors** — varredura
   `grep -n "throw '" src/executors.js` deve dar zero matches. Helper
   `assertOk(result, msg)` (não implementado nesta wave porque não havia
   throw de string existente, mas vale criar quando aparecer um novo
   executor).
4. **`installer:runStep` deveria emitir `onError` em vez de devolver
   `{status:'error'}` puro** — hoje só `runAll` chama onError; runStep
   solo (via "Tentar de novo") devolve status mas não dispara toast. Camila
   pode tratar no renderer, mas seria mais consistente backend emitir.
5. **Versionar contratos IPC** — `installer:start` retornar `{checks}` e
   também `{preflight}` ficou ambíguo; idealmente declarar interface
   formal em `src/ipc-contracts.js` e gerar typings pro renderer.

---

## Onda 2 — 5 latentes da Patrícia (2026-05-26)

Patrícia auditou o instalador pós-fix do `checks is not iterable` e encontrou
**5 bugs latentes** que ainda quebravam o fluxo. Documento completo:
`docs/STRESS-TEST-v0.2.1.md`. Fixes aplicados nesta wave:

### BLOCKER #2 — `markRebootDone` perdia `requestSudoPassword` no re-bind

**Onde:** `src/runner.js` — `startWizard` early-return.

**Cenário:** Pós-reboot, `app.whenReady` chamava `runner.markRebootDone()` que
internamente fazia `startWizard({})` SEM events. Depois, ao clicar "Começar",
o handler chamava `startWizard(buildRunnerEvents())` mas o early-return só
atualizava `_ctx.events`, deixando `_ctx.requestSudoPassword` undefined.
Step_05 (apt) e step_10 (gh) explodiam ao chamar sudo:
`sudo: senha exigida e UI não forneceu passwordPromise`.

**Fix:** Nova helper `_applyEvents(ctx, events, opts)` que ATUALIZA tanto
`ctx.events` quanto `ctx.requestSudoPassword` (guard `typeof === 'function'`
preserva a antiga se o novo re-bind vier sem ela). Chamada em todos os
re-bind paths (`startWizard`, `runStep`, `runAll`).

**Smoke test:** `runner._debugCtx()` confirma que após
`startWizard({})` → `startWizard(realEvents)`, `_ctx.requestSudoPassword`
aponta para `realEvents.requestSudoPassword`. Edge case: re-bind subsequente
sem `requestSudoPassword` preserva a anterior.

### BLOCKER #3 — `state.decisions` undefined crashava step_13

**Onde:** `src/state.js` (migrate) + `src/executors.js` (step_13).

**Cenário:** Se `state.json` legítimo for carregado sem `decisions` (versão
antiga, edit manual, migração futura), step_13 lia
`ctx.state.decisions.escritorio3dStrategy` e crashava com NPE.

**Fix:** `migrate(state)` agora SEMPRE preenche `decisions`, `steps`,
`stepDetails` via spread com `emptyState()` defaults. Camada extra de
defensiva no step_13 (`(ctx.state.decisions && ctx.state.decisions.escritorio3dStrategy) || 'release-asset-on-demand'`).

**Smoke test:** `state.migrate({schema_version:1, steps:{}, stepDetails:{}})`
agora retorna objeto com `decisions: {nodeInstallVia, claudeCliVia, escritorio3dStrategy}`.
`step13.validate(ctxSemDecisions)` retorna `true` sem throw.

### HIGH #4 — `onComplete` disparava prematuro com `results=[]`

**Onde:** `main.js` — handler `installer:runAll`.

**Cenário:** `[].every(...)` === `true` (vacuosamente). Se `runner.runAll`
quebrava antes do primeiro push (ex.: reboot-gate, lock collision), `results`
ficava `[]` e UI mostrava "Tudo pronto" sem ter rodado nada.

**Fix:** `const allDone = safeResults.length === ALL_STEPS.length && safeResults.every(...)`.
Só dispara `onComplete` quando os 17 passos estão em terminal positivo
(`done`|`skipped`).

**Smoke test:** `[]` → `false`; 2 itens → `false`; 17 itens done → `true`.

### HIGH #5 — `runStep` throws crus antes do try interno

**Onde:** `src/runner.js` — `runStep`.

**Cenário:** Duas validações early (step inexistente, reboot pendente)
jogavam `throw new Error(...)` ANTES do try/catch interno. O catch nunca
disparava, a promise rejection ia direto pro `safeHandle` do `main.js`, que
mostrava toast genérico em vez de tela de erro estruturada (com sugestões
do catálogo).

**Fix:** Substituídos os throws por `return {id, status:'error', error, ...}`
no mesmo shape do caminho normal de falha. Antes do return, emite
`events.onError(...)` para a UI ter feedback enriquecido. Comportamento
padronizado entre todos os caminhos de erro de `runStep`.

**Smoke test:** `runner.runStep('step_xyz_inexistente', events)` resolve
sem throw com `{id:'step_xyz_inexistente', status:'error', error:'step não encontrado: ...'}`.

### HIGH #8 — `openInteractiveTerminal` double-resolve

**Onde:** `src/shell.js`.

**Cenário:** A Promise resolvia em DOIS caminhos — fallback dentro do
`on('error')` e linha final incondicional. Pior: o `reject` dentro do
fallback.on('error') ficava órfão porque a promise já tinha resolvido.
Resultado: handler SEMPRE retornava `{ok:true}` mesmo quando wt.exe E o
fallback cmd /c start ambos falhavam. step_09 e step_10 ficavam esperando
15min de polling silencioso porque o terminal nunca abriu de verdade.

**Fix:** Flag `resolved` única + helper `done(payload)` idempotente.
Resolve agora ESPERA o `on('spawn')` real (não resolve incondicional no
fim). Se wt falha, tenta fallback; se o fallback também falha, resolve
UMA vez com `{ok:false, error}`.

**Smoke test:** Monkey-patch `cp.spawn` pra emitir `error` em ambos →
resolve UMA vez com `{ok:false, code:1, error:'wt: ... ; cmd: ...'}`.
Happy path (`on('spawn')` emitido) → 1 spawn, 1 resolve, `{code:0}`.

---

## Helper de teste exportado

`runner.js` agora exporta `_debugCtx()` — retorna snapshot raso do `_ctx`
(`hasRequestSudoPassword`, `requestSudoPasswordRef`, `eventsKeys`) usado
pelos smoke tests dos BLOCKERs #2. Não tem efeito em runtime de produção
(nunca é chamado pelo main.js).
