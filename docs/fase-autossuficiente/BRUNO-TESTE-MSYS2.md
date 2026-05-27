# BRUNO — Teste empírico MSYS2 portable + claude CLI + tmux

Data: 2026-05-27
Autor: Bruno (IMP Dev Squad)
Fase: 1 — decisão técnica do ambiente Linux-like sem virtualização

---

## 1. VEREDITO

**MSYS2 portable é VIÁVEL como container POSIX embarcado, MAS o desenho da squad muda: o claude CLI deve rodar como BINÁRIO NATIVO Windows (via `install.ps1`), e o MSYS2 entra SÓ para fornecer `bash` + `tmux` + `git` que o claude consome como ferramentas externas.** Tentar rodar o claude CLI dentro do shell MSYS2/mingw quebra (bug #9883 fechado como won't-fix + #4736 PATH + #3448 filesystem provider).

---

## 2. EVIDÊNCIA EMPÍRICA

### 2.1 Download e extração reais (executados nesta sessão)

| Item | Valor real medido |
|---|---|
| URL tar.zst base | `https://github.com/msys2/msys2-installer/releases/download/2026-03-22/msys2-base-x86_64-20260322.tar.zst` |
| `Content-Length` tar.zst | **54.342.013 bytes = 51,8 MB** |
| URL .exe installer | `https://github.com/msys2/msys2-installer/releases/download/2026-03-22/msys2-x86_64-20260322.exe` |
| `Content-Length` .exe | **94.002.009 bytes = 89,6 MB** |
| tar descompactado | 288 MB |
| msys64/ extraído (base, antes de pacman -Syu) | **317 MB** |
| Pasta `usr/bin/` | 487 binários POSIX (bash, sed, grep, awk, curl, wget, pacman…) |
| **NÃO inclui no base** | tmux, git, nodejs (precisa `pacman -S`) |

Comandos executados localmente:
```
curl -sL -o msys2-base.tar.zst <url>          # 52MB OK
zstd -d msys2-base.tar.zst                    # 288MB
tar -xf msys2-base.tar -C extracted           # 317MB pasta msys64/
ls extracted/msys64/usr/bin/ | wc -l          # 487
```

### 2.2 Pacotes que precisam ser instalados via pacman

Dados consultados em `packages.msys2.org`:

| Pacote | Versão | Download | Instalado |
|---|---|---|---|
| `tmux` (msys) | 3.6.a-1 | 0,42 MB | 1,00 MB |
| `git` (msys) | 2.54.0-1 | 7,02 MB | **40,10 MB** |
| `mingw-w64-ucrt-x86_64-nodejs` | 24.16.0-1 | 20,95 MB | **106,85 MB** |
| Deps (icu, openssl, libwinpthread, python, zlib, c-ares, winpty) | — | ~50 MB | ~150 MB |

**Estimativa total instalado (msys64 com tudo): ~600-650 MB**

### 2.3 Compatibilidade claude CLI

Documentação oficial (`code.claude.com/docs/en/setup`, lida nesta sessão) confirma desde 2025:

- **Instalador nativo Windows**: `irm https://claude.ai/install.ps1 | iex` — **não requer Node, não requer WSL**, instala binário em `~/.local/bin/claude.exe`, auto-update background.
- Quando Git for Windows está instalado, o claude usa Git Bash p/ Bash tool; sem Git, usa PowerShell tool.
- `CLAUDE_CODE_GIT_BASH_PATH` aponta pra `bash.exe` custom — **podemos apontar pro `msys64/usr/bin/bash.exe` embarcado**.

### 2.4 Bugs conhecidos rodando claude CLI DENTRO do MSYS2

- **#9883** (closed not-planned): Bash tool quebra com `cygpath: command not found` em MSYS/Git Bash. Sem workaround.
- **#4736** (closed dup): claude em mingw64 shell não acha binários no `$PATH`.
- **#3448** (closed dup): Edit/Write tools falham por URL-encoding `c%3A%5C…` no filesystem provider.
- **#34150** (closed not-planned): pedido de psmux como tmux nativo Windows — Anthropic não vai implementar. Agent teams (tmux backend) **não funcionam reliably no Windows hoje**.

**Conclusão**: rodar `claude` dentro do shell MSYS2 está oficialmente quebrado. Tem que ser claude.exe NATIVO Windows, invocando ferramentas do MSYS2 como subprocessos.

### 2.5 tmux + agent teams no Windows

Confirmado em docs.bswen.com/blog/2026-05-11-claude-code-agent-teams-windows e issue #34150:
- tmux do MSYS2 (msys2-3.6.a) **funciona com mintty** (terminal default MSYS2).
- Windows Terminal: rolante — alguns relatam OK, outros travas (ConPTY edge cases).
- Workaround atual da comunidade: copiar binários `tmux_for_windows` pra `C:\Program Files\Git\usr\bin`.
- `process.stdout.isTTY` retorna `undefined` em Bun SFE no Windows → claude força in-process mode mesmo com `teammateMode: "tmux"` (issue #26244).

---

## 3. TAMANHO ESTIMADO TOTAL EMBARCADO

| Componente | MB |
|---|---|
| MSYS2 base (msys64 limpo extraído) | 317 |
| + tmux + deps libevent/ncurses | ~5 |
| + git + deps (perl, openssl, curl) | ~80 |
| + nodejs ucrt64 + deps (icu, openssl…) | ~250 |
| + cache pacman + var/lib/pacman/sync | ~30 |
| claude.exe nativo (instalador separado, ~/.local/bin) | ~80 |
| ripgrep (já vem com claude) | (incluso) |
| **TOTAL no `resources/msys2/` do instalador** | **~680 MB** |
| **TOTAL no disco do usuário após instalar** | **~760 MB** |

Cabe folgado no "1GB+ OK" do contexto. Comprimido em .7z ou asar deve dar 250-300 MB de download.

---

## 4. RESTRIÇÕES TÉCNICAS

### 4.1 Licença — OK pra embutir
- Installer MSYS2: BSD-style, redistribuição binária permitida (com aviso de copyright).
- Pacotes individuais: cada um com sua licença (GPL2 git, BSD tmux, MIT node…) — todas permitem redistribuição binária; só precisa preservar avisos. **Sem royalty, sem cláusula comercial.**

### 4.2 Portabilidade da pasta msys64 — RISCO REAL
- Discussion #3504 e issue #2579 (msys2/MSYS2-packages): copiar `msys64/` entre máquinas FUNCIONA pra rodar shell, mas `pacman -Syu` posterior pode quebrar por paths absolutos cacheados. Para nosso caso (instala uma vez, NÃO atualiza via pacman), **OK**.
- `etc/nsswitch.conf` define `db_home: windows` — pega `%USERPROFILE%` automaticamente, sem hardcode de home.
- **Recomendação**: rodar `setup.sh` no PRIMEIRO boot do usuário pra rodar `mkpasswd`/`mkgroup` e gerar `~/.bashrc`. Não é fresh install, é "primeiro uso".

### 4.3 Paths
- claude.exe NATIVO Windows não precisa de cygpath — ele entende `C:\Users\…` direto.
- Quando claude invoca bash do MSYS2 como subprocess via `CLAUDE_CODE_GIT_BASH_PATH`, ele já passa argumentos no formato que o bash entende.
- **NÃO podemos** apontar `CLAUDE_CODE_GIT_BASH_PATH` para `mingw64/bin/bash.exe` se o usuário ainda quiser nodejs do mingw64 — temos que usar `msys2/usr/bin/bash.exe` (MSYS shell) e adicionar `ucrt64/bin` ao PATH dele.

### 4.4 Symlinks
- MSYS2 funciona sem `SeCreateSymbolicLinkPrivilege` (usa cópias ou junções) por padrão. Pacotes node e git instalam OK sem privilégio.
- Exportar variável `MSYS=winsymlinks:nativestrict` SÓ se quisermos symlinks reais — não precisamos.

### 4.5 Antivírus
- Defender ocasionalmente flagga `pacman.exe` e `gpg.exe` por heurística. Pacotes assinados não evitam isso 100%.
- **Mitigação**: pedir whitelist da pasta `C:\Program Files\IMP\msys2\` no UAC do instalador, ou empacotar com Authenticode assinado da Anthropic-style (futuro).

### 4.6 Pacman cache na máquina alvo — NÃO precisa rodar
- Podemos rodar `pacman -Syu` + `pacman -S tmux git mingw-w64-ucrt-x86_64-nodejs` na NOSSA máquina de build, depois zipar `msys64/` completo e embarcar **já com tudo instalado**.
- Usuário final NUNCA roda pacman. Zero rede no install.
- Limpar `var/cache/pacman/pkg/*.zst` depois de instalar (libera ~30MB).

---

## 5. ALTERNATIVAS se MSYS2 der problema

| Opção | Veredito |
|---|---|
| **Cygwin portable** (vegardit/cygwin-portable-installer) | Funciona, ~150-250MB, mas atrai o bug do cygpath se claude tentar dialogar com ele. Mais antigo, pacote `setup-x86_64.exe` em vez de pacman. **Pior que MSYS2.** |
| **Git for Windows portable + tmux_for_windows** | PortableGit-2.54.0 = 62MB; tmux_for_windows binaries ~3MB. **MUITO menor (~70MB)**, mas é exatamente o ambiente que tem os bugs #9883/#3448. Funciona pra `bash`/`git`, NÃO funciona pra agent teams reliably. Bom plano B se quisermos só bash sem tmux real. |
| **Busybox-w32** | Não tem tmux. Descartado. |
| **Container sem WSL2** | Docker Desktop precisa WSL2/Hyper-V. Volta ao muro original. Descartado. |

**Recomendação**: ficar com MSYS2. Single fonte canônica, pacman pra build reproduzível, comunidade ativa, tmux mais novo (3.6.a vs 3.4 do tmux_for_windows).

---

## 6. PLANO DE EMBARCAR (subsídio pro Marcos)

```
imp-installer.exe (NSIS/Electron)
├── resources/
│   ├── msys2/                      # ~650MB no disco; ~250MB comprimido .7z
│   │   ├── usr/bin/bash.exe         # bash core
│   │   ├── usr/bin/tmux.exe         # tmux 3.6
│   │   ├── usr/bin/git.exe          # via msys git
│   │   ├── ucrt64/bin/node.exe      # node 24
│   │   ├── ucrt64/bin/npm.cmd
│   │   ├── etc/                     # pacman.conf, nsswitch
│   │   └── var/lib/pacman/local/    # DB instalado (sem cache)
│   └── claude-installer.ps1         # baixa claude.exe nativo (~80MB) no postinstall
│
└── postinstall.ps1:
     1. extract resources/msys2/ → C:\Program Files\IMP\msys2\
     2. registrar PATH (machine ou user): %ProgramFiles%\IMP\msys2\usr\bin;...\ucrt64\bin
     3. setx CLAUDE_CODE_GIT_BASH_PATH "%ProgramFiles%\IMP\msys2\usr\bin\bash.exe"
     4. iex (irm https://claude.ai/install.ps1)
     5. first-launch.bat: msys2_shell.cmd -here -no-start gera home + bashrc
     6. smoke test: claude --version && bash -c "tmux -V && git --version && node -v"
```

**Restrição crítica observada**: NÃO rodar `claude` dentro do bash MSYS2. O fluxo é: usuário abre Windows Terminal com perfil "IMP Squad" que chama `claude.exe` nativo, e o claude internamente spawna bash/tmux via `CLAUDE_CODE_GIT_BASH_PATH`. Assim contornamos #9883/#4736.

---

## 7. PRÓXIMOS PASSOS PRA QA (Patrícia) testar

1. AppLocker bloqueando pacman.exe / bash.exe sem assinatura
2. Defender escaneando 487 binários em msys64/usr/bin (lentidão no primeiro boot)
3. OneDrive sincronizando `~/.local/share/claude` (corromper config)
4. PATH overflow (Windows tem limite 8191 chars em PATH user)
5. Conflito com Git for Windows pré-existente do usuário (PATH duplicado)
6. Conflito com Node nativo pré-existente (qual `node.exe` ganha no PATH?)
7. Conta MS sem permissão de escrita em Program Files (fallback %LOCALAPPDATA%)

---

## Fontes

- [MSYS2 site oficial](https://www.msys2.org/)
- [MSYS2 installer releases](https://github.com/msys2/msys2-installer/releases)
- [MSYS2 license](https://www.msys2.org/license/)
- [MSYS2 terminals doc](https://www.msys2.org/docs/terminals/)
- [Package tmux](https://packages.msys2.org/package/tmux)
- [Package git](https://packages.msys2.org/packages/git)
- [Package nodejs ucrt64](https://packages.msys2.org/packages/mingw-w64-ucrt-x86_64-nodejs)
- [Claude Code Advanced setup](https://code.claude.com/docs/en/setup)
- [Bug #9883 cygpath](https://github.com/anthropics/claude-code/issues/9883)
- [Bug #4736 PATH MinGW64](https://github.com/anthropics/claude-code/issues/4736)
- [Bug #3448 filesystem provider MINGW64](https://github.com/anthropics/claude-code/issues/3448)
- [Issue #34150 psmux not planned](https://github.com/anthropics/claude-code/issues/34150)
- [Discussion #3504 moving msys64](https://github.com/msys2/MSYS2-packages/discussions/3504)
- [Issue #2579 portable msys2](https://github.com/msys2/MSYS2-packages/issues/2579)
- [BSWEN agent teams Windows tmux guide](https://docs.bswen.com/blog/2026-05-11-claude-code-agent-teams-windows/)
