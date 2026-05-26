# STRESS-TEST v0.2.1 — Patrícia (QA)

**Data:** 2026-05-26
**Escopo:** Auditoria estática + mini-tests Node do fluxo end-to-end do instalador, do clique "Começar" até "Tudo pronto".
**Sem rodar Electron.** Análise de `main.js`, `preload.js`, `renderer/wizard.js`, `src/{runner,executors,preflight,shell,state,logger,error-catalog}.js`.
**Versão alvo:** v0.2.1 (Bruno está corrigindo o bug bloqueador do v0.2.0; este doc cobre o resto.)

---

## 0 — Resumo executivo

- **30+ caminhos auditados** desde o `installer:start` até o `installer:openInterface`.
- **3 BLOCKERs** confirmados (1 é o já reportado; 2 novos).
- **5 HIGHs**, **6 MEDIUMs**, vários LOW.
- **Recomendação universal:** wrapper `safeHandle` em `main.js` que SEMPRE captura exceção dos `ipcMain.handle` e envia `installer:onError` estruturado ANTES de rejeitar a invoke. Hoje, várias rejeições caem em `toast(...)` genérico do wizard sem mostrar a tela de erro com sugestões.

---

## 1 — Mapa do fluxo (alto nível)

```
[welcome]            (wizard.js bindWelcome)
   ▼ "Começar"
api.start()          → ipcMain('installer:start')
   → runner.startWizard(events)   [acquireLock pode throw]
   → preflight.runAll()           ← BUG #1 (objeto, não array)
   → for c of checks              ← TypeError: not iterable

[preflight]
   "Próximo" → showScreen('progress')
   → wizard NÃO chama runAll automaticamente; o usuário tem que clicar?
     OU é chamado por algum onScreen→onStepUpdate? (não-óbvio)

[progress]
   api.runAll()  → ipcMain('installer:runAll')
     → runner.runAll(events)   (fire-and-forget no main; .then trata onComplete)
       ↳ runStep loop (00→16)
         ↳ pauseGate, reboot-gate (throws CRU se reboot pendente)
         ↳ safeCall(detect/execute/validate)
         ↳ emitStepUpdate / onError
       ↳ se step_03 setou rebootRequired: break (aguarda reboot)
     → results.every(r => r.status==='done') → onComplete  ← BUG #4 (every em [])

[manual]              (steps 04, 09, 10 com manualInstructions)
   showManualPrompt(prompt) via onManualPrompt
   "Verificar" → api.runStep(stepId)
   "Pronto"    → api.markManualDone(stepId)

[error]               (qualquer onError do runner)
   "Tentar" → api.retry → runner.runStep
   "Pular"  → api.skip  → runner.skipStep  ← BUG #6 (CRITICAL_STEPS throws)

[done]                (após step_16 ou onComplete)
   "Abrir Squad Comando" → api.openInterface (silent-fail se path quebrado)
```

---

## 2 — Achados (severidade ordenada)

### 2.1 BLOCKERs

| # | Sev | Onde (file:line) | O quê | Repro | Sugestão fix |
|---|---|---|---|---|---|
| 1 | BLOCKER | `main.js:174` | `for (const c of checks)` — `checks` é objeto `{ok, blocking, warnings, results}`, NÃO array. `runAll` mudou shape e handler não acompanhou. | Clica "Começar" no welcome. `TypeError: checks is not iterable`. | `const r = await preflight.runAll({ logger }); for (const c of r.results) { ... } return { ok: r.ok, blocking: r.blocking, warnings: r.warnings, results: r.results };` |
| 2 | BLOCKER | `runner.js:79-83` + `main.js:60-63` | Após pós-reboot, `app.whenReady` chama `markRebootDone()` que internamente faz `startWizard({})` SEM events. Depois quando o usuário clica "Começar", o handler chama `startWizard(buildRunnerEvents())` mas isso entra no early-return da linha 78 — APENAS faz `_ctx.events = events`, **NÃO atualiza `_ctx.requestSudoPassword`**. Resultado: step_05 (apt) e step_10 (gh install) chamam `sudoInWsl` com `passwordPromise: undefined` → throw `sudo: senha exigida e UI não forneceu passwordPromise`. | Instalar até step_03 → reboot → instalador re-abre via RunOnce → usuário clica "Começar"/"Resume" → step_05 falha imediatamente ao precisar de sudo. | Em `startWizard`, mesmo no re-bind path, atualize `_ctx.requestSudoPassword = events.requestSudoPassword \|\| opts.requestSudoPassword;`. Idealmente também em `runStep`/`runAll` quando recebem novos `events`. |
| 3 | BLOCKER | `state.js:62-87` (migrate) | Se um `state.json` legítimo for carregado SEM o campo `decisions` (ex.: usuário editou manualmente, ou versão antiga sem este campo), `step_13_sala3d.execute` acessa `ctx.state.decisions.escritorio3dStrategy` → `TypeError: Cannot read properties of undefined`. Idem para `step_13.validate`. Reproduzi em Node: ✅. | Carregar state sem `decisions` (state corrompido parcial, edit manual). Crash no step_13 com erro CRU. | Em `migrate(state)`, garantir defaults: `s.decisions = { ...emptyState().decisions, ...(s.decisions \|\| {}) };` Idem para `steps`, `stepDetails`. |

### 2.2 HIGHs

| # | Sev | Onde | O quê | Sugestão fix |
|---|---|---|---|---|
| 4 | HIGH | `main.js:191-198` | `runner.runAll()` é fire-and-forget. Se o primeiro step crasha ANTES de pushar em results (ex.: reboot-gate throw na linha `runner.js:151`), `results` fica `[]` e `results.every(...) === true` (vacuosamente verdadeiro). **`installer:onComplete` dispara prematuramente.** Confirmado: `[].every(...) === true`. | Inicializar `let completed = false; if (results.length && results.every(...))`. Ou checar `results.length === ALL_STEPS.length`. |
| 5 | HIGH | `runner.js:142, 151` | `runStep` pode throw CRU em 2 lugares ANTES do try interno: (a) step não encontrado, (b) reboot pendente. `main.js` propaga rejection para `api.runStep().catch(...)` no wizard → toast genérico ("Retry falhou: ..."). Usuário NÃO vê a tela de erro com sugestões. | Envolver throws em try/catch que chama `events.onError(...)` antes de propagar, OU mover essas validações para dentro do try. |
| 6 | HIGH | `main.js:220-223` (`installer:skip`) | `runner.skipStep` joga `Error('step ... é crítico — não pode ser pulado')` para CRITICAL_STEPS. Handler não tem try/catch → invoke rejeita → wizard mostra toast genérico "Não consegui pular: step ... é crítico". Mensagem útil, mas sem botão de força/explicação real. UX ruim. | Try/catch no handler retornando `{ok:false, error: '...', reason: 'CRITICAL_STEP'}`. Wizard pode mostrar modal explicando. |
| 7 | HIGH | `executors.js:104` (step_03 detect) | Regex de fallback `/Ubuntu[\s\S]*\b2\b/m` aceita **Ubuntu-20.04** como já-instalado. Se o usuário tem Ubuntu-20.04 sobrando de outra instalação, step_03 retorna `true` → skip → step_05 (apt) pode falhar porque alguns pacotes/PPA assumem 22.04. Confirmado com regex test em Node. | Remover fallback solto. Aceitar SÓ `/Ubuntu-22\.04[\s\S]*?\b2\b/m`. Se quiser ser permissivo, listar `wsl -l -v` e validar nome exato. |
| 8 | HIGH | `shell.js:162-180` (`openInteractiveTerminal`) | Double-resolve: `resolve` na linha 175 (fallback ok) E na linha 179 (incondicional). Pior — `reject` na 173 nunca dispara porque promise já resolveu. **Handler sempre retorna `{ok:true}` mesmo se o terminal não abriu.** step_09/10 dependem disso para mostrar "abra o terminal" — se falhar silenciosamente, usuário fica esperando o poll de 15min timeout. | Remover `resolve` da linha 179. Disparar resolve dentro do `child.on('spawn', ...)` (wt) e do `fallback.on('spawn', ...)`, ou usar setTimeout curto + check. |

### 2.3 MEDIUMs

| # | Sev | Onde | O quê | Sugestão fix |
|---|---|---|---|---|
| 9 | MED | `runner.js:84` (acquireLock) | `startWizard` throws se outro processo válido tem o lock. Acontece se o user matar o instalador errado-mente e o PID do lock ficar com outro processo válido. `installer:start` propaga rejection cru. Wizard toast: "Não consegui iniciar a instalação. Outro instalador já está rodando (PID 12345). Feche-o antes." — mensagem ok mas sem botão "forçar". | Try/catch + tela dedicada com botão "Liberar lock antigo" (delete file). |
| 10 | MED | `state.js:77` | `JSON.parse(raw)` em `loadState`. Já tem try/catch que rotaciona corrupt files. **OK**, mas se `migrate(parsed)` jogar (não joga hoje, mas em migrações futuras), não há rede de segurança. | Mover `migrate` para dentro do try. |
| 11 | MED | `wizard.js:777-781` | `Object.entries(state.steps).forEach(...)` crasha se `state.steps` for null/undefined. Hoje `loadState` sempre retorna `emptyState()` com `steps:{}`, mas se o IPC `installer:getState` falhar ou retornar shape inesperado, init do wizard quebra silencioso (catch no `console.warn` na linha 783). | `Object.entries(state.steps \|\| {}).forEach(...)` |
| 12 | MED | `main.js:269-282` (`openInterface`) | `shell.openPath(p)` é async mas não tem `await` nem `.then`. Se .lnk corrompido, retorna string vazia (sucesso) ou erro — ignorado. User clica botão na tela "Done", nada acontece, sem feedback. | `const err = await shell.openPath(p); if (err) return {ok:false, error: err};` |
| 13 | MED | `runner.js:269-279` (`skipStep`) | Aceita `stepId` inexistente (testado em Node: setStepStatus grava `state.steps.step_INEXISTENTE='skipped'`). Polui state. | Checar `ALL_STEPS.find(s => s.id === stepId)` antes. |
| 14 | MED | `executors.js:611` (step_13) | `ctx.state.decisions.escritorio3dStrategy` — depende do Bug #3 ser corrigido. Adicional: hoje `defaultState.decisions.escritorio3dStrategy = 'release-asset-on-demand'` mas o código só compara contra `'skip'`. Significa que qualquer outro valor (`'release-asset-on-demand'`) cai no path de download — provavelmente intencional, mas worth a comment. | Documentar enum válido ou usar constant. |

### 2.4 LOWs (worth noting)

- `main.js:242-246` (`openBrowser`): `shell.openExternal` fire-and-forget. Se URL malformada passar pelo regex, falha silenciosa. **LOW** — regex já filtra `^https?://`.
- `main.js:264-266` (`installSala3D`): chama `runStep('step_13_sala3d')` que retorna `{id, status, error?}`. Wizard espera `result.ok` (linha 537 wizard.js: `if (result && result.ok)`) — **incompatível**. `result.ok` é undefined → wizard sempre mostra "Ainda não está pronto" mesmo em sucesso. Provável para `bindManual` mas vale rever pra Sala 3D também.
- `executors.js:732` (step_14): `tmux send-keys 'claude' C-m` em todos os panes. Se `claude` não está no PATH do shell que tmux abre (ex.: ~/.bashrc não-source em non-login shell), panes mostram "command not found". Não-crítico mas e2e capture-pane vai warn-ar.
- `error-catalog.js:228` (`enrichError`): aceita `errorMessage` null/undefined (faz `String(...)`). OK. Mas aceita objetos sem `toString` — vira `[object Object]`. **LOW**.
- `shell.js:222-238` (`scheduleRunOnceAfterReboot`): Se RunOnce não existir/regedit bloqueado por GPO corporativo, falha. Capturado no caller (`step_03` linha 132). **LOW**.

---

## 3 — Outputs dos mini-tests executados

### 3.1 `preflight.runAll()` shape
```
Array.isArray: false
typeof: object
keys: [ 'ok', 'blocking', 'warnings', 'results' ]
iterable?: false
```
Confirma BUG #1.

### 3.2 `state.migrate()` sem `decisions`
```
fakeState = { schema_version: 1, steps: {}, stepDetails: {} }
migrated.decisions: undefined
CRASH: Cannot read properties of undefined (reading 'escritorio3dStrategy')
```
Confirma BUG #3.

### 3.3 `[].every(...)`
```
true   ← onComplete dispara em runAll vazio
```
Confirma BUG #4.

### 3.4 Regex step_03 detect com Ubuntu-20.04
```
/Ubuntu-22\.04[\s\S]*\b2\b/m: false
/Ubuntu[\s\S]*\b2\b/m:        true   ← falso-positivo
```
Confirma BUG #7.

### 3.5 setStepStatus com step inexistente
```
state.steps.step_INEXISTENTE = 'skipped'   ← aceitou, sem warning
```
Confirma BUG #13.

---

## 4 — Caminhos auditados (lista exaustiva)

Total: **31 caminhos**.

### IPC handlers (15)
1. `installer:start` — BUG #1, lock-collision propaga
2. `installer:resume` — branch para iniciar vs flip-pause, ok
3. `installer:runStep` — throws CRU em 2 lugares (BUG #5)
4. `installer:runAll` — fire-and-forget, BUG #4
5. `installer:markManualDone` — validate via .catch (ok)
6. `installer:retry` — alias de runStep (herda BUG #5)
7. `installer:skip` — BUG #6 (CRITICAL_STEPS throw)
8. `installer:getState` — safe
9. `installer:listSteps` — safe
10. `installer:openTerminal` — try/catch, mas BUG #8 do shell faz sempre passar
11. `installer:openBrowser` — fire-and-forget LOW
12. `installer:exportLogs` — writeFileSync sync sem try (pode falhar com EACCES)
13. `installer:installSala3D` — incompatibilidade de shape do retorno
14. `installer:openInterface` — BUG #12 (openPath sem await)
15. `installer:pause/resume/reset/closeApp/sudoReply/pickFolder/getVersion` — safe

### Steps (17) — caminho execute/detect/validate
- step_00: preflight crasha BUG #1
- step_01-02: ok
- step_03: regex BUG #7
- step_04: launcher fallback ok; depende de openInteractiveTerminal BUG #8
- step_05: sudoInWsl BUG #2 (requestSudoPassword undefined)
- step_06-08: ok
- step_09: openInteractiveTerminal BUG #8
- step_10: BUG #8 + sudoInWsl BUG #2
- step_11-12: ok
- step_13: BUG #3 (decisions.escritorio3dStrategy)
- step_14: warning sobre claude no PATH
- step_15: ok
- step_16: ok

---

## 5 — Sugestão de defensiva universal

### 5.1 Adapter `safeHandle` para `ipcMain`

Adicionar em `main.js`:

```js
function safeHandle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      return await fn(event, ...args);
    } catch (err) {
      const stepId = (args[0] && args[0].stepId) || null;
      const enriched = enrichError(stepId, err.message || String(err));
      // Manda pro renderer pra mostrar tela de erro estruturada.
      sendToRenderer('installer:onError', {
        stepId,
        headline: enriched.headline,
        what: enriched.what,
        suggestions: enriched.suggestions,
        canRetry: enriched.canRetry,
        canSkip: enriched.canSkip,
        raw: enriched.raw,
      });
      // Retorna shape padrão pro caller (em vez de rejeitar).
      return { ok: false, error: err.message || String(err), suggestions: enriched.suggestions };
    }
  });
}
```

Substituir os 15 `ipcMain.handle(...)` por `safeHandle(...)`. Garante que **NENHUMA** exceção crua vaza pra renderer.

### 5.2 `process.on('unhandledRejection')` + `'uncaughtException'`

Em `main.js` topo:

```js
process.on('unhandledRejection', (reason) => {
  const msg = (reason && reason.message) || String(reason);
  sendToRenderer('installer:onToast', { message: 'Erro interno: ' + msg, kind: 'error' });
  // logger global se disponível
  try { runner.getState && console.error('[unhandledRejection]', reason); } catch (_) {}
});
process.on('uncaughtException', (err) => {
  sendToRenderer('installer:onToast', { message: 'Erro crítico: ' + err.message, kind: 'error' });
});
```

### 5.3 Defensiva no `state.migrate`

Sempre completar shape:
```js
function migrate(state) {
  let s = state || {};
  const def = emptyState();
  s.steps        = { ...def.steps,        ...(s.steps        || {}) };
  s.stepDetails  = { ...def.stepDetails,  ...(s.stepDetails  || {}) };
  s.decisions    = { ...def.decisions,    ...(s.decisions    || {}) };
  s.schema_version = s.schema_version || SCHEMA_VERSION;
  // ... migrações por versão ...
  return s;
}
```

---

## 6 — Prioridade de fix recomendada

1. **Bruno já faz:** BUG #1 (preflight shape).
2. **Mesma branch v0.2.1 — CRÍTICOS:** BUG #2 (sudo post-reboot), BUG #3 (decisions guard).
3. **v0.2.1:** BUG #4 (every em []), BUG #5 (runStep throws CRU), BUG #8 (openInteractiveTerminal double-resolve).
4. **v0.2.2:** BUG #6, #7, #9, defensiva universal (5.1, 5.2).
5. **backlog:** todos os MEDs e LOWs.

---

## 7 — Notas finais

- Não modifiquei código (Bruno faz). Tudo aqui é análise + repro.
- Mini-tests rodaram em `node` puro carregando os módulos do `src/`. Nenhum Electron, nenhum WSL real.
- Quando testar o build v0.2.1, sugiro repro manual de BUG #2: simular post-reboot deletando `state.rebootDone` no JSON e relançando.
