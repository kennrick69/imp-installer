# REVIEW EDUARDO — v0.2.3

**Reviewer:** Eduardo (revisor IMP Dev Squad)
**Data:** 2026-05-26
**Escopo:** `/mnt/c/Projetos/imp-installer/` único — fixes dos 3 bugs do live test #3 (PC sem WSL)
**Versão alvo:** `0.2.3` (package.json confirmado)

---

## Sumário executivo

Os 3 fixes pegam **a causa raiz, não o sintoma**. Bruno acertou em reclassificar a matriz de blockers (era erro de design, não bug isolado), Camila acertou em separar o modal-error do modal-logs (eram conceitos diferentes empilhados). O texto humano dos erros é especificamente bom — JOs vai entender em vez de só ver stack trace.

A v0.2.3 está **operacionalmente segura pra liberar pré-release** pro live test #4. Não encontrei BLOCKER. Há 1 MÉDIO e 4 NITs que podem ficar pra v0.2.4 ou serem aceitos como tech debt consciente.

### Veredito: **GO COM RESSALVAS** (NITs documentados)

---

## 1. BUG 1 — Bloqueantes reclassificados (Bruno)

**Arquivos analisados:**
- `src/preflight.js` (matriz, `checkAdmin`, `checkVirtualization`, `checkOtherDistros`, `runAll`, `blockerMessage`, `buildBlockingErrorPayload`)
- `main.js` (handler `installer:start`, emissão de `onError` em blocker)

### Critérios

#### 1.1 Matriz declarada bate com o código?

🟢 **SIM**. Comentário das linhas 5–31 declara o contrato: só `windows_build`/`disk_c_free_gb`/`internet_github` são blockers reais; tudo mais é `ok:true` (com ou sem `warning`). O código respeita 1-pra-1:

| check | linha | shape |
|---|---|---|
| `checkAdmin` | 76–85 | `ok:true, warning:!isAdmin` ✓ |
| `checkVirtualization` | 129–138 | `ok:true, warning:!enabled` ✓ |
| `checkOtherDistros` (sem WSL) | 156–161 | `ok:true, warning:true` ✓ |
| `checkOtherDistros` (probe falhou) | 165–172 | `ok:true, warning:true` ✓ |
| `checkOtherDistros` (no distros) | 185–192 | `ok:true, warning:true` ✓ |
| `checkOtherDistros` (parse incerto) | 201–209 | `ok:true, warning:true` ✓ |
| `checkOtherDistros` (Ubuntu OK) | 210–219 | `ok:true, warning:false` ✓ |
| `checkOtherDistros` (não-Ubuntu) | 213–219 | `ok:true, warning:true` ✓ |
| `checkOtherDistros` (exceção) | 220–228 | `ok:true, warning:true` ✓ |
| `checkAntivirus` | 240–246 | `ok:true` em todo caminho ✓ |

#### 1.2 `runAll` calcula `blocking` corretamente?

🟢 **SIM**. Linha 343: `blocking = results.filter(r => !r.ok && !r.warning)`. Pelo contrato declarado, isso só pode capturar `windows_build`/`disk_c_free_gb`/`internet_github` quando falham. Validado por exaustão da matriz acima.

`pre.ok = blocking.length === 0` (linha 346) — consistente.

#### 1.3 `installer:start` emite `onError` humano?

🟢 **SIM**. `main.js` 281–291: se `blocking.length > 0`, monta payload via `preflight.buildBlockingErrorPayload(blocking)` e emite `installer:onError` ANTES de retornar `{ok:false}`. Payload inclui `stepId:'step_00_preflight'`, `headline`, `what`, `suggestions[]` (com mensagem específica por check via `blockerMessage`), `canRetry:true`, `canSkip:false`, `raw`.

🟢 As mensagens em `blockerMessage` (linhas 360–369) são humanas e acionáveis (build do Windows, GB livre, github.com:443).

---

## 2. BUG 2 — Log undefined (Camila)

**Arquivo analisado:** `renderer/wizard.js`

### Critérios

#### 2.1 `appendLog` normaliza `entry.message ?? entry.msg`?

🟢 **SIM**. Linha 271: `const msg = (entry.message != null ? entry.message : entry.msg) || '';`. Equivalente funcional a `??` (trata `null`/`undefined`). String vazia como fallback final, nunca grava `undefined` no DOM.

#### 2.2 Buffer guarda string real?

🟢 **SIM**. Linha 276: `ui.logBuffer.push({ ts, level, stepId, msg })`. Sempre normalizado.

#### 2.3 Modal de logs renderiza texto?

🟢 **SIM**. `refreshLogsModal` linha 340: `text = (e.message != null ? e.message : e.msg) || ''`. Defensivo duplo (já que buffer só grava `msg`, mas se algo entrar pelo `onState` ou similar, ainda fica protegido).

#### 2.4 `appendLogPeek` também normaliza?

🟢 **SIM**. Linhas 577 e 589: `(entry.message || entry.msg) || ''`. Consistente.

---

## 3. BUG 3 — Modal-error separado (Camila)

**Arquivos analisados:** `renderer/index.html`, `renderer/wizard.js`, `renderer/style.css`

### Critérios

#### 3.1 `#modal-error` existe e tem todos os campos?

🟢 **SIM**. `index.html` 479–504. Campos esperados:

| campo | id | linha |
|---|---|---|
| título do modal | `#error-modal-title` | 482 |
| headline | `#error-headline-text` | 488 |
| what | `#error-what-text` | 490 |
| suggestions ul | `#error-suggestions-list` | 492 |
| raw wrap (details) | `.error-raw-wrap` | 493 |
| raw pre | `#error-raw-pre` | 495 |
| skip button | `#btn-error-skip` | 499 |
| logs button | `#btn-error-logs` | 500 |
| retry button | `#btn-error-retry` | 501 |
| close X | `[data-close-modal="modal-error"]` | 483 |

#### 3.2 `showErrorModal(payload)` mapeia todos os campos?

🟢 **SIM** (wizard.js 435–489). Destructuring com defaults em 436–444:
- `headline` cai pra "Travei no passo NN" ou "Algo deu errado" se ausente
- `suggestions=[]` cai pra `['Tentar de novo — às vezes é só rede instável.']` se vazio
- `raw` esconde `.error-raw-wrap` se vazio (`hidden=true`)
- `canSkip` controla visibilidade do botão skip (linha 474)
- `canRetry` controla visibilidade do botão retry (linha 475)
- `stepId` vai pros `dataset.stepId` dos botões (476–477)

#### 3.3 `api.onError(...)` chama `showErrorModal` (não `openModal('modal-logs')`)?

🟢 **SIM**. Linha 1011–1019:
```js
api.onError((payload) => {
  setStatusPill('error', label);
  showErrorModal(payload || {});
});
```

#### 3.4 Status-pill click vai pro modal-error quando state=error?

🟢 **SIM**. Linhas 524–533: filtra `pill.dataset.state !== 'error'` (linha 526). Se há `lastErrorPayload`, abre modal-error; senão fallback pra `openLogsModal()` (defesa em profundidade).

Camada extra: `setStatusPill` linha 520 desabilita `pointerEvents` quando state ≠ 'error'. **2 guards independentes** — não dispara em idle/working/success.

#### 3.5 Botões funcionam?

🟢 **Retry** (843–857): pega `stepId` do `dataset`, fecha modal, chama `api.retry(stepId)` ou `api.start()` se sem stepId (caso preflight). Defensivo.

🟢 **Skip** (859–870): só visível se `canSkip:true` (escondido por padrão). Chama `api.skip(stepId, 'usuário ignorou bloqueante')`. Marca `setStepState(stepId, 'skipped')` local.

🟢 **Logs** (872–875): `closeModal('modal-error')` + `openLogsModal()`. Limpo.

#### 3.6 CSS

🟢 **OK**. `style.css` 1473–1574: `.modal.modal-error` herda do `.modal` base com borda vermelha (`var(--err)`), headline-box com ícone redondo, suggestions estilizadas com seta `→`, raw colapsável. Consistente com o resto do design system.

---

## 4. Bundle (`build.files`)

🟢 **OK**. `package.json` 30–44:
```
"files": [
  "main.js", "preload.js", "package.json",
  "src/**/*", "renderer/**/*", "assets/**/*",
  "!**/*.log", ..., "!docs/**"
]
```

- `renderer/**/*` cobre o novo HTML/CSS/JS dos modais
- `src/**/*` cobre `preflight.js` atualizado
- `main.js` está explícito
- `!docs/**` exclui nosso review (correto — não vai no .exe)

🟡 **MÉDIO #1**: `asar:check` script (linha 15) usa `grep -E` — em Windows nativo (PowerShell) sem WSL, `grep` não existe. JOs vai rodar `npm run asar:check`? Provavelmente não. Mas Claudio sim, e ele tá no WSL. Aceitável.

⚠️ **NÃO RODEI `asar list`** (Claudio rodará pré-release). Confirmação obrigatória do checklist:
- [ ] `renderer/index.html` contém `id="modal-error"`
- [ ] `renderer/wizard.js` contém `function showErrorModal`
- [ ] `renderer/style.css` contém `.modal.modal-error`
- [ ] `src/preflight.js` contém `buildBlockingErrorPayload`

---

## 5. Regressões possíveis

### 5.1 Shape do buffer mudou?

🟢 **NÃO HÁ REGRESSÃO**. Antes o buffer guardava `{ts, level, stepId, msg}`. Continua guardando `{ts, level, stepId, msg}`. O fix foi na ENTRADA (aceita `message` OU `msg`), não na ESTRUTURA INTERNA. `refreshLogsModal` lê `e.message ?? e.msg` defensivamente, mas como o buffer só grava `msg`, o caminho normal é `e.msg`. Outros consumidores: nenhum lê do buffer fora de `refreshLogsModal`.

### 5.2 Alguém referencia `screen-error` legacy?

🟢 **NÃO**. `grep -rn "screen-error"` no projeto inteiro retornou ZERO matches fora do REVIEW. Removido limpo. Comentário no HTML 295–298 documenta a substituição. ✓

### 5.3 Status-pill click acidental quando state ≠ error?

🟢 **DUPLA PROTEÇÃO**:
1. Listener: `if (!pill || pill.dataset.state !== 'error') return;` (linha 526)
2. CSS via JS: `pill.style.pointerEvents = state === 'error' ? 'auto' : 'none';` (linha 520)

Não dispara em idle/working/success. ✓

### 5.4 `setConnection('ok')` (sem label) cobre limpeza do `state-err`?

🟢 **SIM**. Linha 497: `pill.classList.remove('state-paused', 'state-err')` sempre roda. Depois só adiciona `state-paused`/`state-err` se for paused/err. Label cai pro fallback "Trabalhando…" se omitido. ✓

### 5.5 Modal-error sobreposto a tela de progresso preserva contexto?

🟢 **SIM**. `openModal` (linha 148) só remove `.hidden` do overlay. Não toca em `.screen.active`. Quando user clica retry/skip/fechar, a tela embaixo continua visível. Bom UX. ✓

### 5.6 Erro de preflight tem `stepId='step_00_preflight'`, então `setStepState` é chamado e marca o passo 0 como `error` na sidebar — esperado?

🟢 **OK**. Linha 483–485 do wizard:
```js
if (stepId && STEP_BY_ID[stepId]) setStepState(stepId, 'error');
```
`step_00_preflight` está em `STEPS` (linha 21), então a sidebar (se já estiver renderizada) vai mostrar passo 00 em vermelho. Coerente com o que aconteceu. Não bloqueia o user (preflight é a tela ativa, sidebar não está visível ainda).

### 5.7 `lastErrorPayload` nunca limpa após retry-sucesso?

🟡 **NIT #1**: Se retry resolve e instalação avança, `ui.lastErrorPayload` continua apontando pro erro antigo. Se depois o user clica no status-pill por algum motivo (mas agora ele está em 'working'/'success', pointerEvents=none), nada acontece. **Defesa em camadas já cobre.** Mas idealmente, no `onStepUpdate` quando `state === 'running'` ou no `onComplete`, dar `ui.lastErrorPayload = null`. Não-blocker.

---

## 6. Achados extras (fora dos 3 bugs)

### 🟡 MÉDIO #1: `gp-count` hardcoded "0/7" no HTML

`index.html` linha 45: `<span id="gp-count" class="gp-count">0/7</span>`. Coincidentemente são 7 checks de preflight (após a matriz Bruno), então funciona. Mas se Bruno adicionar um check (ex.: `checkRamGb`), o HTML ainda mostraria "0/7" inicial até primeiro `setGlobalProgress`. Cosmético, sub-segundo. Vale trocar pra "—" ou "0/0" pra ser auto-discoverable.

### 🟢 NIT #2: `pf-card` `other_distros` tem markup DIFERENTE dos outros 6

`index.html` 179–182 usa `<header>` interno + `.pf-msg`, enquanto outros 6 cards usam `.pf-body` + `.pf-status`. `setPreflightResult` linha 354 tenta `'.pf-status'` E fallback `'.pf-msg'`, então funciona. Mas é inconsistência visual potencial — Camila pode normalizar na v0.2.4.

### 🟢 NIT #3: `data-check="windows"` no HTML, `data-check="windows_build"` esperado pelo backend

🟢 Mapeado corretamente em `main.js` 159–167 (`PREFLIGHT_NAME_MAP`). Funciona. Mantenho como NIT porque é divergência entre nome backend e nome UI — pegadinha se alguém adicionar check novo e esquecer do map.

### 🟢 NIT #4: `start.js` chamado de `start` no listener mas botão pode ser clicado 2x

`bindWelcome` linha 703: clique no `#btn-start` chama `api.start()` async. Se user clica 2x rápido (antes do `disabled` virar), 2 requests vão. `safeHandle` em main.js engole erros, mas `runner.startWizard` pode duplicar. Aceitável — `app.requestSingleInstanceLock` cobre o caso macro. NIT porque o `btn-start` não vira `disabled` durante a transição.

---

## 7. Confiança no cenário JOs PC sem WSL

**Cenário:** JOs baixa `IMP-Squad-Instalador-0.2.3-portable.exe`, duplo-clique sem "Executar como administrador". PC novo, sem WSL, virtualização do BIOS provavelmente ligada (Windows 11 já vem assim).

**Fluxo esperado:**
1. Splash → tela welcome → marca consent → clica "Começar instalação"
2. Vai pra tela preflight, status-pill: "Iniciando verificações…"
3. Backend streama 7 onPreflight + 7 onLog
4. `checkAdmin`: warning (não é admin) → card amarelo, NÃO bloqueia ✓
5. `checkVirtualization`: provavelmente OK → verde
6. `checkOtherDistros`: warning "WSL ausente — vou instalar no Passo 3" → amarelo, NÃO bloqueia ✓
7. `checkAntivirus`: provavelmente Defender → verde (não warning)
8. `windows_build` + `disk` + `internet`: OK → verde
9. `blocking.length === 0` → `pre.ok = true` → handler retorna `{ok:true}` ao renderer
10. UI: status-pill "Ambiente pronto" (success), botão "Avançar →" habilitado
11. JOs clica "Avançar →" → `showScreen('progress')` → Passo 1 começa

**Não trava** porque:
- `checkAdmin` não bloqueia mais ✓
- `checkOtherDistros` (sem WSL) não bloqueia mais ✓
- `checkVirtualization` (se falso-negativo) não bloqueia mais ✓
- Mesmo se 1 dos 3 blockers REAIS aparecer, modal-error humano explica o que fazer

### **Confiança: 92%**

Pontos de risco residual (8%):
- 3% — `wsl -l -v` em WSL desabilitado no firmware pode demorar 30s mesmo com fast-path probe (raro mas existe). Mitigação: timeout de 30s já está.
- 2% — internet flutuante no momento exato do `checkInternet`. Mitigação: retry no modal-error funciona.
- 2% — JOs num Windows muito antigo (build < 19041). Modal-error é claro mas é blocker real, não tem como contornar.
- 1% — bugs não previstos no executor do passo 1 (fora do escopo desta review).

---

## VEREDITO FINAL: **GO COM RESSALVAS**

- **Blockers (🔴):** 0
- **Altos (🟠):** 0
- **Médios (🟡):** 1 (gp-count hardcoded — cosmético)
- **NITs (🟢):** 4 (lastErrorPayload cleanup, markup inconsistente, naming map, dupla-clique start)

**Pode liberar pré-release pro live test #4 do JOs.** Os 3 bugs do live test #3 estão fechados na causa raiz. O instalador agora trata "PC zerado sem WSL" como caminho esperado, não como erro. Mensagens humanas substituíram tracebacks. Status-pill e modal-error estão semanticamente distintos.

— Eduardo
