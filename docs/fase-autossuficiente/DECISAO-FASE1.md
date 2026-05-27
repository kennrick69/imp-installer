# 🎯 Decisão técnica FASE 1 — caminho escolhido

## Escolha: **MSYS2 portable embarcado + Claude CLI nativo Windows**

### Por quê (com evidência empírica)

**Bruno testou**: MSYS2 portable viável.
- Download base: 51,8 MB (.tar.zst)
- Extraído: 317 MB (487 binários POSIX, sem tmux/git/node ainda)
- + tmux 3.6 + git 2.54 + node 24 + claude CLI = **~680 MB embarcado** (~250-300 MB comprimido .7z)
- Licença BSD: redistribuição binária livre, sem royalty
- Pasta `msys64` é portável entre máquinas (se não rodarmos `pacman -Syu` depois)
- **NÃO precisa de virtualização** ✓
- **NÃO precisa de reboot** ✓

**Nuance crítica**: claude CLI **dentro** do shell MSYS2 está oficialmente quebrado (issue #9883). Solução: claude.exe nativo Windows + `CLAUDE_CODE_GIT_BASH_PATH` aponta pro bash do MSYS2. MSYS2 fornece tmux/git/bash/node, claude.exe é Windows-native.

### Arquitetura (Marcos)
```
IMP-Squad-Setup-X.X.X.exe (~700MB-1GB)
└─ resources/runtime/
   ├─ msys2/usr/bin/{bash,tmux,git,curl,coreutils}
   ├─ node/{node.exe,npm}
   ├─ claude-cli/ (pré-instalado, Windows native)
   ├─ squad-seed/{imp-squad,imp-orchestrator}
   └─ scripts/{bootstrap.ps1, setup.sh, imp-squad.bat}
```

Primeira execução: copia pra `%LOCALAPPDATA%\IMP-Squad-Runtime\<version>\current\` (30-90s com barra de progresso). PATH **isolado** via wrapper `imp-squad.bat`, ZERO poluição no System PATH.

### Sequência nova: 5 steps (em vez dos 17 do WSL)
1. **Preparar runtime** — copia 600MB-1GB pra LOCALAPPDATA (barra real)
2. **Configurar ambiente** — `setup.sh` cria HOME, .bashrc, valida tmux/git/node/claude
3. **Autenticar GitHub** — `gh auth login --device` (opcional/pulável se seed tem repos)
4. **Iniciar squad tmux** — session `imp` com 7 painéis claude
5. **Atalho Desktop** — shortcut pra reabrir sessão tmux + interface

### Riscos novos (Patrícia mapeou 27)
**Top 5 críticos**:
1. **AV real-time scan** trava extração de 50K arquivos (5-15min) → empacotar como UM `.7z` sólido, extrair temp+mover
2. **AV quarentena `tmux.exe`/`nc.exe`** como hacktool → `Add-MpPreference -ExclusionPath` proativo + UAC
3. **AppLocker corporativo** bloqueia LOCALAPPDATA → detectar via `Get-AppLockerPolicy`, fallback PROGRAMDATA
4. **Espaço em disco** — pre-check obrigatório no drive-destino, oferecer alternativo
5. **Symlinks** sem privilégio viram cópias → empacotar runtime "achatado" (2-3GB) por padrão, evita admin

### Lista o que SOME (vs WSL)
- ❌ Virtualização BIOS (Pattern G)
- ❌ Reboot obrigatório (Pattern G)
- ❌ wsl --update / Store / MSI download (Pattern A+D)
- ❌ UTF-16 mojibake do wsl.exe (Pattern D)
- ❌ Detecção legacy vs modern (Pattern F)
- ❌ Encoding pt-BR no UAC do WSL (Pattern D)
- ❌ Distro name discovery (Pattern F)
- ❌ RunOnce pra retomar pós-reboot (Pattern G)
- ❌ ~10 dos 23 cenários antigos da Patrícia

### Lista o que GANHA
- ✅ Funciona OFFLINE
- ✅ Funciona em qualquer Win10+ sem precisar features especiais
- ✅ JOs sai do "21 versões" instantâneo
- ✅ Reproduzível 100% (mesmo runtime em toda máquina)

### Veredito Patrícia
**Aposta CORRETA pro JOs (PC pessoal BR)**. Risco GLOBAL cai. Concentração nova em AV/EDR/AppLocker — mas mitigável com `.7z` sólido + UAC + detecção.

---

## FASE 2 — Implementação

### Quem faz o quê
- **Bruno**: reescreve executors.js com 5 novos steps + helpers (cópia c/ progresso, AV-detect, AppLocker-detect, AppLocker-fallback)
- **Camila**: redesenha sidebar (17 → 5 steps), tela "copiando runtime" com progresso real, tela "AV exclusion"
- **Marcos**: pipeline de build `build-runtime.ps1` (download MSYS2 + pacman + claude + seed + .7z)
- **Patrícia**: smoke test do novo fluxo + cenários novos
- **Eduardo**: review pré-release + não-regressão das 10 funcionalidades preservadas
- **Claudio**: integração + build + release

### Pendência infra
Pra gerar o pacote runtime (.7z ~250MB), precisa rodar em Windows real (pacman é Windows). Vou criar **`scripts/build-runtime.ps1`** que JOs roda 1x numa máquina Windows pra gerar `runtime/runtime.7z` que vira `extraResources` do .exe.

OU usar GitHub Actions Windows runner pra gerar como release asset.

### Não-regressão (10 itens — todos preservar)
janela maximizada, sidebar (agora 5 passos), UAC manifest, preflight feedback, painel avisos âmbar, log UTF-16, modal-error sugestões, telas manual c/ botão+plano B, safeHandle universal, asar bundle.
