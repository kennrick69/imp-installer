# PATRÍCIA — Cenários NOVOS da FASE 1 (runtime embarcado, sem virtualização)

**Autora**: Patrícia, QA da IMP Dev Squad
**Data**: 2026-05-27
**Premissa**: FASE 1 abandona WSL2 e embarca MSYS2 portable (ou equivalente) dentro do `.exe`. Sumiram os riscos de virtualização — mas surgiram outros que NÃO existiam antes.
**Escopo**: complementa (não substitui) os 23 cenários do `noturna-2026-05-27/PATRICIA-CENARIOS-PROCESSO.md`. Mantenho compatibilidade conceitual: cada cenário tem **probabilidade**, **impacto**, **detecção**, **mitigação**, **mensagem humana**.

---

## SUMÁRIO EXECUTIVO

- **27 cenários novos** mapeados (pedido: 20+). 22 herdam diretamente do enunciado do JOs; 5 emergiram da análise (E1–E5).
- **Top 5 críticos pro Bruno tratar PRIMEIRO**: N1 (AppLocker), N2 (Antivírus quarentena), N6 (AV real-time scan na extração), N3+N8 (espaço em disco), N12 (symlinks sem privilégio).
- **Veredito sobre "menos arriscado que WSL"**: **CONFIRMO PARCIALMENTE.** O runtime embarcado é **muito menos arriscado em superfície de falha estrutural** (sem virtualização, sem BIOS, sem GPO de loja, sem reboot, sem RunOnce). Mas é **mais arriscado em superfície de defesa do endpoint** (AV, AppLocker, EDR, SmartScreen) porque o `.exe` agora extrai 50.000+ arquivos com binários POSIX que parecem "ferramentas hacker" pra qualquer EDR sério. Saldo líquido: **risco GLOBAL cai, mas concentra em vetores diferentes**. Detalho em §3.
- Validação SEM virtualização ainda exige Windows real — squad NÃO consegue testar AppLocker/AV em Linux. Ver §4.

---

## 1. CENÁRIOS NOVOS

Convenção: **probabilidade** alta/média/baixa; **impacto** bloqueia (não conclui)/atrapalha (degrada mas conclui)/cosmético.

### N1 — AppLocker corporativo bloqueia execução em LOCALAPPDATA
- **Probabilidade**: média (PCs corporativos com política "deny execute from user-writable"). Alta no público "TI consultor".
- **Impacto**: BLOQUEIA. AppLocker default-deny mata `tmux.exe`, `bash.exe`, `node.exe` antes de eles abrirem.
- **Detecção**:
  - Tentar `child_process.spawn('<runtime>/usr/bin/bash.exe', ['-c','echo ok'])` em smoke pós-extração; capturar exit code `0xC0000022` (STATUS_ACCESS_DENIED) OU stderr "This program is blocked by group policy".
  - Heurística prévia: ler `Get-AppLockerPolicy -Effective -Xml` e procurar regras `<FilePathRule Action="Deny" Path="%LOCALAPPDATA%\*">` ou regras Allow restritivas.
- **Mitigação**:
  - Fallback pasta: tentar `%PROGRAMDATA%\imp-squad\runtime` se LOCALAPPDATA estiver bloqueado (precisa write admin uma vez, mas execução libera).
  - Última opção: pedir TI pra adicionar exceção AppLocker (gerar XML de regra pronto: Publisher rule pelo hash do `.exe` extraído).
- **Mensagem**: "O computador tem regras corporativas (AppLocker) que bloqueiam programas em pastas pessoais. Tentei instalar em outra pasta. Se também der erro, mostro a regra que o TI precisa adicionar (gero o arquivo pronto pra você mandar)."

### N2 — Antivírus quarentena binários extraídos como "PUA/Hacktool"
- **Probabilidade**: ALTA. `tmux.exe`, `nc.exe` (netcat), `ssh.exe` portable, `sed.exe` — vários disparam heurística "potentially unwanted application" em Defender/Kaspersky/Trend.
- **Impacto**: BLOQUEIA. Binário some da pasta após extração (Defender remove silenciosamente).
- **Detecção**:
  - Pós-extração, verificar `Test-Path` de cada binário crítico (`bash.exe`, `tmux.exe`, `git.exe`, `node.exe`). Se sumiu, AV agiu.
  - Ler eventos do Defender: `Get-MpThreatDetection | Where-Object Resources -like "*\imp-squad\runtime\*"` mostra o que foi quarentenado.
- **Mitigação**:
  - Antes da extração, oferecer adicionar exclusão programática: `Add-MpPreference -ExclusionPath "$env:LOCALAPPDATA\imp-squad"` (precisa admin — UAC).
  - Se já quarentenou: `Get-MpThreatDetection` + `Restore-MpThreat -ThreatID <id>` (admin).
  - Documentar como assinar binários (longo prazo).
- **Mensagem**: "O antivírus removeu alguns arquivos achando que são suspeitos (tmux/bash são ferramentas de terminal antigas, mas inofensivas). Posso pedir permissão de administrador agora pra adicionar a pasta como exceção. Sem isso, a squad não roda."

### N3 — Disco cheio durante cópia/extração de ~1GB
- **Probabilidade**: média (SSD 128GB com Win+Office já ocupa 80GB; sobra pouco).
- **Impacto**: BLOQUEIA na primeira instalação; pode CORROMPER state se enche no meio.
- **Detecção**:
  - **Pré-extração** (obrigatório): `Get-PSDrive C | Select Free` — exigir >= 2GB livres (1GB runtime + folga). Idealmente 3GB pra cache de uso.
  - Durante extração: catch `ENOSPC` em writes; pause/abort limpo.
- **Mitigação**:
  - Bloqueio cedo com mensagem clara antes de começar a copiar.
  - Limpeza parcial de extração abortada (não deixar pasta meio-zumbi).
  - Sugerir Limpeza de Disco do Windows; oferecer pasta alternativa em outro drive (D:, E:) se houver.
- **Mensagem**: "Tem só X MB livres no C:. Pra instalar a squad preciso de 2GB no mínimo. Posso instalar no drive D:/E: (tem espaço lá), ou você libera espaço (Limpeza de Disco) e clica 'Tentar de novo'."

### N4 — Conflito PATH com Git for Windows / Node nativo já instalado
- **Probabilidade**: ALTA. Maioria de devs já tem Git for Windows; vários têm Node nativo.
- **Impacto**: ATRAPALHA. `bash` invocado dentro da squad pega o do Git for Windows (versão diferente), `node` pega versão errada, `npm` instala global em pasta errada. Pode até funcionar mas com comportamento errático.
- **Detecção**:
  - Pré-instalação: `where.exe bash`, `where.exe git`, `where.exe node`, `where.exe npm`. Se ≥1 retorna algo, registrar e avisar.
  - Pós-instalação: dentro do shell embarcado, `which bash` DEVE retornar `<runtime>/usr/bin/bash`, NÃO `/c/Program Files/Git/...`.
- **Mitigação**:
  - **NUNCA** mexer no PATH global do Windows. SEMPRE prepend ao PATH SOMENTE do processo filho que executa a squad (env vars na hora do `spawn`).
  - Wrapper `imp-launcher.cmd` que faz `set PATH=%~dp0runtime\usr\bin;%~dp0runtime\mingw64\bin;%PATH%` LOCAL e chama bash.
- **Mensagem**: (silenciosa — fix interno). Só avisar se DETECTAR que squad por engano pegou versão errada: "Notei que a squad pegou o Git/Node do sistema em vez do embarcado. Pode dar comportamento estranho. Reinicia a squad pra resolver."

### N5 — PATH do Windows explode além de 8.191 chars
- **Probabilidade**: baixa (já é problema raro, só vira preocupação se a gente mexer no PATH global — que N4 proíbe).
- **Impacto**: BLOQUEIA. Windows trunca PATH > 8191, programas somem aleatoriamente.
- **Detecção**:
  - Pré-modificação: ler `[Environment]::GetEnvironmentVariable("Path","Machine").Length` + `User`.Length, somar — se > 7800, abortar adicionar.
- **Mitigação**:
  - **REGRA**: nunca tocar PATH global Machine. Se MESMO assim precisar (caso de uso futuro: comando `imp` no terminal nativo), usar `%LOCALAPPDATA%\imp-squad\bin` com 1 único entry e symlink/cmd-shim pros binários.
- **Mensagem**: "Seu PATH do Windows já está perto do limite. Não vou adicionar nada lá — em vez disso, criei um atalho no Desktop que abre a squad direto."

### N6 — AV real-time scan trava extração de 50K+ arquivos do MSYS2
- **Probabilidade**: ALTA. Defender escaneia cada arquivo extraído; com 50K arquivos pequenos, extração que deveria levar 30s leva 5–15 min.
- **Impacto**: ATRAPALHA gravemente (UX terrível); pode parecer travado e usuário fechar.
- **Detecção**:
  - Cronometrar extração: se taxa < 100 arquivos/seg, AV provavelmente está escaneando. Logar tempo decorrido + arquivos extraídos.
- **Mitigação**:
  - PRIMEIRA escolha: distribuir runtime como `.7z` sólido ou `.tar.zst` UM ÚNICO arquivo — extrair em pasta temp E **mover** pra LOCALAPPDATA. Defender escaneia 1 vez na extração, não a cada arquivo.
  - Adicionar exclusão Defender ANTES de extrair (vide N2).
  - Mostrar barra com "Antivírus está verificando os arquivos. Isso é normal e pode levar alguns minutos…" pra não parecer travado.
- **Mensagem**: "Extraindo runtime (1GB, ~50 mil arquivos). Seu antivírus verifica cada um — isso é normal e pode levar de 1 a 10 minutos. Não fecha a janela. Progresso: X/50000."

### N7 — Permissões NTFS restritas em LOCALAPPDATA (perfil herdado/mandatory)
- **Probabilidade**: baixa-média (perfis roaming corporativos, contas "padrão" filhas).
- **Impacto**: BLOQUEIA escrita.
- **Detecção**:
  - Pré-extração: `try { fs.writeFileSync(<localappdata>/imp-squad/.write-test, 'x'); fs.unlinkSync(...) } catch (EACCES/EPERM)`.
- **Mitigação**:
  - Fallback pra `%APPDATA%` (Roaming) ou `%USERPROFILE%\imp-squad`.
  - Última opção: pedir admin pra criar pasta em `%PROGRAMDATA%` com ACL liberada.
- **Mensagem**: "Não consigo escrever na pasta padrão do seu usuário (permissão negada). Vou tentar outra pasta. Se também não der, vou pedir permissão de administrador uma vez pra criar o lugar certo."

### N8 — Pré-check de espaço pula partição (instalar em D: mas verificar C:)
- **Probabilidade**: média (devs com C: pequeno + D: grande).
- **Impacto**: BLOQUEIA tarde (após começar copy, descobre que não tem espaço).
- **Detecção**:
  - O check de free space PRECISA ser feito no drive **DA PASTA-DESTINO**, não fixo em C:. `path.parse(targetDir).root` + `Get-PSDrive <letra>`.
- **Mitigação**:
  - Conforme N3 + a regra: sempre verificar o drive da pasta efetiva.
- **Mensagem**: igual N3 mas com letra correta.

### N9 — MSYS2 sem `pacman -Syu` (sem rede / sem necessidade)
- **Probabilidade**: irrelevante para uso normal (squad não precisa atualizar pacotes). Vira problema se um dia squad fizer `pacman` no meio do fluxo.
- **Impacto**: BLOQUEIA o `pacman` (não BLOQUEIA squad).
- **Detecção**:
  - Se algum script de squad invoca `pacman`, capturar erro de rede.
- **Mitigação**:
  - **Política**: squad NÃO usa `pacman` em runtime. Tudo que precisa vem embarcado. Pacman é só pra dev empacotador (Bruno) atualizar a próxima release.
  - Se precisar baixar algo dinamicamente, usar `curl` com fallback explícito.
- **Mensagem**: (não deveria aparecer ao usuário; é regra interna).

### N10 — Encoding pt-BR e UTF-16 do PowerShell continuam relevantes
- **Probabilidade**: ALTA (igual ao C16/C17 da FASE 0 — não muda).
- **Impacto**: BLOQUEIA passos do INSTALADOR (não da squad, porque shell embarcado é UTF-8 estável).
- **Detecção**: detecção já consolidada no doc anterior (BOM 0xFF 0xFE, padrão `<char>\0`).
- **Mitigação**: reaproveitar todo o trabalho de v0.2.9/v0.2.12. Não regredir.
- **Mensagem**: silenciosa.

### N11 — Caminho com Unicode (`C:\Users\José\AppData\...`)
- **Probabilidade**: ALTA (JOs!). Maioria dos usuários BR tem acento no nome.
- **Impacto**: pode BLOQUEAR. Bash do MSYS2 historicamente lida bem com UTF-8 em paths POSIX (`/c/Users/Jos\xc3\xa9/...`), MAS:
  - `MSYS=enable_pcon` e configurações de locale precisam estar UTF-8.
  - Variáveis de ambiente passadas via `child_process.spawn` no Windows passam por encoding MBCS por default — caracteres podem virar `?`.
- **Detecção**:
  - Smoke pós-extração: em pasta de teste com acento, rodar `bash -lc 'pwd; ls'` e verificar saída sem `?`.
- **Mitigação**:
  - `spawn` com `windowsVerbatimArguments: true` + env var `LANG=en_US.UTF-8` (ou pt_BR.UTF-8) + `LC_ALL=C.UTF-8`.
  - MSYS2 portable já vem com locale `C.UTF-8` configurado por default; validar.
  - Testar OBRIGATORIAMENTE em conta `C:\Users\Téstê Çedilha\...`.
- **Mensagem**: silenciosa se funcionar; se falhar, "Seu nome de usuário tem acento. Estou ajustando a configuração de idioma. (testando...)".

### N12 — Symlinks do MSYS2 sem privilégio `SeCreateSymbolicLink` viram cópias
- **Probabilidade**: ALTA. Default Windows: só admin pode criar symlinks; Win10 1703+ permite usuário SE "Developer Mode" ON (raro).
- **Impacto**: ATRAPALHA. Pacotes do MSYS2 usam ~thousands de symlinks (libs versionadas: `libfoo.dll -> libfoo-1.dll`). Sem symlink, vira cópia: espaço duplica/triplica (1GB → 2-3GB) e UPGRADE futuro fica inconsistente.
- **Detecção**:
  - Pré-extração: tentar criar symlink em pasta temp: `New-Item -ItemType SymbolicLink -Path test.lnk -Target real.txt`. Se falhar com "privilege not held", privilégio faltando.
  - Pós-extração: `Get-ChildItem -Recurse | Where { $_.LinkType -eq 'SymbolicLink' } | Measure` — se esperávamos ~3000 e veio 0, todos viraram cópia.
- **Mitigação**:
  - **Estratégia primária**: empacotar runtime já com symlinks "achatados" (resolvidos como cópias) — pagar 2-3GB de espaço pra evitar problema. JOs disse "tamanho não importa" → essa é a saída pragmática.
  - **Alternativa**: pedir admin ANTES de extrair (UAC uma vez) E usar `SeCreateSymbolicLink` privilege.
  - **Alternativa avançada**: extrair como hardlinks (não precisa de privilégio em NTFS), só funciona dentro do mesmo volume.
- **Mensagem**: "Vou descompactar a squad. Pode demorar um pouco — pra não precisar pedir permissão de admin, ela vai ocupar 2-3GB em vez de 1GB. (Se preferir economizar espaço, posso pedir admin uma vez agora.)"

### N13 — Atalhos no Desktop dependem de `WScript.Shell` (COM)
- **Probabilidade**: baixa-média (alguns AV bloqueiam criação de COM; servidores hardened).
- **Impacto**: ATRAPALHA. Sem atalho, usuário não acha como abrir a squad.
- **Detecção**:
  - `try { $sh = New-Object -ComObject WScript.Shell; ... } catch { ... }` — se lançar, COM indisponível.
- **Mitigação**:
  - Plano B: criar `.cmd` ou `.url` no Desktop manualmente (`Set-Content desktop\IMP.cmd "..."`) — não é tão bonito mas funciona.
  - Plano C: instruir abrir via Iniciar/pasta-instalação.
- **Mensagem**: "Não consegui criar o atalho automático. Te mando o arquivo .cmd no Desktop manualmente; clica nele pra abrir a squad."

### N14 — `tmux` precisa de PTY/terminal; rodar headless em Windows
- **Probabilidade**: ALTA. Tmux espera ambiente PTY POSIX. No Windows, MSYS2 usa winpty/ConPTY. Se invocarmos `tmux new-session -d` via `child_process.spawn` direto, pode falhar com "open terminal failed: not a terminal".
- **Impacto**: BLOQUEIA. Squad inteira depende de tmux.
- **Detecção**:
  - Smoke pós-extração: `bash -lc 'tmux new-session -d -s test "sleep 1" && tmux ls && tmux kill-session -t test'`. Se erro, ajustar.
- **Mitigação**:
  - Usar `winpty` wrapper: `winpty -Xallow-non-tty -Xplain tmux ...` OU
  - Lançar tmux DENTRO de um shell já em PTY: `mintty -e bash -lc 'tmux new-session -s imp'`.
  - Em Win10 1809+, MSYS2 suporta ConPTY nativo (`MSYS=enable_pcon`); validar.
- **Mensagem**: silenciosa se funcionar; se quebrar, "Estou abrindo a sessão da squad numa janela própria de terminal (precisa pra funcionar)."

### N15 — Versão do Node embarcada incompatível com Claude CLI
- **Probabilidade**: média (Claude CLI exige Node >= 18 ou 20; mudanças futuras de requisito).
- **Impacto**: BLOQUEIA. `npm install -g @anthropic-ai/claude-code` falha ou CLI crasha.
- **Detecção**:
  - Pós-instalação: `node --version && claude --version`. Se claude falhar com `unsupported engine`, é isso.
- **Mitigação**:
  - Embarcar Node 20 LTS (atualmente estável e compatível). Versão fixa na release do `.exe`.
  - Manter changelog cruzado: "Release X.Y do instalador embarca Node 20.W.Z; testado com Claude CLI vN.M.K".
  - Mecanismo de upgrade do runtime numa release futura do instalador (não dinâmico).
- **Mensagem**: "A versão da squad embarcada está desatualizada pro Claude novo. Atualize o instalador (link aqui)."

### N16 — Múltiplas instâncias da squad (JOs roda launcher 2x)
- **Probabilidade**: ALTA. Duplo-clique acidental, atalho no Desktop + na taskbar.
- **Impacto**: ATRAPALHA. Duas sessões tmux `imp` colidem; arquivos de estado conflitam.
- **Detecção**:
  - Lockfile em `%LOCALAPPDATA%\imp-squad\.lock` com PID. Antes de abrir, checar PID vivo.
  - `tmux has-session -t imp` retorna 0 → já existe.
- **Mitigação**:
  - Se sessão tmux `imp` já existe E PID dono ainda vivo: anexar à existente (`tmux attach -t imp`) em vez de criar nova. Mensagem amigável.
  - Se PID dono morto mas tmux ainda vivo: assumir controle, atualizar lockfile.
- **Mensagem**: "A squad já está rodando. Vou trazer ela pra frente (em vez de abrir uma nova)."

### N17 — Reboot/sleep do PC enquanto squad estava rodando
- **Probabilidade**: ALTA. Notebook hiberna, Windows Update reinicia à noite.
- **Impacto**: ATRAPALHA. Sessão tmux some (processos do MSYS2 morrem com user session). Estado de trabalho da squad fica salvo em disco (Git, _shared, logs), mas tmux precisa renascer.
- **Detecção**:
  - Na abertura, `tmux has-session -t imp` → não tem. Mas state.json indica "última sessão estava ativa".
- **Mitigação**:
  - Auto-recriar sessão tmux `imp` na próxima abertura, com 7 painéis padrão e mostrar "Sessão recriada após reinício; trabalho em disco preservado".
  - NÃO tentar restaurar histórico de scrollback (não dá pra recuperar de tmux morto).
- **Mensagem**: "Vi que o PC reiniciou (ou hibernou) enquanto a squad estava aberta. Recriei a sessão. Seu trabalho em arquivos (`/c/Projetos`) está intacto. As conversas que estavam na tela infelizmente se perderam."

### N18 — JOs muda de perfil/usuário Windows; runtime fica em LOCALAPPDATA do user antigo
- **Probabilidade**: baixa (mas acontece com troca de domínio empresarial).
- **Impacto**: BLOQUEIA. Squad some pro usuário novo; runtime existe em pasta sem acesso.
- **Detecção**:
  - Ao abrir, verificar se `<runtime>/usr/bin/bash.exe` existe NO LOCALAPPDATA do usuário atual. Se não, runtime "sumiu".
- **Mitigação**:
  - Oferecer reinstalar (extração rápida, ~1min com AV exclusion).
  - Detectar pasta antiga em `C:\Users\*\AppData\Local\imp-squad`; oferecer migrar `state.json` e `_shared/` (cópia pro novo perfil).
- **Mensagem**: "Parece que você está em outro usuário do Windows. Reinstalo a squad pra esse usuário (1 minuto) e tento trazer suas configurações antigas."

### N19 — Backup/restauração de Windows mexe nos arquivos do runtime
- **Probabilidade**: baixa. (System Restore, OneDrive Folder Backup, Macrium Reflect).
- **Impacto**: ATRAPALHA ou BLOQUEIA. Runtime pode ficar com arquivos misturados de épocas diferentes (libs versionadas mismatched).
- **Detecção**:
  - Smoke na abertura: `bash -lc 'tmux -V && git --version && node --version'` — qualquer falha → runtime suspeito.
  - Comparar hashes de binários críticos com manifesto da release.
- **Mitigação**:
  - Manifesto SHA256 em `runtime/.manifest.json`. Comparar arquivos críticos na abertura; se 1+ falhar, oferecer reinstalar runtime.
- **Mensagem**: "Detectei que arquivos da squad estão diferentes do esperado (talvez um backup tenha misturado versões). Reinstalo o runtime pra arrumar?"

### N20 — Antivírus/Defender exclusion como otimização recomendada
- **Probabilidade**: alta benefício (não é "cenário de falha" mas evitar muita coisa).
- **Impacto**: previne N2 + N6.
- **Detecção**: N/A — é uma ação proativa.
- **Mitigação**:
  - No instalador, oferecer (com UAC): `Add-MpPreference -ExclusionPath <runtime>` + `-ExclusionProcess @('bash.exe','tmux.exe','node.exe','git.exe')`.
  - Documentar como remover depois.
- **Mensagem**: "Pra squad rodar rápido e sem o antivírus interferir, recomendo adicionar a pasta como exceção. Posso fazer isso agora (vai pedir permissão de admin uma vez). Você pode reverter quando quiser nas configurações do Defender."

### N21 — EDR corporativo (CrowdStrike, SentinelOne) monitora chamadas e bloqueia `tmux exec` ou `spawn`
- **Probabilidade**: média-alta em ambientes corporativos sérios.
- **Impacto**: BLOQUEIA específico. EDR pode permitir tmux abrir mas matar quando ele faz `fork+exec` rápido (típico shell). Ou bloquear `Get-MpThreatDetection` (irônico).
- **Detecção**:
  - Smoke `bash -lc 'for i in 1 2 3; do echo $i; done'` falhar com `Cannot allocate memory` ou crash silencioso → EDR provável.
  - Listar processos AV/EDR conhecidos: `Get-Process | Where Name -in 'CSAgent','SentinelAgent','CarbonBlack','MsMpEng'`.
- **Mitigação**:
  - Não há fix automático — esses EDRs são governados centralmente.
  - Gerar relatório técnico padrão (hashes dos binários, comportamento esperado, justificativa de negócio) pro JOs entregar ao TI.
- **Mensagem**: "Detectei o sistema de segurança corporativo (X). Ele pode estar bloqueando a squad. Gerei um relatório técnico no Desktop pra você enviar ao TI pedir liberação. Sem a liberação, a squad não vai rodar nesse PC."

### N22 — Symlinks internos do MSYS2 quebram após cópia entre filesystems
- **Probabilidade**: baixa-média. Se runtime for instalado e depois movido (drag-drop pra outro disco), symlinks (se foram criados — vide N12) quebram.
- **Impacto**: BLOQUEIA. `bash`, `git` podem não encontrar libs.
- **Detecção**:
  - Smoke `bash -lc 'true'`. Se sair com `error while loading shared libraries: libwinpthread-1.dll`, symlink quebrado.
- **Mitigação**:
  - Documentar: "Não mova a pasta de instalação manualmente. Use o desinstalador + reinstalador."
  - Detectar mudança de path (state.json guarda path da instalação; comparar com execPath).
- **Mensagem**: "Vi que a pasta da squad foi movida. Reinstalo no novo lugar (1 min)?"

### N23 — Firewall bloqueia node listening em porta local (claude OAuth callback)
- **Probabilidade**: média. Login Claude usa OAuth via http://localhost:PORTA — firewall corporativo pode bloquear.
- **Impacto**: BLOQUEIA o LOGIN do Claude (não a squad em si após logado).
- **Detecção**:
  - `claude login` retorna timeout no callback.
  - `Test-NetConnection -ComputerName localhost -Port <porta>` falha.
- **Mitigação**:
  - Claude CLI normalmente sobe em porta aleatória; aceitar primeira que abrir.
  - Se Defender Firewall bloquear, primeira execução do `node.exe` no localhost dispara prompt nativo do Windows "Permitir node.exe acessar a rede" — orientar usuário a clicar Permitir (apenas privado).
- **Mensagem**: "O Windows vai perguntar se permite o `node` acessar a rede local — clica em PERMITIR (apenas redes privadas). Isso é só pra você fazer login no Claude — sem isso, o login não termina."

### N24 — GPU drivers (não relevante, mantido por completude)
- **Probabilidade**: irrelevante.
- **Impacto**: nenhum. Squad não usa GPU.
- **Mitigação**: nenhuma.

### N25 — Acessibilidade: leitor de tela funciona com terminal `cmd /k` vivo?
- **Probabilidade**: baixa (público-alvo atual). Relevante se squad for distribuída em contexto educacional/inclusivo.
- **Impacto**: ATRAPALHA. NVDA/JAWS pode não anunciar saída do mintty/conhost ConPTY corretamente.
- **Detecção**: testar com NVDA portable.
- **Mitigação**:
  - Documentar; longo prazo, oferecer modo "saída pra arquivo" pra que leitor de tela consuma de arquivo plano (workaround clássico).
- **Mensagem**: documentação, não popup.

### N26 (novo, eu) — Defender SmartScreen + Mark-of-the-Web no `.exe` baixado
- **Probabilidade**: ALTA (igual ao C21 do doc anterior, mas vale repetir).
- **Impacto**: ATRAPALHA primeiro uso. Usuário precisa "Mais informações > Executar mesmo assim".
- **Detecção**:
  - Pre-extração, `Get-ItemProperty -Path .\imp-installer.exe -Stream Zone.Identifier` retorna stream presente → MOTW ativo.
- **Mitigação**:
  - Documentação clara no site/release; screenshots passo-a-passo.
  - Sugerir `Unblock-File imp-installer.exe` ANTES de duplo-clicar.
  - Longo prazo: code-signing.
- **Mensagem**: (no site) "Na primeira execução o Windows vai mostrar 'Windows protegeu seu computador'. Clica em 'Mais informações' → 'Executar mesmo assim'. (Isso só na primeira vez.)"

### N27 (novo, eu) — Pasta runtime corrompida por desligamento abrupto durante extração
- **Probabilidade**: média. Power cut, kill via task manager, Ctrl+C.
- **Impacto**: BLOQUEIA reabertura — runtime parcial.
- **Detecção**:
  - Marca atômica: ao extrair, criar `<runtime>/.extracting` no início; remover apenas após smoke `bash -lc 'true'` OK.
  - Próxima abertura: se `.extracting` existe, runtime é zumbi.
- **Mitigação**:
  - Auto-limpar pasta e re-extrair.
- **Mensagem**: "A instalação anterior não terminou (computador desligou no meio?). Refaço em 1 minuto."

### N28 (novo, eu) — Locale do MSYS2 vs locale do Windows divergem (datas em logs)
- **Probabilidade**: média (cosmético, mas confunde debugging).
- **Impacto**: COSMÉTICO. Datas em logs do bash saem em EN_US, do PowerShell em pt-BR. Atrapalha grep/análise.
- **Mitigação**: fixar `LC_TIME=C` em todos os scripts; documentar.
- **Mensagem**: silenciosa.

### E1 — Política "Controlled Folder Access" do Defender bloqueia escrita
- **Probabilidade**: baixa (Win10/11 default OFF, mas usuários paranoicos ligam).
- **Impacto**: BLOQUEIA escrita em Documents/Desktop/Pictures (pastas protegidas).
- **Detecção**: `Get-MpPreference | Select EnableControlledFolderAccess` = `Enabled` (1).
- **Mitigação**: NÃO escrever em pastas protegidas. Atalho Desktop vira o único ponto de fricção (clip da política).
- **Mensagem**: "Sua pasta Desktop está protegida pelo Defender. Vou pedir permissão pra criar só o atalho lá."

### E2 — `TMP` / `TEMP` aponta pra pasta inválida ou cheia
- **Probabilidade**: baixa-média. (Usuários espertos mudam TEMP pra outro drive e drive enche.)
- **Impacto**: BLOQUEIA extração intermediária (vide N6: extrai temp depois move).
- **Detecção**: `Get-Item env:TEMP` + Test-Path + free-space.
- **Mitigação**: fallback pra `<localappdata>\imp-squad\temp` (mesma partição que destino → move sem cópia).
- **Mensagem**: "Sua pasta temporária ($env:TEMP) tem só X MB. Vou usar uma pasta própria. (Se mesmo assim faltar espaço, libere o disco.)"

### E3 — Antivírus de terceiros NÃO-Defender (ESET/Avast/AVG/Kaspersky) com suas próprias regras
- **Probabilidade**: alta no público leigo (muitos têm Avast Free).
- **Impacto**: igual N2 + N6 mas SEM `Add-MpPreference` disponível.
- **Detecção**: `Get-CimInstance -Namespace root/SecurityCenter2 -ClassName AntivirusProduct` lista produtos.
- **Mitigação**: gerar instrução por marca: "Avast → Configurações → Exclusões → adicionar `<pasta>`" com screenshots.
- **Mensagem**: "Detectei o antivírus X (que não é o do Windows). Pra ele não bloquear a squad, segue um pequeno passo a passo: [link]."

### E4 — Hora/data do sistema errada quebra HTTPS (clone/login)
- **Probabilidade**: baixa-média (PC velho, bateria CMOS gasta; pós-reinstalação).
- **Impacto**: BLOQUEIA clone/login Claude (cert TLS rejeitado).
- **Detecção**: `Get-Date` retorna ano <2024 ou >2030 → quebrado. Testar `curl https://github.com` falha com `SSL certificate problem`.
- **Mitigação**: detectar e mandar acertar; usar `w32tm /resync` se possível (precisa admin).
- **Mensagem**: "A data do seu computador está em [DATA]. HTTPS não funciona com data errada. Acerta a data nas Configurações do Windows e clica 'Tentar de novo'. (Posso tentar sincronizar agora se for admin.)"

### E5 — `.exe` portable executado de drive de rede (UNC `\\server\share`)
- **Probabilidade**: baixa-média (devs corporativos).
- **Impacto**: BLOQUEIA. `LoadLibrary` de UNC + symlinks + AV = drama.
- **Detecção**: `process.execPath.startsWith('\\\\')` ou drive type via WMI = NetworkDrive.
- **Mitigação**: avisar "Copia o .exe pra um disco local antes de rodar". Recusar continuar de UNC.
- **Mensagem**: "Vi que rodou a squad de um drive de rede. Isso não funciona bem. Copia o arquivo `imp-installer.exe` pra sua pasta `Downloads` (no C:) e abre dele."

---

## 2. TOP 5 CRÍTICOS PRO BRUNO TRATAR PRIMEIRO

Critério: **bloqueia** + **alta probabilidade** + **frequência no público real (JOs + futuros usuários)** + **sem mitigação caseira fácil**.

### #1 — **N6: Antivírus real-time scan durante extração de 50K arquivos**
- **Por que primeiro**: TODO PC tem Defender; extração de MSYS2 sem otimização vai parecer travada por 5–15 min. Top cause de "fechei achando que era bug".
- **Ação Bruno**: empacotar runtime como UM ÚNICO `.7z`/`.tar.zst`; extrair em temp+mover. Adicionar barra de progresso real com taxa.

### #2 — **N2: Antivírus quarentena tmux.exe/binários como hacktool**
- **Por que segundo**: Defender + Kaspersky + Trend silenciosamente removem `tmux.exe`/`nc.exe`. Squad some sem aviso.
- **Ação Bruno**: oferecer `Add-MpPreference -ExclusionPath` ANTES de extrair (com UAC). Detectar pós-extração se algum binário sumiu e dar mensagem clara. Bonus: assinar com certificado quando viável.

### #3 — **N1: AppLocker corporativo bloqueia exec em LOCALAPPDATA**
- **Por que terceiro**: público corporativo nem consegue abrir. E é silencioso (`0xC0000022`).
- **Ação Bruno**: detectar AppLocker via `Get-AppLockerPolicy`, fallback pra `PROGRAMDATA` com permissão admin, e gerar XML de regra pronto pro TI corporativo aprovar.

### #4 — **N3 + N8: Espaço em disco insuficiente ou check no drive errado**
- **Por que quarto**: 1GB é muito pra SSD pequeno. Falhar TARDE na cópia é desastroso. Check no drive certo é trivial mas crítico.
- **Ação Bruno**: pre-check obrigatório `getFreeSpace(targetDrive) >= 2GB`; oferecer drive alternativo (D:/E:) se C: cheio; abortar limpo com pasta-zumbi removida.

### #5 — **N12: Symlinks viram cópias sem privilégio (com fallback claro)**
- **Por que quinto**: estrutural — define como a release é empacotada. Decisão arquitetural que afeta TODO usuário, não só edge case.
- **Ação Bruno**: decidir AGORA: empacotar runtime já "achatado" (cópias em vez de symlinks) por padrão — paga 2-3GB mas funciona sem admin nem dev mode. Documentar o trade-off.

**Honorável menção**: N14 (tmux precisa PTY) — pode esconder bugs sutis, mas é descobrível em smoke; não tão crítico se Bruno testar de verdade.

---

## 3. VEREDITO: AMBIENTE EMBARCADO É "MENOS ARRISCADO" QUE WSL?

**Resposta curta**: **CONFIRMO PARCIALMENTE**. Risco diminui em volume mas se concentra em vetores diferentes.

### Onde o risco CAI dramaticamente (sumiu)
| Eliminado | Estava em |
|---|---|
| Virtualização BIOS (SVM/VT-x) | C2 |
| Hyper-V conflict / hypervisorlaunchtype | C3 |
| Microsoft Store + GPO bloqueia AppX | C4 |
| Reboot + RunOnce + retomada | C5, C6 |
| WSL1 vs WSL2 vs distro conflito | C1, C8 |
| Download de Ubuntu 1GB com retomada | C7 |
| `wsl --update` quebrar kernel | C14 |
| AppX corrompido | C14 |
| `wsl.exe` PATH polution / PowerShell profile | C15 |
| Encoding UTF-16 do `wsl --status` (especificamente) | C16 (parcial — encoding em geral persiste) |

**Total**: dos 23 cenários antigos, ~10 simplesmente desaparecem. Os 13 restantes (UAC, encoding, AV, lockfile, Unicode path, manifest, SmartScreen, etc.) continuam relevantes pois são do Windows, não do WSL.

### Onde o risco SOBE (vetores novos)
| Aumentado | Por quê |
|---|---|
| AV / EDR (real-time + heurística + quarentena) | N2, N6, N21, E3 — 50K arquivos + binários POSIX-style + tmux/nc/ssh = honeypot perfeito pra heurística "hacktool" |
| AppLocker / Smart App Control | N1, C22 — agora o `.exe` carrega + extrai centenas de executáveis; cada um é alvo de policy |
| Espaço em disco | N3, N8 — antes o WSL2 reusava image única, 1GB do .exe é tudo novo |
| Symlinks e privilégios NTFS | N12, N22 — problema 100% novo, não existia no WSL2 (ext4 dentro do VHDX) |
| Manutenção/upgrade do runtime | N15, N17, N19 — antes `apt update` resolvia; agora precisa nova release do .exe |
| Performance de IO em NTFS vs ext4 | (não listado mas relevante) — git operations em 50K arquivos no NTFS é 5-10x mais lento que em ext4 do WSL2 |

### Saldo líquido honesto
- **Robustez do CAMINHO FELIZ**: SOBE muito. Sem virtualização, sem download externo, sem reboot. Provavelmente +50% de instalações que antes não chegavam a completar agora vão completar.
- **Robustez em ambiente HOSTIL**: CAI um pouco. EDR/AppLocker corporativos eram dores manageables com WSL2 (admin habilita feature uma vez); agora cada execução do `.exe` é território de cada novo `tmux.exe` ser bloqueado/quarentenado.
- **Manutenibilidade**: TROCA. WSL2 era "Microsoft mantém"; agora "nós mantemos" — releases novas pra trocar Node, atualizar git, etc. Mais controle, mais responsabilidade.

**Conclusão**: aposta CORRETA pro JOs (público-alvo dele, PC pessoal, BR). DUVIDOSA pra mercado corporativo amplo (EDR/AppLocker matam). Recomendar manter ambos os caminhos no roadmap: instalador embarcado (FASE 1) **principal**, com WSL2 como "modo avançado" pra quem quer (FASE 0 não jogada fora, vira opcional).

---

## 4. VALIDAÇÃO DE PROCESSO — COMO A SQUAD TESTA SEM VIRTUALIZAÇÃO

**Bom**: runtime embarcado é mais **estaticamente testável**: hashes, manifest, smoke `bash -lc 'tmux -V'` etc. Não tem download flaky, não tem dependência externa que muda.

**Ruim**: continua precisando Windows real pra:
- AV/EDR/AppLocker (N1, N2, N6, N21) — Linux não simula.
- SmartScreen/MOTW (N26) — só dispara em download HTTP real.
- ConPTY/tmux PTY (N14) — só Windows tem ConPTY.
- Unicode path em FS NTFS (N11) — Linux usa UTF-8 nativo, perde a categoria de bug.

### Recomendação ajustada (vs doc anterior)
Mantenho A + B + E + D do doc anterior, com ajustes:
- **Opção B (GHA Windows runner)** agora **mais útil**: sem WSL feature enable, o runner Win-latest consegue rodar o `.exe` + extrair runtime + smoke binários. Cobertura sobe de 60% pra ~75%.
- **Opção A (VM Windows)** continua essencial pra AV/AppLocker (não simulável em GHA).
- **NOVO smoke obrigatório**: `tests/smoke-runtime.ps1` que após build extrai o `.exe`, roda `bash -lc 'tmux -V && git --version && node --version && claude --version'` e exige todos saírem 0. Rodável em GHA E em VM. 30 segundos.

---

## 5. CHECKLIST DE NÃO-REGRESSÃO (delta FASE 1)

Aproveitando todos os 10 itens do doc anterior + adicionar:

| # | Nova funcionalidade FASE 1 | Como verificar |
|---|---|---|
| 11 | Runtime extraído íntegro | `<runtime>/.manifest.json` SHA256 bate com manifesto release |
| 12 | Smoke runtime passa | `bash -lc 'tmux -V && git --version && node --version && claude --version'` exit 0 |
| 13 | Single instance lock | abrir 2x = segunda traz primeira pra frente, não cria nova |
| 14 | AV exclusion proativa | opção visível no installer; comando documentado |
| 15 | Detecção espaço pré-extração | aborta limpo se < 2GB no drive destino |
| 16 | Sessão tmux recriável pós-reboot | matar tmux, reabrir launcher, sessão `imp` volta com 7 painéis |
| 17 | Path Unicode | testar em conta `Téstê Çedilha`, smoke runtime ok |
| 18 | Detecção runtime corrompido (`.extracting` zumbi) | criar `.extracting` manualmente, reabrir, instalador re-extrai |

---

## 6. CONCLUSÃO

Mapeei **27 cenários novos** (22 do enunciado + 5 emergentes). Os 5 críticos pro Bruno: **N6, N2, N1, N3/N8, N12**. Confirmo que o ambiente embarcado é **menos arriscado no caminho-feliz** mas **mais sensível a defesas de endpoint**. Squad ainda precisa Windows real pra validar (não escapa) — mas testes ficam mais simples e determinísticos, o que reduz o ciclo squad↔JOs significativamente. A FASE 1 vale a pena.

— Patrícia, QA da IMP Dev Squad
2026-05-27
