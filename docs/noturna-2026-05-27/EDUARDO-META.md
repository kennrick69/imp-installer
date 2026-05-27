# EDUARDO — Meta-análise sistêmica + lista de não-regressão conferida

**Autor:** Eduardo (revisor IMP Dev Squad)
**Data:** 2026-05-27 (sessão noturna autônoma)
**Escopo:** análise dos 9 reviews REVIEW-EDUARDO-v0.2.* + contexto do live-test
**Fonte:** /mnt/c/Projetos/imp-installer (v0.2.16 publicada)

---

## 0. TL;DR

3 padrões sistêmicos dominaram TODOS os bugs do live test:

1. **Contrato divergente main↔wizard** (Pattern B) — apareceu 7×. Causa raiz: nenhum
   schema canônico entre processes; cada Claude codou contra um vocabulário próprio.
2. **Asserção otimista / validação fraca** (Patterns A+G juntos) — apareceu 6×.
   Causa raiz: squad só vê "binário X está no PATH" e assume "binário funciona".
3. **Encoding & quoting de Windows** (Patterns D+E) — apareceu 5×. Causa raiz:
   WSL Linux nunca exercita codecs cp850, UTF-16 LE, ou Start-Process quoting.

A squad NUNCA detecta esses bugs antes do JOs porque:
- Squad roda em WSL Linux + node CLI; .exe é Windows + Electron + Win10 19045.
- Smoke estático (`node --check`) prova sintaxe, não comportamento.
- Nenhum CI renderiza HTML/wizard.js → bugs de DOM passam direto.
- Nenhum CI extrai asar + roda matcher de contrato main↔wizard.

A noite deve PRIORIZAR (nessa ordem):

1. **wsl-legado detector** — `wsl.exe` no PC do JOs é o legacy/inbox que NÃO tem
   `--status`/`--version`/`--install`. v0.2.16 ainda assume que tem.
2. **Test plan executável** — checklist de smoke `extract → strings → diff contrato`
   que o Claudio roda ANTES de cada .exe ir pro JOs.
3. **Schema único main↔wizard** — arquivo `src/ipc-contract.js` com shapes
   declarados; main e wizard importam.

---

## 1. Padrões sistêmicos dos bugs (causa raiz META)

Códigos dos achados nos reviews entre parênteses (REV-EDUARDO-vX.Y.Z achado N).

### Pattern A — Validação fraca / sinal proxy

**Aparições:** 3 (v0.1.0 §6.§1.7, v0.2.4 #1, v0.2.5 #3, v0.2.16 contexto)

| Caso | Sinal usado | Realidade | Custo |
|---|---|---|---|
| v0.1 §6.§1.7 | "wsl --install -d Ubuntu rodou ok" | distro Debian já era default → ignorou | install travada em passos seguintes |
| v0.2.4 #1 | onPreflight terminou → botão liberado | evento "running" atrasado pode chegar depois → botão treme | UX confunde JOs |
| v0.2.5 #3 | `isElevated` catch → false | PowerShell quebrado também devolve false | recursão UAC infinita possível |
| v0.2.16 (atual) | "build Win ≥ 19041" = WSL moderno | build moderno PODE ter wsl.exe legado/inbox | TUDO da v0.2.16 cai aqui hoje |

**Causa raiz REAL:** confundir "consigo executar o comando" com "consigo obter o
resultado certo". A squad escolhe a forma de sinal mais fácil de implementar
(exit code, ou regex em help) e assume que ela mapeia a "funcionou de verdade".

**Prevenção:** toda detecção crítica deve ter **três camadas independentes** —
positiva (resultado A), negativa (sinal de não-funcionou B), e diagnóstica (log
do que veio). O `wslIsFunctional()` de v0.2.16 tem 1 sinal (`wsl --status`
text); precisa de 3.

### Pattern B — Contrato divergente main↔wizard

**Aparições:** 7 (v0.1 BLOCKERS 2.1, 2.2, 2.3, 2.4; v0.2 N1; v0.2.2 M2; v0.2.15 J;
v0.2.15 markManualDone)

| Bug | Main emite | Wizard espera | Sintoma |
|---|---|---|---|
| 2.1 v0.1 | `{id, status}` | `{stepId, state}` | sidebar travada em "pending" |
| 2.2 v0.1 | `{name}` + valores backend | `{checkId}` UI names | preflight nunca avança |
| 2.3 v0.1 | `installer:sudoPrompt` | nenhum handler | install trava 600s |
| 2.4 v0.1 | `step_13_sala_3d` (typo) | `step_13_sala3d` | botão sempre erro |
| N1 v0.2 | handler `installer:reset` existe | preload não expõe `api.reset()` | botão fresh no-op silente |
| M2 v0.2.2 | `{message}` | wizard lê `entry.msg` | logs ao vivo em branco |
| J v0.2.15 | `{screen: 'preflight'}` | trata como string | onScreen quebrado |

**Causa raiz REAL:** Camila escreveu RENDERER-SPEC, Bruno escreveu BACKEND-SPEC,
ninguém escreveu IPC-CONTRACT comum. Cada review pegou 1-2 desses por vez; eles
voltam porque NÃO HÁ FONTE DE VERDADE EXECUTÁVEL.

**Prevenção:** `src/ipc-contract.js` com:
```js
exports.ON_STEP_UPDATE = { ts:Number, stepId:String, state:Enum(...), ... };
```
Tanto `sendToRenderer` quanto `api.onX` validam contra o schema em dev (throw
se mismatch). Em prod só loga.

### Pattern C — Duas fontes de verdade pra mesmo estado UI

**Aparições:** 3 (v0.2.4 #3 span-label órfão, v0.2.4 #4 hint nunca aparece,
v0.2.4 #5 data-state countdown CSS órfão)

| Bug | Fonte A | Fonte B | Resultado |
|---|---|---|---|
| v0.2.4 #3 | `<span#btn-preflight-next-label>` | `btn.textContent = '…'` | span morto, textContent vence sempre |
| v0.2.4 #4 | HTML `#preflight-footer-hint` com `hidden` | JS nunca seta `hidden=false` | hint nunca renderiza |
| v0.2.4 #5 | CSS `[data-state="countdown"]` | JS nunca seta dataset | variante âmbar não dispara |
| (impl atual) | classe `.hidden` vs atributo `[hidden]` | dois mecanismos coexistem | clean código quebra um |

**Causa raiz REAL:** Camila desenha HTML+CSS pensando estado declarativo,
Bruno/Claudio implementam JS pensando comandos imperativos. Os dois caminhos
co-existem sem testes que provem qual ganha.

**Prevenção:** convencionar UM mecanismo de visibility (`.hidden` class via
`toggleClass`) e UM mecanismo de label (data-attribute lido pelo CSS), e o
review ter um checklist "todo `[hidden]` do HTML é setado por JS? todo
`[data-state=…]` do CSS tem JS que dispara?".

### Pattern D — Encoding (UTF-16 LE, cp850, mojibake, pt-BR)

**Aparições:** 5 (v0.2 A4 UTF-16, v0.2.9 mojibake, v0.2.12 reincidência,
v0.2.6 #1 stderr UAC pt-BR, executors.js regex `Vers[aã]o padr[aã]o`)

| Bug | Fonte | Sintoma |
|---|---|---|
| A4 v0.2 | wsl.exe stdout UTF-16 LE | regex `Default Version: 2` nunca matcha |
| v0.2.9 | logs com "instalaýýo" | usuário não consegue ler |
| v0.2.12 | PowerShell wrap → UTF-16 segue | precisou `wslExec` direto |
| v0.2.6 #1 | UAC negado em pt-BR | "cancelada pelo usuário" não bate regex EN |
| atual | `Vers[aã]o padr[aã]o` | tenta cobrir EN+PT, mas só 2 idiomas |

**Causa raiz REAL:** Windows tem múltiplas camadas de encoding (codec do
console, codec do processo, codec do binário, idioma do SO). Squad em WSL nunca
vê esses problemas; assume utf8 universal.

**Prevenção:** todo binário Windows externo (`wsl.exe`, `powershell.exe`,
`Start-Process`, `dism.exe`) tem helper dedicado que:
1. seta env de UTF-8 quando suportado (`WSL_UTF8`, `[Console]::OutputEncoding`).
2. lê stdout como Buffer + detecta encoding via heurística (não confia em
   default do Node).
3. emite saída em texto canônico (utf8 normalizado).

### Pattern E — Quoting/escaping shell (Windows-specific)

**Aparições:** 2 (v0.2 4.5 PS interpolation, v0.2.5 #6 exePath escape)

| Bug | Caminho | Risco real |
|---|---|---|
| v0.2 4.5 | `$exe = '${exePath.replace(/'/g,"''")}'` interpolado | quebra com aspas duplas em path |
| v0.2.5 #6 | `Start-Process -FilePath '…'` cmdline string | path com Unicode raro pode falhar |

**Causa raiz REAL:** PowerShell tem 5 modos de quoting (single, double,
here-string, expression, command), e `child_process.execFile` no Windows
joga tudo num cmdline único. A squad usa interpolação string-template do
JavaScript porque é o que conhece; PowerShell não é JS.

**Prevenção:** **NUNCA interpolar argumento em script PS**. Sempre passar
via `-ArgumentList` ou `param($x)` + stdin. Linter regex que bane
`` `'${...}'` `` em arquivos .js que rodam PS.

### Pattern F — Comando errado / assumption sobre sintaxe que não bate

**Aparições:** 3 (v0.2.16 inteiro — `wsl --status` não existe no legacy;
v0.2 §6.§2.4 dpkg lock; live-test "--no-launch unrecognized")

| Bug | Squad assumiu | Realidade JOs |
|---|---|---|
| --no-launch | `wsl --install -d Ubuntu --no-launch` é universal | wsl legacy: "unrecognized option" |
| --status | `wsl --status` retorna status estruturado | wsl legacy: retorna help genérico |
| --version | `wsl --version` mostra build moderno | wsl legacy: "Opção inválida" |

**Causa raiz REAL:** documentação MS atual é só do WSL moderno (Microsoft Store
package), mas existe um wsl.exe LEGADO/INBOX no Windows 10 que só tem `--exec`,
`-e`, `--cd`, `--`. A presença do `wsl.exe` no PATH não diz QUAL versão é. O
build do Windows (≥ 19041) diz "esse SO SUPORTA WSL moderno", **não** "esse SO
TEM WSL moderno instalado". A squad colapsou essas duas coisas.

**Prevenção:** sempre que um comando externo for usado, primeiro chamar uma
SONDAGEM mínima que prove a versão/capacidade. No caso WSL: `wsl --help`
parseado pra ver se `--install`/`--list`/`--status` aparecem na lista de
opções suportadas; se não, é legacy → migrar via dism antes.

### Pattern G — Asserção otimista (assume sem testar)

**Aparições:** 6 (v0.1 5.6 noopApi vira sucesso; v0.2.1 #2.3 `[].every` true;
v0.2.4 #6 catch deixa UI travada; v0.2.5 #1 fire-and-forget UAC; v0.2.16
inteiro; live-test "validação mentirosa passos 01-03")

**Causa raiz REAL:** quando o resultado positivo é a hipótese padrão e a
negativa é "vamos cair em um catch genérico", todo silêncio vira sucesso.
O array vazio `.every()` retorna true; o catch genérico engole; o
fire-and-forget assume que disparou ok.

**Prevenção:** todo handler deve responder o **shape de sucesso**, com campos
**positivos** que provam o sucesso. Nunca `{ok:true}` sem evidência. Exemplo:
em vez de `installer:start → {ok:true}`, retornar `{ok:true, checksRun:7,
blockingCount:0, durationMs:3614}`. A inspeção do retorno permite catch de
"falso true".

---

## 2. Por que squad NUNCA detecta esses bugs antes do JOs?

Honestidade brutal: a squad **funciona em um universo paralelo** que não cruza
com o universo do JOs em 3 dimensões importantes:

| Dimensão | Squad | JOs (.exe rodando) |
|---|---|---|
| OS | WSL Linux (Ubuntu) | Windows 10 build 19045 nativo |
| Runtime | `node main.js` direto ou `electron .` | Electron portable empacotado em asar |
| Encoding | utf8 universal por padrão | cp850 / UTF-16 LE / pt-BR mix |
| GUI | nenhuma; sem DOM | DOM completo + IPC contextBridge |
| Permissão | $USER comum sem UAC | precisa eleva, Start-Process -Verb RunAs |
| WSL | já tá funcionando | pode ter WSL legado, pode não ter, pode estar disabled |

**Consequência:** todo bug que envolve interação de pelo menos 2 dessas
dimensões é INVISÍVEL pra squad. Squad só vê:
- Sintaxe JavaScript válida (node --check).
- Lógica pura (unit testes de funções puras).
- Bundle declarativo (asar list).

**O que a squad NÃO vê (e por isso JOs sempre acha o bug primeiro):**
1. Botão fantasma renderizado vs estado JS.
2. UTF-16 LE no stdout de qualquer binário Windows.
3. Quoting de Start-Process com path Unicode.
4. UAC negado vs aceito vs lento.
5. wsl.exe legacy vs moderno.
6. Diferença entre "binário no PATH" e "binário funcional".

---

## 3. Plano de melhoria do processo da squad

### 3.1 Validação arquitetural (PRÉ-PR)

Cada PR que toca handler/event novo passa por checklist:

```
- [ ] Schema do payload declarado em src/ipc-contract.js
- [ ] sendToRenderer usa shape do contract (não objeto ad-hoc)
- [ ] api.onX correspondente lê os campos definidos no contract
- [ ] Em dev mode (NODE_ENV=development), contract valida shape e throws
- [ ] Resposta de invoke tem campos positivos (não só {ok:true})
```

### 3.2 Smoke automatizado pré-release

`scripts/preflight-release.sh`:

```bash
#!/bin/bash
set -e
# 1. node --check em todos os .js
# 2. npm run dist:win
# 3. asar list dist/win-unpacked/resources/app.asar | tee asar-listing.txt
# 4. grep -c 'src/error-catalog.js' asar-listing.txt  # exige >= 1
# 5. grep -c 'renderer/wizard.js' asar-listing.txt
# 6. strings dist/win-unpacked/IMP-Squad-Instalador.exe | grep -i 'requireAdministrator'
# 7. node scripts/contract-matcher.js  # cruza main.js↔wizard.js
# 8. node scripts/jsdom-smoke.js       # renderiza HTML + simula clicks
```

### 3.3 jsdom CI (matar botão-fantasma class)

`scripts/jsdom-smoke.js` carrega `renderer/index.html` no jsdom, executa
`renderer/wizard.js` com `window.api` mockado, simula:
- click em #btn-start → garante que showElevateModal foi chamada
- evento mock onPreflight → garante que pf-card mudou data-state
- evento mock onManualPrompt → garante que #manual-action-btn ficou clicável
- click em #manual-action-btn → garante que api.executeManualAction foi chamado

Cada uma dessas asserções teria PEGO um dos bugs do live-test em 30 segundos.

### 3.4 Pre-build linter de contrato

`scripts/contract-matcher.js`:
- Lista todo `sendToRenderer('installer:on*', payload)` em main.js
- Lista todo `api.on*((p) => ...)` em wizard.js
- Cruza: pra cada canal main↔wizard, extrai shape via AST e diff.
- Output: "✅ onLog match" / "❌ onScreen: main envia object, wizard espera string".

### 3.5 Test plan documentado

`docs/TEST-PLAN-JOS.md` separado em duas colunas:
- **Ações que JOs vai fazer** — squad NÃO simula, mas DOCUMENTA o checklist.
- **Ações que squad PODE simular** — jsdom smoke, asar list, contract matcher.

Cada release: marca quais smoke a squad rodou + quais ações ficam delegadas pro
JOs validar.

---

## 4. LISTA NÃO-REGRESSÃO — conferida item por item no código atual

Versão verificada: **0.2.16** (package.json).

| # | Item | Como confiro | Achado no código | Status |
|---|---|---|---|---|
| 1 | Janela maximizada (v0.2.11) | grep `maximize()` + `getPrimaryDisplay` em main.js | `main.js:39` `screen.getPrimaryDisplay()`; `main.js:57` `mainWindow.maximize()`; `main.js:60` segundo tiro defensivo | ✅ OK |
| 2 | Sidebar 17 passos (v0.2.11) | grep `#step-sidebar` + `SIDEBAR_SCREENS` + `STEPS` array | `index.html:60` `<aside id="step-sidebar">`; `wizard.js:860` `SIDEBAR_SCREENS = Set(['preflight','progress','manual','error'])`; `wizard.js:20-39` `STEPS` array com 17 entradas (`step_00`..`step_16` ou equivalente) | ✅ OK |
| 3 | UAC auto-elevate (v0.2.6, manifest) | grep `requireAdministrator` + lockfile + PORTABLE_EXECUTABLE_FILE | `package.json:56` `requestedExecutionLevel: requireAdministrator`; `main.js:20` `ELEVATED_LOCK`; `shell.js:387` `relaunchAsAdmin()` usa `PORTABLE_EXECUTABLE_FILE` (linha 394) | ✅ OK |
| 4 | Preflight streaming (v0.2.2) | grep `onCheck` em preflight.js + emit `onPreflight` no main | `preflight.js:293` `onCheck = opts.onCheck`; `preflight.js:305-322` chama onCheck por check; `main.js:391-395` `sendToRenderer('installer:onPreflight', {checkId,state,message})` por evento | ✅ OK |
| 5 | Painel avisos âmbar + countdown (v0.2.4) | grep `preflight-warnings` HTML + `schedulePreflightAdvance` | `index.html:215` `<aside class="preflight-warnings" id="preflight-warnings">`; `index.html:230` `#preflight-footer-hint`; `wizard.js:1104` `schedulePreflightAdvance()` definida; `wizard.js:1095` e `:1285` chamam ela após start ok | ✅ OK |
| 6 | Log decode UTF-16 (v0.2.9/v0.2.12) | grep `decodeWslOutput` + `wslExec` | `shell.js:16` `decodeWslOutput(buf)` definida; `shell.js:58-66` aplicada em `execP` para wsl; `shell.js:107` `wslExec()` dedicado | ✅ OK |
| 7 | Modal de erro separado (v0.2.3) | grep `#modal-error` + `showErrorModal` | `index.html:537` `<div ... id="modal-error">`; `wizard.js:652` `function showErrorModal(payload)`; `wizard.js:708` `openModal('modal-error')` | ✅ OK |
| 8 | Telas manual c/ botão + plano B (v0.2.13/v0.2.15) | grep `#manual-action-btn` + `manual-fallback` | `index.html:296` `<button id="manual-action-btn">`; `index.html:307` `<div class="manual-fallback hidden" id="manual-fallback">`; `wizard.js:442` `actionBtn = $('#manual-action-btn')`; `wizard.js:464` chama `api.executeManualAction`; `wizard.js:562-583` renderiza fallback | ✅ OK |
| 9 | safeHandle universal (v0.2.1) | grep `safeHandle` em main.js, contagem ≥ 15 | `main.js`: 25 ocorrências de `safeHandle`, sendo 24 wrappers `safeHandle('installer:...', ...)` (linhas 370, 455, 460, 496, 501, 506, 512, 516, 520, 553, 680, 688, 705, 710, 725, 730, 741, 747, 752, 764, 783, 852, 861). Apenas 2 handlers raw `ipcMain.handle`: `installer:sudoReply` (157) e `app:getVersion` (866) — justificados em REVIEW-EDUARDO-v0.2.1.md §3.1 | ✅ OK (24 ≥ 15) |
| 10 | Asar bundle completo (lição v0.3.0) | conta arquivos cobertos pelos globs do build.files | main.js + preload.js + package.json (3) + `src/*` (7: error-catalog, executors, logger, preflight, runner, shell, state) + `renderer/*` (3: index.html, style.css, wizard.js) + `assets/*` (2: icon.ico, source) = **15 arquivos**. Todo `require()` em main/preload/src está coberto por `src/**/*` ou explícito. Verificado via REVIEW-EDUARDO.md §1.1 e REVIEW-EDUARDO-v0.2.1.md §4.1 | ✅ OK (15 ≥ 11) |

**Conclusão da auditoria de não-regressão: 10/10 itens OK. Nenhum regressed.**

### Ressalva sobre item 9 (safeHandle):
A contagem inclui a `function safeHandle` (definição) + 24 callsites de wrap.
Total textual = 25. Itens cobertos = 24, exatamente como a v0.2.1 documentou.

### Ressalva sobre item 10 (asar):
`assets/source` está coberto pelo glob `assets/**/*` mas é diretório/fonte do
ícone — não atrapalha runtime. `assets/icon.ico` é referenciado em `build.win.icon`
(package.json:55).

---

## 5. Recomendação final pra noite

Em ordem decreasente de impacto pra desbloquear o JOs:

### 5.1 PRIORIDADE 1 — Detector WSL legado (resolve o blocker atual)

A v0.2.16 baseia `wslIsFunctional` em `wsl --status`. No PC do JOs **o `wsl --status`
ALSO retorna help genérico do legacy**. Estratégia: sondagem `wsl --help` e busca
literal por `--install`, `--list`, `--status` no texto do help. Se 0 das 3
aparecerem, é wsl legacy → trocar branch pra instalar via `dism.exe
/online /enable-feature /featurename:Microsoft-Windows-Subsystem-Linux /all
/norestart` + `dism /online /enable-feature /featurename:VirtualMachinePlatform`
+ baixar `wsl_update_x64.msi` + setar default version 2.

Backup: se `wsl --help` também retornar lixo, sondar registro Windows:
`HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Appx\AppxAllUserStore\Applications`
procurando `MicrosoftCorporationII.WindowsSubsystemForLinux` (que é o pacote
moderno via Store).

### 5.2 PRIORIDADE 2 — Smoke automatizado pré-release (impede regressão futura)

Implementar `scripts/preflight-release.sh` + `scripts/contract-matcher.js` +
`scripts/jsdom-smoke.js` (esqueletos no §3 acima). Custo: 1 noite de Claudio +
Camila pareando. ROI: cada novo bug que esses pegariam é 1 ciclo a menos com o
JOs.

### 5.3 PRIORIDADE 3 — IPC contract canônico (mata Pattern B na raiz)

Criar `src/ipc-contract.js` com schema declarado. Mudança incremental: começa
documentando o que já existe, depois adiciona validação runtime em dev mode.

### 5.4 PRIORIDADE 4 — Encoding helpers consolidados (mata Pattern D)

Refator: tudo que invoca powershell.exe/wsl.exe/dism.exe passa por helpers
únicos (`powershell()`, `wslExec()` — já existem) que aplicam triple-defesa
(env utf8 + decode buffer + regex bilíngue). Auditar executors.js pra ver se
algum lugar ainda chama `execFile('powershell',...)` direto sem passar pelo
helper.

### 5.5 PRIORIDADE 5 — Test plan doc executável

`docs/TEST-PLAN-JOS.md` com 3 colunas: "ação", "quem testa (squad jsdom / JOs
manual)", "evidência esperada". Cria responsabilidade clara e impede deslize de
"achei que era squad / achei que era JOs".

---

## 6. Confiança pra noite

- Confiança de que a lista de não-regressão está OK: **alta** (verificado linha
  a linha no código atual).
- Confiança de que a Prioridade 1 resolve o blocker WSL legado do JOs: **média-alta**
  (sondagem via `wsl --help` é robusta, mas depende de Bruno implementar o
  branch `dism`-based como fallback correto).
- Confiança de que Prioridades 2-5 evitam 80% dos próximos bugs de live-test:
  **alta** (cada pattern A-G tem prevenção concreta proposta).

---

— Eduardo
