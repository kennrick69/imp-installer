# REVIEW EDUARDO — v0.2.15

**Escopo:** caça a "botões fantasma" do MESMO PADRÃO do fix v0.2.15
(divergência de contrato entre `main.js sendToRenderer(...)` e
`wizard.js api.onX((payload) => ...)`).

**Padrão alvo:** main envia `{a, b, c}` top-level; wizard lê `payload.something.a` (nested errado) ou vice-versa → leitura silenciosa de `undefined` → UI não reage.

**Constraints respeitados:**
- Pasta `imp-installer/` única — sem tocar.
- Sem corrigir — só relatar.

**Arquivos lidos:**
- `/mnt/c/Projetos/imp-installer/main.js` (832L)
- `/mnt/c/Projetos/imp-installer/preload.js` (64L)
- `/mnt/c/Projetos/imp-installer/renderer/wizard.js` (1642L)
- `/mnt/c/Projetos/imp-installer/renderer/index.html` (621L — checagem cirúrgica nos IDs do manual screen)
- `/mnt/c/Projetos/imp-installer/renderer/style.css` (2096L — landmines de `display:none`/`pointer-events`)
- `/mnt/c/Projetos/imp-installer/src/runner.js` (parcial — shape de emitStepUpdate)
- `/mnt/c/Projetos/imp-installer/src/logger.js` (parcial — shape de onLog)
- `/mnt/c/Projetos/imp-installer/src/preflight.js` (parcial — buildBlockingErrorPayload)
- `/mnt/c/Projetos/imp-installer/src/executors.js` (step_04_ubuntu_first_boot)

---

## 1) Inventário: `sendToRenderer('installer:on*', ...)` em main.js

| # | Linha | Canal | Shape do payload emitido |
|---|------:|---|---|
| 1 | 153 | `installer:sudoPrompt` | `{ id, prompt }` |
| 2 | 180 | `installer:onLog` | `entry` direto do logger = `{ ts, level, component, message, extra? }` |
| 3 | 182 | `installer:onStepUpdate` | `{ stepId, state, title, category, ...upd }` (spread espalha `id`, `status`, +extra) |
| 4 | 276 | `installer:onManualPrompt` | TOP-LEVEL: `{ stepId, title, subtitle, instructions[], steps[], action, fallback, commands[], expected, note, terminal, browser }` |
| 5 | 288 | `installer:onNeedsAdmin` | `{ stepId }` |
| 6 | 296 / 354 / 441 / 483 | `installer:onError` | `{ stepId, headline, what, suggestions[], canRetry, canSkip, raw }` |
| 7 | 306 | `installer:onState` | `state` (objeto cru do runner) |
| 8 | 372 / 701 | `installer:onScreen` | `{ screen: 'preflight'\|'progress' }` |
| 9 | 378 / 400 / 428 / 773 / 789 / 806 | `installer:onLog` (variantes inline) | `{ ts, level, component, message }` |
| 10 | 395 | `installer:onPreflight` | `{ checkId, state, message }` |
| 11 | 475 | `installer:onComplete` | `{ durationSeconds, sala3dInstalled }` |
| 12 | 805 | `installer:onElevateTimeout` | `{ elapsedMs, logFile }` |

---

## 2) Inventário: `api.on*((cb) => ...)` em wizard.js

| # | Linha | Listener | Como acessa o payload |
|---|------:|---|---|
| 1 | 1445 | `onLog` | `(entry) => entry.message ?? entry.msg` (com normalização) |
| 2 | 1459 | `onStepUpdate` | `(update) => update.stepId, update.state, update.progress, update.etaSeconds, update.message` |
| 3 | 1504 | `onPreflight` | `(res) => res.checkId, res.state, res.message` |
| 4 | 1509 | `onManualPrompt` | passa direto pra `showManualPrompt(prompt)`; lê `prompt.action`/`prompt.fallback`/`prompt.steps`/... TOP-LEVEL (fix v0.2.15) |
| 5 | 1510 | `onError` | `(payload) => payload.stepId`, repassa pra `showErrorModal(payload)` que destruct `{stepId, headline, what, suggestions, canRetry, canSkip, raw}` |
| 6 | 1521 | `onNeedsAdmin` | `(payload) => showElevateModal(payload)` — ignora conteúdo |
| 7 | 1526 | `onElevateTimeout` | `(payload) => ...` mas **NÃO lê NADA do payload** — só mostra string fixa |
| 8 | 1531 | `onComplete` | `(summary) => summary.durationSeconds, summary.sala3dInstalled` |
| 9 | 1546 | `onScreen` | `(name) => showScreen(name)` ← **trata como STRING** |
| 10 | 1547 | `onToast` | `({ message, kind }) => toast(...)` |
| 11 | 1550 | `onSudoPrompt` | `({ id, prompt }) => ...` |
| **AUSENTE** | — | `onState` | apenas exposto no `preload.js` e emitido pelo main; **wizard NUNCA registra** |

---

## 3) Cruzamento — Achados

| # | Evento | Main envia | Wizard consome | Bate? | Severidade |
|---|---|---|---|---|---|
| A | `onLog` | `{ts, level, component, message}` | `entry.message ?? entry.msg` | OK (fix Camila prévio) | — |
| B | `onStepUpdate` | `{stepId, state, title, category, ...upd}` | `update.stepId/state/progress/etaSeconds/message` | OK (campos primários presentes) | 🟢 |
| C | `onPreflight` | `{checkId, state, message}` | `res.checkId/state/message` | OK (NAME_MAP traduz no main) | 🟢 |
| D | `onManualPrompt` | top-level `{stepId, title, action, fallback, steps, commands, ...}` | top-level (fix v0.2.15) com fallback pra `prompt.instructions.*` | OK | 🟢 |
| E | `onError` | `{stepId, headline, what, suggestions, canRetry, canSkip, raw}` | `showErrorModal(payload)` destruct com defaults `canRetry=true canSkip=false` | OK | 🟢 |
| F | `onComplete` | `{durationSeconds, sala3dInstalled}` | `summary.durationSeconds, summary.sala3dInstalled` | OK | 🟢 |
| G | `onElevateTimeout` | `{elapsedMs, logFile}` | nada lido | OK funcional, info desperdiçada (logFile não exibido) | 🟡 |
| H | `onNeedsAdmin` | `{stepId}` | ignorado (só abre modal) | OK | 🟢 |
| I | `sudoPrompt` | `{id, prompt}` | `{id, prompt}` | OK | 🟢 |
| **J** | **`onScreen`** | **`{ screen: 'preflight'\|'progress' }`** | **`(name) => showScreen(name)`** trata como string | **❌ NÃO BATE** | **🔴 ALTO** |
| K | `onState` | objeto `state` | **wizard nunca registra listener** | dead code | 🟡 |
| L | `onToast` | **main nunca emite** | wizard registra mas em vão | dead code | 🟢 |

### Achado J detalhado (🔴 BUG MESMO PADRÃO DO v0.2.15)

- **main.js:172** `sendToRenderer('installer:onScreen', { screen: 'preflight' });`
- **main.js:701** `sendToRenderer('installer:onScreen', { screen: 'progress' });`
- **wizard.js:1546** `api.onScreen && api.onScreen((name) => showScreen(name));`
- `showScreen()` faz `$('#screen-' + name)` — com `name = {screen:'preflight'}` vira `#screen-[object Object]`, que retorna `null`, e o `target.classList.add('active')` daria TypeError ANTES de `target` ser usado — mas tem guard `if (target)`, então silenciosamente nada acontece.
- **Sintoma esperado:** se algum dia algo depender desse evento pra trocar de tela, a UI fica congelada. Hoje o impacto é BAIXO porque o fluxo principal (preflight→progress) é triggered por `runPreflightFlow()`/`advanceToProgress()` que chamam `showScreen()` direto. Mas o evento existe pra ser usado em recovery scenarios e está QUEBRADO.
- **Severidade real:** 🔴 do ponto de vista contrato (mesma família do bug v0.2.15), 🟡 do ponto de vista user-impact imediato (não impede usar Step 04).

### Achados secundários

- **K (`onState` dead):** main emite (`onState: (state) => sendToRenderer('installer:onState', state)`) mas wizard nunca registra `api.onState(cb)` — só stub no `makeNoopApi`. 🟡 não quebra nada hoje; é dead pipe.
- **L (`onToast` dead):** main NUNCA emite `installer:onToast`; wizard registra à toa. 🟢 inofensivo.
- **G (`onElevateTimeout` info perdida):** main envia `logFile` mas wizard só mostra string genérica, perdendo o path do log que ajudaria o JOs reportar pro Bruno. 🟡.

---

## 4) Invoke contracts — `api.installer.xxx()` calls em wizard.js

Cruzei TODO `api.X(` em wizard com `preload.js` e `ipcMain.handle/safeHandle` em main:

| Método wizard | Preload expõe? | Main handle? | Retorno bate? |
|---|---|---|---|
| `start()` | sim | sim | `{ok, checks, preflight}` — wizard lê `res.ok` e `res.preflight` ✅ |
| `resume()` | sim | sim | `{ok}` ✅ |
| `runStep(id)` | sim (passa `{stepId}`) | sim | retorna resultado de `runner.runStep` (ok via `res.ok!==false`) ✅ |
| `runAll()` | sim | sim | `{ok:true}` imediato (fire-and-forget) — wizard não usa o retorno (chama em `advanceToProgress`) ✅ |
| `markManualDone(id)` | sim | sim | retorna o que `runner.markManualDone` devolve; wizard espera `r.status === 'done'` ⚠️ ver nota |
| `retry(id)` | sim | sim | ok (delega pra runStep) ✅ |
| `skip(id, reason)` | sim | sim | `{ok:true}` ✅ |
| `getState()` | sim | sim | objeto state — wizard lê `state.lastStepCompleted`/`state.steps` ✅ |
| `openTerminal(cmd)` | sim | sim | `{ok}` ✅ (wizard não usa hoje) |
| `openBrowser(url)` | sim | sim | `{ok}` ✅ |
| `executeManualAction(kind, payload)` | sim | sim | `{ok, via?, error?}` — wizard lê `r.ok`/`r.error` ✅ |
| `exportLogs()` | sim | sim | `{ok, path}` — wizard lê `out?.path` ✅ |
| `installSala3D()` | sim | sim | ok ✅ |
| `openInterface()` | sim | sim | `{ok, opened?, error?}` ✅ (sem feedback no wizard) |
| `pause()`/`closeApp()`/`pickFolder()`/`reset()` | sim | sim | ✅ |
| `isElevated()` | sim | sim | `{ok, elevated}` — wizard lê `r.ok && r.elevated===false` ✅ |
| `relaunchAsAdmin()` | sim | sim | `{ok, monitoring, error?}` — wizard lê `r.ok && r.monitoring` e `r.error==='UAC_CANCELLED'` ✅ |
| `cancelRelaunch()` | sim | sim | `{ok, cancelled}` ✅ |
| `quitApp()` | sim | sim | ✅ (não usado no wizard atualmente) |
| `sudoReply(id, password, cancelled)` | sim | sim | ✅ |

**Nota ⚠️ markManualDone:** wizard.js:607 espera `r.status === 'done'`. Não validei runner.markManualDone, mas o `safeHandle` em torno NÃO toca o retorno (passa direto). Se markManualDone às vezes devolver `{ok:true}` em vez de `{status:'done'}`, o botão "Já fiz, continuar" fica perpetuamente disabled — outro botão fantasma! Severidade 🟠 a verificar (fora do escopo desta missão — não devo abrir runner pra modificar; só sinalizo).

---

## 5) CSS landmines

- `style.css:86` `.hidden { display: none !important; }` — usado SEMPRE com `classList.toggle('hidden', !show)`. OK.
- `style.css:1738` `.toast-container { pointer-events: none; }` + `.toast { pointer-events: auto; }` na linha 1751. Toast e botão de fechar funcionam. OK.
- **`.manual-action-row`** (1165) — NÃO tem `display:none` baseline. Visibilidade controlada por `.hidden`. OK.
- **`.btn-manual-action`** (1176) — sem `pointer-events:none`. Botão clicável quando visível. OK.
- **`.btn-passive`** (1192) — usado pra `kind:'none'` (steps esperando); tem `cursor:default` e disabled via JS. OK por design.
- `actionBtn.hidden = false` em wizard.js:447: usa atributo `[hidden]` — o `display:none !important` da classe `.hidden` (com `!important`) sobrescreveria se ambos coexistissem, MAS o código também faz `actionRow.classList.remove('hidden')` na linha anterior, então OK.
- Nenhum `[hidden]` sobrescrito com `display:block!important` encontrado.

**Veredito CSS:** 🟢 sem landmines.

---

## 6) Severidades consolidadas

| Sev | Achado |
|---|---|
| 🔴 | **J** — `onScreen` contrato quebrado main↔wizard (mesma família do v0.2.15). Hoje não bloqueia Step 04 porque ninguém depende desse canal pra avançar. |
| 🟠 | (potencial) markManualDone shape — não verificado por estar fora do escopo (`src/runner.js`); pode ser outro botão fantasma escondido. |
| 🟡 | **K** — `onState` dead pipe; **G** — `logFile` do onElevateTimeout descartado. |
| 🟢 | Demais contratos OK. CSS limpo. |

---

## 7) Veredito

# GO COM RESSALVAS

**Confiança de que JOs CONSEGUE USAR o Step 04 na v0.2.15: ~88%.**

- O fix do botão fantasma em `onManualPrompt` está CORRETO — wizard lê top-level com fallback pra nested, exatamente o shape que main emite (`payload.action`, `payload.fallback`, `payload.steps`, etc., todos top-level — main.js linhas 210-275 confirmam).
- IDs do HTML batem com `$('#manual-action-btn')`, `$('#manual-action-hint')`, `.manual-action-row` (closest) — todos presentes em index.html:295-298.
- CSS não esconde nem mata click.
- `executeManualAction('terminal', {distro})` está corretamente cabeado main↔preload↔wizard.

**Riscos remanescentes:**
1. **🔴 J (`onScreen`):** se algum hotfix futuro depender desse evento pra ressincronizar tela, falha silente. Bug LATENTE do tipo procurado — recomendo fix antes do próximo release, mesmo não bloqueando hoje.
2. **🟠 markManualDone:** se o runner devolver shape `{ok:true}` em vez de `{status:'done'}` (não verificado), o botão "✓ Já fiz, continuar" do Step 04 fica disabled mesmo após verify OK. ALTO IMPACTO no Step 04 específico — vale 1 grep antes do JOs testar.
3. **Pequeno:** UAC fallback em main.js:805 envia `logFile` que wizard descarta — perde rastro pra debug remoto.

**Recomendação:** soltar v0.2.15 pro JOs testar Step 04 com o fix atual; abrir issues separadas pros achados J, ~K, G~ (não bloqueantes) e VERIFICAR markManualDone shape antes de marcar como "GO total".

---

— Eduardo, revisor da IMP Dev Squad
