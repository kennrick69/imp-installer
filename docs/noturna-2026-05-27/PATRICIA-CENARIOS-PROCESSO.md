# PATRÍCIA — Cenários futuros, processo de validação real e como a squad testa o .exe

**Autora**: Patrícia (QA, IMP Dev Squad)
**Data**: 2026-05-27 — sessão noturna
**Premissa**: JOs cobrou — por que bugs só aparecem no `.exe` do PC dele e nunca no nosso "OK" da squad?
Este doc responde com 4 frentes: (1) cenários futuros preventivos, (2) processo de validação que vale como prova real, (3) análise sistêmica do hiato squad↔JOs, (4) como a squad passa a testar o `.exe` antes do release.

---

## SUMÁRIO EXECUTIVO

- **23 cenários futuros mapeados** (mín. pedido: 15), todos com detecção + tratamento + mensagem humana.
- **Tabela de provas por step (17 steps)** — cada step define o que conta como "feito" com comando exato e falsos positivos a evitar. Essa é a peça que mata o "OK fake".
- **Causa raiz do hiato squad↔JOs**: a squad nunca executou `.exe` Windows. Tudo que validamos rodou em WSL/Node nativo, sem Electron-GUI, sem PowerShell real, sem RunOnce, sem encoding UTF-16/cp850, sem antivírus, sem AppX, sem manifest. Os bugs que JOs viu são todos do mundo Win exclusivo.
- **Recomendação primária**: combinar **A (VM Windows local) + B (GitHub Actions runner Windows) + E (smoke estático tipo jsdom em CI)** + processo de **branch interna validada antes de publicar release**.

---

## 1. CENÁRIOS FUTUROS QUE VÃO ACONTECER

Cada cenário tem: descrição, probabilidade no público-alvo (JOs + futuros usuários), como detectar, como tratar, mensagem humana.

### C1 — WSL1 instalado (não WSL2)
- **Descrição**: instalador assume WSL2; usuário tem WSL1 da época de 2018-2020.
- **Probabilidade**: média (devs antigos).
- **Detectar**: `wsl -l -v` parse — coluna VERSION mostra `1` em ≥1 distro. Se `wsl --status` retornar "Default Version: 1".
- **Tratar**: `wsl --set-default-version 2` + `wsl --update` (modo moderno) ou avisar pra rodar manualmente se for legado.
- **Mensagem**: "Achei uma versão antiga (WSL1) aqui. Vou atualizar pra WSL2 (mais rápido). Suas distros existentes vão continuar — mas, pra serem rápidas também, posso convertê-las depois (te aviso antes)."

### C2 — Virtualização desabilitada na BIOS
- **Probabilidade**: alta (notebooks corporativos, alguns AMD com SVM off).
- **Detectar**: `Get-CimInstance Win32_Processor | Select-Object -ExpandProperty VirtualizationFirmwareEnabled` → `False`. Backup: `systeminfo | findstr /i "Virtualization"`.
- **Tratar**: marcar passo como `blocked_user_action`, abrir link com tutorial por marca (Dell/Lenovo/HP/ASUS).
- **Mensagem**: "Seu processador tem virtualização DESLIGADA na BIOS. Sem isso, WSL2 não roda. Você precisa entrar na BIOS (geralmente F2 ou DEL ao ligar o PC) e ativar 'Intel VT-x', 'AMD-V' ou 'SVM'. Quando voltar, abro de novo do ponto certo."

### C3 — Hyper-V conflitando / hypervisorlaunchtype Off
- **Probabilidade**: média (devs que mexeram com VirtualBox).
- **Detectar**: `bcdedit /enum {current}` parse `hypervisorlaunchtype` — se for `Off`, virtualização está bloqueada pro Hyper-V/WSL2.
- **Tratar**: `bcdedit /set hypervisorlaunchtype Auto` + reboot obrigatório.
- **Mensagem**: "Detectei que o hypervisor do Windows está DESLIGADO (provavelmente alguém rodou um comando antigo do VirtualBox). Vou religar e reiniciar. Suas VMs antigas voltam funcionando depois do reboot."

### C4 — Microsoft Store bloqueada por GPO empresarial
- **Probabilidade**: média (PCs corporativos).
- **Detectar**: tentar `winget --version` → falha; checar reg `HKLM\SOFTWARE\Policies\Microsoft\WindowsStore\RemoveWindowsStore = 1` ou similar; `Add-AppxPackage` retorna `0x80073CFF`.
- **Tratar**: fallback pra download direto do AppX (`.appx`/`.appxbundle`) via `Invoke-WebRequest` no canal aka.ms/wslubuntu2204, instala com `Add-AppxPackage`. Se também bloqueado por GPO de AppX, escalonar pra passo manual instrumentado.
- **Mensagem**: "A loja Microsoft está bloqueada nesse PC (provavelmente política da empresa). Vou tentar baixar o Ubuntu direto. Se também der erro, te dou o link e instruções pra pedir pro TI."

### C5 — Reboot esperado mas não aconteceu (JOs deixou pra depois)
- **Probabilidade**: alta (humano clica "depois").
- **Detectar**: `state.json.needs_reboot === true` E `os.uptime() > tempoDoMarcadorDeReboot`. Refinamento: gravar `state.rebootMarkerAt = Date.now()` ANTES de pedir reboot e comparar com `os.uptime()` na próxima entrada — se uptime < (Date.now() - marker), houve reboot; senão, NÃO houve.
- **Tratar**: ao reentrar, se ainda não rebootou, MOSTRAR aviso firme + botão "Reiniciar agora (10s)" / "Vou reiniciar manual". Não tentar prosseguir.
- **Mensagem**: "Ainda não reiniciou. Sem reboot, o WSL não carrega o kernel novo. Reinicio agora? (10s de aviso, salvo seu progresso)."

### C6 — RunOnce não disparou após reboot
- **Probabilidade**: média (Windows às vezes pula, ou JOs cancelou no logon).
- **Detectar**: checar registry `HKCU\Software\Microsoft\Windows\CurrentVersion\RunOnce` — se a entrada CRIADA pelo instalador ainda existe APÓS reboot, RunOnce não disparou (ele apaga depois de rodar). Se não existe E o state.json continua em `needs_reboot=true`, executou mas o instalador não foi inicializado.
- **Tratar**: tentar abrir instalador imediatamente (botão no Desktop existe). Se Desktop shortcut sumiu, recriar.
- **Mensagem**: "Reiniciou mas o instalador não voltou sozinho. Sem problema — abre o atalho 'IMP Squad' no Desktop que eu continuo daqui."

### C7 — Rede cai durante download do Ubuntu (parcial)
- **Probabilidade**: média (Wi-Fi instável, conexão móvel).
- **Detectar**: download interrompido — checar tamanho do .appx baixado vs Content-Length esperado; `Invoke-WebRequest` exit code ≠ 0.
- **Tratar**: retomar com `curl.exe -C -` (resume) ou `BITS` (Background Intelligent Transfer Service); registrar checkpoint em `state.json.downloads[ubuntu] = { bytesDone, expectedSize, etag }`. Retry com backoff 2s, 8s, 30s.
- **Mensagem**: "Internet caiu no meio do download (X de Y MB já baixados). Tento continuar de onde parou daqui a 2 segundos…"

### C8 — Debian/Kali/outra distro já é default
- **Probabilidade**: média (devs que testaram outras distros).
- **Detectar**: `wsl --status` parse "Default Distribution: <X>" — se ≠ Ubuntu, está em conflito; OU `wsl -l -v` mostra `*` em outra distro.
- **Tratar**: NÃO mexer na default do usuário SEM avisar. Perguntar: "Quer que IMP Squad use sua distro X existente OU instalo um Ubuntu dedicado?"
- **Mensagem**: "Você já tem Debian/Kali como padrão. Posso usar essa distro (rápido) ou instalar um Ubuntu dedicado pra IMP Squad (não mexe na sua atual). O que prefere?"

### C9 — Antivírus corporativo bloqueia spawn de cmd/wsl/powershell
- **Probabilidade**: média (CrowdStrike, Symantec, Sophos, Trend).
- **Detectar**: `child_process.spawn('wsl.exe')` retorna ENOENT mesmo com wsl.exe existindo em `C:\Windows\System32\wsl.exe`; OU exit code `-1073741819` (0xC0000005 access violation); OU logs do Windows Event mostram bloqueio Defender/AV.
- **Tratar**: detectar com check leve (`Get-Process` consegue listar AV conhecido?), avisar JOs que pode haver bloqueio, sugerir whitelist da pasta do instalador no AV.
- **Mensagem**: "O antivírus aqui (X detectado) pode estar bloqueando comandos. Se der erro, abre o painel do antivírus e adiciona a pasta `<caminho>` como confiável. Eu mostro o caminho exato quando você abrir."

### C10 — Disco enche durante apt update
- **Probabilidade**: baixa-média (SSD 128GB).
- **Detectar**: ANTES de cada bloco apt, `wsl bash -lc 'df --output=avail / | tail -1'` — exigir mínimo 2GB livres dentro do WSL; ANTES da install completa, exigir 5GB no C:.
- **Tratar**: parar com mensagem clara e link pro "Liberar espaço" do Windows.
- **Mensagem**: "Disco cheio (só X MB livres). Preciso de pelo menos 2GB pra continuar. Libera espaço (Limpeza de Disco do Windows, ou exclui downloads grandes) e clica 'Tentar de novo'."

### C11 — JOs fecha instalador no meio
- **Probabilidade**: alta (humano fecha tudo às vezes).
- **Detectar**: ao reentrar, `state.json.lastStepCompleted` + cada step `pending|running|done`. Step que estava `running` ao fechar precisa ser **reavaliado**, não pulado.
- **Tratar**: na reentrada, perguntar "Vi que parei no Passo X. Verifico se ele completou (rápido) e continuo, ou prefere recomeçar do zero?" Default = verificar.
- **Mensagem**: "Você fechou no meio do Passo X. Verifico em 5 segundos se ele terminou ou se preciso refazer. Não perdeu nada."

### C12 — 2 instâncias do instalador rodando
- **Probabilidade**: baixa (mas acontece com duplo-clique).
- **Detectar**: lockfile `%LOCALAPPDATA%\imp-installer\.lock` com PID + timestamp. Antes de abrir, checar se PID está vivo (`process.kill(pid, 0)` no Node retorna sem erro se vivo). Já existe em v0.2.6.
- **Tratar**: nova instância fecha imediatamente com toast no foco "Já tem instalador rodando".
- **Mensagem**: "Já tem uma janela do IMP Squad aberta. Vou trazer ela pra frente." (Electron `app.requestSingleInstanceLock` cobre.)

### C13 — state.json corrompido (JSON inválido)
- **Probabilidade**: baixa SE escrita atômica; média SE não.
- **Detectar**: `JSON.parse(fs.readFileSync(...))` lança SyntaxError.
- **Tratar**: backup do state corrompido em `state.json.broken-<ts>.bak`, entrar em modo "rediscovery" — varre cada componente (`wsl --status`, `wsl bash -lc 'which node'`, `Test-Path C:\Projetos\imp-orchestrator`) e reconstrói state.
- **Mensagem**: "Achei o estado da instalação anterior corrompido. Não tem drama — vou verificar o que já está instalado e continuo daí. Isso leva uns 30 segundos."

### C14 — AppX do Ubuntu instalado mas não roda
- **Probabilidade**: baixa.
- **Detectar**: `wsl -l -q` mostra Ubuntu, MAS `wsl -d Ubuntu -- echo ok` retorna erro ou hang. Pode ser kernel desatualizado, ou AppX parcialmente corrompido.
- **Tratar**: `wsl --update` + retry; se persistir, `wsl --unregister Ubuntu` + reinstalar (PERIGOSO se tinha dados — perguntar primeiro).
- **Mensagem**: "O Ubuntu instalou mas não está respondendo. Vou atualizar o kernel WSL e tentar de novo. Se não resolver, ofereço reinstalar (te aviso antes de apagar qualquer coisa)."

### C15 — PowerShell profile muda PATH (módulo esconde wsl.exe)
- **Probabilidade**: baixa (devs com profile customizado).
- **Detectar**: rodar PowerShell com `-NoProfile` consegue ver `wsl.exe`, MAS rodar normal não. Comparar `where.exe wsl` em ambos modos.
- **Tratar**: SEMPRE invocar PowerShell com `-NoProfile -NonInteractive -ExecutionPolicy Bypass` nos comandos do instalador. Documentar.
- **Mensagem**: (silenciosa — a correção é interna).

### C16 — pt-BR encoding UTF-16 BOM em saída de `wsl.exe`
- **Probabilidade**: ALTA (PC do JOs!).
- **Detectar**: stdout começa com bytes `0xFF 0xFE` ou contém `\x00` intercalado entre chars ASCII.
- **Tratar**: decodificar UTF-16LE quando detectar BOM ou padrão `<char>\0<char>\0`; fallback pra cp850/utf-8 sem BOM.
- **Mensagem**: (silenciosa — já implementado em v0.2.9/v0.2.12; manter regression test).

### C17 — Idioma pt-BR muda mensagem de erro do `Start-Process -Verb RunAs`
- **Probabilidade**: ALTA (Windows pt-BR é o caso JOs).
- **Detectar**: stderr contém "cancelad" (cancelada/cancelado em PT) ao invés de "cancelled".
- **Tratar**: regex multi-idioma: `/cancel(ad[ao]|lled|ed)/i` + checar exit code 1 + ausência de SPAWNED marker.
- **Mensagem**: "Você cancelou a permissão de administrador. Sem problema — clica de novo em 'Reabrir como administrador' quando quiser."
- **Nota**: já apontado por Eduardo na review v0.2.6 (achado #1).

### C18 — Caminho do .exe com caractere Unicode (JoãoPaixão)
- **Probabilidade**: média (nomes brasileiros em `C:\Users\<nome>`).
- **Detectar**: `process.execPath` contém char fora ASCII; PowerShell `Start-Process -FilePath '<path>'` falha com encoding.
- **Tratar**: escapar via `-ArgumentList` array ou passar caminho via stdin com `param($Exe)`. Validar com teste em `C:\Users\Téstê\Desktop\IMP.exe`.
- **Mensagem**: (silenciosa — fix interno).

### C19 — Janela renderiza fora da tela (multi-monitor com layout estranho)
- **Probabilidade**: baixa-média (devs com 2-3 monitores).
- **Detectar**: ao iniciar, ler `screen.getAllDisplays()` e verificar se posição/tamanho restaurados ainda cabem em algum display.
- **Tratar**: forçar `BrowserWindow` em display primário com `center: true` + `maximize()` no `ready-to-show` (já tem v0.2.11). Adicionar guard: se window.getBounds() fora de qualquer display, reset.
- **Mensagem**: (silenciosa).

### C20 — Manifest UAC `requireAdministrator` ignorado (Win 8.1 antigo)
- **Probabilidade**: muito baixa (target é Win10+, mas vale defesa).
- **Detectar**: SO < 10.0.x → instalador mostra aviso antes de tentar.
- **Tratar**: bloquear no preflight inicial com mensagem clara.
- **Mensagem**: "Detectei Windows 8.1 (build X). A IMP Squad precisa de Windows 10 ou superior. Faz a atualização do Windows e volta aqui."

### C21 — Defender SmartScreen bloqueia o `.exe` portable não-assinado
- **Probabilidade**: ALTA (todo `.exe` portable não-assinado dispara SmartScreen na primeira execução).
- **Detectar**: prevenir, não detectar — instruções no readme/site.
- **Tratar**: documentar "Mais informações > Executar mesmo assim" com screenshot; longo prazo, code-signing.
- **Mensagem (no site/release notes)**: "Na primeira execução o Windows vai mostrar 'Windows protegeu seu computador'. Clica em 'Mais informações' e depois 'Executar mesmo assim'. Isso é normal pra programas novos sem certificado caro."

### C22 — Win11 com Smart App Control matando o portable
- **Probabilidade**: baixa-média (Win11 default em PCs novos).
- **Detectar**: `Get-MpComputerStatus | Select SmartAppControlState` → `On`.
- **Tratar**: instruir desligar temporariamente OU avisar que precisa instalar via MSI assinado (versão futura).
- **Mensagem**: "Seu Windows 11 tem 'Smart App Control' ligado, que bloqueia programas sem certificado. Vou abrir a tela pra você desligar temporariamente (ou instala a versão MSI quando estiver disponível)."

### C23 — Login Claude expira no meio do uso (refresh token quebra)
- **Probabilidade**: média (tokens duram dias/semanas).
- **Detectar**: `claude -p "ping"` retorna 401 ou texto "authentication required". Periódico, não no instalador — mas o instalador pode dar diagnose pós-instalação.
- **Tratar**: rodar `claude logout && claude login` automaticamente, reabrir navegador.
- **Mensagem**: "Seu login do Claude expirou. Vou reabrir o navegador pra você logar de novo (10 segundos)."

---

## 2. PROCESSO DE VALIDAÇÃO REAL — TABELA DE PROVAS POR STEP

A regra de ouro: **só marca `done` no state se a prova passar**. NÃO basta "comando rodou sem stderr".

| Step | Prova de "feito" | Comando exato (executado no contexto Windows ou WSL) | Falsos positivos a evitar |
|---|---|---|---|
| 01 — habilitar features Windows | (a) `Get-WindowsOptionalFeature` retorna `Enabled` em VirtualMachinePlatform E Microsoft-Windows-Subsystem-Linux; (b) `wsl --status` executa sem erro de "comando não reconhecido" | `Get-WindowsOptionalFeature -Online -FeatureName VirtualMachinePlatform,Microsoft-Windows-Subsystem-Linux \| Where-Object State -eq Enabled \| Measure-Object \| Select -ExpandProperty Count` deve retornar `2`; depois `wsl --status` | "Feature: Enabled" no XML do dism NÃO basta — pode estar "Enable Pending" aguardando reboot. Tem que checar State propriamente. E `wsl --status` retornar help significa que wsl.exe é LEGADO mesmo com features Enabled. |
| 02 — set default version 2 | `wsl --status` contém linha "Default Version: 2" (case-insensitive, encoding-aware) | `wsl --status` → parse linha — também testar `wsl --set-default-version 2` retorna exit 0 SEM imprimir help | Output em UTF-16 pode parecer vazio; pt-BR diz "Versão Padrão: 2"; legado não tem essa linha. |
| 03 — instalar distro Ubuntu | `wsl -l -v` (parse UTF-16) contém linha começando com `Ubuntu` ou `*  Ubuntu` E coluna VERSION = 2 | `wsl --list --verbose` | "Ubuntu" pode estar VERSION=1 (precisa converter); pode estar `INSTALLING` (não está pronto); pode estar Ubuntu-20.04 (legado, exigir 22.04+). |
| 04 — primeiro boot + criar usuário | `wsl -d Ubuntu -- whoami` retorna NOME ≠ "root" E `wsl -d Ubuntu -- id -u` retorna número ≥ 1000 | `wsl -d Ubuntu --user <nome> -- whoami` | "ok" não basta — se retorna `root`, o usuário ainda NÃO foi criado e o instalador vai bagunçar permissões. Falso positivo clássico. |
| 05 — apt update + pacotes base | `dpkg -l \| grep -E '^ii\s+(tmux\|git\|curl\|ca-certificates\|build-essential)'` retorna 5 linhas | `wsl bash -lc 'dpkg -l \| grep -cE "^ii\s+(tmux\|git\|curl\|ca-certificates\|build-essential)"'` deve retornar `5` | Pacote pode estar `iU` (parcial); apt-get install pode ter exit 0 sem instalar nada se sources.list quebrado. |
| 06 — instalar nvm | `bash -lc 'command -v nvm'` retorna `nvm` (é função, não path) E `~/.nvm/nvm.sh` existe | `wsl bash -lc 'source ~/.nvm/nvm.sh && command -v nvm'` | Só `test -d ~/.nvm` não basta — install pode ter falhado no `curl install.sh`. |
| 07 — instalar Node 20 LTS via nvm | `node --version` em login shell retorna `v20.x.y` E é DEFAULT (`nvm alias default` → 20) | `wsl bash -lc 'node --version && nvm alias default \| grep "default"'` | `node --version` em shell NÃO-login retorna `command not found` mesmo com nvm instalado — sempre usar `bash -lc`. |
| 08 — npm config prefix em $HOME | `npm config get prefix` retorna path em `~` (não `/usr/lib`) | `wsl bash -lc 'npm config get prefix'` deve começar com `/home/` | nvm já configura — só checar se nodesource foi usado por engano. |
| 09 — instalar Claude CLI | `command -v claude` retorna path E `claude --version` retorna versão semver | `wsl bash -lc 'command -v claude && claude --version'` | `npm install -g` pode ter exit 0 com warnings; CLI pode estar instalada mas não no PATH dessa sessão. |
| 10 — claude login (interativo) | `claude -p "responda apenas: pong"` retorna texto contendo "pong" em ≤30s | `wsl bash -lc 'timeout 30 claude -p "responda apenas: pong"'` | `claude --version` ok não significa login ok; arquivo `~/.claude/auth.json` existir não significa token válido. SÓ um round-trip real prova. |
| 11 — GitHub token salvo + scope correto | `curl` com token retorna user, header `X-OAuth-Scopes` contém `repo` | `wsl bash -lc 'curl -sI -H "Authorization: token $TOKEN" https://api.github.com/user \| grep -iE "x-oauth-scopes:.*repo"'` retorna linha | Token válido mas sem scope `repo` autoriza READ público mas falha em privado. |
| 12 — clone _squad | `test -f /mnt/c/Projetos/_squad/_shared/REGRAS_GERAIS.md` retorna exit 0 E `git -C /mnt/c/Projetos/_squad rev-parse HEAD` retorna hash | `wsl bash -lc 'test -f /mnt/c/Projetos/_squad/_shared/REGRAS_GERAIS.md && git -C /mnt/c/Projetos/_squad rev-parse --short HEAD'` | Pasta existir não basta — pode ser shallow incompleto; `.git/index.lock` pode estar travada. |
| 13 — clone imp-orchestrator | igual 12 com adicional: `test -f /mnt/c/Projetos/imp-orchestrator/orchestrator.js` | `wsl bash -lc 'test -d /mnt/c/Projetos/imp-orchestrator/.git && test ! -f /mnt/c/Projetos/imp-orchestrator/.git/index.lock'` | Clone pode ter parado no `Resolving deltas` deixando o working tree incompleto. |
| 14 — sala escritorio-3d | (a) pasta existe, (b) hash SHA256 do `.version` bate com release esperada | `wsl bash -lc 'sha256sum /mnt/c/Projetos/escritorio-3d/.version'` compara com state.expectedHash3d | Pasta existir não basta — pode ser parcial; comparar hash. |
| 15 — sessão tmux `imp` criada com 7 paineis | `tmux list-panes -t imp \| wc -l` = 7 E cada painel responde via `tmux send-keys` + `capture-pane` mostra prompt | `wsl bash -lc 'tmux has-session -t imp && [ $(tmux list-panes -t imp \| wc -l) -eq 7 ]'` | Sessão pode existir com 7 paineis MORTOS (claude crashou); precisa capture-pane mostrar prompt vivo em cada um. |
| 16 — atalho Desktop `IMP Squad.lnk` | `Test-Path "$env:USERPROFILE\Desktop\IMP Squad.lnk"` E o `.lnk` aponta pra .exe que ainda existe | PowerShell parse via `(New-Object -COM WScript.Shell).CreateShortcut(...).TargetPath` retorna caminho válido | `.lnk` pode estar quebrado (target inexistente após mover .exe). |
| 17 — verificação final + abrir squad | (a) todos os steps acima `done`, (b) `imp-interface.exe` (orquestrador) abre sem crash, (c) janela renderizada em < 5s | `Start-Process imp-interface.exe; Start-Sleep 5; Get-Process imp-interface -ErrorAction SilentlyContinue` retorna processo vivo | Processo iniciar não significa janela visível — captura screenshot pra confirmar (parte 4). |

---

## 3. POR QUE BUGS SÓ APARECEM NO `.EXE` REAL DO JOs

Análise sistêmica honesta — e dolorosa.

### 3.1 Onde a squad realmente roda
A squad (Camila, Bruno, Eduardo, eu) roda em **WSL/Ubuntu nativo**. Nosso `npm start` ou `node main.js` carrega Electron contra **GTK no Linux**, com janela X11/XWayland. Comandos como `wt.exe`, `cmd.exe`, `powershell.exe`, `Start-Process -Verb RunAs`, manifest UAC, RunOnce, registry — **NENHUM** existe no nosso ambiente.

### 3.2 O que existe no `.exe` empacotado e NÃO existe no nosso teste
1. **PowerShell pt-BR**: Encoding `Windows-1252` ou UTF-16 nas saídas (depende do comando). Nosso `child_process.spawn('pwsh')` no Linux usa PowerShell Core com UTF-8 puro.
2. **`wsl.exe`**: nosso WSL não tem `wsl.exe` (somos o WSL!). Não conseguimos exercitar a layer `Windows→WSL` que é onde TODOS os bugs do JOs aparecem.
3. **Manifest `requireAdministrator`**: só vale em PE Windows. Linux Electron ignora.
4. **RunOnce + atalho Desktop**: registry HKCU + `.lnk` — não existem.
5. **AppX install + Microsoft Store**: irrelevante fora do Win.
6. **SmartScreen, Defender, AV corporativo**: zero exposição.
7. **PORTABLE_EXECUTABLE_FILE env var**: setada só pelo electron-builder quando roda `.exe` portable. Em `npm start` é `undefined`. Bugs como o do v0.2.6 (alvo de elevação errado) literalmente NÃO podem ser reproduzidos sem rodar o `.exe`.
8. **Encoding cp850/UTF-16**: nosso terminal é UTF-8. A primeira vez que o BOM `0xFF 0xFE` aparece é no PC do JOs.
9. **Empacotamento ASAR**: bugs como "arquivo X não está no asar" só explodem após build, nunca em dev.
10. **PATH com `\` e `C:\Program Files`**: parsing de path em Node funciona ambos, mas em comandos passados a PowerShell via string single-quoted o `\` requer cuidado.

### 3.3 A janela renderizada — o ponto cego dolorido
A squad **nunca viu o Electron renderizar o HTML+CSS no Windows real**. Nossa validação é:
- Eduardo lê código e contratos (ótimo pra IDs, listeners, payloads).
- Camila escreve UI e testa em jsdom/local Electron-Linux.
- Bruno escreve backend e testa funções isoladas.
- Eu (Patrícia) faço plano de teste no papel.

NENHUM de nós abre o `.exe` empacotado num Windows. JOs é nosso único "QA real". Por isso bugs como "botão não clica" (v0.2.15), "janela não maximiza" (v0.2.11), "UAC não aparece" (v0.2.5/v0.2.6) só foram descobertos por JOs.

### 3.4 O hiato fundamental
**Nosso "OK" é estático/estrutural; o "OK" do JOs é dinâmico/comportamental.** Enquanto nossa validação for só leitura de código + execução em Linux, vamos sempre estar atrás dos bugs Win-exclusivos. **A correção é fazer a squad rodar o `.exe` num Windows real, idealmente automaticamente.**

---

## 4. COMO A SQUAD PODE TESTAR O `.EXE` REAL ANTES DO RELEASE

Cinco opções analisadas, com prós/contras e recomendação.

### Opção A — VM Windows local (squad spawn QEMU/virsh com Win10 LTS)
- **Como**: imagem Win10 LTSC pré-configurada, sem antivírus pesado, com PowerShell pt-BR setado, snapshot "clean install". Squad anexa `.exe` via shared folder ou `scp`, executa via `virsh console` ou RDP, captura screenshots via QEMU `screendump`.
- **Prós**: ambiente IDÊNTICO ao do JOs (idioma, encoding, build). Captura visual real. Permite testes manuais quando squad noturna estiver no ambiente.
- **Contras**: VM Windows pesa 20-40GB; precisa licença válida; rodar GUI consome muita RAM/CPU; não é automatizável trivialmente (Selenium-Electron é frágil).
- **Esforço**: alto inicial (montar VM), baixo recorrente.
- **Cobertura de bugs**: 90% (encoding, UAC, manifest, RunOnce, SmartScreen, AV).

### Opção B — GitHub Actions com Windows runner
- **Como**: workflow `.github/workflows/smoke-windows.yml` em `runs-on: windows-latest` que: faz checkout, `npm run build:win`, executa `.exe portable` em background, exercita comandos do preflight (sem GUI — modo headless via flag), captura logs em `%LOCALAPPDATA%\imp-installer\logs`.
- **Prós**: GRATUITO pra repo público (2000 min/mês private), reproducível, roda a cada PR. Detecta build broken, asar incompleto, dependência faltando.
- **Contras**: runner Windows do GHA NÃO tem WSL2 habilitado por default (precisa enable feature + reboot — passos 01-04 do instalador não rodam). Não tem GUI visível (não testa UI rendering). Não tem AV corporativo. É Windows EN, não pt-BR (perde C16, C17).
- **Esforço**: médio (escrever workflow + adicionar flag headless no instalador).
- **Cobertura**: 60% (build/asar/spawn/encoding básico, mas NÃO UAC/UI/WSL real).

### Opção C — Smoke "headless" via PowerShell extraindo o portable
- **Como**: script `tests/smoke-portable.ps1` que: extrai `.exe` portable em pasta temp, lê o `app.asar`, lista handlers IPC esperados, lança o `.exe` com env `IMP_HEADLESS=1` (flag a adicionar), valida que ele faz preflight detect e sai limpo (exit code 0) em ≤20s.
- **Prós**: bem rápido (1-2 min), roda local na máquina Win do dev, não precisa VM full.
- **Contras**: precisa ter Win disponível (qualquer dev: o próprio JOs ou parente/amigo); ainda não testa GUI; flag headless é código novo a manter.
- **Esforço**: baixo-médio.
- **Cobertura**: 50% (estrutura e wiring backend).

### Opção D — JOs valida em branch interna antes de publicar release
- **Como**: protocolo formal — squad faz PR pra `master`, faz build local do `.exe`, envia binário pra JOs via Drive/Wetransfer, JOs testa, valida ou rejeita. Só DEPOIS publica release oficial.
- **Prós**: usa o melhor QA (JOs) sem custo computacional. Pega bugs reais.
- **Contras**: depende do tempo do JOs; loop lento (horas/dia); JOs deve estar acordado; não escala pra futuros usuários.
- **Esforço**: nulo técnico, alto humano.
- **Cobertura**: 100% mas só pro PC do JOs.

### Opção E — jsdom + Vitest validando contratos UI estáticos
- **Como**: testes que carregam o `renderer/index.html` em jsdom, simulam IPCs com mocks do preload, disparam eventos, verificam que listeners atualizam DOM corretamente. Tipo "Eduardo automatizado".
- **Prós**: ROD A em CI, rapidíssimo (segundos), pega bugs tipo v0.2.15 (botão fantasma por contrato divergente) ANTES do release.
- **Contras**: não pega bugs Windows-exclusivos (encoding, UAC, manifest). É só prevenção de regressões de contrato.
- **Esforço**: médio (montar setup jsdom + escrever ~30-50 testes).
- **Cobertura**: 40% mas COMPLEMENTAR — pega bugs que outras opções não pegam.

### Recomendação consolidada: **A + B + E + protocolo D**

| Camada | Quando roda | O que pega |
|---|---|---|
| **E (jsdom em CI)** | Cada PR — segundos | Contratos main↔wizard, IDs, handlers, listeners ausentes. Mata família v0.2.15. |
| **B (GHA Windows runner)** | Cada PR — 5-10 min | Build broken, asar incompleto, spawn/encoding básico, dependências. |
| **A (VM Windows pt-BR local)** | Antes de tag release — manual, 15-30 min | UAC real, encoding pt-BR, RunOnce, SmartScreen, render visual. |
| **D (JOs valida)** | Pré-publish, com `.exe` da branch | Confirmação humana final. JOs aprova → publica. |

**Critério de release**: PR só vira release público se passar E + B em CI, A manual, e D humano. **Nenhum release vai pra `master` sem isso.** Hoje publicamos direto após code review — esse é o gap.

---

## 5. CHECKLIST DE NÃO-REGRESSÃO

Cada item do contexto NOTURNA + comando/teste mental pra garantir que continua funcionando.

| # | Funcionalidade | Versão original | Como verificar não regrediu | Risco se regredir |
|---|---|---|---|---|
| 1 | Janela maximizada ao abrir | v0.2.11 | `grep -n "ready-to-show" main.js` → handler chama `.maximize()`; teste manual: abre .exe e janela ocupa tela toda | Alto — JOs vê janela pequena no canto, péssimo onboarding |
| 2 | Sidebar 17 passos visível em todas as telas | v0.2.11 | `grep -n "step-sidebar" renderer/index.html` aparece em welcome/preflight/progress/done; `grep -n "syncStepSidebar" renderer/wizard.js` chamado em cada `showScreen` | Médio — JOs perde contexto de progresso |
| 3 | Auto-elevação UAC com PORTABLE_EXECUTABLE_FILE | v0.2.6 | `grep -n "PORTABLE_EXECUTABLE_FILE" src/shell.js`; teste manual: roda .exe sem admin, clica Reabrir, UAC aparece | Crítico — bloqueia passo 01 inteiro |
| 4 | Preflight com feedback visual streaming | v0.2.2 | `grep -n "installer:onPreflight" main.js`; eventos emitidos a cada check; wizard atualiza UI em tempo real | Médio — JOs vê tela parada e acha travado |
| 5 | Painel avisos âmbar com countdown | v0.2.4 | `grep -n "startElevateCountdown\|elevate-countdown" renderer/wizard.js`; teste: timer roda visualmente | Baixo — feedback degradado mas funcional |
| 6 | Log decode UTF-16 | v0.2.9/v0.2.12 | `grep -n "0xFF\|0xFE\|UTF-16" src/`; teste com mock de output `\xff\xfeU\x00b\x00u\x00n\x00t\x00u\x00` deve virar `Ubuntu` | Crítico no PC do JOs — sem isso, preflight inteiro mostra `?????` |
| 7 | Modal de erro separado com sugestões | v0.2.3 | `grep -n "showErrorModal\|modal-error" renderer/wizard.js`; payload com `suggestions[]` renderiza lista | Médio — JOs recebe erro vazio sem o que fazer |
| 8 | Telas manual com botão+instruções+plano B | v0.2.13/v0.2.15 | `grep -n "showManualPrompt\|manual-action-btn" renderer/wizard.js`; payload top-level (não nested) | Crítico — Step 04 não avança |
| 9 | safeHandle universal nos ipcMain.handle | v0.2.1 | `grep -n "safeHandle" main.js` em todos os handlers, sem `ipcMain.handle` direto | Médio — erros não tratados crasham IPC |
| 10 | Asar bundle completo (build.files cobre tudo) | v0.3.0 lição | `npx asar list dist/win-unpacked/resources/app.asar \| grep -E "main.js\|renderer/wizard.js\|src/runner.js\|preload.js"` deve achar todos | Crítico — falta de arquivo = crash imediato no boot do .exe |

### Como rodar o checklist
- **Manual**: dev abre o checklist antes de qualquer PR e mentaliza cada item.
- **Automatizado** (recomendado): criar `scripts/check-nao-regressao.js` que faz os `grep`s + parses estruturais e cospe pass/fail em ≤5s. Roda no pre-commit hook E no CI.

---

## 6. TIMING DE TESTES NA SQUAD (FLUXO RECOMENDADO)

```
DEV faz mudança em branch
    │
    ├── pre-commit hook:
    │     • lint
    │     • smoke estático: scripts/check-nao-regressao.js (5s)
    │     • testes jsdom de contrato (10-30s)  ← Opção E
    │
    ├── push pra branch + abre PR
    │     • GitHub Actions:
    │         - Linux: testes Node unitários
    │         - Windows: build .exe + smoke headless (Opção B, 5-10 min)
    │         - jsdom UI tests (Opção E em CI, redundância)
    │
    ├── Eduardo (review humana de código)
    │
    ├── Patrícia (eu) marca pra rodar Opção A:
    │     • squad noturna spawn VM Windows pt-BR
    │     • baixa o .exe artifact do GHA
    │     • roda manualmente o passo 01 até travar OU completar
    │     • captura screenshots, anota anomalias
    │     • posta resultado no PR
    │
    ├── Se A passar → solicita JOs (Opção D)
    │     • squad gera `.exe` de release candidate
    │     • JOs testa no PC real
    │     • aprova ou pede ajuste
    │
    └── Aprovado → tag + release público
```

### Checkpoints obrigatórios (gates)
- **Gate 1 (PR aberto)**: smoke estático + jsdom verde.
- **Gate 2 (PR mergeable)**: build Win em GHA verde.
- **Gate 3 (pre-release)**: VM Windows manual verde + JOs OK.
- **Gate 4 (release)**: tag git + GitHub Release com asset assinado (futuro: code-sign).

### Solicitação a JOs (formal)
Quando squad pedir validação a JOs, sempre incluir:
1. Link pro `.exe` (PR artifact ou Drive).
2. Checklist específico de 3-5 itens (não "testa tudo"): "Por favor: (a) abre e me diz se a janela apareceu maximizada; (b) clica Começar e me manda print da tela seguinte; (c) se modal UAC aparecer, me diz que mensagem está nele."
3. Link pro log que se gera (`%LOCALAPPDATA%\imp-installer\logs\<ts>.log`).
4. Expectativa de tempo (15min, não 1h).

---

## 7. CONCLUSÃO E PRÓXIMOS PASSOS

### Resumo
- A squad opera num ambiente **fundamentalmente diferente** do JOs (Linux vs Win pt-BR `.exe` portable não-assinado). Bugs Win-exclusivos são inevitáveis até essa lacuna ser fechada.
- 23 cenários futuros mapeados cobrem WSL legado, virtualização, GPO, encoding, retomada, lockfile e UI Windows.
- Tabela de provas por step substitui "comando rodou ok" por "estado real validado".
- Recomendação primária: **A (VM) + B (GHA Win) + E (jsdom) + protocolo D (JOs valida pré-release)**.

### Próximos passos sugeridos (ordem de prioridade)
1. **Implementar tabela de provas (Parte 2) no `src/runner.js`** — Bruno deve fazer cada step terminar com `validateStep(stepId)` que executa o comando da tabela.
2. **Criar smoke jsdom (Opção E)** — Camila monta setup, Eduardo escreve os 30 testes baseados nos achados das reviews v0.2.15 (contratos main↔wizard).
3. **Configurar GHA Windows runner (Opção B)** — Bruno ou Eduardo escreve workflow.
4. **Provisionar VM Win10 LTSC pt-BR (Opção A)** — Bruno monta imagem, documenta procedimento.
5. **Formalizar protocolo D** — adicionar em `_squad/_shared/PROTOCOLO.md` a regra "nenhum release sem JOs OK".

### Fechamento honesto
JOs tem razão na cobrança. A squad estava operando como se o `.exe` fosse uma consequência automática do código verde — mas o `.exe` é um produto distinto, num ambiente distinto, com falhas distintas. Esse doc é a base pra fechar esse gap.

— Patrícia, QA da IMP Dev Squad
2026-05-27, 02:xx
