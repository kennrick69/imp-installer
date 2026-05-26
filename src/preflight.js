'use strict';

const { powershell } = require('./shell');

// Minimum Windows 10 build supporting WSL2 with reasonable stability.
const MIN_WIN_BUILD = 19041;
const MIN_FREE_GB   = 5;

async function checkWindowsBuild() {
  const { stdout } = await powershell('[Environment]::OSVersion.Version.Build');
  const build = parseInt(stdout.trim(), 10);
  return {
    name: 'windows_build',
    ok: Number.isFinite(build) && build >= MIN_WIN_BUILD,
    value: build,
    detail: `build ${build} (mínimo ${MIN_WIN_BUILD})`,
  };
}

async function checkAdmin() {
  const { stdout } = await powershell(
    `([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)`
  );
  const ok = /true/i.test(stdout);
  return { name: 'admin', ok, value: ok, detail: ok ? 'rodando como administrador' : 'NÃO está como administrador — relance via UAC' };
}

async function checkDiskSpace() {
  const { stdout } = await powershell('[math]::Round((Get-PSDrive C).Free / 1GB, 2)');
  const free = parseFloat(stdout.trim());
  return {
    name: 'disk_c_free_gb',
    ok: Number.isFinite(free) && free >= MIN_FREE_GB,
    value: free,
    detail: `${free} GB livres em C: (mínimo ${MIN_FREE_GB})`,
  };
}

async function checkInternet() {
  // Test-NetConnection is slow on some boxes; use a quick TCP probe via .NET.
  const script = `
    try {
      $c = New-Object System.Net.Sockets.TcpClient
      $ok = $c.ConnectAsync('github.com', 443).Wait(5000)
      $c.Close()
      if ($ok) { 'true' } else { 'false' }
    } catch { 'false' }
  `;
  const { stdout } = await powershell(script);
  const ok = /true/i.test(stdout);
  return { name: 'internet_github', ok, value: ok, detail: ok ? 'github.com:443 alcançável' : 'sem conexão a github.com:443' };
}

async function checkVirtualization() {
  // VirtualizationFirmwareEnabled = BIOS/UEFI flag. Some hypervisors hide it; we
  // treat false as warning, not blocker, because users sometimes get false negatives.
  const script = `
    try {
      $p = Get-CimInstance Win32_Processor | Select-Object -First 1
      [string]$p.VirtualizationFirmwareEnabled
    } catch { 'unknown' }
  `;
  const { stdout } = await powershell(script);
  const v = stdout.trim().toLowerCase();
  const ok = v === 'true';
  return {
    name: 'virtualization',
    ok,
    value: v,
    warning: !ok,
    detail: ok ? 'virtualização habilitada no firmware' : 'virtualização parece desabilitada — pode falhar no WSL',
  };
}

// §1.7 — outra distro WSL como default pode atrapalhar `wsl --install -d Ubuntu-22.04`
// (não vira default automaticamente, e nossos comandos `wsl -d Ubuntu-22.04` ficam
// chumbados mas o usuário pode estranhar). Marca como warning (não-blocker).
async function checkOtherDistros() {
  const script = `
    try {
      $out = wsl -l -v 2>&1 | Out-String
      $out
    } catch { '' }
  `;
  try {
    const { stdout } = await powershell(script);
    const text = stdout || '';
    // wsl -l -v não instalado / sem distros → não tem outra distro pra atrapalhar.
    if (!text || /no installed distributions/i.test(text) || /not recognized/i.test(text)) {
      return { name: 'other_distros', ok: true, value: 'none', detail: 'nenhuma distro WSL instalada (esperado)' };
    }
    // Procura linha começando com `*` (default) seguida de nome não-Ubuntu.
    const lines = text.split(/\r?\n/);
    let defaultName = null;
    for (const ln of lines) {
      // Formato típico: `* Ubuntu-22.04    Running   2`
      const m = ln.match(/^\s*\*\s+(\S+)/);
      if (m) { defaultName = m[1]; break; }
    }
    if (!defaultName) {
      return { name: 'other_distros', ok: true, value: 'unknown', detail: 'não consegui parsear wsl -l -v' };
    }
    const isUbuntu = /^Ubuntu/i.test(defaultName);
    return {
      name: 'other_distros',
      ok: isUbuntu,
      value: defaultName,
      warning: !isUbuntu,
      detail: isUbuntu
        ? `default distro = ${defaultName} (ok)`
        : `default distro = ${defaultName} (não-Ubuntu) — o instalador vai forçar Ubuntu-22.04 como default depois de instalar`,
    };
  } catch (_) {
    return { name: 'other_distros', ok: true, value: 'error', detail: 'check de outras distros falhou (ignorável)' };
  }
}

async function checkAntivirus() {
  // Just inform; we don't block. AntiVirusProduct on Win10/11.
  const script = `
    try {
      $av = Get-CimInstance -Namespace 'root/SecurityCenter2' -ClassName AntiVirusProduct -ErrorAction Stop |
        Select-Object -ExpandProperty displayName
      ($av -join ', ')
    } catch { '' }
  `;
  try {
    const { stdout } = await powershell(script);
    const detected = stdout.trim();
    return { name: 'antivirus', ok: true, value: detected || 'nenhum detectado', warning: !!detected && !/Windows Defender/i.test(detected), detail: detected ? `AV ativo: ${detected}` : 'AV não detectado' };
  } catch (_) {
    return { name: 'antivirus', ok: true, value: 'unknown', warning: false, detail: 'AV não pôde ser detectado' };
  }
}

// Normaliza um resultado de check pra sempre ter formato canônico.
// Mesmo se o check retornar undefined/null/string solta, devolvemos objeto válido.
// (Bruno — defensiva pós primeiro live-test, onde "checks is not iterable" derrubou tudo.)
function normalizeCheck(name, raw) {
  if (raw && typeof raw === 'object' && typeof raw.name === 'string') {
    // Ainda preenche detail se faltar.
    return {
      name: raw.name,
      ok: !!raw.ok,
      value: raw.value,
      warning: !!raw.warning,
      detail: typeof raw.detail === 'string' ? raw.detail : '(sem detalhe)',
    };
  }
  // Check devolveu algo estranho — converte em erro tratado, NÃO derruba.
  return {
    name: name || 'unknown',
    ok: false,
    warning: false,
    detail: `check retornou tipo inesperado (${typeof raw}) — tratando como falha`,
  };
}

// Run all preflight checks. Returns { ok, blocking, warnings, results }.
// CONTRATO INVIOLÁVEL: SEMPRE retorna objeto com .results = Array<{name,ok,detail,warning?}>.
// Nunca undefined, nunca null, nunca array vazio sem motivo. Cada check individual
// pode falhar (throw, retornar undefined, retornar não-objeto) que normalizamos aqui.
async function runAll(opts = {}) {
  const results = [];
  const fns = [
    checkWindowsBuild,
    checkAdmin,
    checkDiskSpace,
    checkInternet,
    checkVirtualization,
    checkAntivirus,
    checkOtherDistros,
  ];

  // Promise.allSettled em vez de Promise.all — uma reject não derruba o conjunto.
  let settled;
  try {
    settled = await Promise.allSettled(fns.map(f => {
      try { return Promise.resolve(f()); }
      catch (e) { return Promise.reject(e); }
    }));
  } catch (e) {
    // allSettled "nunca" rejeita, mas se algo MUITO inesperado acontecer
    // (ex.: out-of-memory), preservamos o contrato e devolvemos objeto válido.
    return { ok: false, blocking: [], warnings: [], results: [
      { name: 'preflight_internal', ok: false, detail: `erro interno no runAll: ${(e && e.message) || e}` }
    ] };
  }

  for (let i = 0; i < settled.length; i++) {
    const r = settled[i];
    const fnName = (fns[i] && fns[i].name) || `check_${i}`;
    if (r.status === 'fulfilled') {
      results.push(normalizeCheck(fnName, r.value));
    } else {
      const reasonMsg = (r.reason && r.reason.message) || String(r.reason || 'erro desconhecido');
      results.push({ name: fnName, ok: false, detail: `falhou: ${reasonMsg}` });
    }
  }

  const blocking = results.filter(r => !r.ok && !r.warning);
  const warnings = results.filter(r => r.warning);
  if (opts.logger && typeof opts.logger.info === 'function') {
    for (const r of results) {
      try { opts.logger.info('preflight', `${r.name}: ${r.detail}`); }
      catch (_) { /* logger malformado não derruba preflight */ }
    }
  }
  return {
    ok: blocking.length === 0,
    blocking,
    warnings,
    results,
  };
}

module.exports = {
  runAll,
  checkWindowsBuild,
  checkAdmin,
  checkDiskSpace,
  checkInternet,
  checkVirtualization,
  checkAntivirus,
  checkOtherDistros,
};
