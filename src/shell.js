'use strict';

const { execFile, spawn } = require('node:child_process');
const { mask } = require('./logger');

// Default timeout (ms) for one-shot commands. Long ops (apt, npm, clone) override.
const DEFAULT_TIMEOUT = 120_000;
const DEFAULT_MAXBUF  = 50_000_000;

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

  return new Promise((resolve, reject) => {
    if (logger) logger.debug('shell', `exec ${label || cmd} ${(args || []).join(' ')}`);
    const child = execFile(cmd, args, { timeout, maxBuffer, env, cwd, windowsHide: true },
      (err, stdout, stderr) => {
        const result = { stdout: stdout || '', stderr: stderr || '', code: err ? (err.code ?? 1) : 0 };
        if (err) {
          err.stdout = result.stdout;
          err.stderr = result.stderr;
          if (logger) logger.warn('shell', `exit ${err.code} ${label || cmd}: ${mask((stderr || err.message || '').slice(0, 400))}`);
          return reject(err);
        }
        if (logger && (stdout || stderr)) {
          const preview = mask(((stdout || '') + (stderr ? '\n' + stderr : '')).slice(0, 400));
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
function powershell(script, opts = {}) {
  return execP('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { timeout: 300_000, ...opts });
}

// Run a bash command inside WSL (login shell so nvm/PATH from ~/.bashrc are loaded).
// Defaults to the default distro; pass opts.distro to target a specific one.
function wsl(bashCmd, opts = {}) {
  const distro = opts.distro || process.env.IMP_DISTRO || 'Ubuntu-22.04';
  const user = opts.user;
  const args = ['-d', distro];
  if (user) args.push('-u', user);
  args.push('--', 'bash', '-lc', bashCmd);
  return execP('wsl.exe', args, { timeout: 300_000, ...opts, label: opts.label || 'wsl' });
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
  return execP('wsl.exe', args, {
    ...opts,
    input: pass + '\n',
    label: 'sudo-S',
  });
}

// Open an interactive Windows Terminal (or fallback) running a bash command.
// Used for `claude login` and `gh auth login --web`.
function openInteractiveTerminal(bashCmd, opts = {}) {
  const distro = opts.distro || process.env.IMP_DISTRO || 'Ubuntu-22.04';
  const title = opts.title || 'IMP installer';
  // wt.exe inherits no profile if --profile is missing; we set explicitly.
  // Spawn detached so the installer process doesn't block on the terminal.
  return new Promise((resolve, reject) => {
    const trailing = `${bashCmd}; ec=$?; echo ""; echo "[IMP] terminei (exit $ec). Pressione Enter pra fechar."; read`;
    const wtArgs = [
      'new-tab', '--profile', distro, '--title', title,
      'wsl.exe', '-d', distro, '--', 'bash', '-lc', trailing,
    ];
    const child = spawn('wt.exe', wtArgs, { detached: true, stdio: 'ignore', windowsHide: false });
    child.on('error', () => {
      // Fallback: spawn wsl.exe directly with cmd /c start to get a console window.
      const fallback = spawn('cmd.exe', ['/c', 'start', '""', 'wsl.exe', '-d', distro, '--', 'bash', '-lc', trailing],
        { detached: true, stdio: 'ignore' });
      fallback.on('error', reject);
      fallback.unref();
      resolve({ stdout: '', stderr: '', code: 0, fallback: true });
    });
    child.unref();
    // We don't await terminal close — UI will poll the validate() callback.
    resolve({ stdout: '', stderr: '', code: 0 });
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

// Schedule the .exe to relaunch via HKCU\...\RunOnce after reboot.
// RunOnce auto-clears its entry on first run, so this is naturally idempotent.
function scheduleRunOnceAfterReboot(exePath, opts = {}) {
  const name = opts.name || 'IMP-Installer-Resume';
  // Use single-quotes around path for PS to tolerate spaces.
  const script = `
    $exe = '${exePath.replace(/'/g, "''")}'
    if (-not (Test-Path $exe)) { throw "Executável não encontrado: $exe" }
    $key = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce'
    New-Item -Path $key -Force | Out-Null
    Set-ItemProperty -Path $key -Name '${name}' -Value ('"' + $exe + '" --resume')
  `;
  return powershell(script, opts);
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
};
