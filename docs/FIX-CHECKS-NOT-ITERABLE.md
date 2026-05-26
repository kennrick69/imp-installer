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

---

## Onda 3 — feedback visual do live test #2 (2026-05-26)

**Sintoma reportado pelo JOs:** Clicou "Começar" no instalador v0.2.1 e a tela
ficou ESTÁTICA e VAZIA por 2+ minutos. Sem feedback. Sem log. Sem spinner. JOs
não sabia se estava processando ou se travou.

### Causa raiz

`preflight.runAll()` rodava todos os 7 checks PowerShell em paralelo via
`Promise.allSettled`, **MAS** o handler `installer:start` só emitia os
`installer:onPreflight` PRA CADA check DEPOIS de `await runAll()` completar.
Resultado: o batch demorava 30s-2min (cada check PS é 1-5s; mas alguns como
`Get-CimInstance Win32_Processor` podem travar em WMI ruim, e `wsl -l -v` em
PC sem WSL demora 30s pra retornar "not recognized"), e nesse tempo todo a UI
recebia ZERO eventos. Renderizava tela vazia.

### Fixes aplicados

#### FIX 1 — `preflight.runAll` agora é STREAMING

`src/preflight.js` — `runAll(opts)` aceita `opts.onCheck(result)` callback que é
chamado PRA CADA check assim que ele termina (em vez de aguardar o batch).
Implementação: cada `fns[i]()` é envolto em `Promise.race([fn(), timeoutCheck])`
e dentro do `.then` chama `opts.onCheck(normalized)` imediatamente. Promise.all
no fim apenas para agregar o relatório final, mas o user já recebeu feedback.

#### FIX 2 — Timeout per-check de 30s default

Novo helper `timeoutCheck(name, ms)` em `preflight.js`. Cada check virá com
`Promise.race([fn(), timeoutCheck(fnName, 30000)])`. Se travar, vira check
com `ok:false, detail:'tempo esgotado (30000ms) — check travado'`. Antes:
`Get-CimInstance` em PC ruim podia travar 60s+ sem feedback. Agora: 30s e UI
recebe sinal de falha. Customizável via `opts.timeoutMs`.

#### FIX 3 — Log ao vivo em cada passo do `runStep`

`src/runner.js` — `runStep` agora emite `1/3 detectando...`, `2/3 executando
"<step.title>" (pode demorar alguns minutos)...`, `3/3 validando...`. Antes:
`detect <title>` / `execute <title>` (sem indicação de fase nem expectativa
de duração).

`src/executors.js` — step_05 (apt), step_11 (clone _squad), step_12
(clone+install orchestrator): logs granulares ANTES das operações demoradas
(`apt-get update`, `apt-get install`, `git clone`, `npm install`). Step_04
(Ubuntu first boot) já tinha progress de 5s — confirmado, permanece.

#### FIX 4 — Heartbeat de 5s durante step running

`runner.js` — `runStep` arma `setInterval(5s)` que emite
`(ainda processando — Xs decorridos)` enquanto o step roda. Limpo no `finally`
(qualquer caminho: success/error/throw). User SEMPRE vê pulso de vida na UI.

#### FIX 5 — `onPreflight` adapter confirmado

`main.js` linhas 159-167: `PREFLIGHT_NAME_MAP` mapeia `windows_build` →
`'windows'`, `disk_c_free_gb` → `'disk'`, etc, e `state` traduz
`ok→'ok' / warning→'warn' / fail→'err'`. Já estava certo desde a onda 2 —
apenas confirmado, sem mudança.

#### FIX 6 — `checkOtherDistros` defensivo pré-WSL

`src/preflight.js` — `checkOtherDistros` agora faz `Get-Command wsl.exe` PRIMEIRO
(timeout 10s). Se `wsl.exe` não existe, retorna imediatamente
`{ok:true, detail:'wsl.exe ainda não instalado (esperado antes do step 03)'}`.
Antes: `wsl -l -v` em PC sem WSL podia demorar 30s pra dar "not recognized".

### Smoke tests passando

```bash
$ node -e "const p = require('./src/preflight'); let count=0; const start=Date.now(); p.runAll({onCheck: (c) => { console.log('STREAM:', c.name, '|', c.ok?'ok':'fail', '|', Math.floor((Date.now()-start)/100)/10+'s'); count++; }}).then(r => console.log('TOTAL:', count, '/', r.results.length))"
STREAM: windows_build | ok | 1s
STREAM: admin | ok | 1.1s
STREAM: internet_github | ok | 1.7s
STREAM: disk_c_free_gb | ok | 2s
STREAM: antivirus | ok | 2s
STREAM: other_distros | ok | 2.7s
STREAM: virtualization | fail | 3.6s
TOTAL: 7 / 7 em 3.6s
# → streaming OK. Cada STREAM emitido na hora que o check termina,
#   ANTES de TOTAL. windows_build em 1s, virtualization em 3.6s.

$ node -e "const {timeoutCheck} = require('./src/preflight'); timeoutCheck('teste',100).catch(e => console.log('OK timeout:', e.message, '| code:', e.code))"
OK timeout: timeout (100ms) | code: CHECK_TIMEOUT
# → timeoutCheck exporta corretamente.

$ # Smoke 3 (timeout aplicado a check que trava):
$ # Monkey-patch checkVirtualization pra hang infinito + timeoutMs:500
$ # → todos os 7 checks viram fail em <1s (em vez de hang infinito)
```

### Arquivos tocados

- `src/preflight.js` — `timeoutCheck` exportado, `runAll` reescrito streaming
  (~linhas 33-50 helper, ~linhas 175-260 runAll), `checkOtherDistros` com
  fast-path pre-WSL (~linhas 96-107).
- `main.js` — `installer:start` usa `onCheck` callback streaming, emite
  `onLog` antes/depois (~linhas 213-275).
- `src/runner.js` — heartbeat 5s em `runStep` (~linhas 199-211), logs
  granulares `1/3 detectando / 2/3 executando / 3/3 validando` (~linhas
  227-242), `finally` clearInterval (~linha 274).
- `src/executors.js` — logs granulares em step_05 apt (~linhas 287-303),
  step_11 clone (~linhas 538-552), step_12 clone+install (~linhas 574-602).
