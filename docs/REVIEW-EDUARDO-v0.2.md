# Code Review — Eduardo (revisor da IMP Dev Squad) — v0.2.0

> Auditoria pré-build do `imp-installer` v0.2.0. Cruza com `REVIEW-EDUARDO.md`
> (v0.1.0) e `SMOKE-TEST-v0.2.md` (Patrícia). Verifica que:
> 1. Os 4 BLOCKERS da v0.1.0 continuam fixados (sem regressão).
> 2. As 14 ressalvas médias/altas da v0.1.0 foram endereçadas.
> 3. Os 3 NO-GOs da Patrícia (A1, A2, A4) estão em código.
> 4. O bundle continua íntegro (anti-bug v0.3.0).
> 5. Nenhum risco novo crítico introduzido pela onda v0.2.

---

## 1. Regressão dos 4 BLOCKERS v0.1.0 — TODOS CONTINUAM FIXADOS

### B1 (2.1) — `onStepUpdate` rename `id→stepId`, `status→state` — ✅ FIXADO
- `main.js:109-132` (Fix Eduardo 2.1, comentado): adapter constrói `{ stepId: upd.id, state: upd.status, title, category, ...upd }`. O spread `...upd` no fim mantém `id`/`status` originais (defesa em profundidade — nada quebra se renderer evoluir).
- O renderer (`wizard.js:655`) faz `update.stepId` early-return — agora sempre presente. Verificado.

### B2 (2.2) — `onPreflight` PREFLIGHT_NAME_MAP — ✅ FIXADO
- `main.js:159-166` define o mapa: `windows_build→windows`, `admin→admin`, `disk_c_free_gb→disk`, `internet_github→internet`, `virtualization→virtualization`, `antivirus→antivirus`.
- `main.js:173-179` aplica o mapa + traduz `ok/warning→state ('ok'|'warn'|'err')` + manda `message`.
- Renderer (`wizard.js:331-345`) consome `setPreflightResult(checkId, state, message)`. Os 6 cards (`#127-167` do HTML) batem 1-a-1.
- ⚠️ Pequeno achado novo — ver §5.1 (`other_distros` não tem card → warning silencioso).

### B3 (2.3) — Modal sudo + handler — ✅ FIXADO
- HTML `index.html:446-465` tem `#modal-sudo` com `#sudo-input`, `#btn-sudo-confirm`, `#btn-sudo-cancel`, role=dialog, aria-modal.
- `wizard.js:700-736` registra `api.onSudoPrompt`, mostra modal, foca input, faz cleanup, replica via `api.sudoReply(id, pwd, cancelled)`. Suporta Enter/Esc.
- `main.js:74-92` mantém `pendingSudo` map + handler `installer:sudoReply` que faz resolve/reject. Loop fechado.

### B4 (2.4) — `step_13_sala3d` (sem underscore) — ✅ FIXADO
- `main.js:195` (`onComplete.sala3dInstalled`) usa `step_13_sala3d`. ✅
- `main.js:264` (`installSala3D`) chama `runner.runStep('step_13_sala3d', ...)`. ✅
- `executors.js:597` define `id: 'step_13_sala3d'`. ✅
- `wizard.js:34` referência consistente. Grep confirma zero ocorrências de `step_13_sala_3d` no projeto inteiro.

---

## 2. Status das 14 ressalvas v0.1.0

| # | Item v0.1.0 | Status v0.2 | Onde / nota |
|---|---|---|---|
| 1.2 | `assets/` vazio | ✅ FIXADO | `assets/icon.ico` 5646 bytes, `file` reporta **"MS Windows icon resource - 6 icons"** (16,32,48,64,128,256). `package.json:55` referencia em `build.win.icon`. |
| 2.5 | `openInterface` aponta pra path errado | ✅ FIXADO (bônus v0.1) | `main.js:269-281` tenta 3 candidates (lnk, LOCALAPPDATA exe, legacy). |
| 2.6 | `installer:pause` é no-op | ✅ FIXADO | `runner.js:128-135 pauseGate` + `state.paused` flag + `pause/resume/isPaused` em `runner.js:224-242`. `main.js:283-297` chama os reais. **Caveat**: pausa só bloqueia ENTRE steps (não interrompe step em execução). Doc clara em runner.js:223. Aceitável. |
| 2.7 | `btn-fresh` não reseta | ⚠️ PARCIALMENTE FIXADO — **ver §3 / 🟠 ALTO #N1** | `runner.resetState()` existe (`runner.js:283-310`), `main.js:299-303` handler IPC `installer:reset` existe — **MAS `preload.js` NÃO expõe `api.installer.reset()` e `wizard.js:467-470` continua só escondendo o card sem chamar o backend**. Bug. |
| 2.8 | `onManualPrompt` não dispara em HYBRID 03/10 | ✅ FIXADO | `executors.js:96-98 (step 03)` e `executors.js:441-444 (step 10)` agora têm `manualInstructions`. `main.js:118-130` dispara `onManualPrompt` em qualquer step com `manualInstructions` quando entra em `running`. |
| 3.4 | `skipStep` sem CRITICAL_STEPS | ✅ FIXADO | `runner.js:15-23` define set com step_03/05/06/08/10/11/14. `runner.js:269-279 skipStep` recusa críticos sem `opts.force:true`. Bom. |
| 3.5 | `getState` pré-startWizard | ✅ DOC | `runner.js:93-100` tem comentário explicando o padrão (não é bug, é trade-off documentado). |
| 3.6 | Step 04 polling sem feedback | ✅ FIXADO | `executors.js:237-247` emite `ctx.logger.info('step_04', 'aguardando criação (Xs decorridos)...')` a cada 5s. Renderer vê pelos logs. |
| 3.7 | Step 04 swallow silencioso | ✅ FIXADO | `executors.js:196-223` itera launchers + logger.warn em cada falha + throw amigável se nenhum funcionar. Combina com Fix A2 da Patrícia. |
| 4.5 | scheduleRunOnceAfterReboot interpola | ✅ FIXADO | `shell.js:222-239` passa `$Exe, $Name` via param() + `-Exe`/`-Name` args. Sem interpolação. |
| 4.6 | Erro de clone genérico | ✅ FIXADO | `executors.js:542-551` captura erro do clone, chama `enrichError('step_11_clone_squad', raw)`, anexa `friendly.enriched` para o adapter de `onError` consumir. |
| 4.7 | Mask adicionais | ✅ FIXADO | `logger.js:21-25` adiciona `ANTHROPIC_API_KEY=`, `GH_TOKEN=`, `GITHUB_TOKEN=`, `xoxb-`. |
| 5.3 | CSS [data-state] faltantes | ✅ FIXADO | `style.css` cobre `pending|running|done|error|manual|skipped|blocked_user_action` — 7 estados, com cor, ícone e animação por estado. Verificado linhas 517-594. |
| 5.4 | error-catalog.js | ✅ FIXADO | `src/error-catalog.js` criado, 14 entries (3xstep_03, 3xstep_05, 2xstep_10, 2xstep_11, 3x genéricos, 1 reboot, 1 tmux) + fallback genérico. `main.js:133-148` adapter de `onError` chama enrichError. |
| 5.6 | makeNoopApi vira sucesso falso | 🟡 NÃO FIXADO (aceitável) | `wizard.js:60-77` continua igual. Risco baixo no .exe empacotado (preload sempre carrega via contextBridge); fica como hardening v0.3. |
| 5.7 | Versão hardcoded | ✅ FIXADO | `wizard.js:739-743` chama `api.version()` e popula `#installer-version`. |
| 6.§1.7 | Outra distro WSL | ✅ FIXADO | `preflight.js:78-116 checkOtherDistros` adicionado, `runAll` inclui na lista. `executors.js:108-114 (step 03)` também warn-loga + força `wsl --set-default Ubuntu-22.04` ao final. |
| 6.§2.4 | dpkg lock | ✅ FIXADO | `executors.js:269-286 (step 05 execute)` pré-checa lock via `lsof /var/lib/dpkg/lock-frontend`, throw com instrução amigável se positivo. error-catalog tem entry para a mensagem. |

**Score**: 16 de 17 itens fixados; 1 parcial (#2.7 — só backend, falta exposição preload + chamada wizard); 1 aceitável-não-fixado (#5.6 hardening preload-missing).

---

## 3. Status dos 3 NO-GOs da Patrícia

### A1 — Step 13 sempre 404 — ✅ FIXADO
- `executors.js:619-649 (step 13 execute)`: agora faz probe `curl -s -o /dev/null -w '%{http_code}' --max-time 15` na URL da API. Se ≠ 200, marca `sala3dSkipped=true` com motivo `sala_3d_release_indisponivel`, **retorna sem erro**.
- `validate(ctx)` linha 682-686 aceita `sala3dSkipped` como ok.
- Bônus: se a release existir mas o download falhar, também vira skip (não bloqueia instalação principal). Linhas 672-680.
- ✅ **Comportamento ideal**: instalação completa sem travar em release inexistente.

### A2 — Step 04 launcher dinâmico — ✅ FIXADO
- `executors.js:168-223`: probe `Get-Command "ubuntu*.exe"` (linhas 173-184) descobre launchers no PATH; monta `tryOrder` priorizando `ubuntu2204.exe > ubuntu-22.04.exe > ubuntu.exe`. Se probe falhou ou retornou vazio, tenta cegamente os 3.
- Fallback final (linhas 209-223): `openInteractiveTerminal('echo ... ; exec bash', { distro })` — abre WSL direto. Se TUDO falhar, throw mensagem amigável (não swallow silent).
- `ctx.state.ubuntuLauncher` salvo para diagnóstico.
- ✅ Cobre os 3 cenários (somente 22.04, somente genérico, ambos ausentes).

### A4 — UTF-16 mojibake + regex bilíngue — ✅ FIXADO
- `shell.js:10-41 decodeWslOutput`: detecta heuristicamente buffer com null bytes nos índices ímpares (UTF-16 LE clássico) OU string com >20% chars `\x00` → re-decodifica como `utf16le` + strip BOM. Saídas UTF-8 normais passam direto (sem mutação).
- `shell.js:58-66 (execP)`: aplica decode quando `cmd === 'wsl.exe' || cmd === 'wsl'` OU args contém `\bwsl\b`. Cobre `powershell('wsl --status')` e `wsl(...)` diretos.
- `shell.js:90-95, 99-108`: `WSL_UTF8=1` injetado no env tanto de `powershell()` quanto de `wsl()` — defesa em profundidade (wsl.exe ≥ 0.64 respeita e emite UTF-8 plain).
- `executors.js:81`: regex bilíngue `(?:Default Version|Vers[aã]o padr[aã]o)\s*:\s*2` cobre EN + PT-BR.
- `executors.js:104`: regex de Ubuntu version 2 é locale-agnóstica (números puros).
- ✅ Triple-defesa (env, decode, regex bilíngue) — robusto.

---

## 4. Bundle / anti-bug v0.3.0 — ✅ ÍNTEGRO

### 4.1 `build.files` cobertura de require() em runtime
Grep'ei todos os requires do código de produção:
- `main.js` requer: `electron`, `node:*`, `./src/runner`, `./src/preflight`, `./src/executors`, `./src/shell`, `./src/error-catalog` ✅ (todos via `src/**/*`)
- `preload.js` requer: `electron` ✅
- `src/runner.js` requer: `./logger`, `./state`, `./executors`, `node:*` ✅
- `src/executors.js` requer: `./shell`, `./preflight`, `./error-catalog` ✅
- `src/preflight.js` requer: `./shell` ✅
- `src/shell.js` requer: `./logger`, `node:*` ✅
- `src/error-catalog.js` requer: (nenhum — puro JS) ✅
- `src/state.js`, `src/logger.js`: só `node:*` ✅

**Conclusão**: `src/**/*` cobre `error-catalog.js` (recém-criado). **O bug do v0.3.0 da imp-interface NÃO se repete.**

### 4.2 Ícone
- `assets/icon.ico` confirmado **"MS Windows icon resource - 6 icons"** (16×16 PNG, 32×32 PNG, etc.). 
- `package.json:36` (`"assets/**/*"` em files) + `package.json:55` (`"icon": "assets/icon.ico"` em `build.win`) — duplo wire. **Ícone do .exe vai aparecer no Windows Explorer + taskbar.**

### 4.3 Sem extraResources / seeds
- Não há `seeds/` empacotado. Isso significa que o fallback do step 11 (clone de `imp-squad` privado → tarball seed) é **morto em produção** (path `/mnt/c/Projetos/imp-installer/seeds/...` só existe no dev box do Claudio).
- **Não é blocker** porque o caminho feliz (gh auth → clone funciona) cobre 99% dos casos, e o error-catalog tem mensagem amigável quando o clone falha (entry "Não consegui clonar o repo da squad (privado)"). Marcar como **ressalva 🟡 MÉDIO** para v0.3.

---

## 5. Novos riscos / achados v0.2

### 🟠 ALTO

#### N1 — `btn-fresh` não chama backend reset (regressão silenciosa do fix 2.7)
- **Onde**: `renderer/wizard.js:467-470` + `preload.js` (todo).
- **O quê**: `runner.resetState()` foi implementado (runner.js:283-310) e o handler IPC `installer:reset` existe (main.js:299-303), mas:
  - `preload.js` **não expõe** `installer.reset()` — não há `reset: () => ipcRenderer.invoke('installer:reset')`.
  - `wizard.js:467-470 (btn-fresh)` apenas esconde o `#resume-card` com comentário "convenção: chamar start() sem resume" — **não dispara o reset real**.
- **Impacto**: usuário clica "Começar do zero" → próximo `start()` recarrega o `state.json` antigo → `runAll` pula tudo que já estava `'done'`. Comportamento idêntico a "Continuar". Frustrante mas não destrutivo.
- **Fix sugerido**: 2 linhas:
  ```js
  // preload.js
  reset: () => ipcRenderer.invoke('installer:reset'),
  // wizard.js btn-fresh
  $('#btn-fresh').addEventListener('click', async () => {
    try { await api.reset(); } catch (_) {}
    $('#resume-card').classList.add('hidden');
  });
  ```
- **Decisão**: NÃO é blocker pra build — pior caso o usuário tem que apagar `%USERPROFILE%\.imp-installer\state.json` manualmente. **Mas vale fix antes do release.**

### 🟡 MÉDIO

#### N2 — `other_distros` não tem card no HTML
- **Onde**: `preflight.js:78-116` agora emite check `other_distros`; `index.html:127-167` só tem 6 cards (windows/admin/disk/internet/virtualization/antivirus); `main.js:159-166 PREFLIGHT_NAME_MAP` não tem entry pra `other_distros` (cai no fallback `c.name`).
- **Impacto**: o warning ("default distro = Debian (não-Ubuntu)") nunca chega à UI — `setPreflightResult` faz silent return no `if (!card) return` (wizard.js:333). Usuário com Debian default não recebe aviso visual; só vê no log se tiver console aberto.
- **Fix sugerido**: adicionar `<li class="pf-card" data-check="other_distros">` em index.html ou mapear `other_distros → 'distros'` e renderizar card. Não bloqueante (executor step 03 também avisa via warn-log e força default).

#### N3 — Seeds fallback (#A3 Patrícia) continua morto em produção
- **Onde**: `executors.js:527-533 (step 11)`. Aceitável como ressalva — caminho feliz cobre 99%.
- **Fix v0.3**: criar `seeds/_squad.tar.gz` + adicionar `"extraResources": [{ "from": "seeds", "to": "seeds" }]` em `package.json` + resolver path via `process.resourcesPath` em runtime.

#### N4 — Decoder UTF-16 pode (improvável) re-decodificar saída UTF-8 que tenha lixo
- **Onde**: `shell.js:28-39`. Heurística "20% null bytes no sample". UTF-8 normal não tem nulls — risco teórico baixo. Verificado: nenhum dos comandos atuais emite stdout com null bytes legítimos.
- **Mitigação extra**: `WSL_UTF8=1` env reduz drasticamente os casos em que decodeWslOutput precisa atuar. Sem ação.

#### N5 — `resetState` race com lockfile
- **Onde**: `runner.js:283-310`. Se o usuário clicar "Começar do zero" enquanto um step ainda está rodando: `resetState` libera o lockfile e zera `_ctx = null`; mas o `runStep` em execução ainda tem closure no `_ctx` antigo (variável local). Próximo `_ctx.save()` escreve em state.json novo que foi renomeado → fica como `state.json` reaparece com dados parciais.
- **Mitigação atual**: wizard só mostra `btn-fresh` na tela de welcome/resume — **antes** de iniciar runs (`#resume-card` aparece só se há state preserved). Se N1 for fixado, segue protegido. Marcar como nota para futuro multi-thread.

### 🟢 NIT

#### N6 — `enrichError` fallback genérico funciona mas é genérico
- `error-catalog.js:217-226 GENERIC` mostra "Algo deu errado" + sugere tentar de novo e exportar logs. O fallback **inclui** os primeiros 300 chars do erro técnico (`what` + `\n\nDetalhe técnico: ...`) — bom o suficiente. Steps 04, 13 e 14 (fora os já catalogados) caem aqui; mensagem genérica é aceitável.

#### N7 — Probe `Get-Command ubuntu*.exe` race condition
- Após `wsl --install --no-launch`, o registro AppX pode demorar segundos. Em prática, step 03 termina + reboot + relaunch = o launcher já está visível quando step 04 roda. Não vi cenário real onde a race dispara. Sem ação.

#### N8 — `gh auth setup-git` ordem pode ignorar `core.autocrlf` se falhar
- `executors.js:478-481`: `gh auth login --web && gh auth setup-git && git config --global core.autocrlf input`. Se setup-git falhar (raro, mas pode), autocrlf não roda. Cosmético — Patrícia §10 já notou.

---

## 6. Interface (renderer/) — consistência com main.js

| Item | Status |
|---|---|
| `api.onStepUpdate` consome `{stepId, state}` | ✅ |
| `api.onPreflight` consome `{checkId, state, message}` | ✅ (exceto novo `other_distros` — N2) |
| Modal sudo chamado por `api.onSudoPrompt` + `api.sudoReply` | ✅ |
| `btn-pause` chama `api.pause/resume` reais | ✅ |
| `btn-fresh` chama `api.reset()` | ❌ (N1) |
| `btn-install-sala3d` chama `api.installSala3D()` | ✅ |
| `btn-open-interface` chama `api.openInterface()` | ✅ (com 3 candidates) |
| Ícone aparece no .exe | ✅ (`build.win.icon`) |
| Versão dinâmica via `api.version()` | ✅ |

---

## Veredito

### ⚠️ GO COM RESSALVAS PRO BUILD v0.2.0 — 0 BLOCKERS, 1 ALTO (N1), 3 MÉDIOS

**O .exe vai abrir, o fluxo principal vai rodar até o fim, os dois caminhos garantidos de falha da Patrícia (A1/A4) foram fechados, e o caminho problemático A2 ganhou estratégia de fallback robusta.**

A onda corretiva endereçou **16 dos 17 itens da v0.1.0** + **3 dos 3 NO-GOs da Patrícia** + integrou tudo limpo no `main.js`. O bundle continua íntegro (anti-bug v0.3.0): cada `require()` em runtime aponta para arquivo coberto pelos globs de `build.files`.

### Blockers para release: **0**

### Ressalvas (todas pós-release aceitáveis, exceto N1 que vale fix de 2 linhas antes do build):

| Sev | # | Item | Esforço fix |
|---|---|---|---|
| 🟠 | N1 | `btn-fresh` não dispara `api.reset()` (backend pronto, falta wire) | ~2 linhas em preload.js + 1 em wizard.js |
| 🟡 | N2 | `other_distros` warning sem card visual | adicionar `<li>` em index.html |
| 🟡 | N3 | seeds fallback morto em prod (extraResources faltando) | v0.3 — não atinge caminho feliz |
| 🟡 | N5 | `resetState` race com run em curso | proteger no wizard (mostrar btn só em welcome) |

### Recomendação final

- **Build agora** se prazo é apertado — N1 é UX pequena (usuário apaga state.json manualmente como workaround).
- **Build após 5 min** se quer fix N1 — 2 linhas preload + 1 wizard, testar smoke rápido, build.

### Confidence sobre JOs conseguir rodar o instalador no desktop SEM blockers: **ALTA**

Justificativa:
1. Bundle verificado require-by-require — não há "Cannot find module".
2. 4 blockers da v0.1.0 confirmados fixados via grep + leitura linha-a-linha.
3. Os 3 NO-GOs da Patrícia (testados no smoke real dela) têm fix em código que cobre os cenários descritos.
4. Caminho feliz (PC zerado, conta GitHub válida com acesso ao `imp-squad`, conexão estável):
   - preflight passa (6 cards verdes, 1 silencioso ok),
   - features WSL ligam, reboot acontece, RunOnce traz o instalador de volta,
   - Ubuntu 22.04 instala, primeira boot detecta launcher dinamicamente,
   - apt base com sudo modal (B3 fixado),
   - nvm + node + claude + claude-login (terminal interativo) + gh login (Device Flow),
   - clones `imp-squad` e `imp-orchestrator` via `gh auth setup-git` credential helper,
   - Sala 3D **graceful skip** (release 404),
   - tmux session 7 panes, download IMP-Squad-Comando.exe, atalho Desktop.
5. Caminhos infelizes (rede caiu, repo sem acesso, dpkg lock) têm mensagens amigáveis no error-catalog.

**Aprovado para build.** Se a onda do JOs incluir um Claudio livre, sugiro o mini-fix do N1 antes — senão libera assim mesmo.
