'use strict';

// ───────────────────────────────────────────────────────────────────────
// FASE 2 — Runtime MSYS2 embarcado (Bruno, 2026-05-27)
//
// REESCRITA: os 17 steps WSL antigos foram REMOVIDOS. 5 novos steps:
//   step_X1 — copyRuntime    (copia ~680 MB de runtime.7z pra LOCALAPPDATA)
//   step_X2 — setupEnv       (setup.sh, AV exclusion, valida runtime)
//   step_X3 — githubAuth     (gh auth login --device-flow, opcional)
//   step_X4 — launchTmux     (sessão tmux imp + 7 painéis claude)
//   step_X5 — desktopShortcut (atalho .lnk pra reabrir squad)
//
// Premissas (vide docs/fase-autossuficiente/{DECISAO-FASE1,MARCOS-EMBARCAR,
// BRUNO-TESTE-MSYS2,PATRICIA-CENARIOS-NOVOS}.md):
//   - Zero WSL, zero virtualização, zero reboot
//   - PATH isolado via wrapper imp-squad.bat (HKCU\Environment NÃO é tocado)
//   - claude.exe NATIVO Windows + CLAUDE_CODE_GIT_BASH_PATH apontando pro bash
//     do MSYS2 (issue #9883: claude in MSYS2 shell quebra)
//   - Runtime versionado em %LOCALAPPDATA%\IMP-Squad-Runtime\<version>\
//   - Junction `current` aponta pra versão ativa
//
// step00Preflight é PRESERVADO (genérico, vale pra qualquer fluxo).
// ───────────────────────────────────────────────────────────────────────

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { powershell, isElevated } = require('./shell');
const preflight = require('./preflight');

// ───────────────────────────────────────────────────────────────────────
// Constantes globais do runtime
// ───────────────────────────────────────────────────────────────────────

// Tamanho mínimo livre no drive destino — 2 GB (1 GB runtime + folga cache).
const MIN_FREE_GB = 2;

// Arquivos esperados após extração — usados pra validate de step_X1.
// Compatível com 2 layouts: msys64/usr/bin/... (achatado) ou msys2/usr/bin/...
// O builder pode escolher; aqui aceitamos ambos.
const RUNTIME_CRITICAL_BINS = [
  ['msys64', 'usr', 'bin', 'bash.exe'],
  ['msys64', 'usr', 'bin', 'tmux.exe'],
  ['msys64', 'usr', 'bin', 'git.exe'],
];

// Caminho do node embarcado — também aceita dois layouts (node/ raiz ou
// dentro de mingw64/ucrt64).
const RUNTIME_NODE_CANDIDATES = [
  ['node', 'node.exe'],
  ['msys64', 'ucrt64', 'bin', 'node.exe'],
  ['msys64', 'mingw64', 'bin', 'node.exe'],
];

// Caminho do claude.exe nativo embarcado.
const RUNTIME_CLAUDE_CANDIDATES = [
  ['claude-cli', 'claude.exe'],
  ['claude-cli', 'bin', 'claude.exe'],
];

// Personas que ganham 1 painel cada na tmux session.
const TMUX_PERSONAS = ['lider', 'arquiteto', 'criativo', 'debugger', 'qa', 'revisor'];

// ───────────────────────────────────────────────────────────────────────
// Helpers de paths — todos resolvem caminhos absolutos sem efeito colateral.
// ───────────────────────────────────────────────────────────────────────

function getLocalAppData() {
  return process.env.LOCALAPPDATA
    || path.join(os.homedir(), 'AppData', 'Local');
}

function getRuntimeRoot() {
  return path.join(getLocalAppData(), 'IMP-Squad-Runtime');
}

function getRuntimeVersionDir(version) {
  return path.join(getRuntimeRoot(), version);
}

function getRuntimeCurrentDir() {
  // Junction (mklink /J) apontando pra versão ativa. Os steps que precisam
  // do runtime SEM saber versão usam `current`.
  return path.join(getRuntimeRoot(), 'current');
}

// Resolve um candidato de path dentro do runtime — testa cada layout e
// devolve o primeiro existente, ou null.
function resolveRuntimeBin(runtimeDir, candidates) {
  for (const parts of candidates) {
    const p = path.join(runtimeDir, ...parts);
    try {
      if (fs.existsSync(p)) return p;
    } catch (_) {}
  }
  return null;
}

// Localiza o arquivo runtime.7z (ou .zip) empacotado com extraResources do
// electron-builder. Em runtime portable: process.resourcesPath.
// Aceita .7z (preferido — sólido, AV escaneia 1x) ou .zip (fallback se 7za
// não está disponível no Windows host).
function findRuntimeArchive() {
  const baseCandidates = [];
  if (process.resourcesPath) baseCandidates.push(process.resourcesPath);
  baseCandidates.push(path.join(__dirname, '..', 'resources'));
  baseCandidates.push(path.join(__dirname, '..'));

  const fileCandidates = ['runtime.7z', 'runtime.zip', 'runtime.tar.zst'];

  for (const base of baseCandidates) {
    for (const file of fileCandidates) {
      const p = path.join(base, file);
      try { if (fs.existsSync(p)) return p; } catch (_) {}
      const p2 = path.join(base, 'runtime', file);
      try { if (fs.existsSync(p2)) return p2; } catch (_) {}
    }
  }
  return null;
}

// Versão "ativa" do runtime — atrelada à versão do app. Se não conseguir
// resolver, usa "1.0.0" como fallback (Marcos §6 — coexistência versionada).
function getRuntimeVersion() {
  try {
    const pkg = require(path.join(__dirname, '..', 'package.json'));
    return pkg.version || '1.0.0';
  } catch (_) {
    return '1.0.0';
  }
}

// ───────────────────────────────────────────────────────────────────────
// Helper: powershellVerbose — wrap p/ chamadas PS que precisam de output rico.
// Diferente do `powershell` cru: pré-chc 65001 (UTF-8) + enriquece erro com
// stdout/stderr/exit code. Reaproveitado dos steps WSL antigos.
// ───────────────────────────────────────────────────────────────────────
async function powershellVerbose(script, opts = {}) {
  const wrapped = `chcp 65001 > $null; ${script}`;
  try {
    const r = await powershell(wrapped, opts);
    return r;
  } catch (e) {
    const code = e.code != null ? e.code : '(unknown)';
    const stdout = (e.stdout || '').trim();
    const stderr = (e.stderr || '').trim();
    const parts = [
      `exit_code=${code}`,
      stdout ? `stdout=${stdout.slice(0, 1500)}` : 'stdout=(empty)',
      stderr ? `stderr=${stderr.slice(0, 1500)}` : 'stderr=(empty)',
    ];
    const enriched = new Error(`${e.message} | ${parts.join(' | ')}`);
    enriched.code = code;
    enriched.stdout = stdout;
    enriched.stderr = stderr;
    throw enriched;
  }
}

// ───────────────────────────────────────────────────────────────────────
// Admin gate. Steps X1/X2 podem precisar (AV exclusion via Add-MpPreference,
// junction em LOCALAPPDATA opera sem admin mas exclusion sim).
// ───────────────────────────────────────────────────────────────────────
async function requireAdminOrThrow() {
  const elevated = await isElevated();
  if (!elevated) {
    const err = new Error('Este passo precisa de administrador. Reabra o instalador como administrador.');
    err.code = 'NEEDS_ADMIN';
    err.needsAdmin = true;
    throw err;
  }
}

// ───────────────────────────────────────────────────────────────────────
// Helper: checkFreeSpace(drivePath, minGb) → { ok, freeGb }
// Patrícia N8: SEMPRE checa o drive da PASTA-DESTINO, nunca fixo em C:.
// ───────────────────────────────────────────────────────────────────────
async function checkFreeSpace(targetPath, minGb = MIN_FREE_GB) {
  const drive = path.parse(targetPath).root.replace(/\\$/, ''); // "C:"
  const letter = drive.replace(':', '');
  const script = `[math]::Round((Get-PSDrive ${letter}).Free / 1GB, 2)`;
  try {
    const r = await powershell(script, { timeout: 15_000 });
    const free = parseFloat((r.stdout || '').trim());
    if (!Number.isFinite(free)) {
      return { ok: false, freeGb: NaN, drive, error: 'Get-PSDrive não retornou valor numérico' };
    }
    return { ok: free >= minGb, freeGb: free, drive, minGb };
  } catch (e) {
    return { ok: false, freeGb: NaN, drive, error: e.message };
  }
}

// ───────────────────────────────────────────────────────────────────────
// Helper: copyRuntimeWithProgress(srcArchive, destDir, onProgress)
//
// Estratégia (Patrícia N6): UM .7z sólido + extrai em TEMP + MOVE pra destino
// final. Isso faz o AV escanear UMA vez (no .7z baixado e arquivo TEMP), em
// vez de cada um dos 50K binários extraídos.
//
// onProgress recebe { pct, bytesDone, totalBytes, phase }.
//   phase: 'preflight' | 'extracting' | 'moving' | 'done'
//
// Suporta .7z (via 7za.exe se disponível, fallback Expand-Archive p/ .zip)
// e .zip (Expand-Archive direto).
// ───────────────────────────────────────────────────────────────────────
async function copyRuntimeWithProgress(srcArchive, destDir, onProgress) {
  const fire = (payload) => {
    if (typeof onProgress === 'function') {
      try { onProgress(payload); } catch (_) {}
    }
  };

  // Preflight: tamanho do arquivo origem (pra estimar progresso).
  let totalBytes = 0;
  try { totalBytes = fs.statSync(srcArchive).size; } catch (_) {}

  fire({ pct: 0, bytesDone: 0, totalBytes, phase: 'preflight' });

  // Cria destDir se não existe (parent dir do version-dir já deve existir).
  fs.mkdirSync(destDir, { recursive: true });

  // Decide extrator pelo extension.
  const ext = path.extname(srcArchive).toLowerCase();
  const isZip = ext === '.zip';
  const is7z = ext === '.7z';
  const isTarZst = srcArchive.endsWith('.tar.zst');

  // Pasta TEMP intermediária — extração rápida, depois move atomicamente.
  // Mesma partição que destino (move sem cópia) sempre que possível.
  const tempBase = path.join(path.dirname(destDir), `.extracting-${process.pid}-${Date.now()}`);
  fs.mkdirSync(tempBase, { recursive: true });

  // Marca atômica (Patrícia N27): se essa pasta existe na próxima abertura,
  // sabemos que a extração foi interrompida.
  const flagFile = path.join(destDir, '.extracting');
  try { fs.writeFileSync(flagFile, String(Date.now())); } catch (_) {}

  let extractScript;
  if (isZip) {
    // Expand-Archive nativo. Suporta progresso via Write-Progress, mas sem
    // captura prática aqui. Emitimos progresso mock baseado em tempo.
    extractScript = `
      $ErrorActionPreference = 'Stop'
      Expand-Archive -LiteralPath '${srcArchive.replace(/'/g, "''")}' -DestinationPath '${tempBase.replace(/'/g, "''")}' -Force
      'OK'
    `;
  } else if (is7z) {
    // Tenta 7za.exe embarcado (extraResources/tools/7za.exe), depois 7z.exe do PATH.
    extractScript = `
      $ErrorActionPreference = 'Stop'
      $cands = @(
        (Join-Path $PSScriptRoot '7za.exe'),
        (Join-Path '${(process.resourcesPath || '').replace(/'/g, "''")}' 'tools/7za.exe'),
        '7za.exe', '7z.exe'
      )
      $exe = $null
      foreach ($c in $cands) {
        if ($c -and (Test-Path $c)) { $exe = $c; break }
        $cmd = Get-Command $c -ErrorAction SilentlyContinue
        if ($cmd) { $exe = $cmd.Source; break }
      }
      if (-not $exe) { throw 'RUNTIME_7Z_TOOL_MISSING: nem 7za nem 7z encontrados' }
      & $exe x -y -bsp1 -o'${tempBase.replace(/'/g, "''")}' '${srcArchive.replace(/'/g, "''")}'
      if ($LASTEXITCODE -ne 0) { throw "7za exit $LASTEXITCODE" }
      'OK'
    `;
  } else if (isTarZst) {
    // Última opção — requer tar.exe (Win10 17063+) + zstd extension. Não cobrimos
    // amplamente; assumimos zip ou 7z. Falha clara se chegar aqui sem suporte.
    extractScript = `
      $ErrorActionPreference = 'Stop'
      throw 'RUNTIME_ARCHIVE_FORMAT_UNSUPPORTED: tar.zst não suportado nesta versão. Use .7z ou .zip.'
    `;
  } else {
    throw new Error(`RUNTIME_ARCHIVE_FORMAT_UNSUPPORTED: extensão desconhecida ${ext}`);
  }

  fire({ pct: 5, bytesDone: 0, totalBytes, phase: 'extracting' });

  // Roda extração — não temos hook real de progresso da PS, mas emitimos
  // marcadores temporais pra UI não parecer travada.
  let extractTimer = null;
  let fakePct = 5;
  if (typeof onProgress === 'function') {
    extractTimer = setInterval(() => {
      fakePct = Math.min(80, fakePct + 2);
      fire({ pct: fakePct, bytesDone: Math.floor(totalBytes * fakePct / 100), totalBytes, phase: 'extracting' });
    }, 2000);
  }

  try {
    await powershellVerbose(extractScript, { timeout: 1800_000 }); // 30min cap
  } catch (e) {
    if (extractTimer) clearInterval(extractTimer);
    // Limpa pasta de extração parcial
    try { fs.rmSync(tempBase, { recursive: true, force: true }); } catch (_) {}
    // Mensagem amigável p/ disco cheio durante extração
    if (/ENOSPC|no space|disk full/i.test(e.message || '')) {
      const err = new Error(`RUNTIME_DISK_FULL: disco encheu durante extração. ${e.message}`);
      err.code = 'RUNTIME_DISK_FULL';
      throw err;
    }
    // AV pode ter agido — re-lança erro com hint
    if (/access.*denied|cannot find|virus/i.test(e.message || '')) {
      const err = new Error(`AV_QUARANTINE: antivírus pode ter removido binários durante extração. ${e.message}`);
      err.code = 'AV_QUARANTINE';
      throw err;
    }
    throw e;
  }
  if (extractTimer) clearInterval(extractTimer);

  fire({ pct: 85, bytesDone: totalBytes, totalBytes, phase: 'moving' });

  // Move conteúdo do tempBase pra destDir. Se tempBase contém UMA pasta
  // (típico: msys64/ ou runtime/), move o conteúdo dela; senão move tudo.
  const tempEntries = fs.readdirSync(tempBase);
  let srcDir = tempBase;
  if (tempEntries.length === 1) {
    const single = path.join(tempBase, tempEntries[0]);
    if (fs.statSync(single).isDirectory()) {
      // Heurística: se essa pasta única é "runtime", desce mais um nível.
      if (/^runtime$/i.test(tempEntries[0])) {
        srcDir = single;
      }
    }
  }

  // Move atomicamente cada entry de srcDir pra destDir.
  for (const entry of fs.readdirSync(srcDir)) {
    const from = path.join(srcDir, entry);
    const to = path.join(destDir, entry);
    try {
      fs.renameSync(from, to);
    } catch (e) {
      // Cross-device? Fallback: cópia recursiva.
      if (e.code === 'EXDEV' || e.code === 'EPERM') {
        try { fs.cpSync(from, to, { recursive: true, force: true }); }
        catch (e2) { throw e2; }
        try { fs.rmSync(from, { recursive: true, force: true }); } catch (_) {}
      } else if (e.code === 'EEXIST') {
        // Destino já existe (re-run idempotente) — sobrescreve.
        fs.rmSync(to, { recursive: true, force: true });
        fs.renameSync(from, to);
      } else {
        throw e;
      }
    }
  }

  // Cleanup do tempBase
  try { fs.rmSync(tempBase, { recursive: true, force: true }); } catch (_) {}
  try { fs.unlinkSync(flagFile); } catch (_) {}

  fire({ pct: 100, bytesDone: totalBytes, totalBytes, phase: 'done' });
  return { ok: true, destDir };
}

// ───────────────────────────────────────────────────────────────────────
// Helper: createJunction(linkPath, targetPath)
// Cria junction NTFS (não requer admin nem dev-mode) apontando linkPath →
// targetPath. Idempotente: remove link antigo se existir.
// ───────────────────────────────────────────────────────────────────────
async function createJunction(linkPath, targetPath) {
  // Remove existing junction/dir if present
  try {
    const st = fs.lstatSync(linkPath);
    if (st.isDirectory() || st.isSymbolicLink()) {
      // Em Windows, rmSync funciona pra junction também.
      fs.rmSync(linkPath, { recursive: true, force: true });
    }
  } catch (_) {}

  // mklink /J via cmd.exe (PowerShell New-Item -ItemType Junction também
  // funciona, mas mklink /J é mais antigo e confiável).
  const script = `cmd.exe /c mklink /J "${linkPath.replace(/"/g, '""')}" "${targetPath.replace(/"/g, '""')}"`;
  await powershellVerbose(script, { timeout: 15_000 });
}

// ───────────────────────────────────────────────────────────────────────
// Helper: detectAv() — descobre status do Defender e antivírus de terceiros.
// Retorna: { defender: bool, real_time_active: bool, third_party_name: string|null,
//           exclusion_added: bool }
// Patrícia N2, N20, E3.
// ───────────────────────────────────────────────────────────────────────
async function detectAv() {
  const result = {
    defender: false,
    real_time_active: false,
    third_party_name: null,
    exclusion_added: false,
  };

  // 1) Defender via Get-MpComputerStatus
  try {
    const r = await powershell(`
      try {
        $s = Get-MpComputerStatus -ErrorAction Stop
        '' + $s.AntivirusEnabled + '|' + $s.RealTimeProtectionEnabled
      } catch { 'unavail|unavail' }
    `, { timeout: 15_000 });
    const parts = (r.stdout || '').trim().split('|');
    if (parts.length === 2 && parts[0] !== 'unavail') {
      result.defender = /true/i.test(parts[0]);
      result.real_time_active = /true/i.test(parts[1]);
    }
  } catch (_) {}

  // 2) Antivírus de terceiros via SecurityCenter2
  try {
    const r = await powershell(`
      try {
        $av = Get-CimInstance -Namespace root/SecurityCenter2 -ClassName AntivirusProduct -ErrorAction Stop
        $names = @($av | Where-Object { $_.displayName -notmatch 'Defender|Windows Defender' } | ForEach-Object { $_.displayName })
        if ($names.Count -gt 0) { $names -join ',' } else { '' }
      } catch { '' }
    `, { timeout: 15_000 });
    const names = (r.stdout || '').trim();
    if (names) result.third_party_name = names.split(',')[0];
  } catch (_) {}

  return result;
}

// ───────────────────────────────────────────────────────────────────────
// Helper: detectAppLocker() — descobre se há regras AppLocker restritivas
// que possam bloquear binários em LOCALAPPDATA.
// Retorna: { policy_present: bool, blocks_localappdata: bool, raw_xml: string|null }
// Patrícia N1.
// ───────────────────────────────────────────────────────────────────────
async function detectAppLocker() {
  const result = { policy_present: false, blocks_localappdata: false, raw_xml: null };
  try {
    const r = await powershell(`
      try {
        $p = Get-AppLockerPolicy -Effective -Xml -ErrorAction Stop
        if ($p) { $p } else { '' }
      } catch { '' }
    `, { timeout: 20_000 });
    const xml = (r.stdout || '').trim();
    if (xml && /<AppLockerPolicy/i.test(xml)) {
      result.policy_present = true;
      result.raw_xml = xml.slice(0, 4000); // cap pra log
      // Heurística simples: regra Deny com path LOCALAPPDATA, ou Allow MUITO
      // restritiva (sem entries que cubram nossa pasta).
      if (/<FilePathRule[^>]*Action="Deny"[^>]*Path="[^"]*LOCALAPPDATA/i.test(xml)
          || /<FilePathRule[^>]*Action="Deny"[^>]*Path="[^"]*%LOCALAPPDATA%/i.test(xml)
          || /<FilePathRule[^>]*Action="Deny"[^>]*Path="\*\\AppData\\Local/i.test(xml)) {
        result.blocks_localappdata = true;
      }
    }
  } catch (_) {}
  return result;
}

// ───────────────────────────────────────────────────────────────────────
// Helper: addDefenderExclusion(folderPath) — Add-MpPreference -ExclusionPath
// REQUER admin. Patrícia N2 + N20.
// Retorna { ok: bool, error?: string }.
// ───────────────────────────────────────────────────────────────────────
async function addDefenderExclusion(folderPath) {
  if (!(await isElevated())) {
    return { ok: false, error: 'NEEDS_ADMIN: Add-MpPreference exige administrador' };
  }
  try {
    const script = `
      try {
        Add-MpPreference -ExclusionPath '${folderPath.replace(/'/g, "''")}' -ErrorAction Stop
        Add-MpPreference -ExclusionProcess 'bash.exe','tmux.exe','node.exe','git.exe' -ErrorAction SilentlyContinue
        'OK'
      } catch { "ERR: $($_.Exception.Message)" }
    `;
    const r = await powershell(script, { timeout: 30_000 });
    if (/^OK\s*$/m.test(r.stdout || '')) {
      return { ok: true };
    }
    return { ok: false, error: (r.stdout || '').trim() };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ───────────────────────────────────────────────────────────────────────
// Helper: launchTmuxSquadSession(runtimeHome) — cria/recria sessão tmux `imp`
// com 7 painéis (1 main + 6 personas). Usa bash do MSYS2 embarcado, claude.exe
// nativo Windows com CLAUDE_CODE_GIT_BASH_PATH apontando pro bash MSYS2.
//
// Reuso do step_14 antigo (lider/arquiteto/criativo/debugger/qa/revisor) mas
// agora roda dentro do bash embarcado em vez de WSL.
// ───────────────────────────────────────────────────────────────────────
async function launchTmuxSquadSession(runtimeHome, opts = {}) {
  const bash = resolveRuntimeBin(runtimeHome, [['msys64', 'usr', 'bin', 'bash.exe']]);
  if (!bash) {
    throw new Error('RUNTIME_BASH_MISSING: bash.exe do MSYS2 não encontrado em ' + runtimeHome);
  }

  // Pastas das personas. Esperado: runtime/squad-seed/imp-squad/<persona>
  const squadRoot = path.join(runtimeHome, 'squad-seed', 'imp-squad');
  const orchRoot = path.join(runtimeHome, 'squad-seed', 'imp-orchestrator');

  // bash espera paths POSIX. Conversão simples: drive letter → /<letter>/...
  const winToPosix = (p) => {
    const m = p.match(/^([A-Za-z]):[\\/](.*)$/);
    if (!m) return p.replace(/\\/g, '/');
    return `/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}`;
  };

  const squadRootPosix = winToPosix(squadRoot);
  const orchRootPosix = winToPosix(orchRoot);

  // Script — mata sessão `imp` antiga e recria.
  const personasList = TMUX_PERSONAS.join(' ');
  const script = `
    set -e
    SESSION="imp"
    SQUAD_ROOT="${squadRootPosix}"
    ORCH_ROOT="${orchRootPosix}"
    if tmux has-session -t "$SESSION" 2>/dev/null; then
      tmux kill-session -t "$SESSION"
    fi
    tmux new-session -d -s "$SESSION" -n agents -c "$SQUAD_ROOT/lider"
    for dir in ${TMUX_PERSONAS.slice(1).join(' ')}; do
      tmux split-window -t "$SESSION" -c "$SQUAD_ROOT/$dir"
      tmux select-layout -t "$SESSION" tiled
    done
    tmux split-window -t "$SESSION" -c "$ORCH_ROOT"
    tmux select-layout -t "$SESSION" tiled
    tmux set -t "$SESSION" -g pane-border-status top
    PANES=( $(tmux list-panes -t "$SESSION" -F '#{pane_id}') )
    LABELS=(${TMUX_PERSONAS.join(' ')} main)
    for i in "\${!PANES[@]}"; do
      tmux select-pane -t "\${PANES[$i]}" -T "\${LABELS[$i]}"
    done
    for pid in "\${PANES[@]}"; do
      tmux send-keys -t "$pid" 'claude' C-m
    done
  `;

  // Env isolado — IMP_RUNTIME_HOME + CLAUDE_CODE_GIT_BASH_PATH + PATH prepend
  const claudeExe = resolveRuntimeBin(runtimeHome, RUNTIME_CLAUDE_CANDIDATES);
  const nodeExe = resolveRuntimeBin(runtimeHome, RUNTIME_NODE_CANDIDATES);
  const env = {
    ...process.env,
    IMP_RUNTIME_HOME: runtimeHome,
    HOME: path.join(runtimeHome, 'home', os.userInfo().username || 'user'),
    MSYSTEM: 'MSYS',
    CLAUDE_CODE_GIT_BASH_PATH: bash,
    PATH: [
      path.join(runtimeHome, 'msys64', 'usr', 'bin'),
      claudeExe ? path.dirname(claudeExe) : '',
      nodeExe ? path.dirname(nodeExe) : '',
      process.env.PATH || '',
    ].filter(Boolean).join(';'),
  };

  return new Promise((resolve, reject) => {
    const proc = spawn(bash, ['-lc', script], {
      env,
      windowsHide: true,
      timeout: opts.timeout || 60_000,
    });
    let stdout = '', stderr = '';
    proc.stdout && proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr && proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) {
        const err = new Error(`tmux launch falhou (exit ${code}): ${stderr.slice(0, 500)}`);
        err.code = code;
        err.stdout = stdout;
        err.stderr = stderr;
        return reject(err);
      }
      resolve({ ok: true, stdout, stderr });
    });
  });
}

// ───────────────────────────────────────────────────────────────────────
// Helper: createDesktopShortcut(targetPath, name) — cria .lnk no Desktop.
// Usa WScript.Shell via PowerShell. Patrícia N13 (fallback se COM falhar).
// ───────────────────────────────────────────────────────────────────────
async function createDesktopShortcut(targetPath, name) {
  const safeName = String(name || 'IMP Squad').replace(/[\\/:*?"<>|]/g, '_');
  const ps = `
    $ErrorActionPreference = 'Stop'
    $Desktop = [Environment]::GetFolderPath("Desktop")
    $LnkPath = Join-Path $Desktop '${safeName.replace(/'/g, "''")}.lnk'
    try {
      $WshShell = New-Object -ComObject WScript.Shell
      $Shortcut = $WshShell.CreateShortcut($LnkPath)
      $Shortcut.TargetPath       = '${targetPath.replace(/'/g, "''")}'
      $Shortcut.WorkingDirectory = '${path.dirname(targetPath).replace(/'/g, "''")}'
      $Shortcut.IconLocation     = '${targetPath.replace(/'/g, "''")},0'
      $Shortcut.Description      = 'IMP Squad — sessão tmux com 7 Claudes'
      $Shortcut.Save()
      'OK:' + $LnkPath
    } catch {
      # Fallback (Patrícia N13): cria .cmd manual no Desktop
      $CmdPath = Join-Path $Desktop '${safeName.replace(/'/g, "''")}.cmd'
      Set-Content -Path $CmdPath -Value ('@echo off' + "\`r\`n" + 'start "" "${targetPath.replace(/\\/g, '\\\\').replace(/'/g, "''")}"')
      'FALLBACK:' + $CmdPath
    }
  `;
  const r = await powershellVerbose(ps, { timeout: 30_000 });
  return { ok: true, raw: (r.stdout || '').trim() };
}

// ───────────────────────────────────────────────────────────────────────
// Helper: writeImpSquadBat — gera o wrapper `imp-squad.bat` isolando PATH.
// Marcos §5: única var "global" tocada é IMP_RUNTIME_HOME via HKCU.
// ───────────────────────────────────────────────────────────────────────
function writeImpSquadBat(runtimeHome) {
  const batPath = path.join(runtimeHome, 'scripts', 'imp-squad.bat');
  fs.mkdirSync(path.dirname(batPath), { recursive: true });
  const bashRel = path.join('msys64', 'usr', 'bin', 'bash.exe');
  const content = [
    '@echo off',
    `set IMP_RUNTIME_HOME=${runtimeHome}`,
    `set PATH=%IMP_RUNTIME_HOME%\\msys64\\usr\\bin;%IMP_RUNTIME_HOME%\\node;%IMP_RUNTIME_HOME%\\claude-cli;%PATH%`,
    'set MSYSTEM=MSYS',
    'set HOME=%IMP_RUNTIME_HOME%\\home\\%USERNAME%',
    `set CLAUDE_CODE_GIT_BASH_PATH=%IMP_RUNTIME_HOME%\\${bashRel}`,
    `"%IMP_RUNTIME_HOME%\\${bashRel}" --login -i %*`,
    '',
  ].join('\r\n');
  fs.writeFileSync(batPath, content, 'utf8');
  return batPath;
}

// ───────────────────────────────────────────────────────────────────────
// Helper: writeSetupSh — gera setup.sh idempotente que cria HOME, .bashrc,
// configura locale UTF-8 (Patrícia N11), valida tmux/git/node/claude.
// ───────────────────────────────────────────────────────────────────────
function writeSetupSh(runtimeHome) {
  const setupPath = path.join(runtimeHome, 'scripts', 'setup.sh');
  fs.mkdirSync(path.dirname(setupPath), { recursive: true });
  const content = `#!/usr/bin/env bash
# setup.sh — preparado pelo instalador IMP Squad (idempotente)
set -e
RUNTIME="\${IMP_RUNTIME_HOME:-/c/Users/\${USERNAME:-user}/AppData/Local/IMP-Squad-Runtime/current}"
USER_NAME="\${USERNAME:-user}"
HOME_DIR="$RUNTIME/home/$USER_NAME"
mkdir -p "$HOME_DIR"
mkdir -p "$RUNTIME/msys64/tmp" 2>/dev/null || true

# .bashrc minimal (idempotente)
if [ ! -f "$HOME_DIR/.bashrc" ]; then
  cat > "$HOME_DIR/.bashrc" <<'BASHRC'
# IMP Squad runtime bashrc
export LANG=C.UTF-8
export LC_ALL=C.UTF-8
export LC_TIME=C
export PATH="$IMP_RUNTIME_HOME/msys64/usr/bin:$IMP_RUNTIME_HOME/node:$IMP_RUNTIME_HOME/claude-cli:$PATH"
alias ll='ls -la'
BASHRC
fi

# Smoke test
echo "[setup] bash: $(bash --version | head -1)"
command -v tmux >/dev/null && echo "[setup] tmux: $(tmux -V)" || echo "[setup] WARN: tmux ausente"
command -v git >/dev/null  && echo "[setup] git:  $(git --version)" || echo "[setup] WARN: git ausente"

# Marca setup completo
touch "$RUNTIME/.setup-done"
echo "[setup] OK"
`;
  fs.writeFileSync(setupPath, content, 'utf8');
  return setupPath;
}

// ───────────────────────────────────────────────────────────────────────
// Helper: runSetupSh(runtimeHome) — invoca setup.sh dentro do bash embarcado.
// ───────────────────────────────────────────────────────────────────────
async function runSetupSh(runtimeHome) {
  const bash = resolveRuntimeBin(runtimeHome, [['msys64', 'usr', 'bin', 'bash.exe']]);
  if (!bash) throw new Error('RUNTIME_BASH_MISSING: bash não encontrado em ' + runtimeHome);
  const setupPath = path.join(runtimeHome, 'scripts', 'setup.sh');
  const winToPosix = (p) => {
    const m = p.match(/^([A-Za-z]):[\\/](.*)$/);
    if (!m) return p.replace(/\\/g, '/');
    return `/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}`;
  };
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      IMP_RUNTIME_HOME: runtimeHome,
      MSYSTEM: 'MSYS',
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8',
    };
    const proc = spawn(bash, ['-lc', winToPosix(setupPath)], {
      env, windowsHide: true, timeout: 60_000,
    });
    let stdout = '', stderr = '';
    proc.stdout && proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr && proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) {
        const err = new Error(`setup.sh falhou (exit ${code}): ${stderr.slice(0, 500)}`);
        err.code = code;
        err.stdout = stdout;
        err.stderr = stderr;
        return reject(err);
      }
      resolve({ ok: true, stdout, stderr });
    });
  });
}

// ───────────────────────────────────────────────────────────────────────
// Helper: ghAuthStatus(runtimeHome) — checa se gh já está logado.
// Usa o gh embarcado em runtime/gh ou no msys64 binPath.
// ───────────────────────────────────────────────────────────────────────
async function ghAuthStatus(runtimeHome) {
  const bash = resolveRuntimeBin(runtimeHome, [['msys64', 'usr', 'bin', 'bash.exe']]);
  if (!bash) return { logged_in: false, reason: 'bash missing' };
  return new Promise((resolve) => {
    const env = {
      ...process.env,
      IMP_RUNTIME_HOME: runtimeHome,
      MSYSTEM: 'MSYS',
      HOME: path.join(runtimeHome, 'home', os.userInfo().username || 'user'),
      PATH: [
        path.join(runtimeHome, 'msys64', 'usr', 'bin'),
        process.env.PATH || '',
      ].filter(Boolean).join(';'),
    };
    const proc = spawn(bash, ['-lc', 'gh auth status 2>&1 || true'], {
      env, windowsHide: true, timeout: 15_000,
    });
    let out = '';
    proc.stdout && proc.stdout.on('data', (d) => { out += d.toString(); });
    proc.stderr && proc.stderr.on('data', (d) => { out += d.toString(); });
    proc.on('error', () => resolve({ logged_in: false, reason: 'spawn error' }));
    proc.on('close', () => {
      resolve({ logged_in: /Logged in to github\.com/i.test(out), raw: out.slice(0, 300) });
    });
  });
}

// ───────────────────────────────────────────────────────────────────────
// STEPS — 5 novos. step_00 preflight é PRESERVADO (genérico).
// ───────────────────────────────────────────────────────────────────────

// -------- step 00 — preflight (PRESERVADO) --------------------------------
const step00Preflight = {
  id: 'step_00_preflight',
  title: 'Pré-flight (Windows / admin / disco / internet)',
  description: 'Confere Windows version, admin, disco, internet antes de copiar runtime.',
  category: 'AUTO',
  async detect(ctx) { return false; },
  async execute(ctx) {
    const r = await preflight.runAll({ logger: ctx.logger });
    ctx._preflight = r;
    if (!r.ok) {
      const msg = r.blocking.map(b => `${b.name}: ${b.detail}`).join('; ');
      throw new Error(`preflight bloqueante: ${msg}`);
    }
  },
  async validate(ctx) {
    return !!(ctx._preflight && ctx._preflight.ok);
  },
};

// -------- step_X1 — copyRuntime -------------------------------------------
const stepX1CopyRuntime = {
  id: 'step_x1_copy_runtime',
  title: 'Preparar runtime (copiar ~680 MB pra AppData)',
  description: 'Extrai runtime.7z embarcado pra %LOCALAPPDATA%\\IMP-Squad-Runtime\\<version>\\ e cria junction `current`.',
  category: 'AUTO',
  async detect(ctx) {
    const version = getRuntimeVersion();
    const versionDir = getRuntimeVersionDir(version);
    // Sucesso = bash + tmux + (node OU claude) presentes em versionDir
    const bash = resolveRuntimeBin(versionDir, [['msys64', 'usr', 'bin', 'bash.exe']]);
    const tmux = resolveRuntimeBin(versionDir, [['msys64', 'usr', 'bin', 'tmux.exe']]);
    if (!bash || !tmux) return false;
    // Marca state se detectou
    ctx.state.runtimeInstalled = true;
    ctx.state.runtimePath = versionDir;
    ctx.state.runtimeVersion = version;
    ctx.save && ctx.save();
    return true;
  },
  async execute(ctx) {
    const version = getRuntimeVersion();
    const versionDir = getRuntimeVersionDir(version);
    const runtimeRoot = getRuntimeRoot();

    // 1) Localiza arquivo embarcado
    const archive = findRuntimeArchive();
    if (!archive) {
      const err = new Error('RUNTIME_ARCHIVE_MISSING: runtime.7z não foi gerado. Rode scripts/build-runtime.ps1 primeiro.');
      err.code = 'RUNTIME_ARCHIVE_MISSING';
      throw err;
    }
    ctx.logger.info(this.id, `runtime archive localizado: ${archive}`);

    // 2) Pré-check espaço (Patrícia N3 + N8 — checa drive da PASTA DESTINO)
    fs.mkdirSync(runtimeRoot, { recursive: true });
    const space = await checkFreeSpace(runtimeRoot, MIN_FREE_GB);
    if (!space.ok) {
      const err = new Error(
        `RUNTIME_DISK_FULL: precisa de ${MIN_FREE_GB} GB livres em ${space.drive} (tem ${space.freeGb || '?'} GB)`
      );
      err.code = 'RUNTIME_DISK_FULL';
      throw err;
    }
    ctx.logger.info(this.id, `espaço OK em ${space.drive}: ${space.freeGb} GB livres`);

    // 3) Cria pasta da versão (não destrói se já existe — sobrescreve files)
    fs.mkdirSync(versionDir, { recursive: true });

    // 4) Extrai com progresso real → emite events
    const onProgress = (p) => {
      if (ctx.events && typeof ctx.events.onCopyRuntimeProgress === 'function') {
        try { ctx.events.onCopyRuntimeProgress(p); } catch (_) {}
      }
      if (p.phase === 'extracting' || p.phase === 'moving') {
        ctx.logger.info(this.id, `[${p.phase}] ${p.pct}%`);
      }
    };

    await copyRuntimeWithProgress(archive, versionDir, onProgress);

    // 5) Cria junction `current` → versionDir (Marcos §6)
    try {
      await createJunction(getRuntimeCurrentDir(), versionDir);
      ctx.logger.info(this.id, `junction current → ${version}`);
    } catch (e) {
      ctx.logger.warn(this.id, `junction falhou (não-fatal): ${e.message}`);
    }

    // 6) Grava state
    ctx.state.runtimeInstalled = true;
    ctx.state.runtimePath = versionDir;
    ctx.state.runtimeVersion = version;
    ctx.save && ctx.save();
  },
  async validate(ctx) {
    const version = getRuntimeVersion();
    const versionDir = getRuntimeVersionDir(version);
    const bash = resolveRuntimeBin(versionDir, [['msys64', 'usr', 'bin', 'bash.exe']]);
    const tmux = resolveRuntimeBin(versionDir, [['msys64', 'usr', 'bin', 'tmux.exe']]);
    if (!bash) {
      ctx.logger.warn(this.id, `bash ausente após extração — AV pode ter quarentenado`);
      return false;
    }
    if (!tmux) {
      ctx.logger.warn(this.id, `tmux ausente após extração — AV pode ter quarentenado`);
      return false;
    }
    // node E claude são checados em step_x2 (mais granular)
    return true;
  },
};

// -------- step_X2 — setupEnv ----------------------------------------------
const stepX2SetupEnv = {
  id: 'step_x2_setup_env',
  title: 'Configurar ambiente (HOME, AV exclusion, smoke runtime)',
  description: 'Roda setup.sh, detecta AV/AppLocker, oferece exclusion, valida tmux/git/node/claude.',
  category: 'HYBRID',
  async detect(ctx) {
    const version = ctx.state.runtimeVersion || getRuntimeVersion();
    const versionDir = ctx.state.runtimePath || getRuntimeVersionDir(version);
    const setupDone = path.join(versionDir, '.setup-done');
    try {
      return fs.existsSync(setupDone);
    } catch (_) { return false; }
  },
  async execute(ctx) {
    const version = ctx.state.runtimeVersion || getRuntimeVersion();
    const versionDir = ctx.state.runtimePath || getRuntimeVersionDir(version);

    // 1) Detecta AV
    ctx.logger.info(this.id, 'detectando antivírus...');
    const av = await detectAv();
    ctx.state.avDetected = av;
    ctx.save && ctx.save();
    ctx.logger.info(this.id,
      `AV: defender=${av.defender} realtime=${av.real_time_active} 3rd-party=${av.third_party_name || 'nenhum'}`
    );

    // 2) Se Defender ativo + real-time, emite event pra UI mostrar modal opcional
    if (av.defender && av.real_time_active && !av.exclusion_added) {
      if (ctx.events && typeof ctx.events.onNeedsAvExclusion === 'function') {
        try {
          ctx.events.onNeedsAvExclusion({
            folder: versionDir,
            defender: true,
            third_party_name: av.third_party_name,
          });
        } catch (_) {}
      }
      // NÃO bloqueia — exclusion é opcional. UI pode chamar installer:applyAvExclusion depois.
    }

    // 3) Detecta AppLocker (Patrícia N1)
    ctx.logger.info(this.id, 'detectando AppLocker...');
    const al = await detectAppLocker();
    ctx.state.appLockerDetected = { restrictive_policy: al.blocks_localappdata };
    ctx.save && ctx.save();
    if (al.blocks_localappdata) {
      ctx.logger.warn(this.id, 'AppLocker detectado bloqueando LOCALAPPDATA — emitindo event');
      if (ctx.events && typeof ctx.events.onAppLockerBlocked === 'function') {
        try {
          ctx.events.onAppLockerBlocked({
            folder: versionDir,
            raw_xml_excerpt: al.raw_xml ? al.raw_xml.slice(0, 800) : null,
          });
        } catch (_) {}
      }
      const err = new Error(`APPLOCKER_BLOCKED: AppLocker corporativo bloqueia execução em ${versionDir}. Veja sugestões no painel.`);
      err.code = 'APPLOCKER_BLOCKED';
      throw err;
    }

    // 4) Gera scripts wrapper (imp-squad.bat) + setup.sh
    writeImpSquadBat(versionDir);
    writeSetupSh(versionDir);

    // 5) Roda setup.sh
    ctx.logger.info(this.id, 'rodando setup.sh...');
    await runSetupSh(versionDir);

    // 6) Smoke runtime — bash, tmux, node, claude
    const bash = resolveRuntimeBin(versionDir, [['msys64', 'usr', 'bin', 'bash.exe']]);
    const tmux = resolveRuntimeBin(versionDir, [['msys64', 'usr', 'bin', 'tmux.exe']]);
    const nodeBin = resolveRuntimeBin(versionDir, RUNTIME_NODE_CANDIDATES);
    const claudeBin = resolveRuntimeBin(versionDir, RUNTIME_CLAUDE_CANDIDATES);

    if (!bash) {
      const err = new Error('AV_QUARANTINE: bash.exe ausente após setup. Antivírus pode ter removido.');
      err.code = 'AV_QUARANTINE';
      throw err;
    }
    if (!tmux) {
      const err = new Error('AV_QUARANTINE: tmux.exe ausente após setup. Antivírus pode ter removido.');
      err.code = 'AV_QUARANTINE';
      throw err;
    }
    if (!nodeBin) ctx.logger.warn(this.id, 'node.exe não encontrado no runtime — algumas funcionalidades podem quebrar');
    if (!claudeBin) ctx.logger.warn(this.id, 'claude.exe não encontrado no runtime — login Claude vai precisar instalação separada');

    ctx.logger.info(this.id, `runtime OK: bash=${path.basename(bash)} tmux=${path.basename(tmux)}`);
  },
  async validate(ctx) {
    const version = ctx.state.runtimeVersion || getRuntimeVersion();
    const versionDir = ctx.state.runtimePath || getRuntimeVersionDir(version);
    const setupDone = path.join(versionDir, '.setup-done');
    const bash = resolveRuntimeBin(versionDir, [['msys64', 'usr', 'bin', 'bash.exe']]);
    const tmux = resolveRuntimeBin(versionDir, [['msys64', 'usr', 'bin', 'tmux.exe']]);
    return fs.existsSync(setupDone) && !!bash && !!tmux;
  },
};

// -------- step_X3 — githubAuth (opcional, pulável) ------------------------
const stepX3GithubAuth = {
  id: 'step_x3_github_auth',
  title: 'Autenticar GitHub (opcional — pula se seed atualizado)',
  description: 'gh auth login --device-flow ou usa squad-seed pré-clonado.',
  category: 'MANUAL',
  manualInstructions: () => ({
    action: { label: 'Login GitHub (device-flow)', kind: 'none', payload: {} },
    steps: [
      { num: 1, text: 'O instalador já trouxe a squad pré-clonada — você PODE pular este passo' },
      { num: 2, text: 'Se quiser sincronizar com GitHub, abre um terminal e roda `gh auth login --web`' },
      { num: 3, text: 'Vai mostrar um código de 8 dígitos — copia, abre github.com/login/device e cola' },
      { num: 4, text: 'Volta aqui e clica "Verificar agora"' },
    ],
    note: 'Pode pular se você não vai puxar updates do squad por enquanto.',
    fallback: {
      title: 'Pular este passo',
      command: '(seed já tem squad pré-clonado)',
      steps: ['1. Clique "Pular" — squad funciona offline com o seed embarcado'],
    },
  }),
  async detect(ctx) {
    const version = ctx.state.runtimeVersion || getRuntimeVersion();
    const versionDir = ctx.state.runtimePath || getRuntimeVersionDir(version);
    // 1) Seed presente?
    const squadDir = path.join(versionDir, 'squad-seed', 'imp-squad');
    const seedPresent = fs.existsSync(squadDir) && fs.existsSync(path.join(squadDir, '_shared'));
    if (!seedPresent) return false;

    // 2) Seed recente (< 7 dias)? Checa mtime do _shared/REGRAS_GERAIS.md
    try {
      const regras = path.join(squadDir, '_shared', 'REGRAS_GERAIS.md');
      if (fs.existsSync(regras)) {
        const ageMs = Date.now() - fs.statSync(regras).mtimeMs;
        const ageDays = ageMs / (1000 * 60 * 60 * 24);
        if (ageDays < 7) {
          ctx.state.githubAuthMode = 'seed-only';
          ctx.save && ctx.save();
          return true;
        }
      }
    } catch (_) {}

    // 3) gh auth status já OK?
    const gh = await ghAuthStatus(versionDir);
    if (gh.logged_in) {
      ctx.state.githubAuthMode = 'device';
      ctx.save && ctx.save();
      return true;
    }
    return false;
  },
  async execute(ctx) {
    // Manual step — UI dispara terminal. Aqui só log + marca modo.
    ctx.logger.info(this.id, 'aguardando user clicar no botão (gh auth login --web ou Pular)');
    ctx.state.githubAuthMode = ctx.state.githubAuthMode || 'pending';
    ctx.save && ctx.save();
  },
  async validate(ctx) {
    return this.detect(ctx);
  },
};

// -------- step_X4 — launchTmux --------------------------------------------
const stepX4LaunchTmux = {
  id: 'step_x4_launch_tmux',
  title: 'Iniciar squad tmux (7 painéis claude)',
  description: 'Cria sessão tmux `imp` com 1 main + 6 personas (lider/arquiteto/criativo/debugger/qa/revisor).',
  category: 'AUTO',
  async detect(ctx) {
    const version = ctx.state.runtimeVersion || getRuntimeVersion();
    const versionDir = ctx.state.runtimePath || getRuntimeVersionDir(version);
    const bash = resolveRuntimeBin(versionDir, [['msys64', 'usr', 'bin', 'bash.exe']]);
    if (!bash) return false;
    // tmux has-session -t imp
    return new Promise((resolve) => {
      const winToPosix = (p) => {
        const m = p.match(/^([A-Za-z]):[\\/](.*)$/);
        if (!m) return p.replace(/\\/g, '/');
        return `/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}`;
      };
      const env = {
        ...process.env,
        IMP_RUNTIME_HOME: versionDir,
        MSYSTEM: 'MSYS',
        HOME: path.join(versionDir, 'home', os.userInfo().username || 'user'),
        PATH: [path.join(versionDir, 'msys64', 'usr', 'bin'), process.env.PATH || ''].filter(Boolean).join(';'),
      };
      const proc = spawn(bash, ['-lc',
        'tmux has-session -t imp 2>/dev/null && [ "$(tmux list-panes -t imp 2>/dev/null | wc -l)" -ge 7 ] && echo OK || echo MISSING'
      ], { env, windowsHide: true, timeout: 10_000 });
      let out = '';
      proc.stdout && proc.stdout.on('data', (d) => { out += d.toString(); });
      proc.on('error', () => resolve(false));
      proc.on('close', () => resolve(/OK/.test(out)));
    });
  },
  async execute(ctx) {
    const version = ctx.state.runtimeVersion || getRuntimeVersion();
    const versionDir = ctx.state.runtimePath || getRuntimeVersionDir(version);
    ctx.logger.info(this.id, 'criando sessão tmux imp com 7 painéis...');
    await launchTmuxSquadSession(versionDir, { timeout: 60_000 });
    ctx.logger.info(this.id, 'sessão tmux imp criada');
  },
  async validate(ctx) { return this.detect(ctx); },
};

// -------- step_X5 — desktopShortcut ---------------------------------------
const stepX5DesktopShortcut = {
  id: 'step_x5_desktop_shortcut',
  title: 'Atalho Desktop (IMP Squad.lnk)',
  description: 'Cria shortcut .lnk apontando pra imp-squad.bat — duplo-clique reabre a squad.',
  category: 'AUTO',
  async detect(ctx) {
    const desktop = path.join(os.homedir(), 'Desktop');
    const lnk = path.join(desktop, 'IMP Squad.lnk');
    const cmdFallback = path.join(desktop, 'IMP Squad.cmd');
    return fs.existsSync(lnk) || fs.existsSync(cmdFallback);
  },
  async execute(ctx) {
    const version = ctx.state.runtimeVersion || getRuntimeVersion();
    const versionDir = ctx.state.runtimePath || getRuntimeVersionDir(version);
    const batPath = path.join(versionDir, 'scripts', 'imp-squad.bat');

    // Garante que o bat existe (idempotência defensiva)
    if (!fs.existsSync(batPath)) {
      writeImpSquadBat(versionDir);
    }

    ctx.logger.info(this.id, `criando shortcut Desktop apontando pra ${batPath}`);
    const r = await createDesktopShortcut(batPath, 'IMP Squad');
    ctx.logger.info(this.id, `shortcut: ${r.raw}`);
  },
  async validate(ctx) { return this.detect(ctx); },
};

// ───────────────────────────────────────────────────────────────────────
// ALL_STEPS — ordem matters. step_00 primeiro, depois os 5 novos.
// ───────────────────────────────────────────────────────────────────────
const ALL_STEPS = [
  step00Preflight,
  stepX1CopyRuntime,
  stepX2SetupEnv,
  stepX3GithubAuth,
  stepX4LaunchTmux,
  stepX5DesktopShortcut,
];

module.exports = {
  ALL_STEPS,
  // Steps individuais (export pra tests poderem importar)
  step00Preflight,
  stepX1CopyRuntime,
  stepX2SetupEnv,
  stepX3GithubAuth,
  stepX4LaunchTmux,
  stepX5DesktopShortcut,
  // Helpers expostos pra main.js (applyAvExclusion handler) e tests
  copyRuntimeWithProgress,
  detectAv,
  detectAppLocker,
  addDefenderExclusion,
  launchTmuxSquadSession,
  createDesktopShortcut,
  createJunction,
  checkFreeSpace,
  writeImpSquadBat,
  writeSetupSh,
  ghAuthStatus,
  // Path helpers (Camila + main.js usam)
  getLocalAppData,
  getRuntimeRoot,
  getRuntimeVersionDir,
  getRuntimeCurrentDir,
  getRuntimeVersion,
  resolveRuntimeBin,
  findRuntimeArchive,
};
