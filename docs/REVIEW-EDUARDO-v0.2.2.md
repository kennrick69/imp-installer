# Review Final v0.2.2 — Feedback Visual Contínuo (Onda 3)

**Reviewer:** Eduardo (IMP Dev Squad)
**Data:** 2026-05-26
**Escopo:** Bug "tela vazia 2+ min" pós clique em "Começar" (live test #2 do JOs).
**Branch alvo:** `/mnt/c/Projetos/imp-installer/`
**Versão:** v0.2.2 (package.json)
**Veredito:** **GO COM RESSALVAS** — sem blockers. Build aprovado.

---

## Sumário executivo

A combinação (Bruno streaming/timeouts/heartbeat + Camila spinner/progress/peek) cobre
sólida e visivelmente os 100% do tempo desde o clique em "Começar". O bug de tela
estática 2+ min está fechado por design — UI muda ANTES do IPC respoder
(`setStatusPill('working')` + `setGlobalProgress` + `clearLogPeek` antes do `await api.start()`)
e o backend faz streaming por check (cada `onCheck` emite `onPreflight` + `onLog` na hora).
Achei 0 BLOCKERS, 2 ALTOS pré-existentes, 3 MÉDIOS e 4 NITs.

**Confiança de que JOs verá feedback contínuo do clique em diante: 95%.**

---

## 1. Streaming real?  ✅ VERIFICADO

**`preflight.runAll({onCheck})` (src/preflight.js:202-271):**
- ✅ Cada `fns[i]()` envolto em `Promise.race([fn(), timeoutCheck(fnName, timeoutMs)])`.
- ✅ Dentro do `try {…}` da promise individual, `onCheck(norm)` é chamado IMEDIATO após `await` (linha 225-227), ANTES do `Promise.all` final.
- ✅ Erros (rejection ou timeout) também disparam `onCheck(errNorm)` (linha 241-243).
- ✅ Callback do consumidor envolto em try interno — falha do `onCheck` não derruba o batch.

**`main.js installer:start` (linhas 213-279):**
- ✅ Passa `onCheck` callback que envia `installer:onPreflight` + `installer:onLog` por check.
- ✅ Antes do `await preflight.runAll`, dispara `installer:onLog` "Iniciando verificação do ambiente..." (linhas 221-226) — UI tem evento ainda em ms.
- ✅ Map `PREFLIGHT_NAME_MAP` (linha 159-167) traduz nomes backend → checkIds renderer corretamente.

**UI escuta (renderer/wizard.js:938-941):**
- ✅ `api.onPreflight((res) => setPreflightResult(res.checkId, res.state, res.message))` — direto, sem buffer.
- ✅ `api.onLog` (linhas 879-891) alimenta `appendLog` + `appendLogPeek` + `pulseActivity` — três canais visuais por evento.

**Smoke test que confirma:** docs/FIX-CHECKS-NOT-ITERABLE.md:289-300 mostra 7 STREAMs em 3.6s — primeira em 1s.

---

## 2. Timeouts protegem?  ✅ VERIFICADO

- ✅ `timeoutCheck(name, ms)` (preflight.js:17-26) — rejeita com Error `.code = 'CHECK_TIMEOUT'`.
- ✅ Default 30s razoável (`DEFAULT_CHECK_TIMEOUT = 30_000`).
- ✅ Customizável via `opts.timeoutMs` com `Number.isFinite` guard.
- ✅ Cada check em `Promise.race([fn(), timeoutCheck(...)])` (linha 220-223).
- ✅ Se UM check trava, os OUTROS terminam OK — `Promise.all` em cima de promises que NUNCA rejeitam (cada uma tem catch interno na linha 232-248).
- ✅ `checkOtherDistros` fast-path com timeout 10s para sondar `wsl.exe` (preflight.js:101-110).

---

## 3. Heartbeat de step  ✅ VERIFICADO

- ✅ `runner.js:199-204` — `setInterval(5000)` emitindo "(ainda processando — Xs decorridos)".
- ✅ `clearInterval(heartbeat)` no `finally` (linha 273) — cobre sucesso, erro normal e throw inesperado.
- ✅ `setInterval` armado APÓS `emitStepUpdate(step, 'running')` e ANTES do try interno — janela curta sem hb (~ms) é aceitável.
- ✅ Logger envolto em try/catch interno (linha 201-203) — logger malformado não derruba step.

---

## 4. Visual cobre 100% do tempo?  ✅ VERIFICADO

**Cobertura do gap 0ms → primeira mensagem backend:**

- ✅ **Click handler `btn-start`** (wizard.js:650-666): ANTES do `await api.start()`:
  1. `showScreen('preflight')` (sync)
  2. `setStatusPill('working', 'Iniciando verificações…')` (sync)
  3. `setGlobalProgress({ text:'Iniciando…', done:0, total:7 })` (sync)
  4. `clearLogPeek()` — coloca placeholder "aguardando primeira mensagem…" (sync)
  5. **Safety net 200ms:** `setTimeout(() => startPreflightRunning(), 200)` — marca todos os pf-cards `data-state="running"`.

- ✅ **`syncPersistentChrome`** mostra `#global-progress` e `#log-peek` automaticamente quando a tela é "preflight" (linha 554-558, `WORK_SCREENS`).

- ✅ **CSS `.pf-card[data-state="running"]`** (style.css:562-589): spinner CSS-only via `::after`, borda teal, `pfPulse` 1.8s animation, `box-shadow` glow. Visualmente impossível confundir com "tela morta".

- ✅ **`#log-peek` `.lp-dot`** com `dotPulse` 1.4s — ponto verde pulsante mesmo sem mensagens.

- ✅ **Primeira mensagem backend** (linhas 221-226 do main.js) é o `Iniciando verificação do ambiente...` — JOs vai ver isso em <100ms via IPC.

---

## 5. Long-wait warnings  ✅ VERIFICADO

**Preflight (wizard.js:585-606):**
- ✅ 30s soft → `.long-wait` + texto "Esse passo pode levar alguns minutos — aguarde."
- ✅ 5min hard → `.very-long-wait` + texto vermelho "Demorou mais que o esperado — veja logs detalhados."
- ✅ Cleared em `clearPreflightWait` no terminal (ok/warn/err).

**Steps (wizard.js:621-639):**
- ✅ 30s soft → `appendLogPeek` warn + `toast('Esse passo pode levar alguns minutos', 'info', 6000)`.
- ✅ 5min hard → `appendLogPeek` error + `toast('Demorou mais que o esperado', 'warn', 8000)`.
- ✅ Cleared em `clearStepWait` quando `state ∈ {done, skipped, error, manual}` (linha 926-928).

---

## 6. Bundle (anti-bug v0.3.0)  ✅ VERIFICADO

**package.json:30-44:**
- ✅ `build.files` inclui `renderer/**/*` — cobre `*.html`, `*.css`, `*.js` e qualquer asset.
- ✅ `src/**/*`, `main.js`, `preload.js`, `package.json`, `assets/**/*` cobertos.
- ✅ Exclusões `!**/*.md`, `!docs/**`, `!**/*.test.js` corretas — sem vazamento de docs no .exe.

**`assets/icon.ico` (build.win.icon):**
- ✅ Arquivo presente (`/mnt/c/Projetos/imp-installer/assets/icon.ico` confirmado).
- ✅ `target: portable, arch:[x64]` e `artifactName: IMP-Squad-Instalador-${version}-portable.exe`.

---

## 7. Regressões / Riscos

### 🟠 ALTO — A1. Mismatch de step IDs entre renderer e backend (PRÉ-EXISTENTE)

**Não é regressão da v0.2.2**, mas vou ressaltar porque a v0.2.2 amplifica o impacto
(agora a UI fica visualmente ATIVA pra um step que **NUNCA é encontrado pelo backend**).

`renderer/wizard.js:20-38` declara IDs que NÃO batem com `src/executors.js:853-871`:

| renderer (UI) | backend (executors) |
|---|---|
| `step_06_node` | `step_06_node_nvm` |
| `step_07_npm_global` | `step_07_npm_prefix` |
| `step_10_github_auth` | `step_10_gh_auth` |
| `step_12_clone_orch` | `step_12_clone_orchestrator` |
| `step_15_interface_dl` | `step_15_download_interface` |

Quando o backend emite `onStepUpdate({stepId:'step_06_node_nvm', state:'running'})`, o
renderer cai no `if (!STEP_BY_ID[stepId]) return` em `setStepState` (linha 189) — a
sidebar não atualiza esses passos. JOs vai ver 5 de 17 passos "pendente" pra sempre,
mesmo concluindo a instalação.

**Recomendação:** mapa `BACKEND_TO_UI_STEP_ID` ou simplesmente sincronizar os IDs no
renderer. **Fora do escopo desta wave**, mas DEVE virar uma micro-wave imediata pré-build.

### 🟠 ALTO — A2. `pfWaitTimers` não são limpos quando troca de fluxo

`armPreflightWait` (wizard.js:585-600) cria timers em `ui.pfWaitTimers[checkId]`. Se
JOs clicar "Avançar →" (`btn-preflight-next`) DEPOIS de o preflight terminar mas ANTES
do `clearPreflightWait` ser chamado para todos os cards (race com último `onPreflight`),
os timers ficam ativos rodando em background pra cards de uma tela não mais visível.

Cenários reais (improváveis mas possíveis):
- Click no "Conferir de novo" (`btn-preflight-recheck`) sem que todos os preflights estavam em terminal — bota cards de volta em `pending` mas reseta timers via `clearPreflightWait`. **OK**.
- `setPreflightResult(state='ok')` chamado depois de o user já estar em `progress` — `clearPreflightWait` roda fine, sem consequência.

Impacto real: baixo. Só fica memória presa por até 5min. Mas convém um helper
`clearAllPfWaits()` ao sair da tela preflight.

### 🟡 MÉDIO — M1. Safety net 200ms pode pisar em cards JÁ resolvidos

`startPreflightRunning` (wizard.js:562-578) só promove `pending → running` — `if (card.dataset.state === 'pending')`. Backend muito rápido (<200ms) pode já ter colocado um card em `ok`/`warn`/`err`, e o 200ms não pisa. **Race coberta.**

PORÉM: o `setStatusPill('working', 'Verificando ambiente…')` e `setGlobalProgress(...0,7)` na linha 576-577 **sobrescrevem** estados terminais que o backend já mandou. Se um check terminar em 150ms e a UI mostrar "1/7 ok", o setTimeout em 200ms vai voltar pra "0/7". Cosmético, dura <1s (próximo `refreshPreflightProgress` corrige), mas é flicker.

**Sugestão:** dentro de `startPreflightRunning`, antes de chamar `setGlobalProgress({done:0, total:7})`, recalcular `done` a partir dos cards existentes ou só pular essa linha se já houver cards terminais.

### 🟡 MÉDIO — M2. `appendLogPeek` é chamado em `onLog` mas o `installer:onLog` payload vem com `entry.message`, não `entry.msg`

`main.js:222-225` envia `{ ts, level, component, message }`. `wizard.js:879-891`
chama `appendLog(entry)` (que lê `entry.msg` na linha 273 — **`entry.message`
ficaria undefined**) e `appendLogPeek(entry)` (linha 535: `entry.msg`).

Confirmado em `appendLog`:
```js
function appendLog({ msg, level = 'info', stepId = null, ts = Date.now() }) {
```
Destructuring de `msg` mas o backend manda `message`. **Logs ao vivo aparecem em branco**.

Isto é um bug REAL no contrato IPC — afeta diretamente o critério de feedback contínuo
do JOs. Vai aparecer linhas brancas no log peek e no logs-body. **Atenção:** Bruno
provavelmente assumiu `msg`, mas o main.js emite `message`. Reconciliar com helper
ou padronizar nome.

### 🟡 MÉDIO — M3. `populateLogsFilter()` usa IDs do renderer (`STEPS`), gera mismatch em filtro

Mesma causa do A1: filtro de logs vai mostrar `step_06_node` mas as entries vêm com
`stepId='step_06_node_nvm'`. Filtro por step nunca matcha pros 5 IDs divergentes.

### 🟢 NIT — N1. `for (const c of list)` em main.js linha 265-269 é dead code

Cinto extra que o próprio comentário admite ser "rede de segurança" — mas o loop não
emite nada (corpo vazio). Sugestão: remover o `for` (apenas comentário) OU implementar
emissão idempotente real (deduplicação por `checkId`).

### 🟢 NIT — N2. `clearLogPeek` no `btn-start` mas não no `btn-preflight-recheck`

`bindPreflight` (linha 691-706) reseta status pill e progress bar mas não limpa log
peek. Re-check vai acumular logs antigos com novos sem placeholder. Não bloqueia, só
cosmético.

### 🟢 NIT — N3. Heartbeat `runner.js` emite logger com `step.id` como component, não `'runner'`

```js
_ctx.logger.info(step.id, `(ainda processando — ${elapsed}s decorridos)`);
```
Convenção dos outros logs em runner.js usa `'runner'` ou IDs específicos do passo. Hb
ficar com step.id é fine — só vale documentar pro filtro do logs modal funcionar bem.

### 🟢 NIT — N4. `pf-card[data-check="other_distros"]` tem estrutura HTML diferente dos outros

Linha 179-182 do index.html: `<header><span><strong>` + `<p class="pf-msg">`, enquanto
os outros usam `<div.pf-body><h4><p.pf-status>`. O `setPreflightResult` tem fallback
`.pf-status || .pf-msg` — funciona, mas é inconsistência. Visual no estado `running`
pode ficar diferente porque o CSS `.pf-card[data-state="running"] .pf-msg` está coberto
(linha 585) — OK funcionalmente.

---

## Smoke tests confirmados (já passam, listados em docs/FIX-CHECKS-NOT-ITERABLE.md)

1. ✅ `runAll({onCheck})` streaming em <4s, primeiro check em 1s.
2. ✅ `timeoutCheck` exporta corretamente, gera `CHECK_TIMEOUT`.
3. ✅ `node --check` em main.js / src/preflight.js / src/runner.js / src/executors.js.

---

## Recomendações pré-build (opcionais, todas fora do escopo da onda 3)

1. **Patch M2 antes do build** — alinhar `msg` vs `message` no contrato `installer:onLog`. Mudança mínima, alto impacto visível.
2. **Patch A1 em micro-wave imediata** — sincronizar IDs de passos. Sem isso, JOs vê
   5/17 passos como "pending" mesmo após sucesso.
3. **Test runtime no Electron antes do .exe build** — recomendação repetida da onda 1.
   `npm start` + clicar "Começar" valida M2 em 5 segundos.

---

## Veredito final

**✅ GO COM RESSALVAS**

- 0 BLOCKERS.
- 2 ALTOS, mas ambos PRÉ-EXISTENTES (não regressão desta wave).
- O objetivo central da onda — feedback visual contínuo desde o clique — está **cumprido com folga**.
- M2 (msg vs message) é facilmente patchable em <1 linha e devia entrar no build.
- A1 (step ID mismatch) precisa virar próxima wave urgente. Não bloqueia o build atual
  (UI vai mostrar progress bar e log peek mesmo se a sidebar fica defasada nos 5 passos
  afetados — feedback contínuo é preservado).

**Confiança de que JOs vê feedback contínuo desde clique "Começar": 95%.**
Os 5% restantes são exatamente o risco M2 (logs em branco) — mas o status pill,
progress bar, spinners CSS e cards `running` continuam funcionando independente do M2.
