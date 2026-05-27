# build-runtime.ps1
# Gera runtime.7z pra embarcar no IMP Squad Instalador como extraResources.
# Autor: Marcos (IMP Dev Squad) — Fase 2 / Pipeline de Build
# Rodar 1x numa maquina Windows com PowerShell 5+, 7-Zip instalado, ~5GB livres.
#
# Uso:
#   .\scripts\build-runtime.ps1
#   .\scripts\build-runtime.ps1 -Out .\runtime\runtime.7z -WorkDir D:\temp\imp-build
#   .\scripts\build-runtime.ps1 -SkipSeed         # nao tenta clonar repos squad
#   .\scripts\build-runtime.ps1 -SkipClaude       # nao baixa claude.exe
#
# Saida: runtime\runtime.7z + runtime\runtime.7z.sha256

[CmdletBinding()]
param(
  [string]$Out      = ".\runtime\runtime.7z",
  [string]$WorkDir  = "$env:TEMP\imp-runtime-build",
  [switch]$SkipSeed,
  [switch]$SkipClaude,
  [switch]$KeepWorkDir
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# ----- URLs / versoes pinadas (atualizar quando MSYS2 lancar nova base) -----
$MSYS2_DATE     = '20260322'
$MSYS2_BASE_URL = "https://github.com/msys2/msys2-installer/releases/download/2026-03-22/msys2-base-x86_64-$MSYS2_DATE.tar.zst"
$CLAUDE_PS1_URL = 'https://claude.ai/install.ps1'
$SEEDS = @('kennrick69/imp-squad','kennrick69/imp-orchestrator')

# ----- Helpers -----
function Step($n,$total,$msg) {
  Write-Host "`n[$n/$total] $msg" -ForegroundColor Yellow
}
function Info($msg) { Write-Host "  $msg" -ForegroundColor Gray }
function Ok($msg)   { Write-Host "  OK $msg"  -ForegroundColor Green }
function Warn($msg) { Write-Host "  ! $msg" -ForegroundColor DarkYellow }
function Fail($msg) { Write-Host "  X $msg"  -ForegroundColor Red; throw $msg }

function Assert-Tool($name) {
  $cmd = Get-Command $name -ErrorAction SilentlyContinue
  if (-not $cmd) { Fail "Ferramenta obrigatoria nao encontrada: $name" }
  return $cmd.Source
}

function Write-Utf8NoBom($path,$content) {
  $enc = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($path,$content,$enc)
}

# ----- Banner -----
Write-Host "================================================" -ForegroundColor Cyan
Write-Host "  IMP Runtime Builder (Marcos / Fase 2)" -ForegroundColor Cyan
Write-Host "================================================" -ForegroundColor Cyan
Write-Host "Saida   : $Out"
Write-Host "WorkDir : $WorkDir"
Write-Host "SkipSeed: $SkipSeed | SkipClaude: $SkipClaude"
Write-Host ""

# ----- Pre-checks -----
Step 0 8 "Pre-checks (PowerShell, 7-Zip, tar, espaco em disco)..."
if ($PSVersionTable.PSVersion.Major -lt 5) { Fail "Requer PowerShell 5+." }
$sevenZipPath = $null
$cmd = Get-Command 7z.exe -ErrorAction SilentlyContinue
if ($cmd) { $sevenZipPath = $cmd.Source }
elseif (Test-Path 'C:\Program Files\7-Zip\7z.exe')      { $sevenZipPath = 'C:\Program Files\7-Zip\7z.exe' }
elseif (Test-Path 'C:\Program Files (x86)\7-Zip\7z.exe'){ $sevenZipPath = 'C:\Program Files (x86)\7-Zip\7z.exe' }
if (-not $sevenZipPath) { Fail "7-Zip nao instalado. Baixe em https://www.7-zip.org/ e re-execute." }
Ok "7-Zip: $sevenZipPath"
$tarPath = Assert-Tool 'tar'
Ok "tar: $tarPath"
$drive = (Split-Path -Qualifier $WorkDir).TrimEnd(':')
$freeGB = [math]::Round((Get-PSDrive -Name $drive).Free / 1GB, 1)
Info "Espaco livre em ${drive}: $freeGB GB"
if ($freeGB -lt 5) { Warn "Menos de 5GB livres — build pode falhar." }

# ----- 1. Limpa workdir -----
Step 1 8 "Preparando WorkDir..."
if (Test-Path $WorkDir) {
  Info "Removendo WorkDir anterior..."
  Remove-Item $WorkDir -Recurse -Force
}
New-Item -ItemType Directory -Path $WorkDir | Out-Null
Ok "WorkDir limpo: $WorkDir"

# ----- 2. Baixa MSYS2 base -----
Step 2 8 "Baixando MSYS2 base ($MSYS2_DATE)..."
$msys2Tar = Join-Path $WorkDir 'msys2-base.tar.zst'
Info "URL: $MSYS2_BASE_URL"
$progPref = $ProgressPreference
$ProgressPreference = 'SilentlyContinue'
try {
  Invoke-WebRequest -Uri $MSYS2_BASE_URL -OutFile $msys2Tar -UseBasicParsing
} finally {
  $ProgressPreference = $progPref
}
$sizeMB = [math]::Round((Get-Item $msys2Tar).Length / 1MB, 1)
Ok "Baixado: $sizeMB MB"

# ----- 3. Extrai MSYS2 base -----
Step 3 8 "Extraindo MSYS2 base (tar -xf)..."
& $tarPath -xf $msys2Tar -C $WorkDir
if ($LASTEXITCODE -ne 0) { Fail "Falha ao extrair MSYS2 base (tar exit $LASTEXITCODE)." }
$msys64 = Join-Path $WorkDir 'msys64'
if (-not (Test-Path $msys64)) { Fail "Esperado $msys64 apos extracao, nao encontrado." }
$binCount = (Get-ChildItem (Join-Path $msys64 'usr\bin') -ErrorAction SilentlyContinue).Count
Ok "msys64 extraido ($binCount binarios em usr/bin)"

# ----- 4. pacman -Syu + pacotes squad -----
Step 4 8 "Instalando tmux + git + nodejs + base-devel via pacman..."
$msys2Bash = Join-Path $msys64 'usr\bin\bash.exe'
if (-not (Test-Path $msys2Bash)) { Fail "bash.exe nao encontrado em $msys2Bash" }
Info "1a corrida (pacman -Syu fecha shell automatico — esperado)..."
& $msys2Bash -lc "pacman --noconfirm -Syuu" 2>&1 | Out-Host
# 2a corrida — agora instala pacotes (a 1a pode fechar por update do core)
Info "2a corrida (pacotes squad)..."
$pkgList = 'tmux git mingw-w64-ucrt-x86_64-nodejs curl base-devel'
& $msys2Bash -lc "pacman --noconfirm -Syuu && pacman --noconfirm -S --needed $pkgList"
if ($LASTEXITCODE -ne 0) { Fail "pacman falhou (exit $LASTEXITCODE)." }
# Limpa cache pacman pra reduzir tamanho do .7z
Info "Limpando cache pacman (var/cache/pacman/pkg)..."
& $msys2Bash -lc "pacman --noconfirm -Scc || true"
Ok "Pacotes instalados + cache limpo"

# ----- 5. Claude CLI nativo Windows -----
$claudeDir = Join-Path $msys64 'opt\claude-cli'
if ($SkipClaude) {
  Step 5 8 "Pulando download claude.exe (--SkipClaude)..."
  New-Item -ItemType Directory -Path $claudeDir -Force | Out-Null
  Warn "claude.exe NAO embarcado — primeiro run vai baixar online."
} else {
  Step 5 8 "Instalando claude CLI nativo Windows em opt/claude-cli..."
  New-Item -ItemType Directory -Path $claudeDir -Force | Out-Null
  Info "URL: $CLAUDE_PS1_URL"
  $installScript = (Invoke-WebRequest -Uri $CLAUDE_PS1_URL -UseBasicParsing).Content
  $prevInstallDir = $env:CLAUDE_INSTALL_DIR
  $prevPath = $env:CLAUDE_HOME
  try {
    $env:CLAUDE_INSTALL_DIR = $claudeDir
    $env:CLAUDE_HOME = $claudeDir
    Invoke-Expression $installScript
  } catch {
    Warn "install.ps1 falhou ou nao respeita CLAUDE_INSTALL_DIR ($_)."
    Warn "Tentando fallback: copia de ~\.local\bin\claude.exe pra opt\claude-cli\..."
    $defaultClaude = Join-Path $env:USERPROFILE '.local\bin\claude.exe'
    if (Test-Path $defaultClaude) {
      Copy-Item $defaultClaude (Join-Path $claudeDir 'claude.exe') -Force
      Ok "claude.exe copiado do default install dir."
    } else {
      Warn "claude.exe nao encontrado em $defaultClaude — runtime vai sem claude embarcado."
    }
  } finally {
    $env:CLAUDE_INSTALL_DIR = $prevInstallDir
    $env:CLAUDE_HOME = $prevPath
  }
  if (Test-Path (Join-Path $claudeDir 'claude.exe')) {
    Ok "claude.exe presente em $claudeDir"
  } else {
    Warn "claude.exe NAO instalado — primeiro run do .exe vai precisar de internet."
  }
}

# ----- 6. Seed repos (opcional) -----
$seedDir = Join-Path $msys64 'opt\squad-seed'
New-Item -ItemType Directory -Path $seedDir -Force | Out-Null
if ($SkipSeed) {
  Step 6 8 "Pulando seed repos (--SkipSeed)..."
} else {
  Step 6 8 "Clonando repos seed (imp-squad, imp-orchestrator)..."
  $ghCmd = Get-Command gh.exe -ErrorAction SilentlyContinue
  if (-not $ghCmd) {
    Warn "gh CLI nao instalado no host. Seed pulado. (Instale https://cli.github.com/ pra incluir.)"
  } else {
    # Verifica se gh esta autenticado
    & gh.exe auth status 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) {
      Warn "gh nao autenticado. Rode 'gh auth login' e re-execute, OU passe --SkipSeed."
    } else {
      foreach ($repo in $SEEDS) {
        $name = Split-Path $repo -Leaf
        $dest = Join-Path $seedDir $name
        if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
        Info "Clonando $repo..."
        & gh.exe repo clone $repo $dest -- --depth=1 2>&1 | Out-Host
        if ($LASTEXITCODE -ne 0) {
          Warn "Falha ao clonar $repo (pode ser permissao). Seguindo."
        } else {
          Ok "$name clonado"
        }
      }
    }
  }
}

# ----- 7. Scripts auxiliares (imp-squad.bat + setup.sh) -----
Step 7 8 "Gerando scripts auxiliares em opt/imp-scripts/..."
$scriptsDir = Join-Path $msys64 'opt\imp-scripts'
New-Item -ItemType Directory -Path $scriptsDir -Force | Out-Null

# imp-squad.bat — wrapper PATH-isolado (Marcos EMBARCAR §5)
$batContent = @'
@echo off
setlocal
rem IMP Squad wrapper — PATH isolado, zero conflito com PATH global do user.
rem Layout esperado (apos bootstrap.ps1 copiar pra LOCALAPPDATA):
rem   %IMP_RUNTIME_HOME%\msys64\opt\imp-scripts\imp-squad.bat  (este arquivo)
rem   %IMP_RUNTIME_HOME%\msys64\usr\bin\bash.exe
rem   %IMP_RUNTIME_HOME%\msys64\opt\claude-cli\claude.exe

set "RUNTIME=%~dp0..\..\.."
for %%I in ("%RUNTIME%") do set "RUNTIME=%%~fI"

set "MSYS64=%RUNTIME%\msys64"
set "PATH=%MSYS64%\usr\bin;%MSYS64%\ucrt64\bin;%MSYS64%\mingw64\bin;%MSYS64%\opt\claude-cli;%PATH%"
set "MSYSTEM=MSYS"
set "CHERE_INVOKING=1"
set "CLAUDE_CODE_GIT_BASH_PATH=%MSYS64%\usr\bin\bash.exe"
set "HOME=%MSYS64%\home\%USERNAME%"

if not exist "%HOME%" mkdir "%HOME%" >nul 2>&1
if not exist "%MSYS64%\opt\imp-scripts\setup-done" (
  "%MSYS64%\usr\bin\bash.exe" -lc "/opt/imp-scripts/setup.sh"
)

if "%~1"=="resume" (
  "%MSYS64%\usr\bin\bash.exe" -lc "tmux attach -t imp 2>/dev/null || tmux new -s imp"
) else if "%~1"=="shell" (
  "%MSYS64%\usr\bin\bash.exe" --login -i
) else if "%~1"=="check" (
  "%MSYS64%\usr\bin\bash.exe" -lc "bash --version && tmux -V && git --version && node -v && claude --version 2>/dev/null || echo claude_not_ready"
) else (
  "%MSYS64%\usr\bin\bash.exe" -lc "tmux attach -t imp 2>/dev/null || tmux new -s imp"
)

endlocal
'@
Write-Utf8NoBom (Join-Path $scriptsDir 'imp-squad.bat') $batContent
Ok "imp-squad.bat gerado"

# setup.sh — primeiro uso (mkpasswd/mkgroup + .bashrc)
$setupContent = @'
#!/bin/bash
# IMP Squad setup.sh — roda 1x no primeiro launch (chamado pelo imp-squad.bat).
set -e

mkdir -p "$HOME"

# nsswitch.conf ja define db_home: windows, so garantimos bashrc minimo
if [ ! -f "$HOME/.bashrc" ]; then
  cat > "$HOME/.bashrc" <<'EOFB'
# IMP Squad bashrc (gerado por setup.sh)
export PATH="/opt/claude-cli:/usr/bin:/ucrt64/bin:/mingw64/bin:$PATH"
export CLAUDE_CODE_GIT_BASH_PATH=/usr/bin/bash.exe
export EDITOR=nano
alias ll='ls -la'
alias squad='tmux attach -t imp 2>/dev/null || tmux new -s imp'
PS1='\[\e[36m\]\u@imp\[\e[0m\]:\[\e[33m\]\w\[\e[0m\]$ '
EOFB
fi

# Validacoes
echo "=== IMP Squad self-check ==="
bash --version | head -1
tmux -V
git --version
node -v 2>/dev/null || echo "node: missing"
claude --version 2>/dev/null || echo "claude: missing (sera baixado online no 1o login)"

# Marca setup feito
touch /opt/imp-scripts/setup-done
echo "OK: setup completo."
'@
Write-Utf8NoBom (Join-Path $scriptsDir 'setup.sh') $setupContent
Ok "setup.sh gerado"

# Limpeza pre-compactacao — remove .pacnew/.pacsave/cache restantes
Info "Limpeza final (cache pacman, tmp)..."
& $msys2Bash -lc "rm -rf /var/cache/pacman/pkg/* /tmp/* /var/log/*.log 2>/dev/null || true"

# ----- 8. Compacta .7z solido -----
Step 8 8 "Compactando msys64 -> .7z solido (mx=9, ms=on)..."
$outFull = if ([System.IO.Path]::IsPathRooted($Out)) { $Out } else { Join-Path (Get-Location).Path $Out }
$outDir = Split-Path $outFull -Parent
if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir -Force | Out-Null }
if (Test-Path $outFull) { Remove-Item $outFull -Force }

Push-Location $WorkDir
try {
  & $sevenZipPath a -t7z -mx=9 -ms=on -mqs=on -bsp1 $outFull 'msys64' | Out-Host
  if ($LASTEXITCODE -ne 0) { Fail "7z exit $LASTEXITCODE" }
} finally {
  Pop-Location
}

# ----- Hash + sumario -----
$sha = (Get-FileHash $outFull -Algorithm SHA256).Hash
$shaFile = "$outFull.sha256"
"$sha *$(Split-Path $outFull -Leaf)" | Set-Content -Path $shaFile -Encoding ASCII -NoNewline
$sizeMB = [math]::Round((Get-Item $outFull).Length / 1MB, 1)

Write-Host ""
Write-Host "================================================" -ForegroundColor Green
Write-Host "  OK Runtime gerado" -ForegroundColor Green
Write-Host "================================================" -ForegroundColor Green
Write-Host "  Arquivo: $outFull"
Write-Host "  Tamanho: $sizeMB MB"
Write-Host "  SHA256 : $sha"
Write-Host "  Hash em: $shaFile"
Write-Host ""
Write-Host "Proximos passos:" -ForegroundColor Cyan
Write-Host "  1. Confere runtime/runtime.7z + runtime/runtime.7z.sha256 (git ignora)"
Write-Host "  2. npm run dist:win   (electron-builder pega via extraResources)"
Write-Host "  3. dist/IMP-Squad-Instalador-X.Y.Z-portable.exe sai com runtime embutido"
Write-Host ""

if (-not $KeepWorkDir) {
  Info "Limpando WorkDir ($WorkDir)..."
  Remove-Item $WorkDir -Recurse -Force -ErrorAction SilentlyContinue
}
