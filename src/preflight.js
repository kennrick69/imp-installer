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

// Run all preflight checks. Returns { ok, blocking, warnings, results }.
async function runAll(opts = {}) {
  const results = [];
  // Run in parallel — each is independent and cheap.
  const fns = [
    checkWindowsBuild,
    checkAdmin,
    checkDiskSpace,
    checkInternet,
    checkVirtualization,
    checkAntivirus,
  ];
  const settled = await Promise.allSettled(fns.map(f => f()));
  for (let i = 0; i < settled.length; i++) {
    const r = settled[i];
    if (r.status === 'fulfilled') results.push(r.value);
    else results.push({ name: fns[i].name, ok: false, detail: `falhou: ${r.reason && r.reason.message}` });
  }
  const blocking = results.filter(r => !r.ok && !r.warning);
  const warnings = results.filter(r => r.warning);
  if (opts.logger) {
    for (const r of results) {
      opts.logger.info('preflight', `${r.name}: ${r.detail}`);
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
};
