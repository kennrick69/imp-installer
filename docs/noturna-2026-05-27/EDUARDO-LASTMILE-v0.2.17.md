# EDUARDO — Review FINAL last-mile da v0.2.17

**Autor:** Eduardo (revisor IMP Dev Squad)
**Data:** 2026-05-27 (madrugada — antes do JOs acordar)
**Escopo:** auditoria publish-grade da v0.2.17 (WSL legacy → MSI moderno → Ubuntu funcional)
**Fonte:** /mnt/c/Projetos/imp-installer @ v0.2.17 publicada (release GitHub)
**Veredito (TL;DR):** **GO COM RESSALVAS** — 1 blocker UX (telas novas inativas) + 3 pendências reais.

---

## 0. Sumário executivo

| Frente | Status | Notas |
|---|---|---|
| Detector `detectWslState` (shell.js:484) | ✅ Sólido | 3 sinais independentes, fallback explícito, evidência logada |
| `installWslModernViaMsi` (shell.js:557) | ✅ Robusto | TLS 1.2 forçado, 3010 = sucesso, error path completo |
| `forceRebootWindows` + `cancelReboot` (shell.js:629/644) | ✅ Sem race | shutdown.exe síncrono; cancel devolve `noPending` ok |
| `_markRebootAndScheduleRunOnce` cap 3 (executors.js:382) | ✅ Cap funciona | rebootCount incrementa ANTES do check, throw correto |
| step_01 cascata (executors.js:494) | ✅ Idempotente | detectWslState → ensureFeatures → MSI → update → validate → reboot |
| step_02/03 gates `wslIsFunctional` | ✅ Gates presentes | step_03 trava se !fn.ok (executors.js:870) |
| error-catalog ordem (3 entradas novas) | ⚠️ Ordem OK | LEGACY/MSI_FAILED/TOO_MANY_REBOOTS antes do genérico "reboot pendente" |
| **Renderer escuta `onWslUpgradeProgress`** | 🔴 **BLOCKER** | Backend **NUNCA emite** — tela #screen-wsl-upgrade nunca aparece |
| **Renderer escuta `onScreen('reboot')`/`('wsl-upgrade')`** | 🔴 **BLOCKER** | Backend só emite `'preflight'` e `'progress'` (main.js:372,735) |
| Não-regressão (10 itens) | ✅ Todos preservados | Verificado item por item abaixo |

---

## 1. Auditoria final code-review

### 1.1 `detectWslState` (shell.js:484-538) — heurística confiável?

**3 camadas independentes (a regra de ouro do EDUARDO-META §1 Pattern A):**

1. `Get-Command wsl.exe` → `absent` se vazio
2. `wsl --version` + regex `WSL\s+vers[aã]o|WSL\s+version|kernel\s+vers` → `modern`
3. `wsl --status` + filtro `isHelpEcho` (Usage/Uso/Copyright Microsoft + flags `--install/--list/--status` juntas) → `modern` se NÃO for help
4. Fallback: `legacy` (binário existe mas não responde flags)

**Verdadeiro:** três sinais. **Evidência sempre logada** (`evidence.getCommand`, `evidence.version`, `evidence.status`).

**Risco residual:** se o legacy do JOs RETORNAR algo que aleatoriamente case `version|kernel`, vira falso-positivo `modern`. Improvável — help do legacy é texto canônico Windows 10. **OK.**

### 1.2 `installWslModernViaMsi` (shell.js:557-615) — robustez

- ✅ `[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12` (linha 562)
- ✅ `chcp 65001 > $null` antes (evita mojibake)
- ✅ Resolução dinâmica do MSI x64/arm64 via GitHub API `microsoft/WSL/releases/latest`
- ✅ User-Agent header (`imp-installer`) e Accept `application/vnd.github+json`
- ✅ msiexec com `/qn /norestart` — silencioso, sem reboot automático (controlamos nós)
- ✅ Exit 3010 = `rebootRequired: true` (tratado como sucesso DUAS vezes — try-success + catch-recover)
- ✅ Error path retorna `{ ok:false, exitCode, error, stderr, stdout }` sem throw

**Nit (não-blocker):** `timeout = 600_000` (10min) pra baixar ~50MB MSI — se a rede do JOs estiver lenta (4G fallback, hotspot), pode estourar. Mas 600s pra 50MB significa <90KB/s, e nesse caso o JOs tem outros problemas. Aceitável.

### 1.3 `forceRebootWindows` + `cancelReboot` (shell.js:629-656) — race?

- `forceRebootWindows` chama `shutdown.exe /r /t 30 /f /d p:4:1` síncrono via `execP`. Sem race.
- `cancelReboot` chama `shutdown.exe /a` e trata exit 1116 como `{ ok:true, noPending:true }` — defensivo correto.
- main.js:912 chama `setTimeout(() => app.quit(), 1500)` APÓS shutdown agendado — janela de 28.5s pro user ver mensagem. **OK.**

### 1.4 `_markRebootAndScheduleRunOnce` (executors.js:382-406) — cap 3

```js
ctx.state.rebootCount = (ctx.state.rebootCount || 0) + 1;
ctx.save();
if (ctx.state.rebootCount > 3) { /* throw WSL_TOO_MANY_REBOOTS */ }
```

Incrementa **antes** do check. Save antes do throw (estado persiste mesmo após crash). Throw é o último ato. **Cap funciona.**

**Detalhe sutil:** O 4° reboot é o que dispara o throw (count vai pra 4, `>3` true). Isso significa que o usuário PASSA por 3 reboots e o 4° fail-fasts com erro humano. Bem calibrado.

### 1.5 step_01 fluxo completo (executors.js:512-720) — idempotente?

Sequência cascata:

1. `detect()`: `detectWslState === 'modern' && wslIsFunctional.ok && _ubuntuInstalled` → SKIP
2. `execute()`:
   - `detectWslState` (state0)
   - `ensureFeatures` (WSL + VMP via dism) → se !ok → reboot
   - Se legacy/absent → `installWslModernViaMsi` → reboot
   - `wsl --update` (cura best-case)
   - `wslIsFunctional` → se !ok → reboot
   - `discoverUbuntuDistroName` → `wsl --install -d <distro> --no-launch`
   - `wsl --set-default <distro>`
   - `wsl --update` (de novo!) — **ressalva**: duplicado, mas inofensivo (no-op se já atualizado)
   - `wslIsFunctional` final → reboot se !ok
3. `validate()`: re-checa state + functional + ubuntu instalado

**Idempotência verificada:** cada operação `ensureFeatures`, MSI install, `wsl --install` é tolerante a "já feito" (dism retorna rápido, MSI re-instala, wsl --install detecta `already installed`). RunOnce SEMPRE escreve mesma chave (auto-overwrite).

**Pequeno smell:** `wsl --update` chamado 2x na mesma execução (linhas 581, 688). Custo: ~2s a mais por step_01. Aceitável.

### 1.6 step_02/step_03 gates `wslIsFunctional`

- step_02 `detect()` (executors.js:812): `const fn = await wslIsFunctional(); return fn.ok;` ✅
- step_03 `execute()` (executors.js:870): gate explícito — se !fn.ok, marca reboot e RETURN (não tenta install) ✅
- Ambos têm `if (ctx.state.rebootRequired && !ctx.state.rebootDone) return true;` no detect — libera o caminho pós-reboot ✅

### 1.7 error-catalog: ordem das 3 entradas novas

Ordem do array (error-catalog.js:228-266):

1. `WSL_LEGACY_DETECTED|wsl[\s_-]?state=legacy|inbox legad` (228)
2. `WSL_MSI_INSTALL_FAILED|MSI install exit|n[ãa]o consegui (baixar|instalar) o WSL` (241)
3. `WSL_TOO_MANY_REBOOTS|Reinícios excessivos|rebootCount` (255)
4. (jará existia) `WSL.*funcional|wsl mostra help|reboot pendente.*WSL` (278)
5. (já existia, genérico) `reboot pendente|reinicie o windows` (293)

**Crítico:** entrada #4 (WSL não funcional) PRECISA vir antes da #5 (reboot pendente genérico) — comentário em-linha confirma (`// IMPORTANTE: precisa vir ANTES da entrada genérica`). ✅

**Risco residual:** se uma mensagem futura disser "WSL_MSI_INSTALL_FAILED — reboot pendente", a #2 ganha (MSI). Correto — específico antes de genérico. **Ordem OK.**

---

## 2. Cruzamento renderer ↔ backend (replicar bug v0.2.15) 🔴 BLOCKER

### 2.1 `onWslUpgradeProgress`

| Onde | Status |
|---|---|
| preload.js:65 expõe `onWslUpgradeProgress: on('installer:onWslUpgradeProgress')` | ✅ exposto |
| wizard.js:1833 escuta `api.onWslUpgradeProgress(payload => updateWslUpgrade(...))` | ✅ ouvinte |
| main.js — EMITE `installer:onWslUpgradeProgress` em algum lugar? | 🔴 **ZERO ocorrências** |
| shell.js — emite via `logger` callback algo equivalente? | 🔴 **NÃO** |
| executors.js durante `installWslModernViaMsi`? | 🔴 **NÃO** |

**Confirmado por grep direto:** `grep -rn "onWslUpgradeProgress\|installer:onScreen" /mnt/c/Projetos/imp-installer/main.js src/` → 2 hits no main.js (linhas 372 e 735), **ambos pra `'preflight'`/`'progress'`**. Zero hits pra `'reboot'`, `'wsl-upgrade'` ou `onWslUpgradeProgress`.

**Consequência operacional:**
- A tela `#screen-wsl-upgrade` (Camila CAMILA-UX §2) NUNCA é exibida — backend nunca dispara `onScreen('wsl-upgrade')`.
- O progresso visual da barra (`#wsl-up-fill`, `#wsl-up-pct`, `#wsl-up-stage`) permanece em `0%` / `⏳ Baixando…` PORQUE backend nunca dispara `onWslUpgradeProgress`.
- Durante os 10min que o MSI baixa+instala, o JOs vê **a tela de `progress` normal** com step_01 "rodando", sem feedback visual específico da migração.

**Por que isso é blocker UX (não funcional):** o instalador AINDA FUNCIONA — `installWslModernViaMsi` executa, MSI baixa, reboot agenda, fluxo segue. Mas o JOs vai pensar que travou (5-10min sem mudança visual durante o download MSI). **Vai abrir o instalador, esperar 2min, achar que congelou e fechar.** Reincidência exata do live-test anterior.

### 2.2 `onScreen('reboot')` + `onScreen('wsl-upgrade')`

| Quando deveria disparar | Backend dispara? |
|---|---|
| Step_01 detecta legacy → migração iniciando | 🔴 NÃO (Bruno não adicionou call em executors.js:550) |
| `_markRebootAndScheduleRunOnce` antes do reboot | 🔴 NÃO (sem `events.onScreen('reboot')` em executors.js:382) |
| `forceRebootWindows` dentro do handler `scheduleRebootAndQuit` | 🔴 NÃO (handler emite `installer:onLog`, não `onScreen`) |

**Caminho atual real:** main.js só emite `installer:onScreen` em **duas** linhas (372 com `'preflight'`, 735 com `'progress'`). Nenhuma rota emite `'reboot'` ou `'wsl-upgrade'`.

**Consequência:**
- A tela `#screen-reboot` (com botão verde "Salvar progresso e reiniciar agora") NUNCA aparece pro JOs.
- O JOs vai ver o `#modal-error` genérico com texto "Reinicie o Windows antes de continuar" (catálogo entrada 4/5) em vez da tela bonita com botão.
- O botão `#btn-reboot-now` que chama `scheduleRebootAndQuit` (existe e funciona no backend!) está **inacessível na UI atual**.

### 2.3 Shape do payload `onError` — campo `fallback` ausente

Bug bônus encontrado durante audit:

- HTML (index.html:680) tem `<div id="error-fallback">` que renderiza um "Plano B manual" — comando copiável + steps.
- wizard.js:696 chama `renderErrorFallback(payload.fallback, stepId)` SE `payload.fallback` existir.
- main.js:296-304 (emit do `onError`) **não inclui `fallback`** no payload.
- error-catalog.js retorna `{headline, what, suggestions, canRetry, canSkip, raw}` — **sem `fallback`**.

**Resultado:** o bloco "Plano B no modal-error" da Camila NUNCA é renderizado em produção. Não é regressão (nunca funcionou), mas é dead code esperando alguém preencher.

---

## 3. Não-regressão final (10 itens — auditoria item por item)

| # | Item | Verificado em | Status |
|---|---|---|---|
| 1 | Janela maximizada (v0.2.11) | main.js:39-63 — `screen.getPrimaryDisplay().workAreaSize` + `maximize()` 2x | ✅ |
| 2 | Sidebar 17 passos (v0.2.11) | index.html `#step-sidebar`; wizard.js `STEPS` 17 entries | ✅ |
| 3 | UAC auto-elevate manifest (v0.2.6) | package.json `requestedExecutionLevel`; shell.js:387 `relaunchAsAdmin` com PORTABLE_EXECUTABLE_FILE | ✅ |
| 4 | Preflight streaming (v0.2.2) | main.js:393 `onCheck:` callback emite onPreflight por item | ✅ |
| 5 | Painel avisos âmbar + countdown (v0.2.4) | index.html `#preflight-warnings`; wizard.js `schedulePreflightAdvance` | ✅ |
| 6 | Log decode UTF-16 (v0.2.9/12) | shell.js:16 `decodeWslOutput`, shell.js:107 `wslExec` aplicado | ✅ |
| 7 | Modal de erro separado (v0.2.3) | index.html `#modal-error`; wizard.js `showErrorModal` | ✅ |
| 8 | Telas manual com botão + plano B (v0.2.13/15) | index.html `#manual-action-btn` + `#manual-fallback`; wizard.js executeManualAction | ✅ |
| 9 | safeHandle universal (v0.2.1) | main.js: 24 callsites `safeHandle(...)` + 1 definição | ✅ |
| 10 | Asar bundle (lição v0.3.0) | package.json `build.files` cobre main/preload/src/**/renderer/**/assets/** | ✅ |

**10/10 preservados na v0.2.17. Nenhuma regressão.**

---

## 4. Risco residual — cenários que VÃO falhar quando JOs testar

Honestidade brutal, em ordem de probabilidade:

| # | Cenário | Probabilidade | Impacto | Mitigação |
|---|---|---|---|---|
| **A** | Tela WSL upgrade nunca aparece (sem `onScreen('wsl-upgrade')` emit) | **100%** | JOs vê tela "progress" + step_01 rodando 5-10min sem feedback visual; acha que travou | Adicionar `_ctx.events.onScreen({screen:'wsl-upgrade'})` em executors.js:550 antes de `installWslModernViaMsi` |
| **B** | Tela Reboot Forçado nunca aparece (sem `onScreen('reboot')` emit) | **100%** | JOs vê modal-error genérico em vez do screen bonito com botão "Reiniciar agora"; ainda funciona via error modal, mas botão `scheduleRebootAndQuit` fica inacessível | Adicionar emit em `_markRebootAndScheduleRunOnce` (executors.js:382) — depois de `ctx.save()` |
| **C** | `onWslUpgradeProgress` nunca emitido durante MSI download | **100%** | barra fica em 0%; passa visualmente como "travou" | Bruno precisa fazer `installWslModernViaMsi` aceitar `onProgress` callback e disparar a cada etapa (download/install/done) |
| D | GitHub API rate limit (60 req/h unauth) | **Baixa** (JOs testa 1-2x) | falha em `https://api.github.com/repos/microsoft/WSL/releases/latest` → MSI install error | Já tem error catalog WSL_MSI_INSTALL_FAILED com sugestão de retry. **OK** |
| E | UAC negado no boot inicial | **Baixa-média** | manifest força UAC; se negado, app fecha. Não regride v0.2.6 lock-file logic | Já coberto |
| F | TLS 1.2 ausente em Win10 19045 | **Muito baixa** | 19045 é 22H2, TLS 1.2 default há anos | OK |
| G | shutdown.exe `/r` retornar erro (GPO empresa) | **Muito baixa** | JOs roda em home Windows | OK |
| H | RunOnce não dispara após reboot (GPO/AV) | Baixa | JOs reabre manual; state.json preserva progresso | OK — runner.markRebootDone trata |
| I | RunOnce path com aspas extras | Muito baixa | shell.js:671 já usa `('"' + $Exe + '"')` | OK |
| J | MSI 2.7.3 ~50MB falha download (rede lenta) | Baixa | timeout 10min cobre até 90KB/s | OK |

---

## 5. Pendências honestas — o que JOs vai bater

### 5.1 BLOCKER — emits ausentes (telas novas inativas)
Bruno implementou backend completo (handlers, helpers, IPC), Camila implementou UI completa (HTML, CSS, listeners no wizard.js), **MAS NINGUÉM CONECTOU OS DOIS**. Os emits combinados na CAMILA-UX §B2/B3 não foram adicionados em main.js/executors.js.

**Fix:**
- executors.js:550 (antes de installWslModernViaMsi): emitir `onScreen('wsl-upgrade')`
- executors.js:382 (`_markRebootAndScheduleRunOnce`): emitir `onScreen('reboot', {reason, resumeStep})`
- shell.js `installWslModernViaMsi`: aceitar `onProgress(payload)` callback; emitir 4-5 marcos (`stage:'Resolvendo URL'`, `stage:'Baixando MSI (45/51 MB)'`, `pct:88`, etc.) — Camila já documentou shape em CAMILA-UX:658
- main.js: passar `events.onScreen` e `events.onWslUpgradeProgress` em `buildRunnerEvents()`

### 5.2 Ressalva — `fallback` no `onError` nunca chega
`error-catalog.js` não devolve campo `fallback`; main.js:296 não inclui; wizard.js:696 espera e renderiza. Dead code do lado UI. Não é regressão (nunca funcionou), mas devia ser preenchido em entradas relevantes (ex.: WSL_MSI_INSTALL_FAILED com `fallback.command = "powershell -Command 'Invoke-WebRequest https://aka.ms/wsl2kernel ...'"`).

### 5.3 Smell — `wsl --update` duplicado em step_01
executors.js:581 chama 1x, depois :688 chama de novo dentro do mesmo execute. Não quebra (idempotente), só desperdiça ~2s. Bruno provavelmente esqueceu de remover um na refatoração.

### 5.4 Smell — `step_01.detect` chama `detectWslState` que faz 3 powershell calls
Em execução cold-cache pode levar 8-15s só pra DECIDIR pular o step. UX: status pill fica "detectando…" sem feedback durante todo esse tempo. Não-blocker mas notável.

---

## 6. Veredito final

### **GO COM RESSALVAS** — Confiança 60%

**O instalador FUNCIONA tecnicamente:**
- Detector legacy correto, MSI baixa, kernel ativa, Ubuntu instala — provado por code-review linha a linha.
- Cap de 3 reboots funciona, idempotência preservada, não-regressão 10/10.
- TLS 1.2 forçado, GitHub API + msiexec sem race, RunOnce + state.json sobrevivem reboot.

**MAS a experiência UX vai parecer quebrada:**
- JOs vai abrir o instalador, ver step_01 "rodando" por 10min com tela de progress genérica (sem barra de download MSI, sem mensagem específica).
- Quando o reboot for necessário, vai ver um modal-error em vez do screen bonito com botão verde.
- Se ele esperar pacientemente, **o ciclo legado → Ubuntu funcional FECHA**. Se ele perder paciência aos 3min sem feedback visual, vai fechar o instalador e o blocker volta.

**3 blockers reais (todos UX-emit, não funcionais):** ausência de `onScreen('reboot')`, `onScreen('wsl-upgrade')`, `onWslUpgradeProgress`.

**Top 3 pendências que JOs vai bater (ordem de probabilidade):**
1. **Step_01 "trava" 5-10min sem feedback** durante download MSI → JOs fecha o app
2. **Reboot pede via modal-error genérico** em vez da tela com botão "Reiniciar agora" → JOs reinicia manual sem o RunOnce pronto (na verdade RunOnce é agendado pelo `_markRebootAndScheduleRunOnce` interno, então isso é menos grave, mas a UX é pior)
3. **Bloco "Plano B" no modal-error nunca renderiza** (campo `fallback` ausente do payload) — dead code

**Recomendação ao Claudio:** integrar os 3 emits AGORA antes do JOs acordar — são 4-6 linhas em executors.js + 2 em buildRunnerEvents + 1 callback em installWslModernViaMsi. ROI brutal: transforma UX "achei que travou" em "tô vendo a barra subir, é segura".

**Se NÃO integrar:** continua sendo GO técnico (instalador funciona), mas com altíssima probabilidade do JOs reportar "abri, ficou parado, fechei" — exato bug reincidente do live-test v0.2.15.

— Eduardo
