# AUDIT-IDS v0.2.15 — Patrícia (QA) — IMP Squad Instalador

**Data**: 2026-05-26
**Auditora**: Patrícia (QA) — IMP Dev Squad
**Escopo**: `/mnt/c/Projetos/imp-installer/` (renderer + main + preload)
**Gatilho**: bug do BOTÃO FANTASMA na v0.2.14 — divergência de contrato `main.js → wizard.js`. JOs furioso, ordem: auditar TODO o resto pra não passar bug ridículo de novo.
**Metodologia**: cross-check linha-a-linha entre `renderer/index.html`, `renderer/wizard.js`, `renderer/style.css`, `main.js`, `preload.js`.

---

## 1. NÚMEROS

| Métrica | Valor |
|---|---|
| **IDs únicos no HTML** | **120** |
| IDs auditados (com handler em JS) | 120 (100%) |
| Listeners `api.on*` em wizard.js | 11 (onLog, onStepUpdate, onPreflight, onManualPrompt, onError, onNeedsAdmin, onElevateTimeout, onComplete, onScreen, onToast, onSudoPrompt, onState) |
| Handlers `api.installer.*` em wizard.js | 17 |
| `safeHandle/ipcMain.handle` em main.js | 22 |
| Eventos `sendToRenderer('installer:on*')` em main.js | 9 |
| **Quebras encontradas** | **6** (1 BLOCKER, 2 HIGH, 3 LOW) |

---

## 2. QUEBRAS ENCONTRADAS

| Sev | Elemento / Contrato | Bug | Fix sugerido |
|---|---|---|---|
| 🔴 **BLOCKER** | `#elevate-status` (visibilidade) | HTML nasce com **`class="elevate-status hidden"`** (linha 596). `showElevateStatus()` em wizard.js:742 faz `el.hidden = false` (propriedade booleana, manipula só o ATRIBUTO `[hidden]`) — **mas a classe `.hidden` continua aplicada** e tem `display:none !important` (style.css:86). Resultado: status do modal-elevate (aguardando UAC, countdown, mensagem de erro) **NUNCA aparece**. Mesmo padrão do bug do botão fantasma: dois mecanismos de visibilidade brigando entre si. | Em `showElevateStatus()`, trocar `el.hidden = false` por `el.classList.remove('hidden'); el.hidden = false;`. Em `hideElevateStatus()`, adicionar `el.classList.add('hidden')`. Ou remover a classe `hidden` do HTML inicial e deixar só `[hidden]`. |
| 🟠 HIGH | `describeStep()` — IDs divergentes | wizard.js:245-263 usa IDs **errados** no mapa: `step_06_node` (real: `step_06_node_nvm`), `step_07_npm_global` (real: `step_07_npm_prefix`), `step_10_github_auth` (real: `step_10_gh_auth`), `step_12_clone_orch` (real: `step_12_clone_orchestrator`), `step_15_interface_dl` (real: `step_15_download_interface`). Resultado: `#cur-step-desc` **fica em branco** em 5 dos 17 passos. UX horrível: usuário olha pra tela e não tem ideia do que está acontecendo no passo. | Corrigir as 5 chaves do `map` em `describeStep()` pra bater com os IDs canônicos do `STEPS[]` (linhas 20-38) e do backend (`src/executors.js`). |
| 🟠 HIGH | `api.onScreen` (contrato) | main.js:372,701 envia `{ screen: 'preflight' }` (objeto). wizard.js:1546 lê como string: `api.onScreen((name) => showScreen(name))`. `showScreen({screen:'preflight'})` faz `$('#screen-' + name)` → `'#screen-[object Object]'` → `null` → tela nunca troca. **Mitigado** porque wizard.js já chama `showScreen()` localmente em `runPreflightFlow()` e no botão resume; mas se algum dia main.js for fonte da verdade pra navegação, quebra silenciosa. | Em wizard.js: `api.onScreen((p) => showScreen(typeof p === 'string' ? p : p?.screen))`. OU em main.js mandar string direta. |
| 🟡 LOW | `#sala3d-fill` / `#sala3d-text` (sem update) | wizard.js:1391 só faz `$('#sala3d-progress').classList.remove('hidden')` mas NUNCA atualiza `#sala3d-fill` (largura) nem `#sala3d-text` (label). Como o backend não emite progresso específico por download da sala 3D, a barra fica **0% / "Baixando… 0%" permanente** até o `await api.installSala3D()` retornar e fechar o modal. Usuário fica achando que travou. | Ou: (a) backend emitir `onStepUpdate` com progress real do step_13 e wizard espelhar nesses elementos, OU (b) substituir barra por spinner indeterminado quando não há percent. |
| 🟡 LOW | `installer:onLog` (contrato menor) | main.js:378-383 envia `{ts, level, component, message}`. wizard.js:280 normaliza `message → msg` (OK), mas o campo `component` é **ignorado** e `stepId` vem sempre `null`. Resultado: o filtro `logs-filter-step` no modal de logs **não classifica** logs emitidos diretamente pelo main.js (só os de executors via runner). Não quebra UI, mas frustra debug. | Em main.js, traduzir `component` → `stepId` quando aplicável (`'preflight' → 'step_00_preflight'`, `'elevate' → null`, etc.) ou aceitar mapeamento simples. |
| 🟡 LOW | `#modal-sudo` close X — double-fire | HTML:515 tem `data-close-modal="modal-sudo"` no X. Listener delegado global (wizard.js:153) fecha o modal. Adicionalmente, wizard.js:1579-1584 anexa um `onCancel` extra ao mesmo botão. Ao clicar X: **ambos disparam** — modal fecha 2× E `api.sudoReply(id, '', true)` é chamado (correto, mas redundante com `cleanup()` que tenta `removeEventListener` antes de `addEventListener` numa primeira invocação). Funcional, só barulho. | Remover `data-close-modal="modal-sudo"` do X (linha 515) já que o handler local cobre o caso, OU remover o `addEventListener('click', onCancel)` no X (linha 1584) e deixar só o handler global. |

---

## 3. CHECAGENS QUE PASSARAM (sem bug)

### Telas críticas — wireup OK
- ✅ **#screen-welcome**: `btn-start`, `btn-resume`, `btn-fresh`, `btn-cancel-welcome`, `consent-checkbox`, `resume-card`, `resume-step-name`, `summary-grid` (estático). Bindings em `bindWelcome()`.
- ✅ **#screen-preflight**: 7 cards `.pf-card` com `data-check` (windows/admin/disk/internet/virtualization/other_distros/antivirus) — `PREFLIGHT_NAME_MAP` em main.js:316-324 traduz nomes do backend. `btn-preflight-recheck`, `btn-preflight-next` (+ label `#btn-preflight-next-label`), `#preflight-warnings` painel, `#preflight-footer-hint` com `[hidden]` corretamente coberto pelo CSS:820.
- ✅ **#screen-progress**: `step-list` renderizado por `renderStepList()`. `cur-step-num/title/desc/cat`, `step-fill`, `step-eta`, `logs-body`, `autoscroll-toggle`, `btn-pause`, `btn-skip`, `connection-pill` (`span:last-child` resolve corretamente).
- ✅ **#screen-manual** (foco MÁXIMO — bug que originou auditoria): `manual-title`, `manual-subtitle`, `manual-action-btn` (com defesa dupla: `hidden` attr + `.hidden` class no row), `manual-action-hint`, `manual-steps-list`, `manual-fallback` (+ `fallback-title/code/copy/steps`), `manual-commands` + `manual-cmd-list`, `manual-expected` + `expected-text`, `manual-note` + `note-text`, `manual-verify-btn`, `manual-verify-status`, `manual-done-btn`, `manual-skip-btn`. Contrato `main.js → wizard.js` agora alinhado: top-level + fallback pra `instructions` (fix v0.2.15 confirmado linhas 423-439 do wizard.js).
- ✅ **#modal-error**: `error-headline-text`, `error-what-text`, `error-suggestions-list`, `error-raw-pre`, `error-raw-wrap` (toggle via `.hidden` attr — `<details>` default `display:block` + browser `[hidden]:display:none` funciona). `btn-error-retry`, `btn-error-skip` (hidden via prop quando `!canSkip`), `btn-error-logs`. Payload do main.js (linha 296-303) bate 1-pra-1 com `showErrorModal()` em wizard:652-709.
- ✅ **#modal-elevate**: `btn-elevate-relaunch`, `btn-elevate-cancel`, `btn-elevate-manual`, `elevate-status-text`, `elevate-countdown` — todos bindados. Único problema: o WRAPPER `#elevate-status` (BLOCKER acima).
- ✅ **#modal-sudo**: `sudo-input`, `sudo-prompt-text`, `btn-sudo-confirm`, `btn-sudo-cancel` — fluxo de Promise OK, cleanup correto, autofocus presente.
- ✅ **#modal-logs**: `logs-modal-pane`, `logs-filter-step`, `logs-filter-level`, `btn-logs-copy`, `btn-logs-export`. Atalho `Ctrl+L` funciona.
- ✅ **#modal-skip**: `skip-reason`, `btn-skip-confirm`, fluxo OK.
- ✅ **#modal-sala3d**: `btn-sala3d-confirm` chama `api.installSala3D()`. (UX da progress bar tem bug LOW listado acima.)
- ✅ **Topbar**: `installer-version` (dinâmico via `api.version()`), `status-pill` (click quando `error` re-abre `modal-error` com `lastErrorPayload`), `btn-open-logs`, `btn-export-logs`.
- ✅ **#log-peek**: `lp-body`, `lp-hint`, `btn-log-peek-open` (abre modal-logs) — todos OK.
- ✅ **#step-sidebar**: `step-done-count`, `step-total-count`, `overall-fill`, `step-list` — `setStepState` e `refreshCounter` OK, sidebar persistente em preflight/progress/manual/error (v0.2.11+).
- ✅ **#screen-done**: `done-time-pill` (atualizado via `onComplete`), `done-checklist` (estático), `btn-open-interface`, `btn-install-sala3d`, `btn-close-installer`.
- ✅ **#toast-container**: criado dinamicamente via `toast()`.

### Contratos main.js ↔ wizard.js
- ✅ `onLog` → `{ts, level, message}` + `appendLog` aceita ambos `message` e `msg` (BUG 2 fix).
- ✅ `onStepUpdate` → `{stepId, state, progress?, etaSeconds?}` ✓.
- ✅ `onPreflight` → `{checkId, state, message}` ✓.
- ✅ `onManualPrompt` → top-level `{stepId, title, subtitle, action, fallback, commands, expected, note, steps, instructions}` ✓ (fix v0.2.15).
- ✅ `onError` → `{stepId, headline, what, suggestions, canRetry, canSkip, raw}` ✓.
- ✅ `onNeedsAdmin` → `{stepId}` ✓ (intercepta erro `NEEDS_ADMIN`).
- ✅ `onElevateTimeout` → `{elapsedMs, logFile}` ✓.
- ✅ `onComplete` → `{durationSeconds, sala3dInstalled}` ✓.
- ✅ `sudoPrompt` → `{id, prompt}` ✓; `sudoReply(id, password, cancelled)` ✓.
- ✅ Todos `api.installer.*` chamados pelo wizard estão expostos em `preload.js` E têm `safeHandle` em `main.js`.

### CSS visibility — análise de risco
- Apenas **1** regra explícita `[hidden]`: `.preflight-footer-hint[hidden]` (linha 820). Cobre o caso onde o elemento tem `display:flex` próprio que sobrescreveria o default do browser.
- **Risco identificado** (BLOCKER acima): `.elevate-status` tem `display:flex` (linha 2074) SEM regra `[hidden]`. **Mas o HTML inicial usa `class="hidden"`** — então o `[hidden]` attr nunca foi a defesa principal. O bug real é o duplo-mecanismo. Recomendo padronizar: **escolher um** (`.hidden` class OU `[hidden]` attr) e usar consistente.
- `.preflight-warnings` (linha 658) **NÃO** define `display:` — `[hidden]` browser-default funciona. ✓
- `.error-raw-wrap` (linha 1949) **NÃO** define `display:` — `[hidden]` funciona. ✓
- `.btn-manual-action` (linha 1176) **NÃO** define `display:` — botões são inline-block default, `[hidden]` funciona. ✓

---

## 4. RECOMENDAÇÃO PRÉ-RELEASE

1. **OBRIGATÓRIO antes de gerar v0.2.15.exe**:
   - Corrigir BLOCKER `#elevate-status` (1 linha de código).
   - Corrigir HIGH `describeStep()` IDs (5 chaves do objeto).
2. **Forte recomendação** (não bloqueia release mas merece fix):
   - Normalizar contrato `onScreen` (1 linha).
3. **Quando der**:
   - LOWs (sala3d progress, log component, modal-sudo double-fire).
4. **Princípio anti-recidiva** (pra Claudio): adotar **uma** convenção de visibilidade. Sugestão: **`.hidden` class** sempre, banir uso de `[hidden]` attr (ou vice-versa). Hoje convivem 3 padrões (`hidden` attr, `.hidden` class, `display:none` inline em `style="width:0%"` não, mas em outros lugares pode aparecer) e cada cruzamento é uma armadilha.

---

## 5. VEREDITO

🟡 **CONDITIONAL GO** — Lançar v0.2.15 **somente após** os 2 fixes (BLOCKER + HIGH `describeStep`). O BLOCKER do `#elevate-status` repete EXATAMENTE o padrão do bug do botão fantasma (duas fontes de verdade lutando pela visibilidade do mesmo elemento) — soltar sem corrigir é convite a outro live-test com JOs furioso. Os 2 HIGHs degradam UX em fluxos comuns (5 dos 17 passos sem descrição visível). LOWs podem ir pra v0.2.16.

**Coragem do diagnóstico**: o fix da v0.2.15 do botão fantasma só atacou UM elemento. O **padrão arquitetural** que causou o bug (visibilidade via mecanismos competindo) ainda está vivo em pelo menos `#elevate-status`. Sem corrigir o padrão, vai ter um v0.2.16 idêntico.

— Patrícia
