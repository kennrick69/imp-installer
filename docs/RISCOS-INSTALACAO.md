# RISCOS DE INSTALAÇÃO — IMP Squad

**Autora**: Patrícia (QA)
**Data**: 2026-05-26
**Premissa**: assuma que VAI dar errado em algum ponto. Cada risco abaixo veio de "e se...?" honesto, não paranoia. O instalador deve **detectar antes de tentar**, **falhar de forma legível**, e **permitir retomada**.

---

## Princípios transversais (Bruno, lê isso antes de codar)

1. **Idempotência total**: rodar 2x não pode quebrar nada. Antes de cada passo, checar "já está feito?".
2. **State machine + state.json**: cada passo tem 3 estados (`pending`, `running`, `done`). Reentrada lê o state e pula o que está `done`.
3. **Retry com backoff exponencial** em TUDO que toca rede (apt, npm, git clone, curl): 3 tentativas (2s, 8s, 30s).
4. **Logs verbosos em `%LOCALAPPDATA%\imp-installer\logs\<timestamp>.log`** — JOs cola no chat quando travar.
5. **Pré-flight check ANTES de cada bloco**: virtualização? internet? espaço em disco? RAM livre? Não comece o que vai falhar.
6. **Nunca usar `rm -rf` ou `del /s`** dentro de pasta do usuário sem confirmação dupla.
7. **Mensagens curtas + "o que fazer agora"**. Stack trace só no log, nunca na tela do JOs.

---

# PARTE 1 — RISCOS POR COMPONENTE

## 1. Instalação WSL2

### 1.1 Virtualização desabilitada na BIOS
- **Probabilidade**: alta (notebook corporativo, BIOS antiga, Ryzen com SVM off por padrão)
- **Impacto**: bloqueia tudo
- **Detecção**: `systeminfo | findstr /i "Hyper-V"` → se "A hypervisor has been detected" ausente E `Virtualization Enabled In Firmware: No` → bloqueio. Alternativa: `Get-ComputerInfo | select HyperV*`.
- **Mensagem ao JOs**:
  > A virtualização do processador está desligada na BIOS — sem isso o WSL2 não roda. Você precisa entrar na BIOS/UEFI (geralmente F2 ou DEL ao ligar) e ativar "Intel VT-x", "AMD-V" ou "SVM". Quando voltar, é só rodar o instalador de novo que ele continua do ponto certo.
- **Ação**: marcar passo como `blocked_user_action`, abrir link com tutorial por marca (Dell/Lenovo/HP), botão "Já liguei, tentar de novo".

### 1.2 Windows Home muito antigo (build < 19041)
- **Probabilidade**: baixa
- **Impacto**: bloqueia tudo
- **Detecção**: `[System.Environment]::OSVersion.Version.Build` < 19041.
- **Mensagem**:
  > Seu Windows precisa de atualização (build atual X, mínimo necessário 19041). Vou abrir o Windows Update — instale tudo, reinicie, e me chame de volta.
- **Ação**: abrir `ms-settings:windowsupdate`, parar instalação.

### 1.3 Hyper-V já instalado / conflito com VirtualBox / VMware antigo
- **Probabilidade**: média (devs costumam ter VirtualBox)
- **Impacto**: WSL2 pode funcionar mas VMs antigas quebram
- **Detecção**: `Get-WindowsOptionalFeature -Online -FeatureName Microsoft-Hyper-V` + checar VBox `Get-Service VBoxSDS`.
- **Mensagem**:
  > Detectei o VirtualBox instalado. Ele continua funcionando com WSL2, mas pode ficar mais lento. Tudo bem seguir? (sim/não)
- **Ação**: avisar e seguir; não desinstalar nada do JOs.

### 1.4 Falta de privilégio admin
- **Probabilidade**: média (notebook corporativo bloqueado)
- **Impacto**: bloqueia WSL install
- **Detecção**: `([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]"Administrator")` = false.
- **Mensagem**:
  > Pra instalar o WSL preciso rodar como administrador. Fecha aqui, clica com botão direito em "imp-interface" e escolhe "Executar como administrador". Já volto do ponto certo.
- **Ação**: detectar logo no launch, oferecer relaunch com UAC (`Start-Process -Verb RunAs`).

### 1.5 Reboot interrompido / usuário não reinicia
- **Probabilidade**: alta (humano clica "depois")
- **Impacto**: WSL2 não funciona até reboot
- **Detecção**: após `wsl --install`, checar `wsl -l -v` — se erro "kernel não carregado" ou exit code 1 → precisa reboot. Salvar `state.needs_reboot = true`.
- **Mensagem**:
  > Já instalei o WSL, mas o Windows precisa reiniciar pra carregar o kernel novo. Posso reiniciar agora (10s) ou você prefere depois? Quando voltar, abra o "imp-interface" no Desktop que eu continuo daqui.
- **Ação**: botão "Reiniciar agora" + "Reiniciar depois". Atalho Desktop já criado APONTANDO pro próprio instalador na fase 2.

### 1.6 WSL1 existente (sem WSL2)
- **Probabilidade**: média (instalações antigas)
- **Impacto**: distro Ubuntu pode subir como WSL1, performance ruim, networking diferente
- **Detecção**: `wsl -l -v` mostra VERSION 1.
- **Mensagem**:
  > Encontrei uma versão antiga do WSL aqui. Vou atualizar pra WSL2 (mais rápido e estável). Suas distros existentes continuam funcionando.
- **Ação**: `wsl --set-default-version 2` + `wsl --update`; se houver distro WSL1, NÃO converter automaticamente — perguntar.

### 1.7 Outra distro WSL já presente (Debian, Kali, etc.)
- **Probabilidade**: média
- **Impacto**: instalar Ubuntu por cima pode confundir; `wsl bash -lc` pega distro default
- **Detecção**: `wsl -l -q` lista distros; checar se Ubuntu já existe e se é default.
- **Mensagem**:
  > Vi que você já tem o Ubuntu instalado. Posso reusar essa instalação? (recomendado) Ou prefere uma nova, separada só pra IMP Squad?
- **Ação**: default = reusar. Se reusar, validar versão (`lsb_release -rs` ≥ 22.04). Senão, instalar `Ubuntu-24.04` com nome dedicado.

### 1.8 Ubuntu na 1ª boot pede usuário/senha (passo manual)
- **Probabilidade**: alta (sempre acontece em instalação nova)
- **Impacto**: instalador trava esperando input
- **Detecção**: `wsl -d Ubuntu -- whoami` retorna `root` → ainda não setou usuário.
- **Mensagem**:
  > Falta um passo manual: abra o Ubuntu uma vez (já abri pra você) e crie um usuário simples (ex: `jos`) e senha. Quando terminar, clique "Continuar" aqui.
- **Ação**: `start ubuntu.exe` + botão "Já criei o usuário".

---

## 2. Apt update + pacotes

### 2.1 Sem internet
- **Probabilidade**: média
- **Impacto**: bloqueia tudo daqui pra frente
- **Detecção**: `wsl bash -lc 'curl -s -o /dev/null -w "%{http_code}" https://archive.ubuntu.com'` ≠ 200 OU ping 8.8.8.8 falha.
- **Mensagem**:
  > Sem conexão com a internet. Cheque o Wi-Fi/cabo e clique "Tentar de novo". Se está em rede corporativa com proxy, me avisa que tenho um botão pra configurar.
- **Ação**: retry com backoff + botão "Configurar proxy".

### 2.2 Proxy corporativo
- **Probabilidade**: baixa (notebook do JOs é pessoal, mas vale prevenir)
- **Impacto**: apt/npm/git todos quebram
- **Detecção**: `curl https://github.com` sem proxy timeout, mas `curl https://intranet...` responde. Heurística: variável `HTTP_PROXY` no Windows.
- **Mensagem**:
  > Detectei que sua rede usa proxy. Cole o endereço (ex: `http://proxy.empresa:8080`) ou pule se não souber.
- **Ação**: configurar `/etc/apt/apt.conf.d/95proxy`, `~/.npmrc`, `git config --global http.proxy`.

### 2.3 Mirror Ubuntu lento / fora do ar
- **Probabilidade**: baixa
- **Impacto**: apt update demora 5+ min ou falha
- **Detecção**: apt-get update com timeout 120s.
- **Mensagem**:
  > O servidor de pacotes do Ubuntu está lento. Tentando mirror alternativo (BR)…
- **Ação**: fallback pra `br.archive.ubuntu.com` editando `/etc/apt/sources.list`.

### 2.4 Conflito de pacotes / `dpkg --configure -a` pendente
- **Probabilidade**: baixa (em Ubuntu novo) / alta (se reusar Ubuntu antigo)
- **Impacto**: apt install falha com "E: dpkg was interrupted"
- **Detecção**: stderr contém "dpkg was interrupted" OU "broken packages".
- **Mensagem**:
  > Ubuntu pediu uma faxina antes de continuar. Rodando reparo automático (1 min)…
- **Ação**: `sudo dpkg --configure -a && sudo apt --fix-broken install -y`.

### 2.5 `build-essential` ou outro pacote pede confirmação
- **Probabilidade**: alta (sempre que tem `gcc`)
- **Impacto**: instalador trava
- **Detecção**: prevenir, não detectar.
- **Mensagem**: (silenciosa)
- **Ação**: SEMPRE `apt-get install -y` + `DEBIAN_FRONTEND=noninteractive`.

### 2.6 Espaço em disco insuficiente
- **Probabilidade**: média (SSDs pequenos)
- **Impacto**: instala parcialmente, deixa Ubuntu corrompido
- **Detecção**: `df -h /` antes de começar. Mínimo: 5 GB livres em C:.
- **Mensagem**:
  > Preciso de pelo menos 5 GB livres no C:, encontrei só X GB. Libere espaço e tente de novo.
- **Ação**: parar.

---

## 3. Node LTS

### 3.1 Nodesource vs nvm — escolha estratégica
- **Recomendação QA**: usar **nvm**. Motivos:
  - nodesource exige `sudo` e mexe em `/usr/bin` — qualquer atualização do sistema pode quebrar
  - nvm é isolado em `~/.nvm`, fácil de remover/reinstalar
  - Squad pode pedir versão específica no futuro (não trava em 20)
  - Não exige `sudo` pra instalar pacotes globais (resolve risco 4.1)
- **Custo**: nvm exige `source ~/.nvm/nvm.sh` no shell — instalador precisa abrir bash com `-l` (login shell) ou injetar source no `.bashrc`.

### 3.2 Version mismatch (Node 18 já instalado, Squad precisa 20+)
- **Probabilidade**: média (se reusar Ubuntu existente)
- **Impacto**: Claude Code CLI exige Node ≥20, falha cripticamente
- **Detecção**: `node --version` < v20.
- **Mensagem**:
  > Achei Node 18 aqui. A IMP Squad precisa do 20+. Vou instalar a versão 20 LTS via nvm (não mexe na 18 atual).
- **Ação**: instalar via nvm + `nvm alias default 20`.

### 3.3 PATH não atualizado na sessão atual
- **Probabilidade**: alta
- **Impacto**: `node` ainda aponta pra binary velho/inexistente
- **Detecção**: depois de instalar, `which node` em shell NOVO (`wsl bash -lc 'which node'`).
- **Mensagem**: (silenciosa)
- **Ação**: SEMPRE rodar comandos com `wsl bash -lc '...'` (login shell carrega nvm). Nunca `wsl bash -c`.

### 3.4 nvm download falha (raw.githubusercontent rate limit)
- **Probabilidade**: baixa
- **Impacto**: bloqueia node
- **Detecção**: curl install script retorna 429.
- **Mensagem**:
  > GitHub está limitando downloads. Tento de novo em 30s, 1min, 2min — se persistir, baixo um pacote alternativo.
- **Ação**: retry + fallback nodesource como plano B.

---

## 4. Claude CLI

### 4.1 npm permissions (EACCES em `/usr/lib/node_modules`)
- **Probabilidade**: alta SE usar nodesource
- **Impacto**: `npm install -g` falha
- **Detecção**: stderr "EACCES".
- **Mensagem**:
  > npm sem permissão pra escrever globalmente. Configurando pasta pessoal…
- **Ação**: `npm config set prefix ~/.npm-global` + adicionar ao PATH no `.bashrc`. (Se for nvm, não acontece — prefix já é do usuário.)

### 4.2 Rede / npm registry fora
- **Probabilidade**: baixa
- **Impacto**: instalação falha
- **Detecção**: `npm ping` retorna erro.
- **Mensagem**:
  > O registro do npm tá fora. Tentando de novo…
- **Ação**: retry com backoff; fallback `--registry=https://registry.npmmirror.com` se persistir.

### 4.3 Node muito velho — CLI não instala
- **Probabilidade**: baixa (já cobrimos em 3.2)
- **Impacto**: pacote falha com "engines" warning
- **Detecção**: stderr "EBADENGINE" ou exit code ≠ 0.
- **Mensagem**:
  > Versão do Node não bate. Reinstalando 20 LTS…
- **Ação**: pular pra passo 3.2.

### 4.4 Versão da CLI muda contrato (regressão futura)
- **Probabilidade**: baixa
- **Impacto**: comportamento da squad muda
- **Detecção**: instalar versão pinada, não `@latest`.
- **Mensagem**: (silenciosa)
- **Ação**: `npm install -g @anthropic-ai/claude-code@<versão testada>`. Atualizar pin a cada release do instalador.

---

## 5. Claude login (interativo)

### 5.1 Usuário sem plano Max
- **Probabilidade**: baixa (JOs tem Max) / média (outros usuários no futuro)
- **Impacto**: login funciona mas squad esgota cota rapidamente
- **Detecção**: difícil — só após uso. Antes do login, exibir aviso.
- **Mensagem**:
  > A IMP Squad foi feita pro plano Claude Max (uso intenso). Se você está no Pro, vai funcionar mas com limites menores. Tudo bem seguir?
- **Ação**: confirmação + seguir.

### 5.2 Navegador não abre / OAuth bloqueado por antivírus
- **Probabilidade**: média
- **Impacto**: login não completa
- **Detecção**: timeout de 5 min no `claude login`, sem token salvo.
- **Mensagem**:
  > O navegador não abriu sozinho. Copie esse link e cole no Chrome/Edge: `<URL>`. Quando autorizar, volta aqui e clica "Já fiz login".
- **Ação**: mostrar URL manualmente, polling de `~/.claude/auth.json` ou equivalente.

### 5.3 Login parcial (token salvo mas inválido)
- **Probabilidade**: baixa
- **Impacto**: squad falha no primeiro prompt
- **Detecção**: `claude --version` ok mas `claude -p "ping"` retorna 401.
- **Mensagem**:
  > Login não terminou direito. Vou tentar de novo.
- **Ação**: `claude logout` + relogin.

### 5.4 Sessão WSL fecha durante login (mata navegador callback)
- **Probabilidade**: baixa
- **Impacto**: token nunca chega
- **Detecção**: timeout.
- **Mensagem**:
  > Algo cortou a conexão durante o login. Tentando de novo…
- **Ação**: rodar `claude login` dentro de `tmux new -d -s claude-login` pra sobreviver a quedas.

---

## 6. GitHub auth

### 6.1 Token expirado
- **Probabilidade**: alta (PATs expiram)
- **Impacto**: clone falha 401
- **Detecção**: `curl -H "Authorization: token $TOKEN" https://api.github.com/user` → 401.
- **Mensagem**:
  > Seu token do GitHub expirou ou está inválido. Vou abrir a página pra gerar um novo — escolha "repo" e "read:org" como scopes.
- **Ação**: abrir `https://github.com/settings/tokens/new?scopes=repo,read:org&description=IMP-Squad`, campo pra colar.

### 6.2 Sem scope correto
- **Probabilidade**: média (usuário cria token sem `repo`)
- **Impacto**: clone público funciona, privado falha
- **Detecção**: response header `X-OAuth-Scopes` não contém `repo`.
- **Mensagem**:
  > Esse token não tem permissão pra repositórios privados. Crie outro marcando "repo".
- **Ação**: re-pedir.

### 6.3 2FA bloqueia HTTPS sem token (usuário tenta senha)
- **Probabilidade**: média (usuário menos técnico)
- **Impacto**: clone trava esperando senha que GitHub rejeita
- **Detecção**: prevenir — NUNCA pedir senha, só token.
- **Mensagem**: (instrução clara)
- **Ação**: usar exclusivamente PAT via `git-credentials` ou `gh auth login --with-token`.

### 6.4 Rate limit (HTTP 429 ou 403 "rate limit exceeded")
- **Probabilidade**: baixa
- **Impacto**: clone falha
- **Detecção**: stderr contém "rate limit".
- **Mensagem**:
  > GitHub pediu pra esperar um pouco. Tentando de novo em 1 minuto…
- **Ação**: backoff longo (1, 2, 5 min) — rate limit reseta em 1h.

### 6.5 Token vazado no log
- **Probabilidade**: média (log captura stdout/stderr)
- **Impacto**: segurança
- **Detecção**: prevenir.
- **Mensagem**: (silenciosa)
- **Ação**: NUNCA logar comandos que contêm `$TOKEN` literal. Salvar em `~/.git-credentials` com `chmod 600` e referenciar via credential helper.

---

## 7. Clone repos

### 7.1 `_squad` não existe ainda no GitHub
- **Probabilidade**: alta (contexto diz "AINDA NÃO EXISTE")
- **Impacto**: clone falha 404
- **Detecção**: antes do clone, `curl -H "Authorization: ..." https://api.github.com/repos/kennrick69/_squad` → 404.
- **Mensagem**:
  > O repositório `_squad` ainda não está no GitHub. Posso copiar a versão local do seu notebook (se você estiver no notebook origem) OU posso baixar um snapshot que o time preparou.
- **Ação**: **decisão arquitetural pro Bruno**: criar fallback — pasta `imp-installer/seeds/_squad.tar.gz` com snapshot dos `_shared/*.md`. Instalador descompacta em `C:\Projetos\_squad` se clone falhar 404. Mesmo padrão pra `escritorio-3d`.

### 7.2 Repo privado sem permissão (kennrick69)
- **Probabilidade**: média
- **Impacto**: clone falha 403/404 (GitHub mascara 403 como 404)
- **Detecção**: 404 com token válido = sem acesso.
- **Mensagem**:
  > Esse repositório é privado e sua conta GitHub não tem acesso. Você está logado como X — é a conta certa?
- **Ação**: mostrar usuário atual (`gh api user --jq .login`), oferecer trocar.

### 7.3 Rede cai no meio do clone (repo grande)
- **Probabilidade**: média (3d = 130 MB)
- **Impacto**: pasta `.git` parcial, próxima tentativa quebra
- **Detecção**: exit code ≠ 0; pasta `.git/index.lock` presente.
- **Mensagem**:
  > Conexão caiu no meio do download. Limpando e tentando de novo…
- **Ação**: `rm -rf <pasta>` (só se foi instalador que criou — checar marcador `.imp-installer-managed`), retry. Usar `git clone --depth=1` pra repos pesados que não precisam histórico.

### 7.4 Pasta `C:\Projetos\<repo>` já existe com conflito
- **Probabilidade**: alta (JOs já clonou manualmente algum)
- **Impacto**: clone falha "destination path already exists"
- **Detecção**: `Test-Path` Windows + checar se é git repo (`git -C <path> rev-parse`).
- **Mensagem (caso é git repo válido)**:
  > Você já tem o `imp-orchestrator` clonado aqui. Quer que eu use essa cópia (atualizando com `git pull`) ou prefere começar do zero (backup automático da pasta atual)?
- **Mensagem (caso não é git repo, é pasta qualquer)**:
  > A pasta `C:\Projetos\imp-orchestrator` existe mas não é um repositório git. Vou renomear pra `imp-orchestrator.backup-<data>` e clonar limpo. Ok?
- **Ação**: detectar tipo + opções; NUNCA apagar sem confirmar.

### 7.5 CRLF / autocrlf bagunça o working tree
- **Probabilidade**: alta (anotado na memória do JOs: "100+ arquivos modified por flip CRLF")
- **Impacto**: cosmético mas confunde JOs depois
- **Detecção**: depois do clone, `git status` mostra muitos modified.
- **Mensagem**: (silenciosa)
- **Ação**: ANTES do primeiro clone, `git config --global core.autocrlf input` no WSL E `core.autocrlf true` no Git for Windows (se existir). Adicionar `.gitattributes` se repo não tiver — mas isso é responsabilidade do repo, não do instalador. **Recomendação Bruno**: documentar mas não tentar consertar repos alheios.

---

## 8. Sala 3D (`escritorio-3d`, 130 MB)

**Estratégias possíveis**:
| Estratégia | Prós | Contras | Recomendação QA |
|---|---|---|---|
| A) Subir pro GitHub (LFS) | Versionado, atualizável | Setup LFS, custo storage, requer auth | Médio prazo |
| B) Embutir no .exe do instalador | 1-click | .exe fica 150 MB+, lento pra baixar release, update da arte = novo release | Não |
| C) Release asset separado (zip) no GitHub Releases do imp-installer | Atualizável sem rebuild, sem LFS, instalador baixa só se faltar | Precisa hospedar, link pode expirar | **SIM** |
| D) S3/CDN próprio | Performance | Custo, complexidade auth | Overkill |

**Recomendação**: **C** — release asset `escritorio-3d-v1.0.0.zip` no repo `imp-installer`. Instalador checa hash SHA256, baixa com retry, extrai pra `C:\Projetos\escritorio-3d`. Versão atual em `state.json` permite update incremental.

### 8.1 Download interrompido
- **Detecção**: hash SHA256 não bate após download
- **Mensagem**: "Arquivo da sala 3D veio corrompido (110 de 130 MB). Tentando de novo…"
- **Ação**: retry; usar curl com `-C -` (resume).

### 8.2 Pasta já existe (JOs editou modelos localmente)
- **Detecção**: pasta presente sem marcador `.imp-installer-managed`.
- **Mensagem**: "Vi modificações suas na sala 3D. Não vou sobrescrever. Pular atualização?"
- **Ação**: pular por default.

---

## 9. Sessão tmux

### 9.1 Sessão `imp` já existe
- **Probabilidade**: alta (reentrada, ou JOs criou manual)
- **Impacto**: `tmux new -s imp` falha "duplicate session"
- **Detecção**: `tmux has-session -t imp 2>/dev/null`.
- **Mensagem**:
  > A sessão tmux `imp` já existe. Posso anexar (`attach`) ou recriar do zero (perde estado atual)?
- **Ação**: default = anexar. Recriar exige confirmação.

### 9.2 Claude Code falha em painel específico
- **Probabilidade**: média (auth não propaga, working dir errado)
- **Impacto**: painel vazio / erro
- **Detecção**: após `send-keys 'claude'`, checar com `capture-pane` se prompt apareceu em 10s.
- **Mensagem**:
  > O painel `<nome>` não subiu. Vou tentar de novo nele.
- **Ação**: retry por painel, log do `capture-pane` no log do instalador. Se persistir após 2 tentativas, marcar painel como `degraded` mas seguir.

### 9.3 tmux versão muito antiga (< 3.0)
- **Probabilidade**: baixa (Ubuntu 22.04+ tem 3.2)
- **Impacto**: comandos modernos (`-Z`, formatos) falham
- **Detecção**: `tmux -V`.
- **Mensagem**:
  > tmux antigo. Atualizando…
- **Ação**: `apt install -y tmux` (último).

### 9.4 Painel morre logo após criar (TERM errado, locale)
- **Probabilidade**: média
- **Impacto**: claude code reclama de TERM/UTF
- **Detecção**: `capture-pane` mostra "TERM not set" ou caracteres `?`.
- **Mensagem**: (silenciosa)
- **Ação**: `tmux set -g default-terminal "tmux-256color"` + garantir `LANG=pt_BR.UTF-8` ou `C.UTF-8` no `.bashrc`.

---

## 10. Reentrada

### 10.1 `state.json` corrompido (JSON inválido)
- **Probabilidade**: baixa (escrita atômica previne) / média (se Bruno não fizer atômica)
- **Impacto**: instalador não sabe onde parou
- **Detecção**: `JSON.parse` falha no carregamento.
- **Mensagem**:
  > Não consegui ler o estado da instalação anterior. Posso recomeçar do zero validando o que já está instalado (mais lento mas seguro).
- **Ação**: backup do state corrompido + modo "rediscovery" — checa cada componente independente e regenera state. **Recomendação Bruno**: escrita atômica via tmp + rename (`fs.renameSync`), nunca write direto.

### 10.2 Usuário mudou paths (renomeou `C:\Projetos` → `D:\dev`)
- **Probabilidade**: baixa
- **Impacto**: state aponta pra caminhos inexistentes
- **Detecção**: cada passo `done` valida path existe antes de pular.
- **Mensagem**:
  > A pasta `C:\Projetos\imp-orchestrator` registrada não existe mais. Você moveu? Cole o novo caminho ou eu re-clono.
- **Ação**: pedir input ou re-clonar.

### 10.3 Componente foi removido manualmente (JOs `apt remove tmux`)
- **Probabilidade**: baixa
- **Impacto**: state diz `done` mas componente sumiu
- **Detecção**: validação re-checa binário (`which tmux`).
- **Mensagem**:
  > tmux sumiu desde a última vez. Reinstalando.
- **Ação**: re-rodar passo, atualizar state.

### 10.4 Versão do instalador upgrade (v0.3 → v0.4) com state antigo
- **Probabilidade**: alta no futuro
- **Impacto**: estrutura do state.json muda, parse quebra
- **Detecção**: campo `schema_version` no state.
- **Mensagem**:
  > Atualizei o instalador. Vou migrar suas configurações…
- **Ação**: **Recomendação Bruno**: incluir `schema_version: 1` desde dia 1; ter função `migrate(state)` mesmo que no início seja no-op.

### 10.5 Dois instaladores rodando ao mesmo tempo
- **Probabilidade**: baixa
- **Impacto**: corrupção state, comandos conflitantes
- **Detecção**: lockfile `%LOCALAPPDATA%\imp-installer\.lock` com PID.
- **Mensagem**:
  > Já tem um instalador rodando (PID X). Feche aquele primeiro.
- **Ação**: bloquear.

---

# PARTE 2 — CHECKLIST DE TESTES DE VALIDAÇÃO

Cada passo do instalador termina com um teste OK. Bruno: rode TODOS antes de marcar `done` no state.

## Pré-flight (Windows)
| O que valida | Comando | Resultado esperado |
|---|---|---|
| Virtualização ON | `powershell -c "(Get-CimInstance Win32_Processor).VirtualizationFirmwareEnabled"` | `True` |
| Admin | `powershell -c "([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]'Administrator')"` | `True` |
| Build Windows | `powershell -c "[Environment]::OSVersion.Version.Build"` | `≥19041` |
| Espaço C: | `powershell -c "(Get-PSDrive C).Free / 1GB"` | `≥5` |
| Internet | `powershell -c "Test-NetConnection github.com -Port 443 -InformationLevel Quiet"` | `True` |

## WSL2
| O que valida | Comando | Resultado esperado |
|---|---|---|
| WSL instalado | `wsl --status` | output sem erro |
| Default version 2 | `wsl --status` | contém "Default Version: 2" |
| Ubuntu existe | `wsl -l -q` | contém `Ubuntu` |
| Ubuntu é WSL2 | `wsl -l -v` | linha Ubuntu mostra `2` |
| Ubuntu boot ok | `wsl -d Ubuntu -- echo ok` | `ok` |
| User não-root | `wsl -d Ubuntu -- whoami` | ≠ `root` |

## Pacotes apt
| O que valida | Comando | Resultado esperado |
|---|---|---|
| tmux | `wsl bash -lc 'tmux -V'` | `tmux 3.x` |
| git | `wsl bash -lc 'git --version'` | `git version 2.x` |
| curl | `wsl bash -lc 'curl --version | head -1'` | contém `curl 7` ou `8` |
| build-essential | `wsl bash -lc 'gcc --version'` | mostra versão |

## Node + npm
| O que valida | Comando | Resultado esperado |
|---|---|---|
| Node ≥20 | `wsl bash -lc 'node --version'` | `v20.x` ou maior |
| npm funcional | `wsl bash -lc 'npm --version'` | versão 10+ |
| nvm carregado (se nvm) | `wsl bash -lc 'command -v nvm'` | `nvm` (function) |
| npm prefix gravável | `wsl bash -lc 'npm config get prefix'` | path em `$HOME` |

## Claude CLI
| O que valida | Comando | Resultado esperado |
|---|---|---|
| Binary existe | `wsl bash -lc 'command -v claude'` | path não vazio |
| Versão | `wsl bash -lc 'claude --version'` | mostra versão |
| Login funcionando | `wsl bash -lc 'claude -p "responda só: pong"'` | contém `pong` |

## GitHub
| O que valida | Comando | Resultado esperado |
|---|---|---|
| Token válido | `wsl bash -lc 'curl -s -H "Authorization: token $(grep -oP "(?<=:)[^@]+(?=@github)" ~/.git-credentials | head -1)" https://api.github.com/user | grep login'` | retorna usuário |
| Acesso ao repo | `wsl bash -lc 'git ls-remote https://github.com/kennrick69/imp-orchestrator HEAD'` | hash + HEAD |
| Scope `repo` | `wsl bash -lc 'curl -sI -H "Authorization: token <T>" https://api.github.com/user | grep -i x-oauth-scopes'` | contém `repo` |

## Clones
| O que valida | Comando | Resultado esperado |
|---|---|---|
| `_squad` presente | `wsl bash -lc 'test -f /mnt/c/Projetos/_squad/_shared/REGRAS_GERAIS.md && echo OK'` | `OK` |
| `imp-orchestrator` presente | `wsl bash -lc 'test -d /mnt/c/Projetos/imp-orchestrator/.git && echo OK'` | `OK` |
| Sem `index.lock` | `wsl bash -lc 'test ! -f /mnt/c/Projetos/imp-orchestrator/.git/index.lock && echo OK'` | `OK` |
| `escritorio-3d` presente | `wsl bash -lc 'test -d /mnt/c/Projetos/escritorio-3d && echo OK'` | `OK` |
| Hash sala 3D | `wsl bash -lc 'sha256sum /mnt/c/Projetos/escritorio-3d/.version'` | match esperado |

## tmux session
| O que valida | Comando | Resultado esperado |
|---|---|---|
| Sessão `imp` existe | `wsl bash -lc 'tmux has-session -t imp 2>/dev/null && echo OK'` | `OK` |
| 7 paineis | `wsl bash -lc 'tmux list-panes -t imp | wc -l'` | `7` |
| Claude rodando em painel | `wsl bash -lc 'tmux capture-pane -t imp.0 -p | grep -i "claude\|>"'` | match |

## imp-interface.exe
| O que valida | Comando | Resultado esperado |
|---|---|---|
| Binário no Desktop | `powershell -c "Test-Path $env:USERPROFILE\Desktop\imp-interface.lnk"` | `True` |
| Versão correta | `powershell -c "(Get-Item ...).VersionInfo.FileVersion"` | `0.3.1` ou superior |

---

# RESUMO PRO BRUNO — recomendações arquiteturais

1. **State machine com schema_version**: desde v0.1 já gravar `schema_version: 1` + função `migrate()` (no-op inicial).
2. **Escrita atômica do state.json**: write tmp + rename — `fs.writeFileSync(tmp); fs.renameSync(tmp, real)`. Nunca write direto.
3. **Lockfile com PID** pra impedir 2 instâncias.
4. **Retry com backoff exponencial (2s, 8s, 30s)** em TUDO que toca rede. Função `withRetry(fn, label)` reusável.
5. **Engine de pré-flight checks**: rodar batch antes de cada bloco — não comece o que vai falhar.
6. **Marcador `.imp-installer-managed`** em cada pasta criada. Sem esse marcador, NUNCA apagar.
7. **Logs em `%LOCALAPPDATA%\imp-installer\logs\<ts>.log`** com timestamp + componente + comando + stderr. Token MASCARADO.
8. **Use `wsl bash -lc`** (login shell) sempre — carrega nvm/PATH.
9. **`DEBIAN_FRONTEND=noninteractive`** em todo apt + `-y`.
10. **Seeds locais como fallback** quando GitHub não tem repo ainda (`seeds/_squad.tar.gz`, `seeds/escritorio-3d.zip` ou download de release asset).
11. **Validação pós-step OBRIGATÓRIA** (parte 2 deste doc) — só marca `done` se teste passar.
12. **`schema_version` no state.json** — JÁ DITO mas crítico, repetindo.
