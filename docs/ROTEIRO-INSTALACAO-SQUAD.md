# ROTEIRO DE INSTALAÇÃO — IMP Dev Squad (Windows zerado)

Autor: Marcos (arquiteto)
Data: 2026-05-26
Status: **v1 ratificado** — 8 decisões pendentes resolvidas por Claudio (autonomia §8); ver §8.

> Mudanças pós-rascunho:
> - Repo `_squad` no GitHub foi nomeado **`imp-squad`** (GitHub bloqueia repos começando com `_`). Todos os comandos `git clone .../_squad.git` neste doc devem usar `.../imp-squad.git`, mas a pasta local continua `_squad` (a interface e a squad esperam esse path).

---

## 1. Visão geral

O instalador é um `.exe` Windows (Electron) que sai de **PC zerado** e chega em **sessão tmux `imp` rodando com 7 Claudes + interface conectada**. Ele alterna entre rodar comandos PowerShell (lado Windows) e injetar comandos via `wsl.exe -e bash -lc "..."` (lado Ubuntu). Cada passo é **idempotente** (rodar 2x não quebra), **detectável** (sabe se já tá feito) e **reentrante** (se o PC reiniciar no meio, retoma do ponto certo via `~/.imp-installer/state.json`).

---

## 2. Pré-requisitos

| Item | Mínimo |
|---|---|
| SO | Windows 10 21H2+ ou Windows 11 x64 |
| Conta | Usuário com privilégio de Administrador (UAC vai pedir) |
| Internet | Conexão estável (~2 GB de download somando WSL+Ubuntu+Node+repos) |
| Disco | ~10 GB livres em `C:` |
| Conta Claude | Plano Max (login interativo) |
| Conta GitHub | Acesso a `kennrick69/_squad` e `kennrick69/imp-orchestrator` (token PAT ou Device Flow) |
| Antivírus | Defender OK; AVs corporativos podem bloquear `wsl --install` |

O instalador valida tudo isso no **Passo 0** antes de começar.

---

## 3. Schema de estado (`~/.imp-installer/state.json`)

Caminho real: `C:\Users\<user>\.imp-installer\state.json` (Windows) e espelho em `~/.imp-installer/state.json` dentro do Ubuntu após Passo 4.

```json
{
  "version": "1.0",
  "startedAt": "2026-05-26T10:00:00Z",
  "lastStepCompleted": "step_03_wsl_install",
  "rebootRequired": false,
  "rebootDone": true,
  "ubuntuUser": "jos",
  "githubAuthMethod": "device-flow",
  "decisions": {
    "nodeInstallVia": "nodesource",
    "escritorio3dStrategy": "skip-optional"
  },
  "steps": {
    "step_00_preflight": "done",
    "step_01_enable_features": "done",
    "step_02_set_wsl_default_v2": "done",
    "step_03_wsl_install": "done",
    "step_04_ubuntu_first_boot": "done",
    "step_05_apt_base": "pending",
    "...": "..."
  }
}
```

Cada passo grava `done` só **depois** da validação final. Se falhar, fica `error` com `lastError` anexo.

---

## 4. Passos numerados

### Passo 0 — Preflight check
- **Categoria**: `[AUTO]`
- **O quê**: instalador checa Windows version, admin, internet, disco, e se já existe state.json (modo retomada).
- **Por quê**: falhar cedo é melhor que falhar tarde. Em retomada, pular pro último passo incompleto.
- **Como detectar se já feito**: `state.json` existe e `steps.step_00_preflight === "done"`.
- **Como executar**:
  - `[System.Environment]::OSVersion.Version` >= 10.0.19044
  - `New-Object Security.Principal.WindowsPrincipal(...)` checa admin
  - `Test-NetConnection github.com -Port 443`
  - `Get-PSDrive C | Select Free`
- **Como validar**: todos os 4 checks passam.
- **Tempo estimado**: ~10s
- **Pode reentrar?**: SIM (sempre roda)

---

### Passo 1 — Habilitar features WSL e VirtualMachinePlatform
- **Categoria**: `[AUTO]` (mas exige admin)
- **O quê**: habilita os 2 Windows Features necessários pro WSL2.
- **Por quê**: `wsl --install` em Windows 11 já cobre, mas em Win10 mais antigos é mais robusto fazer explícito.
- **Como detectar se já feito**: `Get-WindowsOptionalFeature -Online -FeatureName Microsoft-Windows-Subsystem-Linux` retorna `State: Enabled`.
- **Como executar**:
  ```powershell
  dism.exe /online /enable-feature /featurename:Microsoft-Windows-Subsystem-Linux /all /norestart
  dism.exe /online /enable-feature /featurename:VirtualMachinePlatform /all /norestart
  ```
- **Como validar**: ambos retornam `Enabled`.
- **Tempo estimado**: ~1-2 min
- **Pode reentrar?**: SIM

---

### Passo 2 — Setar WSL default version 2
- **Categoria**: `[AUTO]`
- **O quê**: `wsl --set-default-version 2`.
- **Por quê**: garantir Ubuntu instale como WSL2 (não WSL1).
- **Como detectar se já feito**: `wsl --status` mostra `Default Version: 2`.
- **Como executar**: `wsl --set-default-version 2`
- **Como validar**: parse de `wsl --status`.
- **Tempo estimado**: ~5s
- **Pode reentrar?**: SIM

---

### Passo 3 — Instalar WSL2 + Ubuntu (REBOOT obrigatório)
- **Categoria**: `[HÍBRIDO]` — comando é AUTO, reboot é MANUAL (o JOs clica "Reiniciar agora").
- **O quê**: `wsl --install -d Ubuntu` baixa kernel WSL2 + imagem Ubuntu LTS.
- **Por quê**: base de todo o resto. Tem que reiniciar pra ativar virtualização (Hyper-V).
- **Como detectar se já feito**: `wsl -l -v` lista `Ubuntu` com `STATE: Running` ou `Stopped` e `VERSION: 2`.
- **Como executar**:
  ```powershell
  wsl --install -d Ubuntu --no-launch
  ```
  Depois instalador grava `rebootRequired: true` em state.json e mostra tela "Reinicie agora pra continuar". Quando o JOs reabre o `.exe` depois do reboot, ele detecta state e pula pro Passo 4.
- **Como validar**: pós-reboot, `wsl -l -v` mostra Ubuntu v2.
- **Tempo estimado**: ~5 min download + reboot (~2 min) = ~7 min
- **Pode reentrar?**: SIM — é justamente o ponto onde a reentrada é mais usada.

---

### Passo 4 — Primeira boot do Ubuntu (criar user + senha)
- **Categoria**: `[MANUAL]` (instalador abre janela, JOs digita)
- **O quê**: abrir Ubuntu pela primeira vez pra criar UNIX username + senha.
- **Por quê**: Ubuntu não tem user até a primeira boot interativa. Não dá pra automatizar com segurança (senha em script = ruim).
- **Como detectar se já feito**: `wsl -d Ubuntu -e bash -lc "id -u $USER"` retorna `1000` (ou outro UID válido) sem erro.
- **Como executar**: instalador mostra instrução clara e roda:
  ```powershell
  Start-Process "ubuntu.exe"
  ```
  Tela do instalador: "Uma janela do Ubuntu vai abrir. Escolha um username minúsculo (ex: `jos`) e uma senha. Quando ver o prompt `jos@PC:~$`, volte aqui e clique CONTINUAR."
- **Como validar**: instalador testa `wsl -d Ubuntu -u $userInformado -e whoami`. Se OK, salva `ubuntuUser` no state.
- **Tempo estimado**: ~2 min (depende do JOs)
- **Pode reentrar?**: SIM

---

### Passo 5 — Apt update + pacotes base
- **Categoria**: `[AUTO]`
- **O quê**: instala `tmux git curl build-essential ca-certificates jq`.
- **Por quê**: dependências de tudo que vem depois. `build-essential` pra módulos npm com node-gyp; `jq` pro próprio instalador parsear JSON dentro do bash.
- **Como detectar se já feito**: `dpkg -s tmux git curl build-essential >/dev/null 2>&1` retorna 0 pra todos.
- **Como executar**:
  ```bash
  wsl -d Ubuntu -u $ubuntuUser -e bash -lc "
    sudo -n apt-get update -y &&
    sudo -n apt-get install -y tmux git curl build-essential ca-certificates jq
  "
  ```
  ⚠️ Problema: `sudo -n` exige NOPASSWD. **[PRA JOs DECIDIR]**: ou (a) instalador pede senha sudo numa tela e passa via `echo $pass | sudo -S`, ou (b) configura NOPASSWD pro user (mais simples, menos seguro). Recomendo (a).
- **Como validar**: `which tmux && which git && which curl && which make` todos retornam path.
- **Tempo estimado**: ~3-5 min (download de pacotes)
- **Pode reentrar?**: SIM (`apt-get install` é idempotente)

---

### Passo 6 — Instalar Node 20 LTS
- **Categoria**: `[AUTO]`
- **O quê**: instala Node 20 LTS no Ubuntu.
- **Por quê**: Claude Code CLI exige Node 18+, e 20 LTS é o sweet spot atual.
- **Decisão Marcos: usar NodeSource (apt repo oficial), NÃO nvm.**
  - Justificativa: nvm é ótimo pra dev que mexe em múltiplas versões. O JOs aqui só precisa de UMA versão estável global. NodeSource:
    - instala em `/usr/bin/node` (igual ao notebook atual dele — paridade total)
    - sobrevive a `bash` não-interativo (nvm precisa de `.bashrc` carregado)
    - tmux panes herdam path sem ginástica
    - update via `apt-get upgrade` simples
  - nvm seria certo se ele fosse trocar de versão. Não é o caso.
- **Como detectar se já feito**: `node -v` retorna `v20.x.x` E `which node` = `/usr/bin/node`.
- **Como executar**:
  ```bash
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
  ```
- **Como validar**: `node -v` >= v20.0.0; `npm -v` retorna versão.
- **Tempo estimado**: ~2 min
- **Pode reentrar?**: SIM

---

### Passo 7 — Configurar npm global sem sudo (`~/.npm-global`)
- **Categoria**: `[AUTO]`
- **O quê**: cria `~/.npm-global`, aponta `npm config set prefix`, adiciona ao PATH em `~/.bashrc`.
- **Por quê**: instalar pacotes globais sem sudo (boa prática, evita EACCES, espelha o setup atual do JOs).
- **Como detectar se já feito**: `npm config get prefix` retorna `/home/<user>/.npm-global` E grep no `.bashrc` acha `export PATH=$HOME/.npm-global/bin:$PATH`.
- **Como executar**:
  ```bash
  mkdir -p $HOME/.npm-global
  npm config set prefix "$HOME/.npm-global"
  grep -q '.npm-global/bin' ~/.bashrc || echo 'export PATH=$HOME/.npm-global/bin:$PATH' >> ~/.bashrc
  ```
- **Como validar**: `bash -lc 'echo $PATH'` contém `.npm-global/bin`.
- **Tempo estimado**: ~5s
- **Pode reentrar?**: SIM (o `grep -q` evita duplicar linha no .bashrc)

---

### Passo 8 — Instalar Claude Code CLI
- **Categoria**: `[AUTO]`
- **O quê**: `npm install -g @anthropic-ai/claude-code`.
- **Por quê**: o CLI que cada painel tmux vai rodar.
- **Como detectar se já feito**: `which claude` retorna `~/.npm-global/bin/claude` E `claude --version` responde sem erro.
- **Como executar**:
  ```bash
  npm install -g @anthropic-ai/claude-code
  ```
- **Como validar**: `claude --version` retorna versão.
- **Tempo estimado**: ~1-2 min
- **Pode reentrar?**: SIM

---

### Passo 9 — Login Claude (MANUAL)
- **Categoria**: `[MANUAL]`
- **O quê**: `claude login` interativo, JOs autentica com conta Max no browser.
- **Por quê**: tokens Claude não podem ser embutidos no .exe (segurança + termos de uso). Login é por OAuth-like via browser.
- **Como detectar se já feito**: arquivo `~/.config/claude-code/credentials.json` (ou equivalente) existe E `claude --print "say ok"` responde sem erro de auth. **[PRA JOs DECIDIR]**: confirmar caminho exato do credential file na versão atual do CLI (varia entre versões).
- **Como executar**: instalador mostra tela "Vamos abrir o Claude Code pra você logar. Clique CONTINUAR, faça login no browser que abrir, volte aqui." e roda:
  ```powershell
  wsl -d Ubuntu -u $ubuntuUser -e bash -lc "claude login"
  ```
  (abre terminal interativo dentro do WSL)
- **Como validar**: roda `claude --print "responda apenas: ok"` e verifica resposta.
- **Tempo estimado**: ~2 min
- **Pode reentrar?**: SIM

---

### Passo 10 — GitHub auth
- **Categoria**: `[HÍBRIDO]`
- **O quê**: salvar credencial Git pra clonar repos privados.
- **Decisão Marcos: usar `gh auth login --web` (Device Flow), NÃO pedir PAT colado.**
  - Justificativa:
    - PAT colado = JOs vai pro github.com gerar token com scopes certos, copiar, colar. Frágil, fácil de errar scope.
    - Device Flow: instalador abre browser, JOs cola um código de 8 dígitos, autoriza no GitHub.com. `gh` salva tudo automaticamente em `~/.config/gh/hosts.yml` e configura `git` pra usar via credential helper.
    - Bônus: `gh` é útil pro JOs depois (criar issues, ver PRs).
- **Como detectar se já feito**: `gh auth status` retorna 0 E `git ls-remote https://github.com/kennrick69/imp-orchestrator HEAD` funciona sem prompt.
- **Como executar**:
  ```bash
  # instala gh primeiro
  type -p gh >/dev/null || {
    curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | sudo dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli.list
    sudo apt-get update && sudo apt-get install -y gh
  }
  gh auth login --web --git-protocol https --hostname github.com
  gh auth setup-git
  ```
- **Como validar**: `gh auth status` E `git ls-remote` no repo privado funciona.
- **Tempo estimado**: ~2 min
- **Pode reentrar?**: SIM

---

### Passo 11 — Criar `/mnt/c/Projetos` e clonar `_squad`
- **Categoria**: `[AUTO]`
- **O quê**: `mkdir -p /mnt/c/Projetos && cd /mnt/c/Projetos && git clone https://github.com/kennrick69/_squad.git`.
- **Por quê**: squad é a alma. Em `/mnt/c/Projetos` (não `~/`) pra ser acessível pelo Windows também (editores, backup).
- **Como detectar se já feito**: `[ -d /mnt/c/Projetos/_squad/.git ]` E `git -C /mnt/c/Projetos/_squad rev-parse HEAD` funciona.
- **Como executar**:
  ```bash
  mkdir -p /mnt/c/Projetos
  cd /mnt/c/Projetos
  [ -d _squad/.git ] || git clone https://github.com/kennrick69/_squad.git
  ```
- **Como validar**: pasta existe, `_shared/REGRAS_GERAIS.md` existe.
- **Tempo estimado**: ~30s
- **Pode reentrar?**: SIM
- ⚠️ **Pré-condição [PRA JOs DECIDIR]**: repo `kennrick69/_squad` precisa estar criado no GitHub (público OU privado com acesso liberado). Você disse que vai criar.

---

### Passo 12 — Clonar `imp-orchestrator`
- **Categoria**: `[AUTO]`
- **O quê**: `git clone https://github.com/kennrick69/imp-orchestrator.git` em `/mnt/c/Projetos/imp-orchestrator`.
- **Por quê**: é o orquestrador (tmux, painéis, hub).
- **Como detectar se já feito**: `[ -d /mnt/c/Projetos/imp-orchestrator/.git ]`.
- **Como executar**:
  ```bash
  cd /mnt/c/Projetos
  [ -d imp-orchestrator/.git ] || git clone https://github.com/kennrick69/imp-orchestrator.git
  cd imp-orchestrator && npm install --omit=dev
  ```
- **Como validar**: `node /mnt/c/Projetos/imp-orchestrator/bin/health.js` (ou equivalente) responde OK.
- **Tempo estimado**: ~1-2 min (clone + npm install)
- **Pode reentrar?**: SIM

---

### Passo 13 — Sala 3D (`escritorio-3d`)
- **Categoria**: `[HÍBRIDO]` se feito, `[AUTO]` se pulado
- **O quê**: trazer os ~130 MB de assets da sala 3D pro disco.
- **Recomendação Marcos: OPCIONAL no instalador v1.0 — marcar como "instalar depois".**
  - Justificativa das 3 opções:
    | Opção | Prós | Contras | Veredito |
    |---|---|---|---|
    | **Git LFS** | clone como qualquer repo | 130 MB de LFS bandwidth GitHub gratuito é só 1 GB/mês; PC zerado precisa instalar `git-lfs` antes; lento | ❌ |
    | **GitHub Release asset (.zip)** | download HTTP simples, sem LFS, cache-friendly, pode usar CDN | precisa publicar release no repo (manual de você 1x); precisa script pra unzip | ✅ |
    | **Opcional (skip + botão "instalar depois")** | instalador v1 não atrasa por isso; JOs instala só se for usar | sala 3D não funciona até ele clicar | ✅ pra v1 |
  - **Recomendação concreta**: v1.0 do instalador deixa um botão "Instalar Sala 3D (130 MB)" no dashboard final. Quando clicado, baixa Release asset do `kennrick69/escritorio-3d` versão `latest` em `.zip`, descompacta em `/mnt/c/Projetos/escritorio-3d/`. Marca opcional no state: `decisions.escritorio3dStrategy: "release-asset-on-demand"`.
- **Como detectar se já feito**: pasta `escritorio-3d/index.html` existe E zip do release foi baixado (checksum opcional).
- **Como executar (quando JOs clicar)**:
  ```bash
  curl -L -o /tmp/escritorio-3d.zip https://github.com/kennrick69/escritorio-3d/releases/latest/download/escritorio-3d.zip
  unzip -q /tmp/escritorio-3d.zip -d /mnt/c/Projetos/escritorio-3d/
  ```
- **Como validar**: HTML principal existe.
- **Tempo estimado**: ~3-5 min (depende internet)
- **Pode reentrar?**: SIM
- ⚠️ **Pré-condição [PRA JOs DECIDIR]**: você publica release `.zip` no repo `escritorio-3d` (ou cria o repo). Sem isso, esse passo fica "stub" no instalador.

---

### Passo 14 — Criar sessão tmux `imp` com 7 painéis
- **Categoria**: `[AUTO]`
- **O quê**: matar sessão antiga se existir, criar nova `imp` com 7 panes, rodar `claude` em cada um na pasta de trabalho certa.
- **Por quê**: é o coração do squad — 7 Claudes em tmux.
- **Como detectar se já feito**: `tmux has-session -t imp` retorna 0 E `tmux list-panes -t imp | wc -l` == 7.
- **Como executar**: o `imp-orchestrator` já tem um helper pra isso (`bin/spawn-squad.js` ou similar — confirmar caminho). O instalador chama:
  ```bash
  cd /mnt/c/Projetos/imp-orchestrator
  node bin/spawn-squad.js --session=imp --panes=7
  ```
  Se o helper não existir ainda, fallback puro:
  ```bash
  tmux kill-session -t imp 2>/dev/null || true
  tmux new-session -d -s imp -c /mnt/c/Projetos/_squad
  for i in 2 3 4 5 6 7; do tmux split-window -t imp -c /mnt/c/Projetos/_squad; tmux select-layout -t imp tiled; done
  tmux list-panes -t imp -F '#{pane_id}' | while read p; do tmux send-keys -t $p "claude" Enter; done
  ```
- **Como validar**: `tmux list-panes -t imp` mostra 7 panes; opcionalmente capturar pane e verificar prompt do Claude.
- **Tempo estimado**: ~30s
- **Pode reentrar?**: SIM (mata sessão antiga e recria; OU detecta sessão saudável e pula)
- ⚠️ **[PRA JOs DECIDIR]**: instalador deve **recriar** sessão sempre, ou **respeitar** sessão existente? Recomendo respeitar se saudável (7 panes, claudes responsivos), recriar só se quebrada.

---

### Passo 15 — Baixar `IMP-Squad-Comando-0.3.1-portable.exe` + shortcut Desktop
- **Categoria**: `[AUTO]`
- **O quê**: baixa o portable da última release do `imp-interface` em `C:\Projetos\imp-interface\` e cria atalho `Squad Comando.lnk` no Desktop.
- **Por quê**: é a interface gráfica que conecta na sessão tmux.
- **Como detectar se já feito**: `Test-Path "C:\Projetos\imp-interface\IMP-Squad-Comando-0.3.1-portable.exe"` E shortcut existe no Desktop.
- **Como executar** (PowerShell, lado Windows):
  ```powershell
  $url = "https://github.com/kennrick69/imp-interface/releases/download/v0.3.1/IMP-Squad-Comando-0.3.1-portable.exe"
  $dest = "C:\Projetos\imp-interface\IMP-Squad-Comando-0.3.1-portable.exe"
  New-Item -ItemType Directory -Force -Path "C:\Projetos\imp-interface" | Out-Null
  Invoke-WebRequest -Uri $url -OutFile $dest
  # shortcut
  $ws = New-Object -ComObject WScript.Shell
  $sc = $ws.CreateShortcut("$env:USERPROFILE\Desktop\Squad Comando.lnk")
  $sc.TargetPath = $dest
  $sc.Save()
  ```
- **Como validar**: arquivo existe + tamanho > 50 MB + shortcut clicável.
- **Tempo estimado**: ~1 min
- **Pode reentrar?**: SIM
- ⚠️ **[PRA JOs DECIDIR]**: pin no `0.3.1` ou sempre pegar `latest`? Recomendo `latest` com fallback pro pin se latest falhar.

---

### Passo 16 — Validação end-to-end
- **Categoria**: `[AUTO]`
- **O quê**: instalador abre o `Squad Comando.exe`, espera ele conectar na sessão tmux `imp`, e confirma "tudo verde".
- **Por quê**: prova viva que a stack funciona.
- **Como detectar se já feito**: `steps.step_16_e2e === "done"`.
- **Como executar**:
  ```powershell
  Start-Process "C:\Projetos\imp-interface\IMP-Squad-Comando-0.3.1-portable.exe"
  ```
  Em paralelo, instalador faz `tmux capture-pane -t imp:0.0 -p` via WSL e verifica que tem output recente do Claude (prompt visível).
- **Como validar**: o checkin do interface no tmux deixa marca (ex: socket file, log file). Definir um sinal claro.
- **Tempo estimado**: ~30s
- **Pode reentrar?**: SIM

---

## 5. Tela final ("tudo pronto")

Quando `step_16` vira `done`, instalador mostra:

```
   IMP DEV SQUAD INSTALADO

   [v] WSL2 + Ubuntu                    [v] Repos clonados
   [v] Node 20 + npm                    [v] Sessão tmux 'imp' (7 panes)
   [v] Claude Code CLI                  [v] Squad Comando v0.3.1
   [v] GitHub auth                      [v] Shortcut no Desktop

   Tempo total: 23 min

   [ ABRIR SQUAD COMANDO ]   [ INSTALAR SALA 3D (opcional) ]   [ FECHAR ]
```

Botão "ABRIR SQUAD COMANDO" mata o instalador e abre o `.exe` da interface. Botão "Sala 3D" dispara Passo 13.

---

## 6. Reentrada / recuperação

Cenários cobertos:

| Cenário | Comportamento |
|---|---|
| JOs fecha instalador no meio | Próximo `open` lê `state.json`, pula direto pro `lastStepCompleted + 1`. Mostra "Retomando do Passo X — Instalar Node..." |
| PC reinicia (esperado, Passo 3) | `state.json` tem `rebootRequired: true, rebootDone: false`. Pós-reboot, instalador detecta `Get-Date - bootTime < 5 min` e marca `rebootDone: true`. Continua. |
| PC reinicia (não-esperado, crash) | Idêntico ao "fecha no meio". Idempotência cobre. |
| Passo falha (ex: rede caiu) | State grava `step_XX: "error"` + `lastError`. Tela mostra "Erro no Passo X. [RETRY] [VER LOG] [PULAR (não recomendado)]" |
| State.json corrompido | Backup automático em `state.json.bak` antes de cada gravação. Se ambos corrompem, instalador re-roda detecção de cada passo (todos têm "como detectar se já feito") e reconstrói state. |
| JOs roda instalador depois de já ter tudo pronto | Todos os 16 passos detectam "já feito", instalador pula direto pra tela final em <30s. |

**Diretório de log**: `~/.imp-installer/logs/install-YYYY-MM-DD-HHMM.log` — um arquivo por execução, retém últimos 10.

---

## 7. Edge cases conhecidos (pra Patrícia detalhar)

1. **Virtualização desabilitada na BIOS**: `wsl --install` falha. Detectar via `systeminfo | grep "Virtualization Enabled In Firmware"`. Mostrar tela com link tutorial BIOS.
2. **Hyper-V conflitando com VirtualBox/VMware antigo**: WSL2 não convive bem com Hyper-V desligado. Detectar e avisar.
3. **Defender / AV corporativo bloqueando `wsl --install`**: timeout >5min. Sugerir exceção temporária.
4. **Proxy corporativo**: `apt`, `npm`, `git` precisam de proxy. Tela opcional "Você está em rede corporativa?" → coleta proxy URL → exporta `HTTP_PROXY` em todo lugar.
5. **Disco C: cheio durante instalação**: monitorar a cada passo. Falhar limpo se <2 GB.
6. **Usuário sem direito de admin**: detectar no Passo 0, mostrar "Rode como administrador. [SAIR]".
7. **Conta GitHub sem acesso a `kennrick69/_squad`**: Device Flow funciona, mas `git clone` 404. Tela: "Sua conta GitHub não tem acesso ao repo X. Avise o JOs."
8. **Ubuntu já instalado mas é WSL1**: detectar via `wsl -l -v` e oferecer `wsl --set-version Ubuntu 2` (lento, ~5min de conversão).
9. **`npm install -g` falha por permissão**: o Passo 7 (`~/.npm-global`) previne, mas se rodou antes em outra ordem, limpar `/usr/local/lib/node_modules` ownership.
10. **Claude CLI quebra entre versões**: pin de versão no `npm install -g @anthropic-ai/claude-code@<versão-testada>` em vez de `latest`. **[PRA JOs DECIDIR]**: pinar ou seguir latest?
11. **tmux 3.0a vs 3.4 — diferenças de syntax**: Ubuntu 22.04 vem com 3.2, Ubuntu 24.04 com 3.4. Comandos no Passo 14 funcionam em ambos, mas hooks/options podem variar. Padronizar Ubuntu 22.04 LTS no Passo 3.
12. **Rede flaky no meio do `apt-get install`**: retry com backoff (3 tentativas, 5s/15s/45s).

---

## 8. Decisões pendentes (recap rápido pra JOs)

| # | Decisão | Recomendação Marcos | **Decisão Claudio (autonomia §8)** |
|---|---|---|---|
| D1 | sudo: senha interativa ou NOPASSWD? | Senha interativa via tela do instalador | ✅ **Senha interativa**. NOPASSWD enfraquece segurança; instalador abre prompt nativo. |
| D2 | Claude CLI: pinar versão? | Pinar a versão testada, com flag pra latest | ✅ **Latest por padrão + flag `--pin <v>` avançada**. Claude CLI evolui rápido, o JOs precisa do recente. |
| D3 | Sala 3D: LFS, release asset ou opcional? | Release asset, opcional (botão "instalar depois") | ✅ **Release asset opcional**. Bruno empacota `escritorio-3d.zip` (130MB → ~50MB compactado) no release; instalador oferece "instalar 3D?" ao final. |
| D4 | imp-interface: pinar v0.3.1 ou latest? | latest com fallback pro pin | ✅ **Latest release via GitHub API** (`/releases/latest`), fallback pra v0.3.1 hardcoded se API falhar. |
| D5 | Recriar tmux sempre ou respeitar? | Respeitar se saudável | ✅ **Respeitar se saudável** (tem 7 paneis + claude rodando). Senão `tmux kill-session -t imp` + recriar. |
| D6 | Distro Ubuntu: 22.04 ou 24.04? | 22.04 LTS (mais maduro com WSL2 hoje) | ✅ **22.04 LTS** (`wsl --install -d Ubuntu-22.04`). 24.04 ainda tem edge cases no WSL2. |
| D7 | Repo `_squad` público ou privado? | Privado faz mais sentido — Device Flow cobre | ✅ **PRIVADO**. Repo `imp-squad` (renomeado) tem `PROJETOS.md` com URLs de produção + IPs. Device Flow no instalador. |
| D8 | Onde fica o credential file do Claude CLI? | Confirmar caminho atual antes de codar Passo 9 | ⏳ **Bruno confirma** no doc COMANDOS-AUTOMACAO.md (provavelmente `~/.config/claude/credentials.json` ou `~/.claude/credentials.json`). Não bloqueia roteiro.
