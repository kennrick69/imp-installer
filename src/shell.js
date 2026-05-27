'use strict';

const { execFile, spawn } = require('node:child_process');
const { mask } = require('./logger');

// Default timeout (ms) for one-shot commands. Long ops (apt, npm, clone) override.
const DEFAULT_TIMEOUT = 120_000;
const DEFAULT_MAXBUF  = 50_000_000;

// --------- UTF-16LE mojibake fix for wsl.exe output (Patrícia #A4) ----------
// wsl.exe (legacy paths sem WSL_UTF8=1) emite stdout em UTF-16 LE; Node lê isso
// como string latin1/utf8 e a regex `/Default Version:\s*2/` nunca matcha
// porque cada char vem intercalado com \x00.
// Esta função detecta heuristicamente saídas com null bytes interleaved e
// re-decodifica como UTF-16 LE. Em saídas normais (UTF-8), passa direto.
function decodeWslOutput(buf) {
  if (buf == null) return '';
  // Caso 1: Buffer cru com null bytes nos índices ímpares (UTF-16 LE clássico).
  if (Buffer.isBuffer(buf)) {
    if (buf.length >= 2 && buf[1] === 0x00 && buf[3] === 0x00) {
      // Strip BOM se presente.
      const s = buf.toString('utf16le');
      return s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s;
    }
    return buf.toString('utf8');
  }
  // Caso 2: string já decodada como utf8/latin1 mas com null bytes intercalados.
  if (typeof buf === 'string') {
    // Heurística: se >20% dos chars são \x00, é UTF-16 LE lido como bytes.
    let nulls = 0;
    const sample = buf.slice(0, Math.min(200, buf.length));
    for (let i = 0; i < sample.length; i++) if (sample.charCodeAt(i) === 0) nulls++;
    if (sample.length > 0 && nulls / sample.length > 0.2) {
      const b = Buffer.from(buf, 'binary');
      const s = b.toString('utf16le');
      return s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s;
    }
    return buf;
  }
  return String(buf);
}

function execP(cmd, args, opts = {}) {
  const {
    timeout = DEFAULT_TIMEOUT,
    maxBuffer = DEFAULT_MAXBUF,
    input,
    env,
    cwd,
    logger,
    label,
  } = opts;

  // wsl.exe (e algumas vezes powershell encapsulando wsl --status) emite UTF-16 LE.
  // Pra fix #A4: sempre que rodarmos algo que possa ser wsl.exe ou um comando wsl
  // que retorne mojibake, passamos o stdout/stderr por decodeWslOutput antes.
  // Heurístico — não custa nada quando a saída já é UTF-8.
  const needsWslDecode = cmd === 'wsl.exe' || cmd === 'wsl'
    || (Array.isArray(args) && args.some(a => typeof a === 'string' && /\bwsl\b/i.test(a)));

  return new Promise((resolve, reject) => {
    if (logger) logger.debug('shell', `exec ${label || cmd} ${(args || []).join(' ')}`);
    const child = execFile(cmd, args, { timeout, maxBuffer, env, cwd, windowsHide: true },
      (err, stdout, stderr) => {
        const out = needsWslDecode ? decodeWslOutput(stdout) : (stdout || '');
        const errOut = needsWslDecode ? decodeWslOutput(stderr) : (stderr || '');
        const result = { stdout: out, stderr: errOut, code: err ? (err.code ?? 1) : 0 };
        if (err) {
          err.stdout = result.stdout;
          err.stderr = result.stderr;
          if (logger) logger.warn('shell', `exit ${err.code} ${label || cmd}: ${mask((result.stderr || err.message || '').slice(0, 400))}`);
          return reject(err);
        }
        if (logger && (out || errOut)) {
          const preview = mask(((out || '') + (errOut ? '\n' + errOut : '')).slice(0, 400));
          logger.debug('shell', `ok ${label || cmd}: ${preview}`);
        }
        resolve(result);
      });
    if (input != null && child.stdin) {
      try { child.stdin.end(input); } catch (_) {}
    }
  });
}

// ───────────────────────────────────────────────────────────────────────
// wslExec — chamada DIRETA ao wsl.exe (sem PowerShell wrapper) com decode
// hard-coded de UTF-16 LE no buffer cru.
//
// Bruno v0.2.12 (live-test JOs em v0.2.11):
// Mesmo após `chcp 65001` na sessão PowerShell, o binário wsl.exe segue
// emitindo stdout em UTF-16 LE — é como ele foi compilado. Quando passamos
// `powershell -Command "wsl --install -d Ubuntu-22.04"`, o PS lê o stdout
// do wsl como bytes brutos e re-emite, ainda em UTF-16 (mojibake garantido:
// "distribuiýýo", "Parýmetro").
//
// Solução: spawn wsl.exe DIRETAMENTE (sem PS no meio), capturar Buffer cru
// e decodificar como UTF-16 LE quando heurística detecta. Resultado: texto
// limpo, regex de detecção funciona, mensagens de erro legíveis.
//
// Heurística de detecção: byte[1] === 0x00 → UTF-16 LE (caractere ASCII
// em UTF-16 ocupa 2 bytes, sendo o segundo 0x00). Em saídas UTF-8 normais
// o byte[1] raramente é zero.
//
// Retorna shape unificado: { exit_code, stdout, stderr } (snake_case proposital
// pra distinguir do shape do execP que usa `code`).
function wslExec(args, opts = {}) {
  const { timeout = 30_000, env, logger, label } = opts;
  const mergedEnv = { ...(process.env || {}), ...(env || {}), WSL_UTF8: '1' };
  return new Promise((resolve) => {
    if (logger) logger.debug('shell', `wslExec ${label || ''} wsl.exe ${(args || []).join(' ')}`);
    let ps;
    try {
      ps = spawn('wsl.exe', args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env: mergedEnv,
      });
    } catch (err) {
      return resolve({ exit_code: -1, stdout: '', stderr: `spawn falhou: ${err.message}` });
    }

    const stdoutBufs = [];
    const stderrBufs = [];
    ps.stdout.on('data', (b) => stdoutBufs.push(b));
    ps.stderr.on('data', (b) => stderrBufs.push(b));

    const to = setTimeout(() => {
      try { ps.kill(); } catch (_) {}
    }, timeout);

    ps.on('error', (err) => {
      clearTimeout(to);
      resolve({ exit_code: -1, stdout: '', stderr: err.message });
    });

    ps.on('close', (code) => {
      clearTimeout(to);
      const rawOut = Buffer.concat(stdoutBufs);
      const rawErr = Buffer.concat(stderrBufs);

      // Detecta UTF-16 LE: byte 1 (e idealmente byte 3) === 0x00.
      const isUtf16 = (buf) =>
        buf.length >= 2 && buf[1] === 0x00 && (buf.length < 4 || buf[3] === 0x00);

      const stripBom = (s) => (s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s);

      const stdout = rawOut.length === 0
        ? ''
        : (isUtf16(rawOut) ? stripBom(rawOut.toString('utf16le')) : rawOut.toString('utf8'));
      const stderr = rawErr.length === 0
        ? ''
        : (isUtf16(rawErr) ? stripBom(rawErr.toString('utf16le')) : rawErr.toString('utf8'));

      if (logger) {
        const preview = mask((stdout + (stderr ? '\n' + stderr : '')).slice(0, 400));
        logger.debug('shell', `wslExec exit=${code} ${label || ''}: ${preview}`);
      }
      resolve({
        exit_code: code,
        stdout: (stdout || '').trim(),
        stderr: (stderr || '').trim(),
      });
    });
  });
}

// PowerShell wrapper. Runs with -NoProfile to avoid user profile side effects.
// Injeta WSL_UTF8=1 (suportado em wsl.exe ≥ 0.64) — força saída UTF-8 plain
// quando o script chamar `wsl --status`/`wsl -l -v` por dentro do PS. Defesa
// em profundidade pro fix #A4 (decodeWslOutput cobre o resto).
function powershell(script, opts = {}) {
  const env = { ...(process.env || {}), ...(opts.env || {}), WSL_UTF8: '1' };
  return execP('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { timeout: 300_000, ...opts, env });
}

// Run a bash command inside WSL (login shell so nvm/PATH from ~/.bashrc are loaded).
// Defaults to the default distro; pass opts.distro to target a specific one.
function wsl(bashCmd, opts = {}) {
  const distro = opts.distro || process.env.IMP_DISTRO || 'Ubuntu-22.04';
  const user = opts.user;
  const args = ['-d', distro];
  if (user) args.push('-u', user);
  args.push('--', 'bash', '-lc', bashCmd);
  // WSL_UTF8=1 vai no env do wsl.exe (versão >=0.64). decodeWslOutput cobre o resto.
  const env = { ...(process.env || {}), ...(opts.env || {}), WSL_UTF8: '1' };
  return execP('wsl.exe', args, { timeout: 300_000, ...opts, env, label: opts.label || 'wsl' });
}

// Sudo inside WSL. Uses `sudo -n` first; if that fails (NEEDS_PASSWORD),
// it awaits `passwordPromise` (resolved by the wizard UI) and pipes via `sudo -S`.
// passwordPromise: () => Promise<string>  — lazy on purpose; we only ask if needed.
async function sudoInWsl(bashCmd, opts = {}) {
  const { passwordPromise, logger } = opts;

  // First: try passwordless.
  try {
    const r = await wsl(`sudo -n bash -lc ${shSingleQuote(bashCmd)}`, { ...opts, label: 'sudo-n' });
    return r;
  } catch (err) {
    // Detect "password required" — sudo prints "a password is required" or "sudo: a terminal is required"
    const stderr = (err.stderr || '').toLowerCase();
    const needsPass = stderr.includes('password is required')
                   || stderr.includes('a terminal is required')
                   || stderr.includes('no tty')
                   || /^\s*sudo:/m.test(err.stderr || '');
    if (!needsPass) throw err;
    if (typeof passwordPromise !== 'function') {
      if (logger) logger.error('shell', 'sudo precisa de senha mas nenhum passwordPromise foi fornecido');
      throw new Error('sudo: senha exigida e UI não forneceu passwordPromise');
    }
  }

  // Ask UI for password (lazy).
  const pass = await passwordPromise();
  if (!pass) throw new Error('sudo: senha vazia');

  // sudo -S reads password from stdin. We pass via execFile input + a wrapper
  // that pipes via printf to avoid leaving the password in argv.
  // Strategy: spawn `wsl ... bash -lc 'sudo -S -p "" bash -lc "<cmd>"'` and write `pass\n` to stdin.
  const distro = opts.distro || process.env.IMP_DISTRO || 'Ubuntu-22.04';
  const user = opts.user;
  const args = ['-d', distro];
  if (user) args.push('-u', user);
  args.push('--', 'bash', '-lc', `sudo -S -p "" bash -lc ${shSingleQuote(bashCmd)}`);
  const sudoEnv = { ...(process.env || {}), ...(opts.env || {}), WSL_UTF8: '1' };
  return execP('wsl.exe', args, {
    ...opts,
    env: sudoEnv,
    input: pass + '\n',
    label: 'sudo-S',
  });
}

// Open an interactive Windows Terminal (or fallback) running a bash command.
// Used for `claude login` and `gh auth login --web`.
//
// Patrícia HIGH #8: a versão anterior resolvia a Promise em DOIS caminhos
// (linha final incondicional + fallback dentro do on('error')). Pior — também
// "rejeitava" no fallback.on('error') mesmo após resolver. Resultado: handler
// SEMPRE retornava {ok:true} mesmo quando wt.exe falhava E o fallback
// cmd /c start nem tinha conseguido executar. step_09 (claude login) e
// step_10 (gh login) ficavam esperando 15min de polling silenciosamente
// porque o terminal não tinha aberto de verdade.
//
// Fix: flag `resolved` única; ESPERA o `spawn` real disparar antes de
// resolver com sucesso (`on('spawn')`); fallback é tentado quando wt falha
// e ele também só resolve no `on('spawn')` dele; se AMBOS falham, resolve
// UMA vez com {ok:false, error}.
function openInteractiveTerminal(bashCmd, opts = {}) {
  const distro = opts.distro || process.env.IMP_DISTRO || 'Ubuntu-22.04';
  const title = opts.title || 'IMP installer';
  return new Promise((resolve) => {
    let resolved = false;
    const done = (payload) => {
      if (resolved) return;
      resolved = true;
      resolve(payload);
    };

    const trailing = `${bashCmd}; ec=$?; echo ""; echo "[IMP] terminei (exit $ec). Pressione Enter pra fechar."; read`;
    const wtArgs = [
      'new-tab', '--profile', distro, '--title', title,
      'wsl.exe', '-d', distro, '--', 'bash', '-lc', trailing,
    ];

    let child;
    try {
      child = spawn('wt.exe', wtArgs, { detached: true, stdio: 'ignore', windowsHide: false });
    } catch (e) {
      // spawn síncrono falhou — vai direto pro fallback.
      return tryFallback(e);
    }

    child.on('spawn', () => {
      // wt.exe abriu — sucesso real.
      try { child.unref(); } catch (_) {}
      done({ stdout: '', stderr: '', code: 0 });
    });
    child.on('error', (err) => {
      // wt.exe não pôde iniciar (ex.: Windows Terminal não instalado).
      tryFallback(err);
    });

    function tryFallback(wtErr) {
      if (resolved) return;
      let fallback;
      try {
        fallback = spawn('cmd.exe',
          ['/c', 'start', '""', 'wsl.exe', '-d', distro, '--', 'bash', '-lc', trailing],
          { detached: true, stdio: 'ignore' });
      } catch (e) {
        return done({ ok: false, stdout: '', stderr: '', code: 1, error: `wt: ${wtErr && wtErr.message}; cmd: ${e && e.message}` });
      }
      fallback.on('spawn', () => {
        try { fallback.unref(); } catch (_) {}
        done({ stdout: '', stderr: '', code: 0, fallback: true });
      });
      fallback.on('error', (e) => {
        done({ ok: false, stdout: '', stderr: '', code: 1, error: `wt: ${wtErr && wtErr.message}; cmd: ${e && e.message}` });
      });
    }
  });
}

// Retry wrapper with explicit backoff schedule (in seconds, per Patricia's spec).
async function withRetry(fn, opts = {}) {
  const {
    label = 'op',
    attempts = 3,
    backoff = [2, 8, 30],
    onRetry,
    logger,
    shouldRetry, // optional predicate (err) => boolean
  } = opts;
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (shouldRetry && !shouldRetry(err)) throw err;
      const delay = (backoff[i] ?? backoff[backoff.length - 1] ?? 5) * 1000;
      if (logger) logger.warn('retry', `${label} falhou (tentativa ${i + 1}/${attempts}): ${mask((err.stderr || err.message || '').slice(0, 200))}. Esperando ${delay}ms.`);
      if (typeof onRetry === 'function') {
        try { onRetry({ attempt: i + 1, error: err, nextDelayMs: delay }); } catch (_) {}
      }
      if (i < attempts - 1) await new Promise(r => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

// Safely embed an arbitrary string inside single-quotes for bash.
function shSingleQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

// ───────────────────────────────────────────────────────────────────────
// Admin elevation helpers (Bruno — live-test #3, v0.2.4 -> v0.2.5)
//
// Os steps 01 (dism enable-feature), 02 (wsl --set-default-version 2) e
// 03 (wsl --install) EXIGEM token de admin no processo Windows. Os steps
// 04-16 rodam dentro do WSL via `wsl bash -lc`, então NÃO precisam admin
// Windows (no máximo precisam sudo Linux, que já temos via sudoInWsl).
//
// isElevated() — pergunta ao PowerShell se o processo atual está em
//   role Administrator. Retorna boolean.
// relaunchAsAdmin(exePath) — dispara um Start-Process -Verb RunAs num
//   PowerShell separado. Fire-and-forget: o UAC popup aparece, e quando
//   o user clica "Sim" o EXE reabre elevado. O processo original deve
//   chamar app.quit() logo depois (main.js cuida).
// ───────────────────────────────────────────────────────────────────────
async function isElevated() {
  try {
    const r = await powershell(
      `([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)`,
      { timeout: 5000 }
    );
    return /true/i.test(r.stdout || '');
  } catch (_) {
    return false;
  }
}

// relaunchAsAdmin — Bruno live-test v0.2.5 → v0.2.6
//
// CAUSA RAIZ (confirmada via doc electron-builder + repro JOs):
// O .exe portable do electron-builder, ao ser duplo-clicado, EXTRAI o app
// em `%TEMP%\<random>\IMP Squad Instalador.exe` e roda dali. `process.execPath`
// aponta pra ESSE temp — NÃO pro .exe portable que JOs tem no Desktop.
// Ao chamar `Start-Process -Verb RunAs $tempExe`:
//   - O temp some quando o pai morre (limpeza do portable wrapper)
//   - Windows pode rejeitar elevar exe em pasta temporária
//   - Resultado: UAC NÃO aparece e o processo elevado nasce zumbi.
//
// Fix: usar `process.env.PORTABLE_EXECUTABLE_FILE` — env var setada pelo
// electron-builder portable que aponta pro PATH ORIGINAL do .exe
// (documentado em https://www.electron.build/configuration/nsis#portable).
// Em dev (`electron .`) essa var NÃO existe, então cai no fallback execPath.
//
// Também — substituímos `spawn detached + unref` (que engolia stderr e fazia
// quit silencioso) por `spawn` com pipe de stdout/stderr e PROMISE que só
// resolve quando o PowerShell fecha (com sucesso ou erro detectável).
async function relaunchAsAdmin(opts = {}) {
  const fs = require('node:fs');
  const pathMod = require('node:path');
  const os = require('node:os');

  // PORTABLE_EXECUTABLE_FILE é env var setada pelo electron-builder portable
  // apontando pro .exe ORIGINAL (não o extraído em %TEMP%). Em dev não existe.
  const portableExe = process.env.PORTABLE_EXECUTABLE_FILE;
  const fallbackExe = (opts && opts.exePath) || process.execPath;
  const target = portableExe || fallbackExe;

  // Log diagnóstico EM ARQUIVO pra capturar falha silenciosa
  // (JOs pode mandar esse log se UAC não aparecer).
  const logFile = pathMod.join(
    os.homedir(),
    '.imp-installer',
    'logs',
    `elevate-${Date.now()}.log`
  );
  try { fs.mkdirSync(pathMod.dirname(logFile), { recursive: true }); } catch (_) {}
  const log = (msg) => {
    try { fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${msg}\n`); } catch (_) {}
  };
  log(`relaunchAsAdmin called. portableExe=${portableExe || '(undefined)'}, execPath=${fallbackExe}, target=${target}`);

  if (!target || !fs.existsSync(target)) {
    log(`target não existe no FS — abortando`);
    return { ok: false, error: 'caminho do .exe não encontrado pra elevar', target, logFile };
  }

  // Comando PowerShell que dispara UAC. -PassThru retorna o Process pra
  // saber se foi spawnado. Capturamos stderr pra detectar falha.
  // -Verb RunAs faz o UAC popup aparecer.
  const escapedTarget = target.replace(/'/g, "''");
  const psCmd = `try {
    $p = Start-Process -FilePath '${escapedTarget}' -Verb RunAs -PassThru -ErrorAction Stop;
    if ($p) { Write-Output "SPAWNED:$($p.Id)" } else { Write-Output 'SPAWN_NO_PROCESS' }
  } catch {
    Write-Error "UAC_FAILED:$($_.Exception.Message)"
    exit 1
  }`;

  return new Promise((resolve) => {
    const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psCmd], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    let stdout = '', stderr = '';
    ps.stdout.on('data', (d) => { stdout += d.toString(); });
    ps.stderr.on('data', (d) => { stderr += d.toString(); });
    ps.on('error', (err) => {
      log(`spawn error: ${err.message}`);
      resolve({ ok: false, error: 'spawn falhou: ' + err.message, target, logFile });
    });
    ps.on('close', (code) => {
      log(`powershell closed code=${code} stdout=${stdout.trim()} stderr=${stderr.trim()}`);
      if (code === 0 && stdout.includes('SPAWNED:')) {
        const pidMatch = stdout.match(/SPAWNED:(\d+)/);
        const elevatedPid = pidMatch ? parseInt(pidMatch[1], 10) : null;
        resolve({ ok: true, elevatedPid, target, logFile });
      } else if (stderr.includes('UAC_FAILED') || /cancel[ae]d|cancelad[ao]/i.test(stderr)) {
        // Usuário negou UAC ou outra falha. Windows retorna
        // EN: "The operation was canceled by the user"
        // pt-BR: "A operação foi cancelada pelo usuário"
        // pt-PT: "Operação cancelada pelo utilizador"
        // (Fix Eduardo v0.2.6 #1: regex cobre pt-BR/pt-PT também.)
        const userCancelledPattern = /(canceled|cancelled) by the user|cancelad[ao] pel[oa] (usuário|utilizador)/i;
        const reason = userCancelledPattern.test(stderr) ? 'UAC_CANCELLED' : 'UAC_FAILED';
        resolve({ ok: false, error: reason, stderr: stderr.trim(), target, logFile });
      } else {
        resolve({
          ok: false,
          error: `falha desconhecida (code=${code})`,
          stderr: stderr.trim(),
          stdout: stdout.trim(),
          target,
          logFile,
        });
      }
    });
  });
}

// ───────────────────────────────────────────────────────────────────────
// detectWslState — classifica o WSL em 3 estados pra decisão de install.
//
// Bruno (noturna 2026-05-27): a v0.2.16 confiava em `wsl --status` pra
// dizer se está funcional, mas no LEGACY o `wsl.exe` ignora --status e
// cospe a tela de help. Precisamos CLASSIFICAR explicitamente os 3
// estados ANTES de decidir caminho de instalação.
//
// Estados:
//   'absent'  → wsl.exe não existe (Get-Command retorna null)
//   'legacy'  → binário inbox Windows 10 antigo (não tem --version/--status)
//   'modern'  → binário moderno (MSI/Store/winget) — responde --version
//
// Retorna: { state, evidence, exePath }
async function detectWslState(opts = {}) {
  const { logger } = opts;
  const evidence = {};
  let exePath = '';

  // 1) Binário existe?
  try {
    const r = await execP('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command',
       `Get-Command wsl.exe -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source`],
      { timeout: 5000 });
    exePath = ((r && r.stdout) || '').trim();
    evidence.getCommand = { exePath };
  } catch (e) {
    evidence.getCommand = { error: e.message };
    if (logger) logger.info('detectWslState', `absent (Get-Command falhou: ${e.message})`);
    return { state: 'absent', evidence, exePath: '' };
  }
  if (!exePath) {
    if (logger) logger.info('detectWslState', 'absent (wsl.exe não encontrado no PATH)');
    return { state: 'absent', evidence, exePath: '' };
  }

  // 2) wsl --version (só MODERN responde com texto válido)
  const versionR = await wslExec(['--version'], { timeout: 8000, logger });
  evidence.version = {
    exit: versionR.exit_code,
    stdoutSample: (versionR.stdout || '').slice(0, 200),
  };
  if (versionR.exit_code === 0 &&
      /WSL\s+vers[aã]o|WSL\s+version|kernel\s+vers/i.test(versionR.stdout || '')) {
    if (logger) logger.info('detectWslState', `modern (sinal: wsl --version OK)`);
    return { state: 'modern', evidence, exePath };
  }

  // 3) Fallback --status (também só responde válido em moderno)
  const statusR = await wslExec(['--status'], { timeout: 8000, logger });
  evidence.status = {
    exit: statusR.exit_code,
    stdoutSample: (statusR.stdout || '').slice(0, 200),
  };
  const out = statusR.stdout || '';
  const isHelpEcho =
    /Usage:|Uso:|Copyright.*Microsoft.*Windows Subsystem.*Linux/i.test(out) ||
    (/--install/i.test(out) && /--list/i.test(out) && /--status/i.test(out));
  if (statusR.exit_code === 0 && !isHelpEcho &&
      /Default\s+(Distribution|Version)|Distribu[ií][cç][aã]o\s+padr|Vers[aã]o\s+padr/i.test(out)) {
    if (logger) logger.info('detectWslState', `modern (sinal: wsl --status mostra default)`);
    return { state: 'modern', evidence, exePath };
  }

  // 4) Binário existe mas não responde --version nem --status → LEGACY (inbox)
  if (logger) logger.info('detectWslState', `legacy (binário existe mas não responde flags modernas)`);
  return { state: 'legacy', evidence, exePath };
}

// ───────────────────────────────────────────────────────────────────────
// installWslModernViaMsi — baixa+instala MSI WSL moderno do GitHub Microsoft.
//
// Bruno (noturna 2026-05-27): Win10 19045 com inbox legacy não suporta
// `wsl --update` (descartado), Store appx exige conta MS (descartado),
// `wsl --install` do inbox ignora --no-launch (não-confiável). MSI é o
// caminho programático mais confiável.
//
// Estratégia:
//   1) GitHub API resolve URL do MSI x64 latest
//   2) Invoke-WebRequest com TLS 1.2 forçado (Win10 antigo)
//   3) Start-Process msiexec /qn /norestart, exit 3010 = sucesso+reboot
//
// Pré-req: features Windows (Subsystem-Linux + VirtualMachinePlatform) já
// habilitadas. Caller (executors.js) garante via ensureFeatures().
//
// Retorna: { ok, version, exitCode, msiPath, rebootRequired, error? }
async function installWslModernViaMsi(opts = {}) {
  const { logger, timeout = 600_000, onProgress } = opts;
  // Eduardo lastmile v0.2.17: emite onProgress pra UI mostrar tela #screen-wsl-upgrade
  // com barra real. Sem isso, JOs vê tela genérica "processando" por 5-10min e fecha
  // achando que travou (exata reincidência live-test anterior).
  const emit = (stage, pct, detail, logLine) => {
    if (typeof onProgress === 'function') {
      try { onProgress({ stage, pct, detail, logLine }); } catch (_) {}
    }
    if (logger) logger.info('installWslModernViaMsi', `${stage} ${pct != null ? '('+pct+'%)' : ''} ${detail || ''}`);
  };
  emit('init', 0, 'Iniciando atualização do WSL...');
  const psScript = `
    $ErrorActionPreference = 'Stop'
    chcp 65001 > $null
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $api = 'https://api.github.com/repos/microsoft/WSL/releases/latest'
    $headers = @{ 'User-Agent' = 'imp-installer'; 'Accept' = 'application/vnd.github+json' }
    $rel = Invoke-RestMethod -Uri $api -Headers $headers -TimeoutSec 30
    $arch = if ([Environment]::Is64BitOperatingSystem) { 'x64' } else { 'arm64' }
    $asset = $rel.assets | Where-Object { $_.name -match ('\\.' + $arch + '\\.msi$') } | Select-Object -First 1
    if (-not $asset) { throw "Nenhum MSI $arch na release $($rel.tag_name)" }
    $ts = [int][double]::Parse((Get-Date -UFormat %s))
    $msiPath = Join-Path $env:TEMP ('wsl_msi_' + $ts + '_' + $asset.name)
    Write-Output ("VERSION=" + $rel.tag_name)
    Write-Output ("URL=" + $asset.browser_download_url)
    Write-Output ("MSI=" + $msiPath)
    Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $msiPath -UseBasicParsing
    $proc = Start-Process msiexec.exe -ArgumentList ('/i', ('"' + $msiPath + '"'), '/qn', '/norestart') -Wait -PassThru
    Write-Output ("EXIT=" + $proc.ExitCode)
    if ($proc.ExitCode -ne 0 -and $proc.ExitCode -ne 3010) {
      throw ("msiexec falhou exit=" + $proc.ExitCode)
    }
  `;
  try {
    emit('downloading', 10, 'Consultando catálogo Microsoft...');
    const r = await powershell(psScript, { timeout });
    const out = (r && r.stdout) || '';
    const version = (out.match(/VERSION=(\S+)/) || [])[1] || '?';
    const msiPath = (out.match(/MSI=(.+?)(?:\r|\n|$)/) || [])[1] || '';
    const exitCode = parseInt((out.match(/EXIT=(\d+)/) || [])[1] || '0', 10);
    const rebootRequired = exitCode === 3010;
    emit('done', 100, `WSL ${version} instalado (exit=${exitCode}${rebootRequired ? ', reboot pendente' : ''})`);
    return { ok: true, version, exitCode, msiPath, rebootRequired };
  } catch (e) {
    const stdout = (e.stdout || '').trim();
    const stderr = (e.stderr || '').trim();
    const exitMatch = stdout.match(/EXIT=(\d+)/);
    const exitCode = exitMatch ? parseInt(exitMatch[1], 10) : (e.code != null ? e.code : -1);
    if (exitCode === 3010) {
      // Falsa-falha — 3010 é sucesso-com-reboot.
      const version = (stdout.match(/VERSION=(\S+)/) || [])[1] || '?';
      const msiPath = (stdout.match(/MSI=(.+?)(?:\r|\n|$)/) || [])[1] || '';
      if (logger) logger.info('installWslModernViaMsi', `MSI ${version} sucesso 3010 (reboot pendente)`);
      return { ok: true, version, exitCode: 3010, msiPath, rebootRequired: true };
    }
    if (logger) logger.error('installWslModernViaMsi',
      `falhou: exit=${exitCode} stderr=${stderr.slice(0, 300)} stdout=${stdout.slice(0, 300)}`);
    return {
      ok: false,
      exitCode,
      error: e.message || `MSI install exit=${exitCode}`,
      stderr,
      stdout,
    };
  }
}

// ───────────────────────────────────────────────────────────────────────
// forceRebootWindows — agenda reboot em N segundos com mensagem amigável.
//
// Bruno (noturna 2026-05-27): JOs autorizou reboot forçado durante missões.
// shutdown /r /t <delay> /c "<reason>" /f /d p:4:1
//   /r  = reinicia (não shutdown)
//   /t  = delay em segundos
//   /c  = comentário (até 512 chars)
//   /f  = força fechar apps abertos
//   /d p:4:1 = motivo "Application: Maintenance (Planned)"
//
// Retorna: { ok, delaySeconds, error? }
async function forceRebootWindows(opts = {}) {
  const { delaySeconds = 30, reason = 'Reinício agendado pelo Instalador IMP — salve seu trabalho', logger } = opts;
  try {
    await execP('shutdown.exe',
      ['/r', '/t', String(delaySeconds), '/c', reason, '/f', '/d', 'p:4:1'],
      { timeout: 10_000, label: 'shutdown /r' });
    if (logger) logger.info('forceRebootWindows', `reboot agendado em ${delaySeconds}s — motivo: ${reason}`);
    return { ok: true, delaySeconds };
  } catch (e) {
    if (logger) logger.error('forceRebootWindows', `falhou: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

// cancelReboot — cancela reboot pendente (shutdown /a).
async function cancelReboot(opts = {}) {
  const { logger } = opts;
  try {
    await execP('shutdown.exe', ['/a'], { timeout: 10_000, label: 'shutdown /a' });
    if (logger) logger.info('cancelReboot', 'reboot cancelado');
    return { ok: true };
  } catch (e) {
    // Exit 1116 = "Não foi possível anular o desligamento porque não havia desligamento em andamento"
    // — não é erro pra nós.
    if (logger) logger.info('cancelReboot', `shutdown /a retornou: ${e.message}`);
    return { ok: true, noPending: true, info: e.message };
  }
}

// Schedule the .exe to relaunch via HKCU\...\RunOnce after reboot.
// RunOnce auto-clears its entry on first run, so this is naturally idempotent.
//
// Eduardo 4.5 (nit): passamos exePath via -ArgumentList em vez de interpolar
// dentro do script PS — assim caracteres especiais no path (quotes, etc.) não
// quebram a string PS. O script lê via $args[0].
function scheduleRunOnceAfterReboot(exePath, opts = {}) {
  const name = opts.name || 'IMP-Installer-Resume';
  const script = `
    param($Exe, $Name)
    if (-not (Test-Path $Exe)) { throw "Executável não encontrado: $Exe" }
    $key = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce'
    New-Item -Path $key -Force | Out-Null
    Set-ItemProperty -Path $key -Name $Name -Value ('"' + $Exe + '" --resume')
  `;
  // execP usa execFile; passamos args sem interpolação. -Command bloco recebe
  // $args[0], $args[1] via param().
  return execP('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-Command', script,
    '-Exe', exePath,
    '-Name', name,
  ], { timeout: 60_000, ...opts, label: 'scheduleRunOnce' });
}

module.exports = {
  execP,
  powershell,
  wsl,
  sudoInWsl,
  openInteractiveTerminal,
  withRetry,
  shSingleQuote,
  scheduleRunOnceAfterReboot,
  decodeWslOutput,
  isElevated,
  relaunchAsAdmin,
  wslExec,
  // Bruno (noturna 2026-05-27) — fluxo WSL legacy→moderno
  detectWslState,
  installWslModernViaMsi,
  forceRebootWindows,
  cancelReboot,
};
