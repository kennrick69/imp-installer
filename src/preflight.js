'use strict';

const { powershell } = require('./shell');

// ────────────────────────────────────────────────────────────────────────────
// MATRIZ DE SEVERIDADE DOS CHECKS (Bruno onda 4 — bloqueante falso v0.2.2)
// ────────────────────────────────────────────────────────────────────────────
// PRINCÍPIO (JOs): SÓ é bloqueante o que o instalador NÃO consegue resolver.
// Tudo que o instalador INSTALA (WSL, Ubuntu, Node, tmux, claude CLI, ...) NÃO
// bloqueia — é o trabalho dele. Ausência de WSL/distro é ESPERADA pré-instalação.
//
//   check                cenário ruim                severidade
//   ────────────────────  ──────────────────────────  ─────────────────────────
//   windows_build         build < 19041               BLOCKER REAL  (SO antigo)
//   disk_c_free_gb        < 5 GB livres em C:         BLOCKER REAL  (sem disco)
//   internet_github       sem rede / firewall         BLOCKER REAL  (sem download)
//   virtualization        firmware flag = false       WARNING       (false-neg comum)
//   admin                 NÃO está como admin         WARNING       (UAC no passo 1)
//   antivirus             AV de terceiros             WARNING       (informativo)
//   other_distros         sem WSL OU não-Ubuntu       WARNING       (instalador resolve)
//
// REGRA NA RUNTIME: `blocking = results.filter(r => !r.ok && !r.warning)`.
// Pra um check NÃO bloquear quando "ruim", ou põe `ok:true` OU põe `warning:true`.
// Pelos casos da matriz acima:
//   - admin sem privilégio → `{ok:true, warning:true}` (não bloqueia; UAC no passo 1).
//   - virtualization desligada → `{ok:true, warning:true}` (não bloqueia; falha clara depois).
//   - other_distros (qualquer cenário) → sempre `ok:true`.
//
// CONSEQUÊNCIA: o conjunto de blockers possíveis daqui pra frente é EXATAMENTE
// {windows_build, disk_c_free_gb, internet_github}. Nada além disso bloqueia.
// ────────────────────────────────────────────────────────────────────────────

// Minimum Windows 10 build supporting WSL2 with reasonable stability.
const MIN_WIN_BUILD = 19041;
const MIN_FREE_GB   = 5;

// Default per-check timeout (ms). PowerShell checks geralmente terminam em
// 1-5s, mas `Get-CimInstance Win32_Processor` pode travar 60s+ em PCs com
// WMI ruim, e `wsl -l -v` em PC sem WSL instalado também pode demorar. 30s
// dá feedback rápido pro user (e o check vira `ok:false, detail:'tempo esgotado'`).
const DEFAULT_CHECK_TIMEOUT = 30_000;

// timeoutCheck — Promise que rejeita após `ms` com mensagem padronizada.
// Usada em Promise.race contra cada check pra cortar travas de PowerShell.
function timeoutCheck(name, ms) {
  return new Promise((_, reject) => {
    setTimeout(() => {
      const e = new Error(`timeout (${ms}ms)`);
      e.code = 'CHECK_TIMEOUT';
      e.checkName = name;
      reject(e);
    }, ms);
  });
}

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
  // Bruno onda 4: sem privilégio admin NÃO bloqueia mais. O instalador pede
  // UAC quando precisa elevar (passo 1 já faz `Start-Process -Verb RunAs`).
  // Forçar admin no momento do preflight derrubava users que clicaram duplo
  // no .exe portable sem "Executar como administrador" — cenário comum demais.
  const { stdout } = await powershell(
    `([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)`
  );
  const isAdmin = /true/i.test(stdout);
  return {
    name: 'admin',
    ok: true,                  // nunca bloqueia
    warning: !isAdmin,         // só vira aviso visual
    value: isAdmin,
    detail: isAdmin
      ? 'rodando como administrador'
      : 'sem privilégio admin — o instalador vai pedir UAC no Passo 1',
  };
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
  // VirtualizationFirmwareEnabled = BIOS/UEFI flag. Hipervisores (Hyper-V já
  // ligado, VMware, etc.) frequentemente ESCONDEM esse flag, então false aqui
  // é false-negative comum. Bruno onda 4: NUNCA bloqueia — sempre ok:true,
  // só marca warning se vier 'false'/'unknown'. Se a virtualização realmente
  // estiver desligada, o `wsl --install` no passo 3 falha com mensagem clara
  // da Microsoft mandando o user ligar na BIOS — melhor pegar lá do que aqui.
  const script = `
    try {
      $p = Get-CimInstance Win32_Processor | Select-Object -First 1
      [string]$p.VirtualizationFirmwareEnabled
    } catch { 'unknown' }
  `;
  const { stdout } = await powershell(script);
  const v = stdout.trim().toLowerCase();
  const enabled = v === 'true';
  return {
    name: 'virtualization',
    ok: true,            // nunca bloqueia
    warning: !enabled,   // só aviso quando flag não é 'true'
    value: v,
    detail: enabled
      ? 'virtualização habilitada no firmware'
      : 'virtualização parece desabilitada no firmware (detecção é incerta — vou tentar instalar e, se falhar, te aviso pra ligar na BIOS)',
  };
}

// §1.7 — outra distro WSL como default pode atrapalhar `wsl --install -d Ubuntu-22.04`
// (não vira default automaticamente, e nossos comandos `wsl -d Ubuntu-22.04` ficam
// chumbados mas o usuário pode estranhar). Marca como warning (não-blocker).
//
// Bruno onda 4: este check NUNCA retorna ok:false. Cenários (sem WSL, com WSL
// sem distros, com WSL+distro não-Ubuntu, parser falhou) viram ok:true com
// warning opcional. O instalador resolve TUDO isso no Passo 3.
async function checkOtherDistros() {
  // Fast path: se wsl.exe nem existe no PATH, NÃO chama `wsl -l -v` (pode demorar
  // 30s+ pra retornar "not recognized" em PCs sem WSL instalado). Bruno onda 3.
  try {
    const probe = await powershell(
      `if (Get-Command wsl.exe -ErrorAction SilentlyContinue) { 'YES' } else { 'NO' }`,
      { timeout: 10_000 }
    ).catch(() => ({ stdout: 'NO' }));
    if (!/YES/i.test(probe.stdout || '')) {
      return {
        name: 'other_distros',
        ok: true,
        warning: true,
        value: 'no_wsl',
        detail: 'WSL ausente — vou instalar no Passo 3',
      };
    }
  } catch (_) {
    return {
      name: 'other_distros',
      ok: true,
      warning: true,
      value: 'probe_failed',
      detail: 'não consegui sondar wsl.exe — vou seguir e ajustar se preciso',
    };
  }

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
      return {
        name: 'other_distros',
        ok: true,
        warning: true,
        value: 'none',
        detail: 'nenhuma distro WSL instalada — vou instalar Ubuntu-22.04 no Passo 3',
      };
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
      return {
        name: 'other_distros',
        ok: true,
        warning: true,
        value: 'unknown',
        detail: 'WSL detectado mas listagem incerta — vou seguir e ajustar se preciso',
      };
    }
    const isUbuntu = /^Ubuntu/i.test(defaultName);
    return {
      name: 'other_distros',
      ok: true,                // sempre ok:true (instalador resolve)
      value: defaultName,
      warning: !isUbuntu,
      detail: isUbuntu
        ? `default distro = ${defaultName} (ok)`
        : `default distro = ${defaultName} (não-Ubuntu) — vou forçar Ubuntu-22.04 como default no Passo 3`,
    };
  } catch (_) {
    return {
      name: 'other_distros',
      ok: true,
      warning: true,
      value: 'error',
      detail: 'check de outras distros falhou (ignorável — instalador resolve no Passo 3)',
    };
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
//
// Bruno onda 3 (live-test #2): runAll agora chama `opts.onCheck(result)` PRA CADA
// check assim que ele termina, em vez de só devolver o array no final. Sem isso,
// a UI ficava 2+ minutos com tela vazia esperando todos os 7 checks
// (Promise.allSettled = batch). Agora streaming: cada check normalizado vira
// callback IMEDIATO + cada check tem timeout via Promise.race.
async function runAll(opts = {}) {
  const fns = [
    checkWindowsBuild,
    checkAdmin,
    checkDiskSpace,
    checkInternet,
    checkVirtualization,
    checkAntivirus,
    checkOtherDistros,
  ];
  const timeoutMs = (opts && Number.isFinite(opts.timeoutMs)) ? opts.timeoutMs : DEFAULT_CHECK_TIMEOUT;
  const onCheck = (opts && typeof opts.onCheck === 'function') ? opts.onCheck : null;

  // Cada check roda em paralelo (Promise.race contra timeoutCheck) e dispara
  // onCheck assim que termina. Erros viram check com ok:false (não derruba batch).
  const promises = fns.map(async (f) => {
    const fnName = (f && f.name) || 'unknown';
    try {
      const raw = await Promise.race([
        Promise.resolve().then(() => f()),
        timeoutCheck(fnName, timeoutMs),
      ]);
      const norm = normalizeCheck(fnName, raw);
      if (onCheck) {
        try { onCheck(norm); } catch (_) { /* callback do consumidor não pode derrubar */ }
      }
      if (opts && opts.logger && typeof opts.logger.info === 'function') {
        try { opts.logger.info('preflight', `${norm.name}: ${norm.detail}`); } catch (_) {}
      }
      return norm;
    } catch (e) {
      const reasonMsg = (e && e.message) || String(e || 'erro desconhecido');
      const isTimeout = e && e.code === 'CHECK_TIMEOUT';
      const errNorm = {
        name: fnName,
        ok: false,
        warning: false,
        detail: isTimeout ? `tempo esgotado (${timeoutMs}ms) — check travado` : `falhou: ${reasonMsg}`,
      };
      if (onCheck) {
        try { onCheck(errNorm); } catch (_) {}
      }
      if (opts && opts.logger && typeof opts.logger.warn === 'function') {
        try { opts.logger.warn('preflight', `${fnName}: ${errNorm.detail}`); } catch (_) {}
      }
      return errNorm;
    }
  });

  // Promise.all aqui é seguro porque cada promise NUNCA rejeita (catch interno
  // converte qualquer falha em objeto normalizado). Mantemos try/catch externo
  // de defensiva pra cenário OOM/etc.
  let results;
  try {
    results = await Promise.all(promises);
  } catch (e) {
    return { ok: false, blocking: [], warnings: [], results: [
      { name: 'preflight_internal', ok: false, detail: `erro interno no runAll: ${(e && e.message) || e}` }
    ] };
  }

  const blocking = results.filter(r => !r.ok && !r.warning);
  const warnings = results.filter(r => r.warning);
  return {
    ok: blocking.length === 0,
    blocking,
    warnings,
    results,
  };
}

// Bruno onda 4: mensagem específica por blocker REAL, pra o `installer:start`
// emitir um `installer:onError` humano em vez de erro genérico. Ver matriz
// no topo do arquivo — só esses 3 nomes podem aparecer como blocker.
function blockerMessage(check) {
  if (!check || typeof check !== 'object') {
    return 'Algo deu errado na verificação inicial — tenta de novo.';
  }
  switch (check.name) {
    case 'windows_build':
      return `Seu Windows está em build ${check.value} — preciso de pelo menos ${MIN_WIN_BUILD} (Windows 10 21H2 ou Windows 11). Atualize o Windows e tente de novo.`;
    case 'disk_c_free_gb':
      return `Você tem ${check.value} GB livres em C: — preciso de pelo menos ${MIN_FREE_GB} GB. Libere espaço e tente de novo.`;
    case 'internet_github':
      return 'Não consegui chegar em github.com:443. Verifica internet/proxy/firewall e tenta de novo.';
    default:
      return check.detail || `Pré-requisito não atendido: ${check.name}`;
  }
}

// Constrói o payload completo de erro de preflight pra o adapter `installer:start`
// emitir via `installer:onError`. Não é blocker genérico — é mensagem específica
// por check, com canRetry:true (user conserta no Windows e clica de novo).
function buildBlockingErrorPayload(blocking) {
  const list = Array.isArray(blocking) ? blocking : [];
  return {
    stepId: 'step_00_preflight',
    headline: 'Antes de continuar...',
    what: 'Algumas coisas precisam ser ajustadas no Windows antes de eu poder instalar',
    suggestions: list.map(blockerMessage),
    canRetry: true,
    canSkip: false,
    raw: list.map(c => `${c.name}: ${c.detail || ''}`).join('\n'),
  };
}

module.exports = {
  runAll,
  timeoutCheck,
  normalizeCheck,
  checkWindowsBuild,
  checkAdmin,
  checkDiskSpace,
  checkInternet,
  checkVirtualization,
  checkAntivirus,
  checkOtherDistros,
  blockerMessage,
  buildBlockingErrorPayload,
  MIN_WIN_BUILD,
  MIN_FREE_GB,
  DEFAULT_CHECK_TIMEOUT,
};
