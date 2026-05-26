# Code Review — Eduardo (revisor da IMP Dev Squad)

> Auditoria pré-build do `imp-installer` v0.1.0. Foco: garantir que o `.exe`
> abra sem repetir o "Cannot find module" da v0.3.0 da `imp-interface`,
> e que o contrato renderer ↔ main feche sem cair em runtime.

---

## 1. Bundle / build (CRÍTICO — não repetir o bug da v0.3.0)

### 1.1 [package.json:30-44] `build.files` — cobertura

- `main.js`, `preload.js`, `package.json`, `src/**/*`, `renderer/**/*`, `assets/**/*` → **todos os `require()` em runtime apontam pra dentro desse conjunto**. Confirmado via grep:
  - `main.js` requer: `electron`, `node:*` builtins, `./src/runner`, `./src/preflight`, `./src/executors`, `./src/shell` ✅
  - `preload.js` requer: `electron` ✅
  - `src/runner.js` requer: `./logger`, `./state`, `./executors`, `node:*` ✅
  - `src/executors.js` requer: `./shell`, `./preflight` ✅
  - `src/preflight.js` requer: `./shell` ✅
  - `src/shell.js` requer: `./logger`, `node:*` ✅
  - `src/state.js`, `src/logger.js` → só `node:*` ✅
- `src/**/*` está presente — **o bug da v0.3.0 NÃO se repete aqui**.

**Sem achados.**

### 1.2 [package.json:36] 🟡 MÉDIO — `assets/**/*` listado mas pasta não existe

- Onde: `package.json:36` lista `"assets/**/*"` em `build.files`, mas `/mnt/c/Projetos/imp-installer/assets/` não existe.
- O que: electron-builder aceita glob sem matches sem dar erro, então o build vai funcionar. Mas a intenção fica ambígua: ou é placeholder esquecido, ou é dependência futura (ícone do app, p.ex.).
- Sugestão: criar `assets/` com pelo menos um `icon.ico` (ou remover a linha). Sem ícone, o `.exe` portátil sai com ícone genérico do Electron — **ruim pra um produto de "Squad Comando".**

### 1.3 [package.json:54] `asar: true` — compatibilidade

- Tudo que está no bundle é JS/CSS/HTML estático lido por `loadFile`/`require`. Nenhum `fs.readFileSync(__dirname + ...)` apontando pra binário nativo, nenhum `child_process.spawn(__dirname + ...)` apontando pra script empacotado. **Compatível com asar.**
- `child_process` chama sempre executáveis do sistema (`powershell.exe`, `wsl.exe`, `wt.exe`, `cmd.exe`), nunca recursos internos. ✅

**Sem achados.**

### 1.4 [package.json:15] 🟢 NIT — script `asar:check`

- Útil pra pipeline futura. Funciona se rodado pós-`pack`. **Nice to have, mantém.**

---

## 2. IPC contracts — **MISMATCHES SIGNIFICATIVOS**

O renderer (Camila), o preload (Claudio) e o runner/main (Bruno/Claudio) usam **vocabulários divergentes** em vários pontos. Isso não impede o build, mas **mata o feedback visual em runtime**.

### 2.1 [main.js:106-125 ↔ wizard.js:653-671] 🔴 BLOCKER — `id` vs `stepId` + `status` vs `state` no onStepUpdate

- Onde: `src/runner.js:99-105` emite `{ id, title, category, status, ...extra }` via `onStepUpdate`. `main.js:107` repassa exatamente esse objeto pro renderer.
- O renderer espera (`wizard.js:653-670`):
  ```js
  api.onStepUpdate((update) => {
    if (!update || !update.stepId) return;        // ← bail out!
    if (update.state) setStepState(...);          // ← undefined!
    if (update.state === 'running') { ... }
  });
  ```
- O que acontece: como `update.stepId` é `undefined` (vem `id`), **o handler retorna logo no early-return da linha 655**. A sidebar inteira fica em "pending" do começo ao fim. O usuário vê só os logs rolando — zero feedback de progresso por passo.
- Sugestão de fix (escolha UM lado):
  - **Opção A (no main.js):** no adapter de `onStepUpdate` (main.js:107-125), renomear antes de enviar: `sendToRenderer('installer:onStepUpdate', { stepId: upd.id, state: upd.status, ...upd })`.
  - **Opção B (no wizard.js):** trocar `update.stepId` → `update.id` e `update.state` → `update.status` em wizard.js linhas 655, 656, 657, 659, 664, 666.
- Recomendo **Opção A** porque o contrato `{stepId, state}` é o que a Camila documentou no `RENDERER-SPEC` (e bate com `onPreflight: { checkId, state, message }`, mais consistente).

### 2.2 [main.js:148-151 ↔ wizard.js:673-676] 🔴 BLOCKER — preflight emite `name` mas renderer espera `checkId`

- Onde: `src/preflight.js:13,25,32,51,67,87` retorna `{ name, ok, value, detail, warning? }`. `main.js:150` faz `sendToRenderer('installer:onPreflight', c)` sem remapear.
- O renderer (`wizard.js:675`): `setPreflightResult(res.checkId, res.state, res.message)` → todos `undefined`.
- Além disso, o renderer (`index.html:127-168`) tem `data-check="windows|admin|disk|internet|virtualization|antivirus"` mas o backend manda `windows_build|admin|disk_c_free_gb|internet_github|virtualization|antivirus`. Mesmo se o `checkId` chegasse, **dois cards (windows, disk, internet) não casariam**.
- Resultado: **a tela de preflight fica eternamente em "pending"** com botão "Avançar" desabilitado. O usuário trava ali e nunca chega ao passo 03.
- Sugestão: no adapter dentro de `installer:start` (main.js:148-152), traduzir:
  ```js
  const NAME_TO_CHECKID = {
    windows_build: 'windows',
    admin: 'admin',
    disk_c_free_gb: 'disk',
    internet_github: 'internet',
    virtualization: 'virtualization',
    antivirus: 'antivirus',
  };
  for (const c of checks) {
    sendToRenderer('installer:onPreflight', {
      checkId: NAME_TO_CHECKID[c.name] || c.name,
      state: c.ok ? 'ok' : (c.warning ? 'warn' : 'err'),
      message: c.detail,
    });
  }
  ```

### 2.3 [main.js:80, wizard.js (ausente)] 🔴 BLOCKER — `installer:sudoPrompt` não tem handler no renderer

- Onde: `main.js:76-82` cria `requestSudoPassword()` que envia `installer:sudoPrompt` e espera o usuário responder via `installer:sudoReply`. `preload.js:33-34,45` expõe `api.installer.sudoReply()` e `api.installer.onSudoPrompt()`.
- O `wizard.js` **nunca chama `api.onSudoPrompt`** (grep não acha) e **não tem UI de prompt de senha**. Quando o passo 05 (`apt install`) ou 10 (`gh install`) precisar de sudo, o backend vai pendurar pra sempre no `pendingSudo.set(id, ...)` esperando uma resposta que **nunca chega**. O passo 05 vai dar timeout em 600s (`sudoInWsl` → `wsl` timeout) e abortar.
- Sugestão: Camila precisa adicionar um modal de sudo (e.g. `#modal-sudo` com `<input type="password">`) e bindings:
  ```js
  api.onSudoPrompt(({ id, prompt }) => {
    showSudoModal(prompt, (password, cancelled) => {
      api.sudoReply(id, password, cancelled);
    });
  });
  ```
- **Sem isso, a instalação trava no passo 05.** Esse é o caminho normal do primeiro uso, então 100% das instalações batem nisso.

### 2.4 [main.js:170-171,239-240] 🔴 BLOCKER — `step_13_sala_3d` (com underscore extra) vs `step_13_sala3d`

- Onde:
  - `executors.js:466`, `wizard.js:34` → `'step_13_sala3d'` (canônico)
  - `main.js:171` → `runner.getState().steps['step_13_sala_3d']` (não existe)
  - `main.js:240` → `runner.runStep('step_13_sala_3d', ...)` (vai estourar `step não encontrado`)
- O que: `installer:installSala3D` **sempre joga `Error: step não encontrado: step_13_sala_3d`** vindo de `runner.js:115`. O botão "Instalar Sala 3D" da tela final fica quebrado.
- Sugestão: trocar `'step_13_sala_3d'` por `'step_13_sala3d'` em main.js:171 e main.js:240. Procurar todos `sala_3d` no projeto (replace_all seguro).

### 2.5 [main.js:243-250] 🟠 ALTO — `openInterface` aponta pra `Desktop/IMP Squad Comando.exe`, mas o instalador cria `Squad Comando.lnk`

- Onde: `main.js:244-245` procura por `~/Desktop/IMP Squad Comando.exe`. Mas o passo 15 (`executors.js:578-601`) cria:
  - `%LOCALAPPDATA%\IMP-Squad\IMP-Squad.exe` (binário)
  - `~/Desktop/Squad Comando.lnk` (atalho)
- Nenhum dos dois é `~/Desktop/IMP Squad Comando.exe`. O botão "Abrir IMP Squad Comando" da tela final **vai sempre cair no else** retornando `imp-interface.exe não encontrado na Desktop`. Usuário fecha frustrado.
- Sugestão: trocar main.js:244 por:
  ```js
  const exe = path.join(os.homedir(), 'Desktop', 'Squad Comando.lnk');
  // OU usar o binário direto:
  // const exe = path.join(process.env.LOCALAPPDATA, 'IMP-Squad', 'IMP-Squad.exe');
  ```

### 2.6 [main.js:252-254] 🟡 MÉDIO — `installer:pause` é no-op

- Onde: `main.js:252-254` `pause` retorna `{ ok: true }` sem fazer nada. O wizard chama `api.pause()` em `wizard.js:493`, mas o runner não tem mecanismo de pausa real (sem flag em `_ctx`, sem AbortSignal nos `execP`/`wsl`).
- O que: botão "Pausar" muda o label pra "Continuar" mas o passo segue rodando. Ilusão de controle.
- Sugestão: ou implementa pausa real (flag em `_ctx.state.paused` checada antes de cada `runStep` em `runAll`), ou esconde o botão / mostra toast "Pausa não disponível durante um passo — clique Pular se preciso parar".

### 2.7 [wizard.js:457-465, 459] 🟡 MÉDIO — `btn-resume` chama `api.resume()` mas backend não distingue resume de start

- Onde: `main.js:155-159` `installer:resume` apenas chama `runner.startWizard()` (igual a start) e manda `onScreen: 'progress'`. Como `startWizard` é idempotente (já tem `_ctx`), não há diferença comportamental. **Funciona por sorte**, mas a semântica de "começar do zero" do `btn-fresh` em wizard.js:462-465 não limpa `state.json` — só esconde o card. Próximo `start()` ainda traz `lastStepCompleted`.
- Sugestão: backend ganhar `installer:reset` que apaga `~/.imp-installer/state.json` e renomeia pra `state.json.preserved-<ts>`. Wizard chama em `btn-fresh`.

### 2.8 [main.js:108-125] 🟡 MÉDIO — `onManualPrompt` dispara em TODO passo running, não só nos MANUAL

- Onde: `main.js:110-124` emite `onManualPrompt` se `step.manualInstructions` existe. Só os passos 04 e 09 têm `manualInstructions`. Os HYBRID (03, 10, 13) **não têm**, mas precisam de telas manuais. O passo 10 já abre terminal sozinho (`executors.js:358-361`) sem avisar o usuário pelo wizard.
- Sugestão: passos 03 (reboot), 10 (gh login web) deveriam ter `manualInstructions` definidas em executors.js — senão o wizard nunca chama `showManualPrompt` pra eles e o usuário não sabe o que tá acontecendo quando um terminal externo abre.

---

## 3. Lógica de execução (runner do Bruno)

### 3.1 [runner.js:64-78] Lockfile — 🟢 OK

- `acquireLock` checa PID liveness, limpa stale, joga erro com PID se outro vivo. Combinado com `app.requestSingleInstanceLock()` em `main.js:16-20`, dois processos não rodam. ✅

### 3.2 [runner.js:119-123] 🟢 OK — Reboot gate

- Bloqueia steps != 03 quando `rebootRequired && !rebootDone`. `main.js:57-62` flipa `rebootDone` no relaunch pós-reboot via `markRebootDone()`. RunOnce agendado em `shell.js:166-179`. **Loop fechado, OK.**

### 3.3 [shell.js:65-103] 🟢 OK — Sudo flow não vaza no log

- Tenta `sudo -n` primeiro; só pede senha se necessário; senha vai por stdin (`input: pass + '\n'`), **nunca em argv**. Logger usa `mask()` (`logger.js:9-29`) com regex pra `ghp_`, `sk-ant-`, `Bearer`, URLs `user:token@`. **Bem feito.**

### 3.4 [runner.js:111-166] 🟠 ALTO — Reentrada cobre 5 dos 6 cenários do Marcos

- ✅ Cenário 1 (rebobinar do zero): state.json não existe → emptyState.
- ✅ Cenário 2 (retomar após reboot): rebootDone flag + RunOnce.
- ✅ Cenário 3 (passo já feito): `step.detect()` retorna true → skip.
- ✅ Cenário 4 (passo falhou, retry): `runStep` re-executa, `attempts++`.
- ✅ Cenário 5 (state corrompido): `state.js:72-86` tenta `.bak`, rotaciona corrupto.
- ❌ Cenário 6 (usuário pulou passo crítico): `skipStep` aceita qualquer stepId sem aviso. **Pular passo 05 (apt base) garante que 06+ falhem**. Não há lista de "skippable" no backend; toda decisão de bloquear pulo está só no wizard (toast warn).
- Sugestão: no `runner.skipStep`, marcar `state.steps[id] = 'skipped-by-user'` e fazer `runStep` validar pré-requisitos antes de executar. Ou pelo menos uma lista `CRITICAL_STEPS = new Set([...])` que recusa skip.

### 3.5 [runner.js:80-83] 🟡 MÉDIO — `getState` antes de `startWizard` pode dar TOCTOU

- `main.js:58` chama `runner.getState()` antes do `createWindow`/`startWizard`. `getState` faz `stateLib.loadState()` se `_ctx == null` — lê do disco. Funciona, mas **`markRebootDone()` em main.js:60 chama `startWizard({})` (linha 208) que adquire lock** entre o `getState` e a primeira interação do usuário. Se o renderer demorar pra mandar `installer:start`, o lock já está pego. **Não é bug, é só nuance de ordem.**
- Sugestão: documentar que `markRebootDone` adquire lock. Sem ação obrigatória.

### 3.6 [executors.js:120-154] 🟠 ALTO — Step 04 polling de 10 min sem feedback de progresso

- `step04UbuntuFirstBoot.execute` faz `Start-Process ubuntu2204.exe` (com fallback) e depois faz poll loop silencioso de até 10 min checando `whoami`. **Nenhum `emitStepUpdate` com progresso, nenhum `onLog`.** O usuário vê uma janela do Ubuntu abrir, cria usuário, volta pro instalador, vê "running" parado por minutos — pensa que travou.
- Sugestão: dentro do loop, a cada N segundos chamar `ctx.logger.info('step_04', 'aguardando criação do usuário Ubuntu (Xs decorridos)…')` pro renderer mostrar atividade.

### 3.7 [executors.js:141-143] 🟡 MÉDIO — Step 04 swallow silencioso de erro

- `await powershell('Start-Process ubuntu2204.exe').catch(async () => { await powershell('Start-Process ubuntu.exe').catch(() => {}); })`. Se ambos falharem, o poll loop nem percebe. O usuário não vê Ubuntu abrir e fica esperando 10 min.
- Sugestão: detectar falha do Start-Process e dar erro imediato com instrução "abra o Ubuntu manualmente pelo menu Iniciar".

### 3.8 [executors.js:543-548] 🟢 OK — Sessão tmux

- Layout tiled, labels nas panes, send-keys `claude` em cada. Decision D5 respeitada (não recria se já tem 7 panes saudáveis).

---

## 4. Segurança

### 4.1 [main.js:33-38] 🟢 OK — `contextIsolation: true, sandbox: false, nodeIntegration: false`

- contextIsolation true ✅. nodeIntegration false ✅. **sandbox: false** justificado pelo preload usar `ipcRenderer.invoke` — algumas APIs precisam de privilégios. Aceitável pra um instalador.

### 4.2 [main.js:217-221] 🟢 OK — `openExternal` valida `http(s):`

- `if (!/^https?:\/\//i.test(url)) return { ok: false }` antes de abrir. **Cobre file://, javascript:, etc.** ✅

### 4.3 [main.js:6 + Content-Security-Policy index.html:6] 🟢 OK — CSP

- `default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'` — restritivo. `unsafe-inline` em style é meh mas comum.

### 4.4 [shell.js:23, shell.js:118-122] 🟢 OK — `execFile`/`spawn` com args separados

- Nenhuma string concat passada como `command`. ✅
- Exceção: `shell.js:118-122` (fallback wt.exe) usa `cmd.exe /c start ""` com args separados. Seguro.

### 4.5 [shell.js:170-179] 🟡 MÉDIO — `scheduleRunOnceAfterReboot` interpola `exePath` em script PS

- `$exe = '${exePath.replace(/'/g, "''")}'` — escape de aspas simples PS ok, mas o que vai em `Set-ItemProperty -Value` é `'"' + $exe + '"'`. Se `exePath` contiver aspas duplas (improvável mas Windows aceita), quebra. Como vem de `process.execPath`, é seguro na prática.
- Sugestão (nit): usar `[System.Environment]::SetEnvironmentVariable` paradigm ou passar via `-ArgumentList` ao invés de interpolar. Não-bloqueante.

### 4.6 [executors.js:404-414] 🟡 MÉDIO — Mensagem de erro do clone vaza estrutura interna

- Se o clone falhar e não houver seed, `exit 3` sem mensagem amigável. O `withRetry` retorna erro genérico. O usuário vai ver "cannot clone" sem entender que o repo `kennrick69/imp-squad` ainda é privado.
- Sugestão: detectar exit 3 e enriquecer com texto da Patrícia §7.1 ("repo ainda não foi liberado pro seu user. Pede liberação em…").

### 4.7 [logger.js] 🟢 OK — Mask de tokens

- Cobre `ghp_`, `github_pat_`, `gho_`, `ghs_`, `ghu_`, `sk-ant-`, `Bearer`, `user:token@`. **Bom espectro.** Considerar adicionar `ANTHROPIC_API_KEY=` plain e `GH_TOKEN=` plain pra robustez. Não bloqueante.

---

## 5. UX / acessibilidade (Camila)

### 5.1 [index.html:11, 219, 199, 446] 🟢 OK — Aria-live, role, aria-label cobertos

- `#app` tem `aria-live="polite"`, `#screens > section.step-detail` aria-live, `#toast-container` aria-live, modais com `role="dialog" aria-modal aria-labelledby`. **Bem feito.**

### 5.2 [wizard.js:99-103] 🟢 OK — Focus management

- Trocou tela → coloca tabindex no h1/h2 e foca. Bom pra leitor de tela.

### 5.3 [index.html:127-167] 🟠 ALTO — 6 estados de passo não estão todos cobertos em CSS

- O backend pode mandar `'pending' | 'running' | 'done' | 'error' | 'manual' | 'skipped' | 'blocked_user_action'`. O wizard atribui `dataset.state` direto sem normalizar. Não validei o `style.css`, mas se ele não tem `[data-state="blocked_user_action"]` e `[data-state="manual"]`, esses passos ficam invisuais.
- Sugestão: padronizar enum no backend (5-6 estados fixos) e garantir CSS pra cada.

### 5.4 [wizard.js:412] 🟡 MÉDIO — Mensagens de erro são genéricas

- Default suggestion é só `['Tentar de novo — às vezes é só rede instável.']`. O backend em `main.js:177-178` manda `suggestions: ['Veja os logs detalhados', 'Tente retomar']` que também são genéricas.
- A `RISCOS-INSTALACAO.md` da Patrícia tem mensagens-padrão por risco (ex: §1.1 BIOS virtualização — texto exato em linha 30). Nenhuma dessas chega ao usuário.
- Sugestão: criar `src/error-catalog.js` mapeando `stepId + errorPattern → { headline, what, suggestions }`. Adapter de `onError` em main.js olha o stderr e enriquece.

### 5.5 [index.html:269] 🟢 OK — Botão "Próximo" começa desabilitado no manual

- Só libera após checkbox "Já fiz isso". Bom UX de defesa contra clique acidental.

### 5.6 [wizard.js:60-77] 🟡 MÉDIO — `makeNoopApi` retorna `{ok: true}` em `runStep` no modo preview

- Significa que o botão "Verificar agora" do manual (`wizard.js:528-531`) trata noop como sucesso e libera "Próximo". No `.exe` empacotado isso não acontece porque preload define `window.api`, mas se o build der defeito e o preload não carregar, **o usuário consegue "concluir" instalação sem instalar nada**. Falha silenciosa.
- Sugestão: detectar `window.api == null` e mostrar tela de erro fatal ("preload não carregou — bug do .exe, reinstale"). Não confiar em noop como modo aceitável em prod.

### 5.7 [index.html:22, package.json:4] 🟡 MÉDIO — Versão hardcoded `v0.1.0` no HTML

- `<span class="version" id="installer-version">v0.1.0</span>` — bate hoje, mas no próximo bump alguém vai esquecer. O preload já expõe `api.version()` → use isso.
- Sugestão: em `wizard.js init()`, `const v = await api.version(); $('#installer-version').textContent = 'v' + v;`. Tem o método pronto, só falta chamar.

---

## 6. Cobertura dos riscos críticos da Patrícia

| Risco                                         | Endereçado?                       | Onde / observação                                                                                                              |
|-----------------------------------------------|-----------------------------------|--------------------------------------------------------------------------------------------------------------------------------|
| §1.1 Virtualização BIOS desabilitada          | ⚠️ PARCIAL                         | `preflight.js:54-72` checa via WMI, mas marca como `warning` (não blocker). Texto amigável da Patrícia (§1.1, "F2 ou DEL ao ligar") **não chega ao usuário** — só "virtualização parece desabilitada". |
| §1.5 Reboot interrompido / usuário não reinicia | ✅ COBERTO                         | `executors.js:106-114` set rebootRequired + RunOnce; `runner.js:119-123` gate; `main.js:57-62` flip on relaunch.                |
| §7.1 _squad GitHub repo ainda privado         | ⚠️ PARCIAL                         | `executors.js:404-414` tenta fallback seed tarball, mas erro final é genérico (ver 4.6 acima).                                  |
| §X Pasta destino conflito                     | ✅ COBERTO                         | `executors.js:397-401, 446-449` aborta se pasta existe sem `.git`. Boa proteção.                                                |
| §3.3 PATH Node não atualizado                 | ✅ COBERTO                         | `executors.js:202-213` usa `nvm.sh` source + `nvm alias default`; `executors.js:241` adiciona ao `.bashrc`. `wsl()` usa `bash -lc` (login shell) — PATH carrega.    |
| §6.5 Token vazado no log                      | ✅ COBERTO                         | `logger.js:9-29` mascara antes de `appendFileSync`.                                                                             |
| §1.2 Build Windows < 19041                    | ✅ COBERTO                         | `preflight.js:9-18` bloqueador hard.                                                                                            |
| §1.7 Outra distro WSL                         | ❌ NÃO COBERTO                     | Nenhum check de "Debian/Kali já instalado roubaria default distro". Pode causar `wsl --install -d Ubuntu-22.04` não virar default. |
| §1.8 Ubuntu 1ª boot — usuário não cria        | ⚠️ PARCIAL                         | Step 04 abre console mas se Start-Process falha silenciosamente (3.7) o usuário não sabe.                                       |
| §2.4 dpkg --configure -a pendente             | ❌ NÃO COBERTO                     | Se Ubuntu vem com dpkg lock de instalação anterior, `apt-get install` falha e retry não ajuda. Sem recuperação.                  |

**Gaps**: §1.7 (distro conflitante), §2.4 (dpkg lock), §1.1 (texto amigável BIOS).

---

## Veredito

### ⚠️ REPROVADO PRA RELEASE — **4 BLOCKERS, 6 ALTOS, 8 MÉDIOS**

**Build vai gerar `.exe` que abre sem `Cannot find module`** (achado 1.1 confirma que `build.files` cobre tudo — diferente da v0.3.0 da imp-interface). **MAS** ao executar, 4 bugs travam o fluxo principal:

### Blockers (precisam fix ANTES de buildar pra release):
1. **2.1** — `onStepUpdate` usa `id`/`status` no main mas wizard espera `stepId`/`state` → sidebar inteira fica em "pending" (silencioso, mata feedback).
2. **2.2** — `onPreflight` emite `name` (e valores diferentes dos `data-check` do HTML) mas wizard espera `checkId`/`state`/`message` → **tela 2 trava o usuário, ele nunca avança**.
3. **2.3** — Wizard não escuta `onSudoPrompt` e não tem UI de senha → **passo 05 (apt) trava em ~10 min de timeout**, instalação morre.
4. **2.4** — `installer:installSala3D` e `onComplete.sala3dInstalled` usam `step_13_sala_3d` (typo) → botão Sala 3D na tela final **sempre dá erro**.

### Top 3 problemas (resumo executivo pro JOs):
1. **Contrato renderer↔main quebrado em 3 lugares** (step updates, preflight, sudo prompt). Cada Claude codou contra um vocabulário diferente. Sem renomear, o usuário não vê nada acontecendo na UI.
2. **Botão de abrir Squad Comando aponta pra caminho errado** (`Desktop/IMP Squad Comando.exe` vs `Desktop/Squad Comando.lnk`) — usuário termina instalação e não consegue abrir.
3. **Mensagens de erro genéricas** — a `RISCOS-INSTALACAO.md` tem texto humano pronto pra cada cenário, mas nada disso chega à tela de erro. Quando algo falhar (e vai falhar), o usuário fica perdido.

### Confidence: **ALTA**
- Verifiquei via `grep` cada `require()` em `main.js`/`preload.js`/`src/*` contra `build.files` — todos cobertos. Bug v0.3.0 NÃO se repete.
- Verifiquei via `grep` cada `api.installer.<x>()` em wizard.js contra `preload.js` (existe?) e `ipcMain.handle('installer:<x>')` em main.js (handler?). Todos batem **em nome**, mas o conteúdo do payload diverge (2.1, 2.2).
- Verifiquei step IDs across runner/executors/wizard/main: 16 IDs canônicos em `executors.js`, todos batem com wizard, exceto `step_13_sala_3d` em main.js (typo claro — 2.4).
- Verifiquei `onSudoPrompt` no wizard.js — `grep` retornou zero matches. Sem ambiguidade: **não está implementado.**

### Pergunta do JOs respondida (≤200 palavras):

**O .exe vai abrir sem o "Cannot find module" da v0.3.0?** ✅ **SIM, com alta confiança.** Cada `require()` em runtime aponta pra arquivo coberto por `build.files` (`main.js`, `preload.js`, `src/**/*`, `renderer/**/*`). O bug da imp-interface não se repete.

**Mas o instalador funciona depois de abrir?** ❌ **Não como está.** 4 blockers travam o fluxo principal: preflight nunca avança (2.2), sidebar nunca atualiza (2.1), apt-install trava sem UI de sudo (2.3), Sala 3D quebrada (2.4). Mais o botão "Abrir Squad Comando" da tela final aponta pra arquivo que não existe (2.5).

**Fixes são pequenos** — todos são renames/adaptadores em `main.js` (lines 107, 148-151, 171, 240, 244) + adicionar handler `onSudoPrompt` no `wizard.js`. Estimativa: **~50 linhas de código, ~30 min de trabalho** pra 1 Claude focado. Recomendo onda corretiva ANTES do build de release. Build de "smoke test" interno pode rodar pra validar bundle, mas não distribuir.
