# build-runtime.ps1 — docs

Pipeline que gera `runtime/runtime.7z` (MSYS2 portable + tmux + git + node + claude CLI + seed repos) embarcado no `.exe` do IMP Squad Instalador como `extraResources`.

> **Quem roda:** JOs (1x por release), numa máquina Windows real.
> **Por quê:** `pacman` é Windows-only — não roda no GitHub Actions Linux nem em WSL "puro" sem ginástica. Build local é o caminho mais simples enquanto não migramos pra runner Windows.

---

## Pré-requisitos

| Item | Versão | Como instalar |
|---|---|---|
| Windows | 10 ou 11 x64 | — |
| PowerShell | 5.1+ (built-in) ou 7+ | já vem |
| 7-Zip | 19.0+ | https://www.7-zip.org/ — instalar em `C:\Program Files\7-Zip\` |
| tar | qualquer (já vem no Windows 10 1803+) | `tar --version` pra checar |
| Espaço livre | ~5 GB no drive do `$env:TEMP` | — |
| Internet | sim, ~150 MB de download | — |
| **(opcional)** `gh` CLI autenticado | 2.40+ | https://cli.github.com/ + `gh auth login` |

Se rodar sem `gh` autenticado, o script **pula o seed** (repos não vão embutidos) — primeiro launch da squad faz `git clone` online.

---

## Como rodar

Numa janela PowerShell na raiz de `imp-installer/`:

```powershell
# Modo padrão (com seed se gh autenticado)
.\scripts\build-runtime.ps1

# Sem seed (gera mais rápido, repos baixam online no 1º launch)
.\scripts\build-runtime.ps1 -SkipSeed

# Sem claude.exe (se você não quer embarcar binário Anthropic)
.\scripts\build-runtime.ps1 -SkipClaude

# Mudar destino
.\scripts\build-runtime.ps1 -Out D:\releases\runtime.7z

# Manter WorkDir pra debug
.\scripts\build-runtime.ps1 -KeepWorkDir
```

Duração esperada: **8–15 min** na 1ª vez (download MSYS2 + pacman -Syu + pacotes + 7z mx=9). Reexecuções limpam o `WorkDir` e refazem tudo (não há cache incremental — é simples e idempotente).

---

## O que cada step faz

| Step | Ação | Saída |
|---|---|---|
| **0** | Pre-checks (PS version, 7z presente, tar presente, espaço livre) | aborta se faltar tool |
| **1** | Limpa `WorkDir` (`$env:TEMP\imp-runtime-build`) | pasta vazia |
| **2** | Baixa `msys2-base-x86_64-20260322.tar.zst` (~52 MB) do release oficial msys2-installer | `.tar.zst` no WorkDir |
| **3** | `tar -xf` → cria `msys64/` (~317 MB, 487 binários POSIX) | pasta `msys64` pronta |
| **4** | `pacman -Syu` + `pacman -S tmux git mingw-w64-ucrt-x86_64-nodejs curl base-devel` + limpa cache | `msys64` cresce pra ~600 MB |
| **5** | Baixa `https://claude.ai/install.ps1` e instala `claude.exe` em `msys64\opt\claude-cli\` | binário Anthropic nativo Win |
| **6** | (opcional) `gh repo clone kennrick69/imp-squad,imp-orchestrator --depth=1` pra `msys64\opt\squad-seed\` | repos seed embutidos |
| **7** | Gera `msys64\opt\imp-scripts\imp-squad.bat` (wrapper PATH-isolado, conforme MARCOS-EMBARCAR §5) + `setup.sh` (1º uso) | scripts prontos |
| **8** | `7z a -t7z -mx=9 -ms=on -mqs=on` da pasta `msys64` → `runtime/runtime.7z` + `.sha256` | artefato final |

---

## Onde colocar o output

```
imp-installer/
├── runtime/
│   ├── .gitignore          ← ignora runtime.7z + .sha256
│   ├── .gitkeep            ← pasta versionada
│   ├── runtime.7z          ← gerado, NÃO commit
│   └── runtime.7z.sha256   ← gerado, NÃO commit
├── package.json            ← build.extraResources aponta pra runtime/runtime.7z
└── ...
```

O `package.json` (seção `build.extraResources`) inclui `runtime/runtime.7z` + `.sha256` no `.exe` final em `resources/runtime/`. O `bootstrap.ps1` (Bruno) descompacta no 1º run pra `%LOCALAPPDATA%\IMP-Squad-Runtime\<ver>\`.

---

## Wrapper `imp-squad.bat` (gerado pelo script)

PATH isolado, zero conflito com PATH global do user. Suporta 3 modos:

| Comando | O que faz |
|---|---|
| `imp-squad.bat` (sem arg) | attach na session `imp` ou cria nova |
| `imp-squad.bat resume` | idem, explícito |
| `imp-squad.bat shell` | abre bash interativo (pra debug) |
| `imp-squad.bat check` | roda self-check (bash, tmux, git, node, claude) |

---

## Troubleshooting

### `7-Zip não instalado`
Baixa em https://www.7-zip.org/ e instala em `C:\Program Files\7-Zip\`. O script aceita `7z.exe` no PATH ou nos paths padrão Win.

### `pacman: signature is unknown trust`
Acontece quando o keyring do MSYS2 base está desatualizado. O `pacman -Syuu` na 1ª corrida atualiza o keyring. Se persistir:
```powershell
& "$env:TEMP\imp-runtime-build\msys64\usr\bin\bash.exe" -lc "pacman-key --init && pacman-key --populate msys2"
```
E re-execute o script.

### `pacman: failed retrieving file from mirror`
Mirror instável. Re-executa — o script é idempotente (limpa WorkDir e refaz).

### `gh: not authenticated`
Roda `gh auth login` antes ou usa `-SkipSeed`. Sem auth, repos privados (`imp-squad`) não clonam.

### `install.ps1 não respeita CLAUDE_INSTALL_DIR`
O instalador Anthropic pode ignorar a env var e botar em `~\.local\bin\`. O script tem fallback: copia de lá pra `opt\claude-cli\`. Se mesmo assim falhar, usa `-SkipClaude` e configura o claude na 1ª execução da squad.

### `tar: Cannot connect`
Confere conectividade GitHub: `Invoke-WebRequest https://github.com -UseBasicParsing | Select-Object StatusCode`. Proxy corporativo pode bloquear release downloads.

### `.7z gerado > 400 MB`
Esperado (~250–300 MB ideal). Se passar 400 MB, conferir se `var/cache/pacman/pkg` não ficou populado:
```powershell
& "$env:TEMP\imp-runtime-build\msys64\usr\bin\bash.exe" -lc "du -sh /var/cache/pacman/pkg"
```
O step 4 já limpa, mas em caso de erro a meio o cache pode ter sobrado.

### `Defender quarentenou bash.exe ou tmux.exe`
Acontece raro em máquinas com EDR corporativo. Adiciona exclusão temporária:
```powershell
Add-MpPreference -ExclusionPath $env:TEMP\imp-runtime-build
```
Depois do build, remove a exclusão.

---

## Versão do runtime e compatibilidade

| Componente | Versão pinada | Atualizar quando |
|---|---|---|
| MSYS2 base | `20260322` | nova base release no msys2-installer |
| tmux | 3.6.a (via pacman) | rebuild |
| git | 2.54 (via pacman) | rebuild |
| nodejs ucrt64 | 24.16 (via pacman) | rebuild |
| claude.exe | latest (install.ps1) | toda rebuild |

A versão do `runtime.7z` está acoplada à versão do `.exe` (`package.json` `version`). O `bootstrap.ps1` (Bruno) compara `.runtime-version` antes de re-extrair.

---

## CI futuro (não-bloqueante)

Quando migrar pra GitHub Actions Windows runner:

```yaml
# .github/workflows/build-runtime.yml (TODO)
jobs:
  build-runtime:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4
      - run: choco install 7zip -y
      - run: pwsh ./scripts/build-runtime.ps1 -SkipSeed
      - uses: actions/upload-artifact@v4
        with:
          name: runtime
          path: runtime/runtime.7z
```

E o release job baixa o artifact, dispara `npm run dist:win`.

---

*Marcos — IMP Dev Squad / Fase 2*
