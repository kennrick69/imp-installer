# MARCOS — Arquitetura de Embarque do Runtime Linux-like

**Autor:** Marcos (arquiteto IMP Squad)
**Data:** 2026-05-27
**Fase:** 1 — decisão técnica pós-WSL
**Escopo:** COMO embarcar 500MB-1GB de runtime POSIX num .exe portable sem virtualização, com persistência, idempotência e atualização limpa.

---

## 0. Premissas herdadas do CONTEXTO-FASE1

- Zero virtualização (sem WSL2, sem Hyper-V, sem container engine)
- Runtime alvo: MSYS2 portable + node 20 + claude CLI + tmux + git + bash + coreutils
- 1GB+ aceitável, funciona offline
- Preservar 10 itens de não-regressão (sidebar 17 passos, UAC, asar, etc.)

Este doc assume que **Bruno validará MSYS2 portable como o runtime escolhido**. Se Bruno trocar (ex.: Cygwin), a arquitetura abaixo continua válida — só muda o conteúdo de `resources/runtime/`.

---

## 1. extraResources vs extraFiles — decisão e por quê

| Mecanismo | Onde vai | Sobrevive portable run? | Verdict |
|---|---|---|---|
| `extraResources` | `resources/` ao lado do `app.asar` | NÃO — extraído em `%TEMP%\<random-7zSFX>\resources\`, apagado ao fechar | Bom pra TRANSPORTAR |
| `extraFiles` | raiz do install dir | NSIS sim, **portable também some** | Não resolve sozinho |
| `asar.unpack` | dentro do asar, exposto descomprimido | Mesmo problema de `%TEMP%` | Inadequado pra binários grandes |

**Decisão arquitetural:**

> Usar `extraResources` pra EMBUTIR o runtime no .exe + **script de bootstrap (first-run) que copia o runtime de `process.resourcesPath` pra `%LOCALAPPDATA%\IMP-Squad-Runtime\<version>\` uma única vez**. Toda execução subsequente detecta a pasta persistente, pula a cópia, e usa direto de lá.

Isso é o padrão usado por VS Code Insiders portable, Cursor portable, Obsidian portable e outros — extrair-uma-vez-pra-AppData é canônico no ecossistema electron-builder portable.

---

## 2. Path resolution — runtime sempre conhecido

Variável de ambiente exposta pelo main process do Electron:

```
IMP_RUNTIME_HOME = %LOCALAPPDATA%\IMP-Squad-Runtime\<version>
IMP_RUNTIME_BIN  = %IMP_RUNTIME_HOME%\msys2\usr\bin
IMP_RUNTIME_VER  = arquivo .runtime-version dentro de IMP_RUNTIME_HOME
```

Toda chamada à squad (spawn de bash, tmux, claude) usa caminho **absoluto** via `IMP_RUNTIME_BIN` — nunca depende do PATH do usuário. Isso garante isolamento total.

Detecção em runtime:

```
if (existe IMP_RUNTIME_HOME && .runtime-version == app.version):
    skip cópia, reusa
elif (existe IMP_RUNTIME_HOME && .runtime-version != app.version):
    triggers upgrade flow (seção 6)
else:
    triggers first-install flow (seção 4)
```

---

## 3. Estrutura final do .exe — árvore completa

```
IMP-Squad-Setup-<version>.exe                  ← portable single-file 7zSFX
└─ (extração TEMP em runtime, transparente ao user)
   ├─ IMP-Squad.exe                            ← electron app principal
   ├─ resources/
   │  ├─ app.asar                              ← UI sidebar 17 passos, preflight, etc.
   │  ├─ app.asar.unpacked/                    ← módulos nativos (node-pty, etc.)
   │  └─ runtime/                              ← PAYLOAD do embarque (~600MB-1GB)
   │     ├─ .runtime-version                   ← string "1.0.0" (igual app.version)
   │     ├─ msys2/                             ← MSYS2 portable extraído (~500MB)
   │     │  ├─ usr/bin/
   │     │  │  ├─ bash.exe
   │     │  │  ├─ tmux.exe
   │     │  │  ├─ git.exe
   │     │  │  ├─ curl.exe, wget.exe
   │     │  │  ├─ coreutils (ls, cat, sed, grep, ...)
   │     │  │  └─ msys-2.0.dll
   │     │  ├─ mingw64/                        ← toolchain opcional
   │     │  ├─ etc/                            ← profile, fstab, pacman
   │     │  └─ tmp/, home/                     ← criados pelo setup.sh
   │     ├─ node/                              ← Node 20 LTS Windows x64 (~80MB)
   │     │  ├─ node.exe
   │     │  └─ npm.cmd, npx.cmd
   │     ├─ claude-cli/                        ← @anthropic-ai/claude-code pré-instalado (~50MB)
   │     │  ├─ node_modules/
   │     │  └─ bin/claude
   │     ├─ squad-seed/                        ← repos pré-clonados (~5MB)
   │     │  ├─ imp-squad/                      ← personas Camila/Marcos/Patricia/Bruno/...
   │     │  └─ imp-orchestrator/               ← tmux.js, fixes do live test
   │     └─ scripts/
   │        ├─ bootstrap.ps1                   ← cópia inicial pra LOCALAPPDATA
   │        ├─ setup.sh                        ← ajustes pós-cópia (paths, perms, ln -s)
   │        ├─ imp-squad.bat                   ← wrapper PATH-isolado
   │        └─ uninstall.ps1                   ← cleanup
```

**Tamanho estimado total do .exe:** ~700MB-1GB (7zSFX comprime MSYS2 bem, ~40-50% ratio).

---

## 4. Sequência de instalação NOVA — 5 steps (substitui WSL)

A sidebar de 17 passos é REORGANIZADA: os 12 passos antigos de WSL/virtualização viram 5 passos novos. Os passos comuns (preflight, GitHub auth, atalho, finalização) ficam.

| Step | Nome sidebar | O que faz | Duração típica |
|---|---|---|---|
| **01** | Preparar runtime | Detecta `IMP_RUNTIME_HOME`. Se ausente: copia `resources/runtime/*` → `%LOCALAPPDATA%\IMP-Squad-Runtime\<ver>\` via `bootstrap.ps1`. **Mostra barra de progresso real** (bytes copiados / total). | 30-90s |
| **02** | Configurar ambiente | Roda `setup.sh` dentro do bash embarcado: cria `/home/<user>`, ajusta `/etc/fstab`, gera `.bashrc`, registra IMP_RUNTIME_HOME, popula `~/.npmrc` apontando pro node embarcado, valida `tmux -V`, `git --version`, `node -v`, `claude --version`. | 5-10s |
| **03** | Autenticar GitHub | `gh auth login --device` (gh binary já no MSYS2) — opcional/pulável se squad-seed já tem repos. Token gravado em `%LOCALAPPDATA%\IMP-Squad-Runtime\<ver>\home\<user>\.config\gh\`. | 30-60s (manual) |
| **04** | Iniciar squad tmux | Cria session `imp` com 7 painéis: orchestrator + Camila + Marcos + Patrícia + Bruno + Sofia + JOs-console. Cada painel já roda `claude --resume` apontando pra persona correta. | 5s |
| **05** | Atalho e finalizar | Cria shortcut Desktop "IMP Squad" → `imp-squad.bat resume` (reabre tmux session existente ou cria nova). Registra Apps & Features. Marca instalação completa. | 2s |

Preflight, painel âmbar de avisos, modal-error, manual-step com Plano B — todos preservados (não-regressão).

---

## 5. Isolamento — zero conflito com instalação prévia do usuário

JOs pode ter git/node/python/tmux NATIVOS instalados. NÃO podemos quebrar isso.

**Estratégia: PATH local, nunca System PATH.**

```
imp-squad.bat (gerado em LOCALAPPDATA\IMP-Squad-Runtime\<ver>\scripts\):

@echo off
set IMP_RUNTIME_HOME=%LOCALAPPDATA%\IMP-Squad-Runtime\<ver>
set PATH=%IMP_RUNTIME_HOME%\msys2\usr\bin;%IMP_RUNTIME_HOME%\node;%IMP_RUNTIME_HOME%\claude-cli\bin;%PATH%
set MSYSTEM=MSYS
set HOME=%IMP_RUNTIME_HOME%\home\%USERNAME%
"%IMP_RUNTIME_HOME%\msys2\usr\bin\bash.exe" --login -i %*
```

- Variável `IMP_RUNTIME_HOME` é a ÚNICA env var "global" que o instalador toca, e ela vai em **HKCU\Environment** (user-level, não machine-level) — não exige admin pra setar/remover.
- System PATH continua intacto.
- O .bat **prepends** runtime ao PATH só dentro do processo filho, nunca persiste.

Conflito de DLL? MSYS2 carrega `msys-2.0.dll` por caminho absoluto, não vaza pra outros processos.

---

## 6. Atualização — versão N+1 do instalador

Esquema versionado: cada release vai pra subpasta própria.

```
%LOCALAPPDATA%\IMP-Squad-Runtime\
├─ 1.0.0\
├─ 1.1.0\           ← release nova coexiste
├─ current\         ← junction (mklink /J) apontando pra versão ativa
└─ backups\
   └─ 1.0.0-config-backup-20260601.zip
```

Fluxo de upgrade quando user roda instalador N+1:

1. Detecta `%LOCALAPPDATA%\IMP-Squad-Runtime\current\.runtime-version` = "1.0.0"
2. App version = "1.1.0" → upgrade necessário
3. Backup de pastas mutáveis: `home/<user>/.config/`, `home/<user>/.claude/`, `squad-seed/*/` → `backups\1.0.0-config-backup-<date>.zip`
4. Extrai `resources/runtime/*` → `1.1.0\` (cópia full, sem mexer em 1.0.0)
5. Migra configs: descompacta backup dentro de `1.1.0\home\<user>\`
6. Atualiza junction `current` → `1.1.0`
7. Atualiza `imp-squad.bat` pra apontar pra `1.1.0`
8. Mantém `1.0.0\` por 1 release como rollback (limpa na N+2)

Mesma versão? Skip cópia, só re-gera scripts/wrapper.

---

## 7. Cleanup — desinstalação limpa

`uninstall.ps1` (também gerado em LOCALAPPDATA + entry em Apps & Features):

1. Mata processos `bash.exe`, `tmux.exe`, `node.exe`, `claude.exe` dentro de `IMP_RUNTIME_HOME`
2. Remove tmux session `imp` (`tmux kill-session -t imp`)
3. Remove shortcut Desktop + Start Menu
4. Remove `HKCU\Environment\IMP_RUNTIME_HOME`
5. Remove entrada `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\IMP-Squad`
6. **Pergunta** ao user: "Manter configs/repos da squad? (Y/n)" — se N, apaga `%LOCALAPPDATA%\IMP-Squad-Runtime\` inteiro; se Y, mantém `home\<user>\` e `squad-seed\` num zip de backup
7. Apaga resto da pasta

---

## 8. Riscos arquiteturais — top 5

| # | Risco | Impacto | Mitigação |
|---|---|---|---|
| **R1** | **Cópia 1GB na 1ª execução = 30-90s de "tela branca"** | UX ruim, JOs pensa que travou | Barra de progresso REAL (bytes copiados / total) + texto "Preparando runtime (uma única vez, ~1 min)..." + spinner. NUNCA tela branca. |
| **R2** | **Antivírus (Defender, Kaspersky) escaneia 500MB de .exe/.dll novos = lentidão extrema ou quarentena** | Pode triplicar tempo de R1 ou bloquear bash.exe/tmux.exe como "suspeito" | Doc instala adiciona exclusão Defender opcional (PowerShell `Add-MpPreference -ExclusionPath`). Modal informativo se cópia >180s sugerindo exclusão. Binários MSYS2 oficiais são assinados — usar release oficial reduz falso-positivo. |
| R3 | LOCALAPPDATA redirecionado pra rede corporativa (roaming profile) | Cópia 1GB sobre rede = 5-15min | Detectar `[Environment]::GetFolderPath("LocalApplicationData")` apontando pra UNC path → modal-error com sugestão de mudar pra disco local OU usar `%PROGRAMDATA%` como fallback. |
| R4 | Symlinks MSYS2 (`/usr/bin/sh` → `bash.exe`) precisam `SeCreateSymbolicLinkPrivilege` | Em Windows não-Dev-Mode + non-admin = symlinks viram cópias = git/bash quebram | Habilitar Developer Mode silenciosamente no Step 02 (registry `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\AppModelUnlock\AllowDevelopmentWithoutDevLicense=1` — requer admin do UAC manifest que já temos) OU usar MSYS2 com `MSYS=winsymlinks:nativestrict` desligado (copies em vez de symlinks, +50MB). |
| R5 | tmux dentro de MSYS2 em terminal Windows não-pty = render quebrado | 7 painéis viram lixo visual | Usar `node-pty` (já em `app.asar.unpacked`) pra spawnar tmux com PTY real; renderizar dentro da janela Electron (xterm.js) — não depender de cmd.exe/conhost. |

**Top 2 destacados** (resposta resumida): **R1 (cópia 1GB demorada)** e **R2 (antivírus quarentenando binários POSIX)**.

---

## 9. Recomendação final

**Estrutura:** `extraResources/runtime/` com 4 sub-payloads (msys2, node, claude-cli, squad-seed) + scripts/. Cópia first-run pra `%LOCALAPPDATA%\IMP-Squad-Runtime\<version>\` via PowerShell com progresso real. Junction `current\` aponta pra ativa. PATH isolado via `imp-squad.bat`, nunca System PATH.

**Sequência de fases recomendada:**

- **Fase 1 (este doc + Bruno + Patrícia):** decisão MSYS2 ✅
- **Fase 2 (próxima):** Cláudio consolida; implementar `bootstrap.ps1` + `setup.sh` + electron-builder.yml com `extraResources: ["runtime/**/*"]`; reescrever 12 steps WSL pros 5 novos
- **Fase 3:** integrar `node-pty` + `xterm.js` pra renderizar tmux dentro da janela
- **Fase 4:** testar upgrade 1.0.0 → 1.1.0 ponta-a-ponta
- **Fase 5:** Patrícia roda matriz AV/AppLocker/disco-cheio/roaming-profile

**Não negociável:**

1. Cópia first-run NUNCA usa `%TEMP%` como destino persistente
2. PATH do user permanece intocado
3. Toda invocação de bash/tmux/claude usa caminho absoluto via `IMP_RUNTIME_HOME`
4. Barra de progresso real em todos os passos >5s
5. Cada release vai em subpasta versionada (coexistência > substituição destrutiva)

---

*Fim do MARCOS-EMBARCAR.md*
