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

async function relaunchAsAdmin(exePath) {
  try {
    const escaped = (exePath || '').replace(/'/g, "''");
    const cmd = `Start-Process -FilePath '${escaped}' -Verb RunAs`;
    // spawn em vez de execFile pra não esperar (Start-Process retorna rápido,
    // mas o UAC bloqueia o exit code se aguardar; melhor fire-and-forget)
    spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], {
      detached: true,
      stdio: 'ignore'
    }).unref();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
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
};
