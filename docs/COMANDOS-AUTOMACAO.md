# COMANDOS-AUTOMACAO.md

**Autor**: Bruno (IMP Dev Squad)
**Data**: 2026-05-26
**Escopo**: Snippets REAIS e testáveis para cada passo automatizável do instalador.
**NÃO contém**: roteiro UX (Marcos) nem análise de riscos (Patrícia). Só comandos.

> Convenções de notação neste doc:
> - `pwsh:` = PowerShell no Windows (host)
> - `wsl:` = bash dentro do Ubuntu/WSL2
> - `node:` = código Electron (main process) usando `child_process`
> - `⚠️ VERIFICAR` = não consegui confirmar com 100% de certeza; testar antes de release

---

## 0. Decisões-chave (resumo executivo)

| Componente | Escolha | Razão |
|---|---|---|
| **Node 20 LTS** | **nvm v0.40.4** | PATH user-scope, sem `sudo`, fácil upgrade futuro, alinha com Anthropic best practice (eles **proíbem** `sudo npm install -g`) |
| **Claude Code CLI** | **Native installer** `curl -fsSL https://claude.ai/install.sh \| bash` | Confirmado oficial — auto-update, sem dependência de Node. npm é "opcional"; pode ficar como fallback |
| **GitHub auth** | **gh CLI (`gh auth login --web`)** | Device flow nativo, abre browser sozinho, salva token de forma segura. Token-em-arquivo `.git-credentials` continua disponível como fallback offline |
| **WSL distro** | `wsl --install` (default = Ubuntu) | É o caminho oficial Microsoft; `-d Ubuntu` é redundante mas seguro como explícito |

---

## 1. WSL2 install (PowerShell admin)

### O quê
Instalar WSL2 + Ubuntu numa máquina Windows 10/11 zerada. Comando único habilita "Virtual Machine Platform" + "WSL" + baixa kernel WSL2 + baixa Ubuntu.

### Pré-requisitos
- Windows 10 build 19041+ ou Windows 11
- PowerShell rodando como **Administrador**
- Reboot OBRIGATÓRIO após instalação

### Detecção (já tem?)
```powershell
# pwsh: retorna 0 se WSL instalado, !=0 se não
wsl --status
```

Parse do stdout (instalador Electron):
- Se exit code = 0 **e** stdout contém `Default Distribution:` → WSL pronto
- Se exit code != 0 ou stdout vazio → não instalado
- Se exit code = 0 **mas** sem `Default Distribution` → WSL kernel instalado mas sem distro → rodar `wsl --install -d Ubuntu`

Detectar admin:
```powershell
# pwsh: true se elevado
([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
```

### Execução
```powershell
# pwsh (admin):
wsl --install
```

**Observação importante da Microsoft Docs**: se `wsl --install` mostrar o help (em vez de instalar) significa que WSL já está parcialmente presente. Nesse caso usar:
```powershell
wsl --install -d Ubuntu
```

Se o download pendurar em 0.0%:
```powershell
wsl --install --web-download -d Ubuntu
```

### Validação (success?)
Após reboot:
```powershell
wsl --list --verbose
# Esperado: ter pelo menos 1 linha com "Ubuntu" e "Running" ou "Stopped", VERSION = 2
```

### Como o Electron chama
```javascript
// node: (Electron main process)
const { execFile } = require('node:child_process');

// Detecta admin antes de tentar instalar
function isAdmin() {
  return new Promise((resolve) => {
    execFile('powershell.exe', [
      '-NoProfile', '-Command',
      `([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)`
    ], (err, stdout) => {
      resolve(/true/i.test(stdout));
    });
  });
}

// Instala WSL — DEVE ser chamado por processo já elevado
function installWsl() {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', [
      '-NoProfile', '-Command', 'wsl --install'
    ], { windowsHide: false }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`wsl --install falhou: ${stderr || err.message}`));
      resolve({ needsReboot: true, stdout });
    });
  });
}
```

Para *forçar elevação* sem rodar o Electron inteiro como admin:
```javascript
// node: lança PowerShell elevado via Start-Process -Verb RunAs
execFile('powershell.exe', [
  '-NoProfile', '-Command',
  `Start-Process powershell -ArgumentList '-NoProfile','-Command','wsl --install; pause' -Verb RunAs`
]);
// Isso dispara UAC; usuário aprova; PowerShell elevado abre em janela separada.
```

### Edge cases conhecidos
- **Hyper-V/Virtualization desabilitada na BIOS** → `wsl --install` instala features, mas WSL2 não sobe até habilitar VT-x/AMD-V no firmware. Detectar: `wsl --status` retorna `WSL 2 requires an update to its kernel component` ou similar.
- **Windows N edição** sem Media Feature Pack → falha
- **Após reboot, primeira boot do Ubuntu pede user/senha** → trata na Seção 2.
- **Corporate laptops com WSL bloqueado por política de grupo** → comando passa mas distro não aparece.

---

## 2. Setup Ubuntu primeira boot (MANUAL)

### O quê
Após reboot, no primeiro launch do Ubuntu uma janela de console abre pedindo:
1. UNIX username (qualquer, ex.: `jos`)
2. Senha (será usada para `sudo` depois)
3. Confirmação senha

O instalador **NÃO automatiza isso**. Estratégia: instalador exibe instrução clara e fica em poll esperando o WSL ficar utilizável.

### Detecção (Ubuntu pronto?)
```powershell
# pwsh: testa se conseguimos rodar bash dentro do Ubuntu sem prompt interativo
wsl -d Ubuntu -- bash -lc 'echo OK'
# stdout = "OK" → pronto
# erro / hang / mensagem de "create a default UNIX user account" → ainda em setup
```

### Loop de espera (Electron)
```javascript
// node: poll até Ubuntu responder
async function waitForUbuntu(timeoutMs = 10 * 60 * 1000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const out = await execFileP('wsl.exe', ['-d', 'Ubuntu', '--', 'bash', '-lc', 'echo OK']);
      if (out.stdout.trim() === 'OK') return true;
    } catch (_) { /* ignore */ }
    await new Promise(r => setTimeout(r, 3000));
  }
  throw new Error('Ubuntu não respondeu em 10 min — abra "Ubuntu" no menu Iniciar e complete o setup.');
}
```

### Como abrir Ubuntu pra o JOs ver
```powershell
# pwsh: abre Ubuntu em janela própria (foreground, JOs interage)
Start-Process ubuntu.exe
# ou:
wt -p Ubuntu       # Windows Terminal, se instalado
```

### Edge cases
- Se JOs digitar username com maiúsculas/espaços, Ubuntu rejeita silenciosamente — instrução do instalador deve enfatizar lowercase, sem espaços.
- Se JOs fechar a janela antes de terminar setup, o Ubuntu fica num estado meio-cru; `wsl --unregister Ubuntu && wsl --install -d Ubuntu` reseta.

---

## 3. Apt update + pacotes base

### O quê
Atualizar índice apt e instalar `tmux git curl build-essential ca-certificates`.

### Problema do sudo interativo
`sudo apt install` pede senha. Em Ubuntu WSL recém-criado, o user é sudoer **sem senha** por padrão (`%sudo ALL=(ALL) NOPASSWD:ALL` está em `/etc/sudoers.d/`... ⚠️ VERIFICAR — em algumas builds recentes do Ubuntu WSL isso mudou). Estratégia robusta:

1. Tenta `sudo -n` (non-interactive). Se passa → segue sem senha.
2. Se falha → o instalador pede senha do JOs via UI, passa via `wsl -e bash -lc "echo SENHA | sudo -S ..."`.

### Detecção (já tem?)
```bash
# wsl:
command -v tmux >/dev/null && command -v git >/dev/null && command -v curl >/dev/null && command -v cc >/dev/null && echo OK
```

Teste sudo passwordless:
```bash
# wsl:
sudo -n true 2>/dev/null && echo NOPASSWD || echo NEEDS_PASSWORD
```

### Execução
```bash
# wsl: rodado de UMA vez via wsl.exe do Electron
sudo -n apt-get update -y \
  && sudo -n apt-get install -y --no-install-recommends \
       tmux git curl ca-certificates build-essential
```

Fallback com senha:
```bash
# wsl: senha vai via stdin (echo é menos seguro, mas só roda no Electron local)
echo "$SUDO_PASS" | sudo -S apt-get update -y \
  && echo "$SUDO_PASS" | sudo -S apt-get install -y --no-install-recommends \
       tmux git curl ca-certificates build-essential
```

### Validação
```bash
# wsl:
tmux -V && git --version && curl --version | head -1 && cc --version | head -1
```

### Como o Electron chama
```javascript
// node:
function aptInstall(sudoPass) {
  const cmd = sudoPass
    ? `echo '${sudoPass.replace(/'/g, "'\\''")}' | sudo -S apt-get update -y && echo '${sudoPass.replace(/'/g, "'\\''")}' | sudo -S apt-get install -y --no-install-recommends tmux git curl ca-certificates build-essential`
    : `sudo -n apt-get update -y && sudo -n apt-get install -y --no-install-recommends tmux git curl ca-certificates build-essential`;
  return execFileP('wsl.exe', ['-d', 'Ubuntu', '--', 'bash', '-lc', cmd], { maxBuffer: 50_000_000 });
}
```

### Edge cases
- **DNS quebrado no WSL** → `apt-get update` falha em "Could not resolve". Fix: `echo "nameserver 8.8.8.8" | sudo tee /etc/resolv.conf` + `[network] generateResolvConf=false` em `/etc/wsl.conf`.
- **Mirror lento (.br)** → `apt-get update` pendura. Mitigação: timeout no execFile + retry.
- **Espaço em disco da VHDX cheio** → erro `No space left on device`. Diagnóstico: `df -h /`.

---

## 4. Node 20 LTS (RECOMENDAÇÃO: nvm)

### Comparação

| Critério | Opção A: nodesource | Opção B: nvm (v0.40.4) |
|---|---|---|
| Instalação | precisa `sudo` (apt) | user-space, sem sudo |
| Idempotência | apt cuida | precisa `source ~/.nvm/nvm.sh` em cada shell |
| Upgrade | `sudo apt upgrade nodejs` | `nvm install --lts && nvm alias default lts/*` |
| Múltiplas versões | NÃO | SIM (futuro: testar 18/20/22) |
| PATH | `/usr/bin/node` global | `~/.nvm/versions/node/vXX/bin/node` |
| Conflito com `npm -g` sem sudo | precisa `npm config set prefix ~/.npm-global` (chato) | prefix já está no home |

### ✅ RECOMENDAÇÃO: nvm v0.40.4

**Justificativa**: Anthropic oficialmente avisa "**Do NOT use `sudo npm install -g`**". Com nodesource, qualquer `npm install -g` futuro vai cair em permission error e gerar suporte. Com nvm, `npm -g` já escreve em `~/.nvm/versions/...` sem fricção. Versão **v0.40.4** é a stable atual (inclui patch CVE-2026-1665).

### Detecção
```bash
# wsl:
[ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh" && command -v node >/dev/null \
  && node -v | grep -qE '^v(2[0-9]|[3-9][0-9])\.' && echo OK
```

### Execução
```bash
# wsl: instala nvm 0.40.4 + Node LTS
export NVM_DIR="$HOME/.nvm"
if [ ! -s "$NVM_DIR/nvm.sh" ]; then
  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.4/install.sh | bash
fi
# nvm install script já adiciona auto-source no ~/.bashrc; carrega na sessão atual
. "$NVM_DIR/nvm.sh"
nvm install --lts
nvm alias default 'lts/*'
```

### Validação
```bash
# wsl: precisa rodar em shell login pra pegar o ~/.bashrc atualizado
bash -lc 'node -v && npm -v'
# Esperado: v20.x.x (ou maior) + npm >=10
```

### Como o Electron chama
```javascript
// node:
function installNode() {
  const script = `
    set -e
    export NVM_DIR="$HOME/.nvm"
    if [ ! -s "$NVM_DIR/nvm.sh" ]; then
      curl -fsSL -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.4/install.sh | bash
    fi
    . "$NVM_DIR/nvm.sh"
    nvm install --lts
    nvm alias default 'lts/*'
    node -v
  `;
  return execFileP('wsl.exe', ['-d', 'Ubuntu', '--', 'bash', '-lc', script]);
}
```

### Edge cases
- **`~/.bashrc` não é carregado em shells não-login** → instalador deve sempre usar `bash -lc` (l = login) no WSL.
- **Corporate proxy** bloqueia `raw.githubusercontent.com` → curl falha. Mitigação: detectar `curl: (6) Could not resolve` e mostrar mensagem clara.
- **Disco cheio durante `nvm install`** → Node baixa ~30MB; raro mas possível.

---

## 5. Claude Code CLI install

### Comando confirmado (oficial — code.claude.com/docs/en/setup)

**Recomendado**: instalador nativo (auto-update embutido, sem dependência de Node):
```bash
# wsl:
curl -fsSL https://claude.ai/install.sh | bash
```

**Alternativa via npm** (mantém como fallback):
```bash
# wsl:
npm install -g @anthropic-ai/claude-code
```
(Pacote npm CONFIRMADO: `@anthropic-ai/claude-code` — não chuta, a doc oficial bate.)

### Binário exposto
Em ambos os caminhos o binário se chama **`claude`** (não `claude-code`).
- Native installer: `~/.local/bin/claude`
- npm global (com prefix custom): `~/.npm-global/bin/claude`

### Detecção
```bash
# wsl:
command -v claude >/dev/null && claude --version && echo OK
```

### Execução (caminho recomendado)
```bash
# wsl:
curl -fsSL https://claude.ai/install.sh | bash
# adiciona ~/.local/bin ao PATH se faltar
case ":$PATH:" in
  *":$HOME/.local/bin:"*) ;;
  *) echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$HOME/.bashrc" ;;
esac
```

### Execução (caminho npm — só se native falhar)
Precisa configurar prefix pra evitar EACCES sem sudo:
```bash
# wsl:
mkdir -p "$HOME/.npm-global"
npm config set prefix "$HOME/.npm-global"
grep -qF 'NPM_GLOBAL=$HOME/.npm-global' "$HOME/.bashrc" || cat >> "$HOME/.bashrc" <<'EOF'

# IMP installer — npm global sem sudo
export NPM_GLOBAL="$HOME/.npm-global"
export PATH="$NPM_GLOBAL/bin:$PATH"
EOF
export PATH="$HOME/.npm-global/bin:$PATH"
npm install -g @anthropic-ai/claude-code
```

### Validação
```bash
# wsl:
bash -lc 'claude --version && claude doctor'
```
`claude doctor` faz self-check de instalação, PATH, login etc — útil pro instalador parsear e diagnosticar.

### Como o Electron chama
```javascript
// node:
async function installClaudeCode() {
  // Tenta native primeiro
  try {
    await execFileP('wsl.exe', ['-d', 'Ubuntu', '--', 'bash', '-lc',
      'curl -fsSL https://claude.ai/install.sh | bash'
    ], { maxBuffer: 20_000_000 });
  } catch (e) {
    // Fallback npm
    await execFileP('wsl.exe', ['-d', 'Ubuntu', '--', 'bash', '-lc',
      `mkdir -p "$HOME/.npm-global" && npm config set prefix "$HOME/.npm-global" && export PATH="$HOME/.npm-global/bin:$PATH" && npm install -g @anthropic-ai/claude-code`
    ]);
  }
  // valida
  const { stdout } = await execFileP('wsl.exe', ['-d', 'Ubuntu', '--', 'bash', '-lc', 'claude --version']);
  return stdout.trim();
}
```

### Edge cases
- **PATH não atualizado na sessão WSL atual** → instalador precisa abrir NOVA shell (`bash -lc`) ou exportar PATH inline.
- **Ubuntu WSL 20.04 (libc antiga)** → native binary pode falhar com glibc errors. Doc oficial pede Ubuntu 20.04+; testar.
- **`claude doctor` reporta "ripgrep missing"** → `apk add ripgrep` em alpine, raro em Ubuntu.

---

## 6. Claude login (MANUAL — terminal interativo)

### O quê
`claude` na primeira execução abre um fluxo de login web/browser. Precisa ser **interativo**, com terminal real (TTY), porque o Claude Code abre o browser default e espera redirect.

### Estratégia
Instalador abre uma janela de terminal Windows visível ao JOs, rodando `bash` dentro do WSL com `claude` como primeiro comando. JOs faz login, fecha o terminal, o instalador detecta sucesso.

### Comandos pra abrir terminal interativo
**Opção 1: Windows Terminal (`wt`)** — preferida, vem default em Win11:
```powershell
# pwsh:
wt new-tab --profile Ubuntu --title "IMP — Login Claude" wsl.exe -d Ubuntu -- bash -lc "claude; echo ''; echo 'Login pronto. Pressione Enter pra fechar.'; read"
```

**Opção 2: ubuntu.exe direto** (fallback se `wt` não existir):
```powershell
# pwsh:
Start-Process ubuntu.exe -ArgumentList 'run', 'bash', '-lc', 'claude; echo ""; echo "Feche esta janela."; read'
```

**Opção 3: `wsl.exe` direto** (sem janela própria — herda do parent):
```powershell
# pwsh: NÃO recomendado se Electron rodou sem console
wsl.exe -d Ubuntu -- bash -lc 'claude'
```

### Detecção (login feito?)
```bash
# wsl: claude grava credenciais em ~/.claude/ — presença de arquivos lá é sinal
test -f "$HOME/.claude.json" && grep -q '"oauth' "$HOME/.claude.json" 2>/dev/null && echo LOGGED_IN
```
⚠️ VERIFICAR — formato exato do `.claude.json` pode mudar entre versões; alternativa robusta é rodar `claude --print "ping"` non-interactive e ver se retorna sem pedir auth.

### Como o Electron chama
```javascript
// node:
async function openClaudeLoginTerminal() {
  // tenta Windows Terminal primeiro
  try {
    await execFileP('wt.exe', [
      'new-tab', '--profile', 'Ubuntu', '--title', 'IMP — Login Claude',
      'wsl.exe', '-d', 'Ubuntu', '--', 'bash', '-lc',
      'claude; echo ""; echo "Feche esta janela."; read'
    ]);
  } catch (_) {
    // fallback: ubuntu.exe
    require('node:child_process').spawn('ubuntu.exe', [
      'run', 'bash', '-lc', 'claude; read -p "Feche esta janela."'
    ], { detached: true, stdio: 'ignore' }).unref();
  }
}
```

### Edge cases
- **Browser default não abre** (Linux GUI ausente no WSL) → claude oferece "copie este código e cole em outro browser"; JOs precisa colar manualmente no Windows. Documentar.
- **Plano Free** → `claude` reclama; precisa Pro/Max. Não é resolvível pelo instalador.
- **Token expira** → próxima execução do `claude` pede re-login. Não é falha do instalador.

---

## 7. GitHub auth (RECOMENDAÇÃO: gh CLI device flow)

### Comparação

| Critério | A: Token + `.git-credentials` | B: gh CLI (`gh auth login --web`) |
|---|---|---|
| UX | JOs cria token na web → cola no instalador | `gh` abre browser sozinho |
| Setup do gh | nenhum | precisa instalar `gh` (apt) |
| Segurança | token em plain text em `~/.git-credentials` | token gerenciado pelo gh, mais seguro |
| Refresh | manual | `gh auth refresh` |
| Funciona offline | sim (uma vez salvo) | sim (uma vez salvo) |
| Permissões | JOs escolhe escopo (pode errar) | gh pede escopos certos automaticamente |

### ✅ RECOMENDAÇÃO: gh CLI device flow

**Justificativa**: device flow elimina o passo "vai em github.com/settings/tokens, cria token clássico, marca repo+workflow, copia e cola aqui" (5 cliques, fácil errar escopo). Com `gh auth login --web`, JOs aprova num clique no browser. Como bônus, `gh` já configura o git credential helper automaticamente.

### Pré-requisito: instalar gh
```bash
# wsl: instalação oficial via apt (já investigado — funciona em Ubuntu WSL)
(type -p wget >/dev/null || sudo apt-get install -y wget) \
  && sudo mkdir -p -m 755 /etc/apt/keyrings \
  && wget -qO- https://cli.github.com/packages/githubcli-archive-keyring.gpg | sudo tee /etc/apt/keyrings/githubcli-archive-keyring.gpg > /dev/null \
  && sudo chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
  && sudo apt-get update \
  && sudo apt-get install -y gh
```

### Detecção
```bash
# wsl: já autenticado?
gh auth status 2>&1 | grep -q "Logged in to github.com" && echo OK
```

### Execução (web flow — abre browser)
```bash
# wsl: TEM QUE rodar em terminal interativo (igual claude login)
gh auth login --hostname github.com --git-protocol https --web
```
A flag `--web` força browser flow (default já é, mas explícito é melhor). gh imprime um device code de 8 chars (ex.: `ABCD-1234`), copia pro clipboard (`--clipboard` opcional) e abre `https://github.com/login/device`. JOs cola o code, autoriza, gh termina.

Após sucesso, gh **automaticamente** configura git credential helper:
```bash
# isso roda dentro do gh, mas confirma:
gh auth setup-git
```

### Validação
```bash
# wsl: testa que git push funciona sem prompt
gh auth status
git ls-remote https://github.com/kennrick69/imp-orchestrator.git HEAD >/dev/null && echo OK
```

### Como o Electron chama
```javascript
// node: precisa terminal interativo (igual claude login)
async function openGhAuthTerminal() {
  await execFileP('wt.exe', [
    'new-tab', '--profile', 'Ubuntu', '--title', 'IMP — Login GitHub',
    'wsl.exe', '-d', 'Ubuntu', '--', 'bash', '-lc',
    'gh auth login --hostname github.com --git-protocol https --web; gh auth setup-git; read -p "Feche esta janela."'
  ]);
}
```

### Fallback: token manual (caso gh login falhe ou JOs prefira)
```bash
# wsl: TOKEN vem da UI do instalador (JOs colou)
git config --global credential.helper store
printf 'https://kennrick69:%s@github.com\n' "$TOKEN" > "$HOME/.git-credentials"
chmod 600 "$HOME/.git-credentials"
```

### Edge cases
- **JOs usa 2FA com app authenticator (não SMS)** → device flow funciona normal.
- **Conta organização com SSO** → após auth básico, gh pede `gh auth refresh -s admin:org` ou similar; pra `kennrick69` pessoal não aplica.
- **Browser não abre no host** → gh imprime URL e device code; JOs cola manualmente.

---

## 8. Clone repos

### O quê
Clonar `_squad` e `imp-orchestrator` em `/mnt/c/Projetos/`. ⚠️ `_squad` AINDA NÃO EXISTE NO GITHUB (vide CONTEXTO §7) — instalador precisa lidar com 404. `escritorio-3d` (130MB) FORA DE ESCOPO desta versão.

### Detecção (já clonado?)
```bash
# wsl:
[ -d /mnt/c/Projetos/_squad/.git ] && [ -d /mnt/c/Projetos/imp-orchestrator/.git ] && echo OK
```

### Execução (idempotente)
```bash
# wsl: clone OU pull
clone_or_pull() {
  local url="$1"
  local dest="$2"
  if [ -d "$dest/.git" ]; then
    echo "[$dest] já existe, fazendo pull"
    git -C "$dest" pull --ff-only || echo "[$dest] pull falhou (não fast-forward); pulando"
  elif [ -d "$dest" ]; then
    echo "[$dest] existe mas não é repo git — abortando pra não perder dados"
    return 1
  else
    git clone "$url" "$dest"
  fi
}

mkdir -p /mnt/c/Projetos
clone_or_pull https://github.com/kennrick69/_squad.git              /mnt/c/Projetos/_squad
clone_or_pull https://github.com/kennrick69/imp-orchestrator.git    /mnt/c/Projetos/imp-orchestrator
```

### Validação
```bash
# wsl:
git -C /mnt/c/Projetos/_squad rev-parse HEAD \
  && git -C /mnt/c/Projetos/imp-orchestrator rev-parse HEAD \
  && echo OK
```

### Como o Electron chama
```javascript
// node:
async function cloneRepos() {
  const repos = [
    ['https://github.com/kennrick69/_squad.git', '/mnt/c/Projetos/_squad'],
    ['https://github.com/kennrick69/imp-orchestrator.git', '/mnt/c/Projetos/imp-orchestrator'],
  ];
  const script = `
    set -e
    clone_or_pull() {
      if [ -d "$2/.git" ]; then git -C "$2" pull --ff-only || true
      elif [ -d "$2" ]; then echo "[$2] existe sem .git — abortando" >&2; exit 2
      else git clone "$1" "$2"; fi
    }
    mkdir -p /mnt/c/Projetos
    ${repos.map(([url, dest]) => `clone_or_pull '${url}' '${dest}'`).join('\n')}
  `;
  return execFileP('wsl.exe', ['-d', 'Ubuntu', '--', 'bash', '-lc', script], { maxBuffer: 50_000_000 });
}
```

### Edge cases
- **`_squad` ainda não existe (404)** → `git clone` falha. Instalador precisa: ou criar repo no GitHub via `gh repo create` antes, ou pular esse clone e avisar.
- **Permissão `/mnt/c/Projetos`** → diretório Windows; criar funciona sem sudo (WSL monta com permissão user).
- **Repo grande / conexão lenta** → não há progresso bonito; usar `--progress` e ler stderr do git.
- **Conflito CRLF/LF (já notado na memória do JOs)** → adicionar `.gitattributes` ou config global `core.autocrlf=input` antes do clone:
  ```bash
  git config --global core.autocrlf input
  ```

---

## 9. Sessão tmux `imp` com 7 paneis

### O quê
Criar sessão `imp` detached, com **7 paneis**: 6 agentes (`lider`, `arquiteto`, `criativo`, `debugger`, `qa`, `revisor`) + 1 `main` (orchestrator/scratchpad). Em cada painel, rodar `claude`.

> Base: `/home/jos/imp-orchestrator/scripts/setup-tmux.sh` já cria 6. Estendo pra 7 (main).

### Detecção
```bash
# wsl:
tmux has-session -t imp 2>/dev/null && echo EXISTS
```

### Estratégia idempotente
- Se sessão **NÃO** existe → criar fresh.
- Se sessão **existe** → ofertar dois caminhos via UI:
  - "Recriar" → `tmux kill-session -t imp` + criar
  - "Anexar" → só pular criação

### Execução
```bash
# wsl: cria sessão imp com 7 paneis (6 agentes + main)
set -euo pipefail
SESSION="imp"
SQUAD_ROOT="/mnt/c/Projetos/_squad"
ORCH_ROOT="/mnt/c/Projetos/imp-orchestrator"

# Mata existente se solicitado pelo instalador (flag --force)
if tmux has-session -t "$SESSION" 2>/dev/null; then
  if [ "${FORCE_RECREATE:-0}" = "1" ]; then
    tmux kill-session -t "$SESSION"
  else
    echo "[tmux] sessão '$SESSION' já existe — use FORCE_RECREATE=1 pra recriar"
    exit 0
  fi
fi

# painel 1: lider
tmux new-session -d -s "$SESSION" -n agents -c "$SQUAD_ROOT/lider"

# paneis 2-6: arquiteto, criativo, debugger, qa, revisor
for dir in arquiteto criativo debugger qa revisor; do
  tmux split-window -t "$SESSION" -c "$SQUAD_ROOT/$dir"
  tmux select-layout -t "$SESSION" tiled
done

# painel 7: main (orchestrator scratchpad)
tmux split-window -t "$SESSION" -c "$ORCH_ROOT"
tmux select-layout -t "$SESSION" tiled

# Rótulos (border) — útil pra debug visual
tmux set -t "$SESSION" -g pane-border-status top
PANES=( $(tmux list-panes -t "$SESSION" -F '#{pane_id}') )
LABELS=(lider arquiteto criativo debugger qa revisor main)
for i in "${!PANES[@]}"; do
  tmux select-pane -t "${PANES[$i]}" -T "${LABELS[$i]}"
done

# Envia 'claude' pra cada painel
# (load-buffer + paste-buffer é mais robusto que send-keys com texto literal;
#  mas pra um comando simples send-keys funciona perfeitamente)
for pid in "${PANES[@]}"; do
  tmux send-keys -t "$pid" 'claude' C-m
done

echo "[tmux] sessão '$SESSION' criada com ${#PANES[@]} paneis."
echo "       Anexe com: tmux attach -t $SESSION"
```

### Validação
```bash
# wsl:
test "$(tmux list-panes -t imp | wc -l)" = "7" && echo OK
```

### Como o Electron chama
```javascript
// node: grava script num arquivo dentro do WSL e roda
async function createImpTmuxSession(forceRecreate = false) {
  const script = `/* ...o script acima inteiro... */`;
  // grava em /tmp/ do WSL pra evitar quoting hell
  await execFileP('wsl.exe', ['-d', 'Ubuntu', '--', 'bash', '-lc',
    `cat > /tmp/imp-setup-tmux.sh <<'IMP_EOF'\n${script}\nIMP_EOF\nchmod +x /tmp/imp-setup-tmux.sh`
  ]);
  return execFileP('wsl.exe', ['-d', 'Ubuntu', '--',
    'bash', '-lc',
    `FORCE_RECREATE=${forceRecreate ? 1 : 0} /tmp/imp-setup-tmux.sh`
  ]);
}
```

### Edge cases
- **`claude` não na PATH dentro do tmux** → tmux herda env do shell que rodou `tmux new-session`. Garantir que `tmux` é invocado de `bash -lc` (login shell) pra `~/.bashrc` carregar PATH do nvm/native-claude.
- **Painel não-tiled bagunçado** → `select-layout tiled` resolve mas o JOs pode preferir custom. Deixar pra depois.
- **`pane-border-status` não suportado em tmux < 2.3** → na prática Ubuntu 22.04+ vem com tmux 3.2+, ok.

---

## 10. Download imp-interface.exe + shortcut Desktop

### O quê
Baixar `IMP-Squad-Comando-0.3.1-portable.exe` do release v0.3.1 e criar shortcut no Desktop do JOs.

### URL confirmada
Padrão GitHub releases:
```
https://github.com/kennrick69/imp-interface/releases/download/v0.3.1/IMP-Squad-Comando-0.3.1-portable.exe
```
⚠️ VERIFICAR no momento do release final — se o nome do asset mudar (ex.: dropar "Comando"), atualizar.

### Detecção
```powershell
# pwsh: já baixado?
Test-Path "$env:USERPROFILE\Desktop\IMP Squad.lnk"
```

### Execução
```powershell
# pwsh: baixa e cria shortcut
$ExeUrl  = 'https://github.com/kennrick69/imp-interface/releases/download/v0.3.1/IMP-Squad-Comando-0.3.1-portable.exe'
$ExeDir  = "$env:LOCALAPPDATA\IMP-Squad"
$ExePath = "$ExeDir\IMP-Squad.exe"
$LnkPath = "$env:USERPROFILE\Desktop\IMP Squad.lnk"

New-Item -ItemType Directory -Force -Path $ExeDir | Out-Null

# Download com progress (Invoke-WebRequest é mais lento; curl é melhor pra binários grandes)
curl.exe -L --fail -o $ExePath $ExeUrl
if (-not (Test-Path $ExePath)) { throw "Download falhou: $ExeUrl" }

# Cria shortcut .lnk via WScript.Shell COM
$WshShell = New-Object -ComObject WScript.Shell
$Shortcut = $WshShell.CreateShortcut($LnkPath)
$Shortcut.TargetPath       = $ExePath
$Shortcut.WorkingDirectory = $ExeDir
$Shortcut.IconLocation     = "$ExePath,0"
$Shortcut.Description      = 'IMP Squad — Painel de Comando'
$Shortcut.Save()

Write-Host "Shortcut criado em: $LnkPath"
```

### Validação
```powershell
# pwsh:
Test-Path $LnkPath -and (Get-Item $LnkPath).Length -gt 0
```

### Como o Electron chama
```javascript
// node:
async function installImpInterfaceShortcut() {
  const psScript = `
    $ErrorActionPreference = 'Stop'
    $ExeUrl  = 'https://github.com/kennrick69/imp-interface/releases/download/v0.3.1/IMP-Squad-Comando-0.3.1-portable.exe'
    $ExeDir  = "$env:LOCALAPPDATA\\IMP-Squad"
    $ExePath = "$ExeDir\\IMP-Squad.exe"
    $LnkPath = "$env:USERPROFILE\\Desktop\\IMP Squad.lnk"
    New-Item -ItemType Directory -Force -Path $ExeDir | Out-Null
    curl.exe -L --fail -o $ExePath $ExeUrl
    $WshShell = New-Object -ComObject WScript.Shell
    $Shortcut = $WshShell.CreateShortcut($LnkPath)
    $Shortcut.TargetPath       = $ExePath
    $Shortcut.WorkingDirectory = $ExeDir
    $Shortcut.IconLocation     = "$ExePath,0"
    $Shortcut.Description      = 'IMP Squad - Painel de Comando'
    $Shortcut.Save()
  `;
  return execFileP('powershell.exe', ['-NoProfile', '-Command', psScript]);
}
```

### Edge cases
- **Antivírus bloqueia .exe portable não-assinado** → Defender/SmartScreen pode quarentenar. Mitigação curto-prazo: instruções; longo-prazo: assinar binário.
- **Desktop redirecionado (OneDrive)** → `$env:USERPROFILE\Desktop` pode não ser o desktop real. Usar `[Environment]::GetFolderPath("Desktop")`:
  ```powershell
  $DesktopPath = [Environment]::GetFolderPath("Desktop")
  $LnkPath = Join-Path $DesktopPath 'IMP Squad.lnk'
  ```
- **Sem internet no momento do download** → curl falha; instalador deve cache local de fallback se já baixado antes.

---

## Apêndice A — execFileP helper (Electron)

Snippet único usado em todos os exemplos:
```javascript
// node: promise wrapper de execFile
const { execFile } = require('node:child_process');
function execFileP(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, { maxBuffer: 10_000_000, ...opts },
      (err, stdout, stderr) => {
        if (err) {
          err.stdout = stdout;
          err.stderr = stderr;
          return reject(err);
        }
        resolve({ stdout, stderr });
      });
    if (opts.input) child.stdin.end(opts.input);
  });
}
```

## Apêndice B — Ordem de execução recomendada (pro Marcos)

1. Detectar admin no host → se não, relançar elevado
2. `wsl --status` → instalar se ausente → **REBOOT** (instalador persiste estado)
3. (Após reboot) Detectar Ubuntu pronto → senão, abrir ubuntu.exe + esperar
4. apt update + base packages
5. Instalar nvm + Node LTS
6. Instalar gh (apt) + `gh auth login` (terminal interativo)
7. Clonar repos
8. Instalar Claude Code CLI (native installer)
9. `claude login` (terminal interativo)
10. Criar sessão tmux `imp` com 7 paneis
11. Download imp-interface.exe + shortcut Desktop
12. Abrir shortcut → JOs em casa.

## Apêndice C — Estado entre reboot

Como WSL install exige reboot, instalador precisa persistir progresso em disco:
```
%LOCALAPPDATA%\IMP-Installer\state.json
{
  "step": "wsl-installed",
  "needsReboot": true,
  "startedAt": "2026-05-26T..."
}
```
E registrar auto-start pós-reboot (registry `HKCU\Software\Microsoft\Windows\CurrentVersion\RunOnce` ou Task Scheduler) — esse é território da Patrícia (risco) e do Marcos (roteiro).
