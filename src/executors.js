'use strict';

const { powershell, wsl, sudoInWsl, openInteractiveTerminal, withRetry, scheduleRunOnceAfterReboot, shSingleQuote, isElevated, wslExec } = require('./shell');
const preflight = require('./preflight');
const { enrichError } = require('./error-catalog');

// ───────────────────────────────────────────────────────────────────────
// Wrapper: roda PowerShell e enriquece o erro com stdout+code+stderr.
//
// DISM e wsl.exe escrevem MUITOS erros em STDOUT, não stderr. Em particular,
// erro 740 (ELEVATION_REQUIRED) sai com stderr vazio — o log do JOs no live
// test mostrou exatamente isso: `{"stderr":""}` sem nenhuma pista do motivo.
// Esta função SEMPRE inclui stdout + exit code na mensagem do erro, pra
// debugar sem ficar adivinhando.
//
// Bruno v0.2.9 (live-test #2 fix CAUSA 1 — encoding):
// Windows pt-BR retorna stdout do dism/wsl em codepage 850/1252 (legacy DOS).
// Node lê como UTF-8 → mojibake ("Manuten��o"). Prependamos `chcp 65001 > $null`
// pra forçar a sessão PS pra UTF-8 ANTES de invocar a ferramenta. Inofensivo
// pra comandos sem acentos.
//
// Bruno v0.2.9 (CAUSA 2 — exit 3010): DISM/wsl --install retornam 3010 quando
// têm SUCESSO mas precisam reboot pra ativar. Tratamos como sucesso e flag
// rebootRequired=true em vez de erro. Os steps que chamam powershellVerbose
// devem checar `r.rebootRequired` no resultado.
//
// Exit codes conhecidos (relevantes p/ steps 01/02/03):
//   0     sucesso, sem reboot
//   740   ERROR_ELEVATION_REQUIRED — falta admin (manifest deve resolver em v0.2.7)
//   50    DISM: feature já em estado desejado / não suportado
//   3010  DISM/wsl --install: sucesso mas precisa reboot (tratado como OK)
//   -1    wsl.exe: distro não instalada / erro genérico
// ───────────────────────────────────────────────────────────────────────
async function powershellVerbose(script, opts = {}) {
  // CAUSA 1 fix: força UTF-8 na sessão PS. `chcp 65001 > $null` muda code page
  // do console pra UTF-8 antes do comando real, eliminando mojibake pt-BR na
  // saída do dism/wsl. `$ErrorActionPreference = 'Continue'` garante que
  // mudar chcp não derrube o script se algo der ruim no chcp (raríssimo).
  const wrapped = `chcp 65001 > $null; ${script}`;
  try {
    const r = await powershell(wrapped, opts);
    // CAUSA 2 fix: alguns comandos (raro mas possível) retornam 3010 SEM throw
    // — flag pra caller saber.
    if (r && r.code === 3010) {
      r.rebootRequired = true;
    }
    return r;
  } catch (e) {
    const code = e.code != null ? e.code : '(unknown)';
    const stdout = (e.stdout || '').trim();
    const stderr = (e.stderr || '').trim();

    // CAUSA 2 fix: exit 3010 NÃO é erro — é "sucesso, precisa reboot".
    // Sintetiza um resultado de sucesso e devolve em vez de throw.
    if (code === 3010) {
      return {
        stdout, stderr, code: 3010, rebootRequired: true,
      };
    }

    const parts = [
      `exit_code=${code}`,
      stdout ? `stdout=${stdout.slice(0, 1500)}` : 'stdout=(empty)',
      stderr ? `stderr=${stderr.slice(0, 1500)}` : 'stderr=(empty)',
    ];
    // Hint específico pra erro 740 — orienta o user/dev sem cavar log.
    if (code === 740 || /elevation|0x[0-9a-f]*2e4|ELEVATION_REQUIRED/i.test(stdout + stderr)) {
      parts.push('hint=ELEVATION_REQUIRED (code 740) — manifest deveria forçar elevação no boot');
    }
    const enriched = new Error(`${e.message} | ${parts.join(' | ')}`);
    enriched.code = code;
    enriched.stdout = stdout;
    enriched.stderr = stderr;
    enriched.originalMessage = e.message;
    throw enriched;
  }
}

// Helper: detecta se `wsl --install` moderno está disponível neste Windows.
// Win10 build 19041+ (Win10 21H2) e Win11 têm.
//
// Bruno v0.2.11 (live-test JOs em v0.2.10): a versão anterior dependia 100% de
// regex `/--install/i` sobre `wsl --help`. FALHOU em Win10 19045 pt-BR porque:
//   1) wsl --help em pt-BR não cita o flag literal "--install" em toda linha;
//   2) UTF-16 LE + chcp 65001 ainda assim deixa stdout com chars NUL ou texto
//      traduzido que o regex inglês não casa.
// Resultado: falso-negativo → fallback dism legacy → mojibake + exit 1.
//
// Estratégia v0.2.11: testa via MÚLTIPLOS sinais, retorna na primeira evidência
// positiva. Loga o motivo da decisão pra debug.
//
// Retorna: { supported: boolean, reason: string, evidence: object }
async function wslInstallSupported(logger) {
  const evidence = {};

  // Sinal 1 — `wsl --version`: SÓ existe em wsl moderno (>=0.64, 19041+).
  // Se retorna 0 e stdout menciona "WSL"/"kernel"/"distribu", é moderno.
  // Bruno v0.2.12: wslExec direto (decode UTF-16 LE hard-coded) — antes
  // powershell wrapper deixava mojibake mesmo com chcp 65001.
  try {
    const r = await wslExec(['--version'], { timeout: 10_000, logger });
    evidence.version = { code: r.exit_code, stdoutLen: (r.stdout || '').length, sample: (r.stdout || '').slice(0, 200) };
    if (r.exit_code === 0 && /WSL|kernel|distribu|vers[aã]o/i.test(r.stdout || '')) {
      if (logger) logger.info('wslInstallSupported', `decisão: MODERNO (sinal: wsl --version OK, stdout=${(r.stdout || '').slice(0, 120).replace(/\s+/g, ' ')})`);
      return { supported: true, reason: 'wsl --version retornou ok', evidence };
    }
  } catch (e) {
    evidence.version = { error: e.message };
  }

  // Sinal 2 — `wsl --help` com regex MAIS GENEROSA (pt-BR + en-US):
  // procura "--install" OU "instalar" OU "Install" como palavra/subcomando.
  try {
    const r = await wslExec(['--help'], { timeout: 10_000, logger });
    evidence.help = { code: r.exit_code, stdoutLen: (r.stdout || '').length, sample: (r.stdout || '').slice(0, 200) };
    if (r.exit_code === 0 && /--install\b|\binstall\b|\binstalar\b|\binstale\b/i.test(r.stdout || '')) {
      if (logger) logger.info('wslInstallSupported', `decisão: MODERNO (sinal: wsl --help menciona install/instalar)`);
      return { supported: true, reason: 'wsl --help menciona install', evidence };
    }
  } catch (e) {
    evidence.help = { error: e.message };
  }

  // Sinal 3 — fallback BUILD do Windows. >=19041 = wsl --install moderno.
  // Win10 build 19045 (22H2 do JOs) > 19041 → MODERNO. Esse é o sinal mais
  // confiável quando os 2 primeiros falham por encoding bizarro.
  try {
    const r = await powershell(`[Environment]::OSVersion.Version.Build`, { timeout: 5_000 });
    const buildStr = (r.stdout || '').trim();
    const build = parseInt(buildStr, 10);
    evidence.build = { raw: buildStr, parsed: build, code: r.code };
    if (Number.isFinite(build) && build >= 19041) {
      if (logger) logger.info('wslInstallSupported', `decisão: MODERNO (sinal: build ${build} >= 19041)`);
      return { supported: true, reason: `build ${build} >= 19041`, evidence };
    }
    if (Number.isFinite(build) && build < 19041) {
      if (logger) logger.info('wslInstallSupported', `decisão: LEGACY (build ${build} < 19041)`);
      return { supported: false, reason: `build ${build} < 19041`, evidence };
    }
  } catch (e) {
    evidence.build = { error: e.message, code: e.code };
  }

  if (logger) logger.warn('wslInstallSupported', `decisão: LEGACY (nenhum sinal confirmou suporte) evidence=${JSON.stringify(evidence).slice(0, 400)}`);
  return { supported: false, reason: 'nenhum sinal positivo', evidence };
}

// Helper: lista distros instaladas. Usa wslExec direto (decode UTF-16 LE
// hard-coded) em vez de PS wrapper que sofria mojibake mesmo com chcp 65001.
// Mantém shape { stdout, stderr, code } pra não quebrar callers.
async function wslListVerbose() {
  const r = await wslExec(['-l', '-v'], { timeout: 15_000 });
  return { stdout: r.stdout, stderr: r.stderr, code: r.exit_code };
}

// ───────────────────────────────────────────────────────────────────────
// discoverUbuntuDistroName — lista distros DISPONÍVEIS via `wsl --list --online`
// e escolhe o melhor candidato Ubuntu.
//
// Bruno v0.2.12 (live-test JOs em v0.2.11):
// Em algumas instalações Win10 (especialmente pt-BR), o nome canônico
// `Ubuntu-22.04` NÃO está disponível no catálogo online — wsl --install -d
// retorna "Nome de distribuição inválido". Precisamos descobrir dinamicamente
// quais nomes Ubuntu o `wsl.exe` deste host reconhece.
//
// Output típico de `wsl --list --online`:
//   NAME            FRIENDLY NAME
//   Ubuntu          Ubuntu
//   Ubuntu-24.04    Ubuntu 24.04 LTS
//   Ubuntu-22.04    Ubuntu 22.04 LTS
//   ...
//
// Prioridade: 22.04 > 24.04 > 20.04 > Ubuntu (sem versão) > primeiro Ubuntu*.
//
// Retorna: string com NAME (ex: 'Ubuntu-22.04') ou null se não conseguiu listar
// ou nenhum Ubuntu foi encontrado.
async function discoverUbuntuDistroName(logger) {
  const r = await wslExec(['--list', '--online'], { timeout: 15_000 });
  if (r.exit_code !== 0) {
    if (logger) logger.warn('discoverUbuntuDistroName',
      `wsl --list --online falhou: exit=${r.exit_code} stderr=${(r.stderr || '').slice(0, 200)}`);
    return null;
  }
  const lines = (r.stdout || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  // Primeiro token de cada linha = NAME. Pega só linhas que começam com "Ubuntu".
  const names = lines
    .map(l => l.split(/\s+/)[0])
    .filter(n => /^Ubuntu/i.test(n) && n !== 'NAME');
  if (!names.length) {
    if (logger) logger.warn('discoverUbuntuDistroName',
      `nenhum Ubuntu no catálogo. stdout=${(r.stdout || '').slice(0, 400)}`);
    return null;
  }
  const priority = ['Ubuntu-22.04', 'Ubuntu-24.04', 'Ubuntu-20.04', 'Ubuntu'];
  for (const want of priority) {
    const found = names.find(n => n.toLowerCase() === want.toLowerCase());
    if (found) {
      if (logger) logger.info('discoverUbuntuDistroName',
        `escolhido por prioridade: ${found} (disponíveis: ${names.join(', ')})`);
      return found;
    }
  }
  if (logger) logger.info('discoverUbuntuDistroName',
    `fallback primeiro Ubuntu*: ${names[0]} (disponíveis: ${names.join(', ')})`);
  return names[0];
}

// Each executor exports: { id, title, description, category, detect, execute, validate, manualInstructions? }
//   detect():    Promise<boolean>  — true if step is already done (skip).
//   execute():   Promise<void>     — perform work. May throw to mark error.
//   validate():  Promise<boolean>  — confirm completion. False -> mark error.
//   category:    'AUTO' | 'MANUAL' | 'HYBRID'
//
// `ctx` is passed at runtime and contains: { state, save, logger, events, requestSudoPassword, ... }

const FOLDER_MARKER = '.imp-installer-managed';

// ───────────────────────────────────────────────────────────────────────
// Admin gate (Bruno — live-test #3, v0.2.4 -> v0.2.5)
//
// Steps 01/02/03 manipulam o Windows (dism enable-feature, wsl --install,
// wsl --set-default-version) e EXIGEM token de admin. Se o EXE não estiver
// elevado, throw error com flag NEEDS_ADMIN — main.js intercepta e emite
// `installer:onNeedsAdmin` em vez do onError genérico, pra UI mostrar o
// modal-elevate (botão "Reabrir como administrador") em vez do modal-error.
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

function makeMarker(bashPathExpr) {
  return `mkdir -p ${bashPathExpr} && touch ${bashPathExpr}/${FOLDER_MARKER}`;
}

// -------- step 00 — preflight ---------------------------------------------
const step00Preflight = {
  id: 'step_00_preflight',
  title: 'Pré-flight (Windows / admin / disco / internet)',
  description: 'Confere Windows version, admin, disco, internet e virtualização antes de começar.',
  category: 'AUTO',
  async detect(ctx) {
    // Always re-run preflight on each session; cheap and catches drift (disk filled, AV came online).
    return false;
  },
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

// ───────────────────────────────────────────────────────────────────────
// Bruno v0.2.9 — REFATORAÇÃO steps 01/02/03 (live-test #2)
//
// CAUSA RAIZ (live-test JOs em v0.2.8): dism.exe /enable-feature falhava em
// ~29.4% com exit 1, stderr vazio, stdout em mojibake pt-BR ("Manuten��o").
// Diagnóstico cirúrgico identificou 3 fatores:
//   1) Encoding pt-BR (cp850/1252) lido como UTF-8 → mojibake
//   2) Exit 3010 (sucesso-com-reboot) tratado como erro
//   3) Abordagem dism+wsl --set-default+wsl --install (3 passos) é a forma
//      ANTIGA. Microsoft recomenda `wsl --install` desde Win10 19041 (2021),
//      que faz tudo numa tacada e gerencia reboot.
//
// ESTRATÉGIA CONSERVADORA: preservamos os 3 IDs (step_01/02/03) pra não quebrar
// state.json existente nem a UI da Camila (wizard.js mapeia por ID). Mas:
//   - step_01 agora faz TUDO (wsl --install ou fallback dism)
//   - step_02 e step_03 viram NO-OPs (detect=true após step_01)
//
// Compatibilidade total com state.json antigo (steps já 'done' continuam done).
// ───────────────────────────────────────────────────────────────────────

// Compartilhado: marca reboot + agenda RunOnce. Idempotente.
async function _markRebootAndScheduleRunOnce(ctx, stepId) {
  ctx.state.rebootRequired = true;
  ctx.state.rebootDone = false;
  ctx.save();
  if (ctx.exePath) {
    try {
      await scheduleRunOnceAfterReboot(ctx.exePath);
      ctx.logger.info(stepId, 'RunOnce agendado — instalador re-abre após reboot');
    } catch (e) {
      ctx.logger.warn(stepId, `RunOnce schedule falhou: ${e.message}`);
    }
  }
}

// Compartilhado: detecta QUALQUER distro Ubuntu instalada (qualquer um dos 3
// steps considera "feito" se isso é true, porque step_01 unificado já cuidou).
//
// Bruno v0.2.12: antes hardcodava `Ubuntu-22.04` — falhava quando o host só
// tinha `Ubuntu` ou `Ubuntu-24.04`. Agora aceita qualquer NAME que comece com
// "Ubuntu" (Ubuntu, Ubuntu-22.04, Ubuntu-24.04, etc.). Como a lista vem do
// wslExec (UTF-16 LE decodado), regex casa limpa.
async function _ubuntuInstalled() {
  const r = await wslListVerbose();
  return /\bUbuntu(?:-\d+\.\d+)?\b/i.test(r.stdout || '');
}

// -------- step 01 — Install WSL2 + Ubuntu (unified, modern) ---------------
const step01EnableFeatures = {
  id: 'step_01_enable_features', // ID preservado pra compat com state.json/UI
  title: 'Instalar WSL2 + Ubuntu (features + kernel + distro)',
  description: 'wsl --install -d Ubuntu-22.04 (moderno: faz features, kernel e distro de uma vez). Fallback dism se Windows for antigo.',
  category: 'HYBRID', // pode disparar reboot
  // Bruno v0.2.13: shape NOVO (action/steps/expected/note). action.kind=none —
  // step roda sozinho; só mostra instruções pro caso de reboot pendente.
  manualInstructions: {
    action: { label: 'Aguardando instalação do WSL…', kind: 'none', payload: {} },
    steps: [
      { num: 1, text: 'O instalador vai baixar e instalar o WSL2 + Ubuntu (pode demorar 2–5 min)' },
      { num: 2, text: 'Ao final, o Windows pode pedir um REBOOT' },
      { num: 3, text: 'Salve seu trabalho aberto (Word, navegador, etc.)' },
      { num: 4, text: 'Quando o PC reiniciar, este instalador abre sozinho e retoma de onde parou' },
    ],
    expected: 'Mensagem "wsl --install OK" e/ou pedido de reboot do Windows.',
    note: 'Não feche o instalador. Se o reboot for solicitado, reinicie o Windows.',
  },
  async detect() {
    return _ubuntuInstalled();
  },
  async execute(ctx) {
    await requireAdminOrThrow();

    // Aviso amigável se outra distro for default.
    try {
      const r = await wslListVerbose();
      if (r.stdout && /\*\s+(Debian|Kali|openSUSE|SLES|Oracle|Pengwin|Alpine)/i.test(r.stdout)) {
        ctx.logger.warn('step_01', 'Outra distro detectada como default (não-Ubuntu). Vamos instalar Ubuntu e setar como default.');
      }
    } catch (_) {}

    // Caminho moderno: `wsl --install -d <distro> --no-launch`.
    // --no-launch evita Ubuntu GUI abrir no primeiro boot (step_04 cuida disso).
    //
    // Bruno v0.2.11: wslInstallSupported() retorna {supported,reason,evidence}
    // pra logar exatamente por que decidiu moderno vs legacy.
    const decision = await wslInstallSupported(ctx.logger);
    ctx.logger.info('step_01', `wsl --install decision: ${decision.supported ? 'USAR_MODERNO' : 'USAR_LEGACY'} (motivo: ${decision.reason})`);

    if (decision.supported) {
      // Bruno v0.2.12: descoberta DINÂMICA do nome de distro Ubuntu.
      // Em v0.2.11 hardcodávamos `Ubuntu-22.04`, mas alguns hosts retornavam
      // "Nome de distribuição inválido". Agora consultamos o catálogo online.
      let distro = await discoverUbuntuDistroName(ctx.logger);
      if (!distro) {
        ctx.logger.warn('step_01',
          'wsl --list --online falhou ou não retornou Ubuntu — tentando wsl --install sem -d (Ubuntu default do host).');
        distro = null; // sinaliza pra rodar sem -d
      } else {
        ctx.logger.info('step_01', `distro Ubuntu detectada: ${distro}`);
      }

      // Persiste o nome ESCOLHIDO em ctx.state ANTES de instalar — assim, se
      // der reboot e voltar, os steps 04+ já sabem qual distro usar.
      const chosenDistro = distro || 'Ubuntu';
      ctx.state.distro = chosenDistro;
      ctx.state.ubuntuDistroName = chosenDistro;
      ctx.save && ctx.save();

      const installArgs = distro
        ? ['--install', '-d', distro, '--no-launch']
        : ['--install', '--no-launch'];

      ctx.logger.info('step_01', `rodando: wsl ${installArgs.join(' ')}`);
      // Bruno v0.2.12: usa wslExec direto (UTF-16 LE decode hard-coded) em vez
      // de powershellVerbose que sofria mojibake mesmo com chcp 65001.
      const r = await withRetry(
        () => wslExec(installArgs, { timeout: 600_000, logger: ctx.logger, label: 'wsl --install' }),
        { label: 'wsl --install', attempts: 2, backoff: [10, 30], logger: ctx.logger,
          // wslExec NUNCA throw — sempre resolve com {exit_code,...}. Sinaliza
          // retry só quando exit_code != 0 E não é "já instalado".
          shouldRetry: () => true,
        }
      );

      // Bruno v0.2.12: parser ROBUSTO do output. Aceita sucesso em vários casos:
      //   - exit_code 0 ou 3010 (canônicos)
      //   - stdout indica "já instalado" / "already installed"
      //   - stdout indica reboot needed → marca rebootRequired
      const fullOut = ((r.stdout || '') + ' ' + (r.stderr || ''));
      ctx.logger.info('step_01',
        `wsl --install resultado: exit=${r.exit_code} stdout=${(r.stdout || '').slice(0, 300).replace(/\s+/g, ' ')}`);

      const stdoutLower = fullOut.toLowerCase();
      const alreadyInstalled = /already installed|j[áa] (est[áa]|foi) instalad|already exists|j[áa] existe/i.test(fullOut);
      const wantsReboot = r.exit_code === 3010
        || /restart|reinici|reboot/i.test(stdoutLower);

      // Só falha se: exit != 0/3010 E não há indicador de "já feito".
      if (r.exit_code !== 0 && r.exit_code !== 3010 && !alreadyInstalled) {
        throw new Error(`wsl --install falhou: exit=${r.exit_code} stdout=${(r.stdout || '').slice(0, 500)} stderr=${(r.stderr || '').slice(0, 300)}`);
      }

      if (alreadyInstalled) {
        ctx.logger.info('step_01', 'wsl --install OK — distro já estava instalada (idempotente)');
      } else if (wantsReboot) {
        ctx.logger.info('step_01', 'wsl --install OK — reboot pendente');
      } else {
        ctx.logger.info('step_01', 'wsl --install OK — sem reboot necessário');
      }

      // Força a distro escolhida como default (idempotente). Usa wslExec.
      try {
        await wslExec(['--set-default', chosenDistro], { timeout: 30_000, logger: ctx.logger, label: 'set-default' });
      } catch (_) {}

      // Mesmo que wsl --install não tenha sinalizado reboot, é mais SEGURO
      // forçar reboot pra primeira instalação WSL — features de virtualização
      // só ativam de verdade após restart. Custo: 1 reboot extra. Benefício:
      // zero "WslRegisterDistribution failed" no step_04.
      await _markRebootAndScheduleRunOnce(ctx, 'step_01');
      return;
    }

    // PARTE D — Fallback: Windows antigo (build <19041, raro). Volta pro
    // método dism+wsl --set-default+wsl --install que era v0.2.8.
    ctx.logger.warn('step_01', `wsl --install não suportado (motivo: ${decision.reason}) — usando fallback dism (legacy)`);
    await _executeLegacyDismFlow(ctx);
    await _markRebootAndScheduleRunOnce(ctx, 'step_01');
  },
  async validate(ctx) {
    // Se reboot pendente, segura aqui — runner libera quando rebootDone.
    if (ctx.state.rebootRequired && !ctx.state.rebootDone) return true;
    return _ubuntuInstalled();
  },
};

// Fallback legacy (dism). Só usado quando wsl --install indisponível.
async function _executeLegacyDismFlow(ctx) {
  ctx.logger.info('step_01', 'fallback: dism /enable-feature Microsoft-Windows-Subsystem-Linux');
  await powershellVerbose(
    `dism.exe /online /enable-feature /featurename:Microsoft-Windows-Subsystem-Linux /all /norestart`,
    { timeout: 600_000 }
  );
  ctx.logger.info('step_01', 'fallback: dism /enable-feature VirtualMachinePlatform');
  await powershellVerbose(
    `dism.exe /online /enable-feature /featurename:VirtualMachinePlatform /all /norestart`,
    { timeout: 600_000 }
  );
  ctx.logger.info('step_01', 'fallback: wsl --set-default-version 2');
  // wslExec direto (UTF-16 LE decodado) — antes powershellVerbose dava mojibake.
  await wslExec(['--set-default-version', '2'], { timeout: 30_000, logger: ctx.logger, label: 'set-default-v2' })
    .then(r => {
      if (r.exit_code !== 0) {
        ctx.logger.warn('step_01',
          `wsl --set-default-version 2 falhou: exit=${r.exit_code} (pode precisar reboot antes)`);
      }
    });

  // Bruno v0.2.12: descoberta dinâmica também no fallback legacy.
  let distro = await discoverUbuntuDistroName(ctx.logger);
  const chosen = distro || 'Ubuntu';
  ctx.state.distro = chosen;
  ctx.state.ubuntuDistroName = chosen;
  ctx.save && ctx.save();

  const installArgs = distro
    ? ['--install', '-d', distro, '--no-launch']
    : ['--install', '--no-launch'];

  ctx.logger.info('step_01', `fallback: wsl ${installArgs.join(' ')}`);
  await withRetry(
    () => wslExec(installArgs, { timeout: 600_000, logger: ctx.logger, label: 'wsl --install (legacy)' }),
    { label: 'wsl --install (legacy)', attempts: 2, backoff: [10, 30], logger: ctx.logger, shouldRetry: () => true }
  );
  try {
    await wslExec(['--set-default', chosen], { timeout: 30_000, logger: ctx.logger, label: 'set-default-legacy' });
  } catch (_) {}
}

// -------- step 02 — wsl default v2 (NO-OP no fluxo moderno) ---------------
// Mantido pra compat com state.json + wizard.js. `wsl --install` já configura
// default version 2. Detect retorna true se Ubuntu-22.04 está instalado (step_01
// fez), então este step pula com `skipped` sem executar nada.
const step02SetWslDefaultV2 = {
  id: 'step_02_set_wsl_default_v2',
  title: 'WSL default version 2',
  description: 'Já configurado pelo passo 1 (wsl --install). Mantido por compatibilidade.',
  category: 'AUTO',
  async detect(ctx) {
    // Se reboot pendente, considera detectado (libera o caminho).
    if (ctx.state.rebootRequired && !ctx.state.rebootDone) return true;
    // Se Ubuntu instalado, o `wsl --install` já setou default version 2.
    if (await _ubuntuInstalled()) return true;
    // Caso fluxo legacy (sem wsl --install), checa via wsl --status.
    // Bruno v0.2.12: wslExec direto (UTF-16 LE decodado).
    try {
      const r = await wslExec(['--status'], { timeout: 10_000 });
      return /(?:Default Version|Vers[aã]o padr[aã]o)\s*:\s*2/i.test(r.stdout || '');
    } catch (_) { return false; }
  },
  async execute(ctx) {
    // Defensiva: se detect retornou false (cenário raro de state corrompido),
    // roda set-default-version explícito.
    await requireAdminOrThrow();
    // Bruno v0.2.12: wslExec direto em vez de powershellVerbose.
    const r = await wslExec(['--set-default-version', '2'], { timeout: 30_000, logger: ctx.logger });
    if (r.exit_code !== 0) {
      ctx.logger.warn('step_02', `set-default-version 2 falhou: exit=${r.exit_code} stderr=${(r.stderr || '').slice(0, 200)}`);
    }
  },
  async validate(ctx) { return this.detect(ctx); },
};

// -------- step 03 — install WSL + Ubuntu (NO-OP no fluxo moderno) --------
// Mantido pra compat. `wsl --install` do step_01 já baixou e instalou.
// Detect retorna true → step é pulado como `skipped`.
const step03WslInstall = {
  id: 'step_03_wsl_install',
  title: 'WSL2 + Ubuntu instalados',
  description: 'Já feito pelo passo 1. Mantido por compatibilidade com instalações antigas.',
  category: 'HYBRID',
  // Bruno v0.2.13: shape enriquecido. Mostra apenas se reboot pendente.
  manualInstructions: {
    action: { label: 'Reiniciar Windows', kind: 'none', payload: {} },
    steps: [
      { num: 1, text: 'Se o Windows pediu reboot no passo anterior, salve seu trabalho aberto' },
      { num: 2, text: 'Reinicie o Windows agora (Iniciar → Reiniciar)' },
      { num: 3, text: 'Quando o PC voltar, este instalador abre sozinho e retoma de onde parou' },
    ],
    expected: 'Após o reboot, instalador volta automaticamente neste passo marcado como OK.',
    note: 'Não tem botão automático pra reiniciar — você reinicia o Windows manualmente quando estiver pronto.',
  },
  async detect(ctx) {
    if (ctx.state.rebootRequired && !ctx.state.rebootDone) return true;
    return _ubuntuInstalled();
  },
  async execute(ctx) {
    // Não deveria chegar aqui se step_01 funcionou. Fallback defensivo:
    // se Ubuntu não tá instalado, tenta uma vez (raro: state corrompido).
    await requireAdminOrThrow();
    ctx.logger.warn('step_03', 'step_01 deveria ter instalado Ubuntu — rodando fallback');
    // Bruno v0.2.12: descoberta dinâmica + wslExec.
    let distro = await discoverUbuntuDistroName(ctx.logger);
    const chosen = distro || 'Ubuntu';
    ctx.state.distro = chosen;
    ctx.state.ubuntuDistroName = chosen;
    ctx.save && ctx.save();
    const installArgs = distro
      ? ['--install', '-d', distro, '--no-launch']
      : ['--install', '--no-launch'];
    await withRetry(
      () => wslExec(installArgs, { timeout: 600_000, logger: ctx.logger, label: 'wsl --install (step_03)' }),
      { label: 'wsl --install (step_03 fallback)', attempts: 2, backoff: [10, 30], logger: ctx.logger, shouldRetry: () => true }
    );
    await _markRebootAndScheduleRunOnce(ctx, 'step_03');
  },
  async validate(ctx) {
    if (ctx.state.rebootRequired && !ctx.state.rebootDone) return true;
    return _ubuntuInstalled();
  },
};

// -------- step 04 — Ubuntu first boot (manual) ----------------------------
const step04UbuntuFirstBoot = {
  id: 'step_04_ubuntu_first_boot',
  title: 'Primeira boot do Ubuntu (criar usuário UNIX)',
  description: 'Usuário precisa abrir Ubuntu uma vez para criar username/senha. Não automatizável.',
  category: 'MANUAL',
  // Bruno v0.2.13: shape enriquecido (action/steps/expected/note). Camila usa
  // pra renderizar botão grande + checklist + verify.
  // Função pra que `ctx.state.distro` seja resolvido em runtime, não em load.
  manualInstructions: (ctx) => ({
    action: {
      label: '🐧 Abrir Ubuntu',
      kind: 'terminal',
      payload: { distro: (ctx && ctx.state && ctx.state.distro) || 'Ubuntu' },
    },
    steps: [
      { num: 1, text: 'Uma janela preta do Ubuntu vai abrir' },
      { num: 2, text: 'Digite um nome de usuário (letras minúsculas, sem espaço) + Enter' },
      { num: 3, text: 'Digite uma senha + Enter — não aparece nada na tela, é normal no Linux' },
      { num: 4, text: 'Digite a mesma senha de novo + Enter' },
      { num: 5, text: 'Quando ver o prompt verde "usuario@PC:~$", feche a janela e volte aqui' },
    ],
    commands: [
      { label: 'Comando pra conferir o usuário criado', code: 'whoami' },
    ],
    expected: 'Prompt verde "usuario@PC:~$" no terminal.',
    note: 'ANOTE o usuário e a senha — vai usar várias vezes nos próximos passos (apt, sudo, etc.).',
  }),
  async detect(ctx) {
    try {
      // Check default user is non-root and exists.
      const { stdout } = await wsl(`whoami`, { distro: ctx.state.distro });
      const u = stdout.trim();
      if (!u || u === 'root') return false;
      ctx.state.ubuntuUser = u;
      ctx.save();
      return true;
    } catch (_) { return false; }
  },
  async execute(ctx) {
    // Open the Ubuntu console window so user can create account.
    // Fix #A2: detectar dinamicamente qual launcher o WSL tem instalado.
    // Em PCs com "Ubuntu" genérico (AppX CanonicalGroupLimited.Ubuntu) o launcher
    // é `ubuntu.exe`; em "Ubuntu 22.04 LTS" (CanonicalGroupLimited.Ubuntu22.04LTS)
    // é `ubuntu2204.exe`. Antigamente fallback hardcoded engolia falha silenciosa.
    // Estratégia: descobrir via Get-Command quais .exe existem no PATH, e tentar
    // na ordem 2204 → ubuntu-22.04 → ubuntu → wsl -d (último recurso).
    let opened = false;
    let launcherUsed = null;

    // 1) Descobre launchers Ubuntu disponíveis (Get-Command devolve só os no PATH).
    let availableLaunchers = [];
    try {
      const probe = `
        $names = @()
        Get-Command "ubuntu*.exe" -ErrorAction SilentlyContinue | ForEach-Object { $names += $_.Name }
        $names -join ';'
      `;
      const { stdout } = await powershell(probe, { timeout: 30_000 }).catch(() => ({ stdout: '' }));
      availableLaunchers = (stdout || '').trim().split(';').filter(Boolean);
      if (availableLaunchers.length) {
        ctx.logger.info('step_04', `launchers Ubuntu encontrados: ${availableLaunchers.join(', ')}`);
      }
    } catch (_) {}

    // 2) Monta ordem de tentativas: 2204 primeiro (matches D6 do roteiro), depois alt names, depois genérico.
    const preferred = ['ubuntu2204.exe', 'ubuntu-22.04.exe', 'ubuntu.exe'];
    const tryOrder = [];
    // primeiro os preferidos que de fato existem
    for (const p of preferred) {
      if (availableLaunchers.some(n => n.toLowerCase() === p.toLowerCase())) tryOrder.push(p);
    }
    // se a probe falhou ou não achou nada, tenta cegamente na ordem preferida (Start-Process pode resolver via WindowsApps)
    if (tryOrder.length === 0) tryOrder.push(...preferred);

    for (const exe of tryOrder) {
      try {
        await powershell(`Start-Process ${exe}`, { timeout: 30_000 });
        opened = true;
        launcherUsed = exe;
        ctx.logger.info('step_04', `abriu Ubuntu via ${exe}`);
        break;
      } catch (e) {
        ctx.logger.warn('step_04', `${exe} falhou: ${e.message}`);
      }
    }

    // 3) Último recurso: abre WSL direto pela distro via Windows Terminal (cria sessão e força primeiro setup).
    if (!opened) {
      try {
        const distro = ctx.state.distro || 'Ubuntu-22.04';
        ctx.logger.warn('step_04', `nenhum launcher .exe funcionou — tentando wsl.exe -d ${distro} via terminal`);
        const { openInteractiveTerminal } = require('./shell');
        await openInteractiveTerminal(`echo "Defina seu usuário Ubuntu abaixo:" && exec bash`, {
          distro,
          title: 'IMP — Primeira boot Ubuntu',
        });
        opened = true;
        launcherUsed = `wsl.exe -d ${distro}`;
      } catch (e) {
        ctx.logger.error('step_04', `fallback wsl.exe também falhou: ${e.message}`);
      }
    }

    if (!opened) {
      throw new Error(
        'Não consegui abrir o Ubuntu automaticamente. ' +
        'Abra o Ubuntu pelo Menu Iniciar do Windows (procure "Ubuntu"), defina usuário+senha, e volte aqui.'
      );
    }

    if (launcherUsed) ctx.state.ubuntuLauncher = launcherUsed;
    ctx.save();

    // Poll until detect() succeeds, with a 10-minute window.
    // Emite progresso a cada 5s pro renderer não parecer travado (Eduardo 3.6).
    const startTs = Date.now();
    const deadline = startTs + 10 * 60 * 1000;
    let lastLogTs = 0;
    while (Date.now() < deadline) {
      if (await this.detect(ctx)) return;
      const elapsed = Math.floor((Date.now() - startTs) / 1000);
      if (Date.now() - lastLogTs >= 5000) {
        ctx.logger.info('step_04', `aguardando criação do usuário Ubuntu (${elapsed}s decorridos, timeout em 10 min)...`);
        lastLogTs = Date.now();
      }
      await new Promise(r => setTimeout(r, 3000));
    }
    throw new Error('Ubuntu não respondeu em 10 min — abra o Ubuntu manualmente pelo menu Iniciar e complete o setup de usuário.');
  },
  async validate(ctx) { return this.detect(ctx); },
};

// -------- step 05 — apt base packages -------------------------------------
const step05AptBase = {
  id: 'step_05_apt_base',
  title: 'Pacotes apt base (tmux, git, curl, build-essential, jq)',
  description: 'apt update + instalação dos pacotes mínimos.',
  category: 'AUTO',
  async detect(ctx) {
    try {
      const { stdout } = await wsl(
        `command -v tmux >/dev/null && command -v git >/dev/null && command -v curl >/dev/null && command -v cc >/dev/null && command -v jq >/dev/null && echo OK || echo MISSING`,
        { distro: ctx.state.distro, user: ctx.state.ubuntuUser }
      );
      return /OK/.test(stdout);
    } catch (_) { return false; }
  },
  async execute(ctx) {
    // Pré-check dpkg lock (Eduardo §2.4 / Patrícia §2.4). Se outra instalação travou,
    // apt-get install vai falhar feio — melhor avisar antes com instrução clara.
    try {
      const { stdout: lockOut } = await wsl(
        `(sudo -n lsof /var/lib/dpkg/lock-frontend 2>/dev/null || lsof /var/lib/dpkg/lock-frontend 2>/dev/null) | tail -n +2`,
        { distro: ctx.state.distro, user: ctx.state.ubuntuUser, timeout: 15_000 }
      ).catch(() => ({ stdout: '' }));
      if (lockOut && lockOut.trim()) {
        throw new Error(
          'instalação anterior do Ubuntu ficou pendente (dpkg lock detectado). ' +
          'Abra o Ubuntu pelo menu Iniciar, rode `sudo dpkg --configure -a` e depois `sudo apt-get -f install`, então tente de novo aqui.'
        );
      }
    } catch (e) {
      // Se a mensagem é nossa (lock detectado), propaga; senão segue.
      if (e && /dpkg lock/.test(e.message)) throw e;
    }

    // Bruno onda 3: log granular ANTES de cada operação demorada, pra UI ter
    // sinal de "tá vivo" durante o apt (que pode demorar 2-5min).
    ctx.logger.info('step_05', 'baixando lista de pacotes (apt-get update)...');
    const cmd = `DEBIAN_FRONTEND=noninteractive apt-get update -y && (echo "[imp] update ok, instalando pacotes..." >&2) && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends tmux git curl ca-certificates build-essential jq wget`;
    ctx.logger.info('step_05', 'pacotes a instalar: tmux git curl ca-certificates build-essential jq wget');
    await withRetry(
      () => sudoInWsl(cmd, {
        distro: ctx.state.distro,
        user: ctx.state.ubuntuUser,
        passwordPromise: ctx.requestSudoPassword,
        logger: ctx.logger,
        timeout: 600_000,
      }),
      { label: 'apt install base', attempts: 3, backoff: [2, 8, 30], logger: ctx.logger }
    );
    ctx.logger.info('step_05', 'apt install concluído');
  },
  async validate(ctx) { return this.detect(ctx); },
};

// -------- step 06 — Node 20 LTS via nvm -----------------------------------
const step06NodeViaNvm = {
  id: 'step_06_node_nvm',
  title: 'Node 20 LTS via nvm v0.40.4',
  description: 'Instala nvm em ~/.nvm e Node LTS (sem sudo, sem /usr/bin).',
  category: 'AUTO',
  async detect(ctx) {
    try {
      const { stdout } = await wsl(
        `[ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh" && node -v 2>/dev/null | grep -qE '^v(2[0-9]|[3-9][0-9])\\.' && echo OK || echo MISSING`,
        { distro: ctx.state.distro, user: ctx.state.ubuntuUser }
      );
      return /OK/.test(stdout);
    } catch (_) { return false; }
  },
  async execute(ctx) {
    const script = `
      set -e
      export NVM_DIR="$HOME/.nvm"
      if [ ! -s "$NVM_DIR/nvm.sh" ]; then
        curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.4/install.sh | bash
      fi
      . "$NVM_DIR/nvm.sh"
      nvm install --lts
      nvm alias default 'lts/*'
      node -v
    `;
    await withRetry(
      () => wsl(script, { distro: ctx.state.distro, user: ctx.state.ubuntuUser, timeout: 600_000, logger: ctx.logger }),
      { label: 'nvm + node lts', attempts: 3, backoff: [2, 8, 30], logger: ctx.logger }
    );
  },
  async validate(ctx) { return this.detect(ctx); },
};

// -------- step 07 — npm prefix (kept for npm-global fallback) -------------
const step07NpmPrefix = {
  id: 'step_07_npm_prefix',
  title: 'Configurar prefix npm global em ~/.npm-global (fallback)',
  description: 'Garante npm install -g sem sudo, mesmo que algo bypassse nvm.',
  category: 'AUTO',
  async detect(ctx) {
    try {
      const { stdout } = await wsl(
        `grep -q '.npm-global/bin' "$HOME/.bashrc" && echo OK || echo MISSING`,
        { distro: ctx.state.distro, user: ctx.state.ubuntuUser }
      );
      return /OK/.test(stdout);
    } catch (_) { return false; }
  },
  async execute(ctx) {
    const script = `
      mkdir -p "$HOME/.npm-global"
      npm config set prefix "$HOME/.npm-global" 2>/dev/null || true
      grep -q '.npm-global/bin' "$HOME/.bashrc" || echo 'export PATH="$HOME/.npm-global/bin:$PATH"' >> "$HOME/.bashrc"
    `;
    await wsl(script, { distro: ctx.state.distro, user: ctx.state.ubuntuUser });
  },
  async validate(ctx) { return this.detect(ctx); },
};

// -------- step 08 — Claude Code CLI (native installer) --------------------
const step08ClaudeCli = {
  id: 'step_08_claude_cli',
  title: 'Claude Code CLI (native installer)',
  description: 'curl -fsSL https://claude.ai/install.sh | bash — adiciona ~/.local/bin ao PATH.',
  category: 'AUTO',
  async detect(ctx) {
    try {
      const { stdout } = await wsl(`command -v claude >/dev/null && claude --version 2>/dev/null && echo OK || echo MISSING`,
        { distro: ctx.state.distro, user: ctx.state.ubuntuUser });
      return /OK/.test(stdout);
    } catch (_) { return false; }
  },
  async execute(ctx) {
    const script = `
      set -e
      curl -fsSL https://claude.ai/install.sh | bash
      case ":$PATH:" in
        *":$HOME/.local/bin:"*) ;;
        *) grep -q '.local/bin' "$HOME/.bashrc" || echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$HOME/.bashrc" ;;
      esac
    `;
    try {
      await withRetry(
        () => wsl(script, { distro: ctx.state.distro, user: ctx.state.ubuntuUser, timeout: 600_000, logger: ctx.logger }),
        { label: 'claude native install', attempts: 2, backoff: [5, 20], logger: ctx.logger }
      );
    } catch (e) {
      // Fallback: npm global (passo 7 já preparou prefix).
      ctx.logger.warn('claude', `native installer falhou, tentando npm fallback: ${e.message}`);
      await wsl(
        `export PATH="$HOME/.npm-global/bin:$PATH" && npm install -g @anthropic-ai/claude-code`,
        { distro: ctx.state.distro, user: ctx.state.ubuntuUser, timeout: 600_000 }
      );
    }
  },
  async validate(ctx) { return this.detect(ctx); },
};

// -------- step 09 — Claude login (MANUAL — terminal interativo) ----------
const step09ClaudeLogin = {
  id: 'step_09_claude_login',
  title: 'Login Claude Code (browser OAuth)',
  description: 'Abre terminal Windows com `claude` — usuário loga no browser e fecha.',
  category: 'MANUAL',
  // Bruno v0.2.13: shape enriquecido. Botão dispara terminal já rodando `claude`.
  manualInstructions: (ctx) => ({
    action: {
      label: '🔐 Abrir terminal pra login Claude',
      kind: 'terminal',
      payload: { distro: (ctx && ctx.state && ctx.state.distro) || 'Ubuntu', cmd: 'claude' },
    },
    steps: [
      { num: 1, text: 'Vai abrir um terminal com o Claude pedindo login' },
      { num: 2, text: 'Ele mostra um link — copia (ou aperta Enter pra abrir no navegador)' },
      { num: 3, text: 'Loga com sua conta Claude (Max ou Pro)' },
      { num: 4, text: 'Cola o código de volta no terminal + Enter' },
      { num: 5, text: 'Quando aparecer "Login successful" feche a janela e volte aqui' },
    ],
    commands: [
      { label: 'Comando pra conferir login', code: 'claude --print "responda: pong"' },
    ],
    expected: '"Login successful" no terminal e `claude --print "pong"` retorna pong.',
    note: 'Use uma conta Claude com plano ativo (Max/Pro/Team) — free não funciona pra Claude Code.',
  }),
  async detect(ctx) {
    try {
      // claude --print is non-interactive; if not logged in it returns non-zero.
      const { stdout, code } = await wsl(
        `claude --print "responda apenas: pong" 2>/dev/null | tail -c 200`,
        { distro: ctx.state.distro, user: ctx.state.ubuntuUser, timeout: 60_000 }
      ).catch(e => ({ stdout: '', code: e.code || 1 }));
      return /pong/i.test(stdout);
    } catch (_) { return false; }
  },
  async execute(ctx) {
    await openInteractiveTerminal(`claude`, { distro: ctx.state.distro, title: 'IMP — Login Claude' });
    // Poll for success (15 min window — user may pause).
    const deadline = Date.now() + 15 * 60 * 1000;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 5000));
      if (await this.detect(ctx)) return;
    }
    throw new Error('Timeout esperando login Claude — feche este passo manualmente quando o login estiver concluído.');
  },
  async validate(ctx) { return this.detect(ctx); },
};

// -------- step 10 — GitHub auth via gh device flow ------------------------
const step10GhAuth = {
  id: 'step_10_gh_auth',
  title: 'GitHub auth (gh CLI — Device Flow)',
  description: 'Instala gh CLI + gh auth login --web. Configura credential helper.',
  category: 'HYBRID',
  // Bruno v0.2.13: shape enriquecido. Botão abre terminal com `gh auth login`
  // já rodando. URL device flow vai pros `commands` pra UI mostrar botão browser.
  manualInstructions: (ctx) => ({
    action: {
      label: '🔑 Iniciar login GitHub (Device Flow)',
      kind: 'terminal',
      payload: {
        distro: (ctx && ctx.state && ctx.state.distro) || 'Ubuntu',
        cmd: 'gh auth login --hostname github.com --git-protocol https --web',
      },
    },
    steps: [
      { num: 1, text: 'Terminal abre rodando `gh auth login`' },
      { num: 2, text: 'Ele mostra um código de 8 caracteres tipo "ABCD-1234" — COPIA' },
      { num: 3, text: 'Abre github.com/login/device no navegador (botão abaixo)' },
      { num: 4, text: 'Cola o código + autoriza com sua conta GitHub' },
      { num: 5, text: 'Volta pro terminal, espera "Authentication complete", feche e volte aqui' },
    ],
    commands: [
      { label: 'URL do Device Flow GitHub', code: 'https://github.com/login/device' },
      { label: 'Comando pra conferir login', code: 'gh auth status' },
    ],
    expected: '"Authentication complete" no terminal e `gh auth status` mostra "Logged in to github.com".',
    note: 'Use uma conta GitHub que tenha acesso ao repo kennrick69/imp-squad (squad privado).',
  }),
  async detect(ctx) {
    try {
      const { stdout } = await wsl(`gh auth status 2>&1 | grep -q "Logged in to github.com" && echo OK || echo MISSING`,
        { distro: ctx.state.distro, user: ctx.state.ubuntuUser });
      return /OK/.test(stdout);
    } catch (_) { return false; }
  },
  async execute(ctx) {
    // Install gh first if missing.
    const installGh = `
      set -e
      if ! command -v gh >/dev/null; then
        (type -p wget >/dev/null || sudo apt-get install -y wget) \\
          && sudo mkdir -p -m 755 /etc/apt/keyrings \\
          && wget -qO- https://cli.github.com/packages/githubcli-archive-keyring.gpg | sudo tee /etc/apt/keyrings/githubcli-archive-keyring.gpg > /dev/null \\
          && sudo chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \\
          && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli.list > /dev/null \\
          && sudo apt-get update -y \\
          && sudo apt-get install -y gh
      fi
    `;
    await withRetry(
      () => sudoInWsl(installGh, {
        distro: ctx.state.distro,
        user: ctx.state.ubuntuUser,
        passwordPromise: ctx.requestSudoPassword,
        logger: ctx.logger,
        timeout: 600_000,
      }),
      { label: 'install gh', attempts: 2, backoff: [5, 20], logger: ctx.logger }
    );

    // Open interactive terminal for device flow.
    await openInteractiveTerminal(
      `gh auth login --hostname github.com --git-protocol https --web && gh auth setup-git && git config --global core.autocrlf input`,
      { distro: ctx.state.distro, title: 'IMP — Login GitHub' }
    );
    // Poll up to 15 min.
    const deadline = Date.now() + 15 * 60 * 1000;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 5000));
      if (await this.detect(ctx)) {
        ctx.state.githubAuthMethod = 'device-flow';
        ctx.save();
        return;
      }
    }
    throw new Error('Timeout esperando gh auth login.');
  },
  async validate(ctx) { return this.detect(ctx); },
};

// -------- step 11 — clone imp-squad ---------------------------------------
const step11CloneSquad = {
  id: 'step_11_clone_squad',
  title: 'Clonar imp-squad em /mnt/c/Projetos/_squad',
  description: 'Repo privado kennrick69/imp-squad; pasta local mantém nome _squad.',
  category: 'AUTO',
  async detect(ctx) {
    try {
      const { stdout } = await wsl(
        `[ -d /mnt/c/Projetos/_squad/.git ] && [ -f /mnt/c/Projetos/_squad/_shared/REGRAS_GERAIS.md ] && echo OK || echo MISSING`,
        { distro: ctx.state.distro, user: ctx.state.ubuntuUser }
      );
      return /OK/.test(stdout);
    } catch (_) { return false; }
  },
  async execute(ctx) {
    // Try git clone; on 404 (repo not provisioned), fall back to seeded tarball if available.
    const cloneScript = `
      set -e
      mkdir -p /mnt/c/Projetos
      cd /mnt/c/Projetos
      if [ -d _squad/.git ]; then
        git -C _squad pull --ff-only || true
      elif [ -d _squad ]; then
        echo "[_squad] existe sem .git — abortando pra não perder dados" >&2
        exit 2
      else
        if git clone https://github.com/kennrick69/imp-squad.git _squad; then
          touch _squad/${FOLDER_MARKER}
        else
          # Fallback: seed tarball at /mnt/c/Projetos/imp-installer/seeds/_squad.tar.gz
          SEED=/mnt/c/Projetos/imp-installer/seeds/_squad.tar.gz
          if [ -f "$SEED" ]; then
            mkdir -p _squad && tar -xzf "$SEED" -C _squad && touch _squad/${FOLDER_MARKER}
          else
            exit 3
          fi
        fi
      fi
    `;
    // Bruno onda 3: log granular pre-clone.
    ctx.logger.info('step_11', 'clonando kennrick69/imp-squad em /mnt/c/Projetos/_squad...');
    try {
      await withRetry(
        () => wsl(cloneScript, { distro: ctx.state.distro, user: ctx.state.ubuntuUser, timeout: 300_000, logger: ctx.logger }),
        { label: 'clone imp-squad', attempts: 3, backoff: [2, 8, 30], logger: ctx.logger }
      );
      ctx.logger.info('step_11', 'clone _squad OK');
    } catch (e) {
      // Enriquece o erro do clone usando o catalog (4.6 do Eduardo + 7.1 da Patrícia).
      // Os padrões mais comuns: exit 128 (auth), exit 3 (sem fallback), 403, "could not read from remote".
      const raw = `${e.message || ''}\n${e.stderr || ''}`;
      const enriched = enrichError('step_11_clone_squad', raw);
      const friendly = new Error(`${enriched.headline} — ${enriched.what}`);
      friendly.stderr = e.stderr;
      friendly.enriched = enriched;
      throw friendly;
    }
  },
  async validate(ctx) { return this.detect(ctx); },
};

// -------- step 12 — clone imp-orchestrator + npm install ------------------
const step12CloneOrchestrator = {
  id: 'step_12_clone_orchestrator',
  title: 'Clonar imp-orchestrator + npm install',
  description: 'Clona orquestrador e instala dependências (sem devDependencies).',
  category: 'AUTO',
  async detect(ctx) {
    try {
      const { stdout } = await wsl(
        `[ -d /mnt/c/Projetos/imp-orchestrator/.git ] && [ -d /mnt/c/Projetos/imp-orchestrator/node_modules ] && echo OK || echo MISSING`,
        { distro: ctx.state.distro, user: ctx.state.ubuntuUser }
      );
      return /OK/.test(stdout);
    } catch (_) { return false; }
  },
  async execute(ctx) {
    // Bruno onda 3: log granular pre-clone + pre-install.
    ctx.logger.info('step_12', 'clonando kennrick69/imp-orchestrator em /mnt/c/Projetos/imp-orchestrator...');
    const script = `
      set -e
      mkdir -p /mnt/c/Projetos
      cd /mnt/c/Projetos
      if [ -d imp-orchestrator/.git ]; then
        echo "[imp] orchestrator já existe — git pull --ff-only" >&2
        git -C imp-orchestrator pull --ff-only || true
      elif [ -d imp-orchestrator ]; then
        echo "[imp-orchestrator] existe sem .git — abortando" >&2; exit 2
      else
        git clone https://github.com/kennrick69/imp-orchestrator.git
        touch imp-orchestrator/${FOLDER_MARKER}
      fi
      cd imp-orchestrator
      if [ -d node_modules ]; then
        echo "[imp] node_modules existe — pulando npm install" >&2
      else
        echo "[imp] rodando npm install --omit=dev (pode demorar 1-3min)..." >&2
        npm install --omit=dev
      fi
    `;
    await withRetry(
      () => wsl(script, { distro: ctx.state.distro, user: ctx.state.ubuntuUser, timeout: 600_000, logger: ctx.logger }),
      { label: 'clone+install orchestrator', attempts: 3, backoff: [2, 8, 30], logger: ctx.logger }
    );
    ctx.logger.info('step_12', 'orchestrator + npm install OK');
  },
  async validate(ctx) { return this.detect(ctx); },
};

// -------- step 13 — Sala 3D (optional release asset) ----------------------
const step13Sala3D = {
  id: 'step_13_sala3d',
  title: 'Sala 3D (escritorio-3d) — opcional',
  description: 'Baixa release asset .zip e descompacta. Pode ser pulado e instalado depois.',
  category: 'HYBRID',
  async detect(ctx) {
    try {
      const { stdout } = await wsl(
        `[ -f /mnt/c/Projetos/escritorio-3d/index.html ] && echo OK || echo MISSING`,
        { distro: ctx.state.distro, user: ctx.state.ubuntuUser }
      );
      return /OK/.test(stdout);
    } catch (_) { return false; }
  },
  async execute(ctx) {
    // Patrícia BLOCKER #3: defensiva extra mesmo com state.migrate garantindo
    // decisions:{}. Se algum executor rodar com ctx.state vindo de origem não
    // migrada (ex.: testes diretos), não crashar.
    const strategy = (ctx.state.decisions && ctx.state.decisions.escritorio3dStrategy) || 'release-asset-on-demand';
    if (strategy === 'skip') {
      ctx.logger.info('sala3d', 'pulado por decisão do usuário');
      ctx.state.sala3dSkipped = true;
      ctx.state.sala3dSkipReason = 'usuario_pulou';
      ctx.save();
      return;
    }

    // Fix #A1: probe a release ANTES de tentar baixar. Release pode não existir
    // ainda (caso atual: kennrick69/escritorio-3d sem release publicado).
    // Se a API GitHub retorna 404, marca como skipped (não erro) e segue —
    // usuário pode instalar depois quando a release for publicada.
    const releaseUrl = 'https://api.github.com/repos/kennrick69/escritorio-3d/releases/latest';
    let releaseExists = false;
    try {
      const probe = await wsl(
        `curl -s -o /dev/null -w '%{http_code}' --max-time 15 ${releaseUrl}`,
        { distro: ctx.state.distro, user: ctx.state.ubuntuUser, timeout: 30_000 }
      ).catch(() => ({ stdout: '' }));
      const code = parseInt((probe.stdout || '').trim(), 10);
      releaseExists = code === 200;
      if (!releaseExists) {
        ctx.logger.info('sala3d',
          `release não publicada ainda (HTTP ${code || 'erro'}). ` +
          `Sala 3D ainda não disponível — usuário pode instalar depois quando estiver publicada.`
        );
      }
    } catch (e) {
      ctx.logger.warn('sala3d', `probe release falhou: ${e.message} — assumindo indisponível`);
      releaseExists = false;
    }

    if (!releaseExists) {
      // Graceful skip por default — NÃO é erro.
      ctx.state.sala3dSkipped = true;
      ctx.state.sala3dSkipReason = 'sala_3d_release_indisponivel';
      ctx.save();
      return;
    }

    // Release existe — segue download normal.
    const script = `
      set -e
      mkdir -p /mnt/c/Projetos/escritorio-3d
      cd /tmp
      curl -fsSL --retry 3 -o escritorio-3d.zip \\
        https://github.com/kennrick69/escritorio-3d/releases/latest/download/escritorio-3d.zip
      # unzip pode não estar instalado em Ubuntu mínimo — tenta python3 como fallback
      if command -v unzip >/dev/null; then
        unzip -qo escritorio-3d.zip -d /mnt/c/Projetos/escritorio-3d/
      else
        python3 -c "import zipfile; zipfile.ZipFile('escritorio-3d.zip').extractall('/mnt/c/Projetos/escritorio-3d/')"
      fi
      touch /mnt/c/Projetos/escritorio-3d/${FOLDER_MARKER}
      rm -f escritorio-3d.zip
    `;
    try {
      await withRetry(
        () => wsl(script, { distro: ctx.state.distro, user: ctx.state.ubuntuUser, timeout: 900_000, logger: ctx.logger }),
        { label: 'sala 3d download', attempts: 2, backoff: [5, 30], logger: ctx.logger }
      );
    } catch (e) {
      // Mesmo se a probe disse "200" e o download falhou, não bloqueia install — vira skip.
      ctx.logger.warn('sala3d',
        `download falhou (${e.message}) — marcando como skipped, instalação principal continua.`
      );
      ctx.state.sala3dSkipped = true;
      ctx.state.sala3dSkipReason = 'download_falhou';
      ctx.save();
    }
  },
  async validate(ctx) {
    const strategy = (ctx.state.decisions && ctx.state.decisions.escritorio3dStrategy) || 'release-asset-on-demand';
    if (strategy === 'skip') return true;
    if (ctx.state.sala3dSkipped) return true; // skip aceitável (release indisponível)
    return this.detect(ctx);
  },
};

// -------- step 14 — tmux session imp with 7 panes -------------------------
const step14TmuxSession = {
  id: 'step_14_tmux_session',
  title: 'Sessão tmux `imp` com 7 painéis',
  description: '6 agentes (lider, arquiteto, criativo, debugger, qa, revisor) + main.',
  category: 'AUTO',
  async detect(ctx) {
    try {
      const { stdout } = await wsl(
        `tmux has-session -t imp 2>/dev/null && [ "$(tmux list-panes -t imp 2>/dev/null | wc -l)" = "7" ] && echo OK || echo MISSING`,
        { distro: ctx.state.distro, user: ctx.state.ubuntuUser }
      );
      return /OK/.test(stdout);
    } catch (_) { return false; }
  },
  async execute(ctx) {
    const script = `
      set -e
      SESSION="imp"
      SQUAD_ROOT="/mnt/c/Projetos/_squad"
      ORCH_ROOT="/mnt/c/Projetos/imp-orchestrator"
      if tmux has-session -t "$SESSION" 2>/dev/null; then
        # Per decision D5: respect if healthy (7 panes). Else recreate.
        if [ "$(tmux list-panes -t "$SESSION" | wc -l)" = "7" ]; then
          exit 0
        fi
        tmux kill-session -t "$SESSION"
      fi
      tmux new-session -d -s "$SESSION" -n agents -c "$SQUAD_ROOT/lider"
      for dir in arquiteto criativo debugger qa revisor; do
        tmux split-window -t "$SESSION" -c "$SQUAD_ROOT/$dir"
        tmux select-layout -t "$SESSION" tiled
      done
      tmux split-window -t "$SESSION" -c "$ORCH_ROOT"
      tmux select-layout -t "$SESSION" tiled
      tmux set -t "$SESSION" -g pane-border-status top
      PANES=( $(tmux list-panes -t "$SESSION" -F '#{pane_id}') )
      LABELS=(lider arquiteto criativo debugger qa revisor main)
      for i in "\${!PANES[@]}"; do
        tmux select-pane -t "\${PANES[$i]}" -T "\${LABELS[$i]}"
      done
      for pid in "\${PANES[@]}"; do
        tmux send-keys -t "$pid" 'claude' C-m
      done
    `;
    await wsl(script, { distro: ctx.state.distro, user: ctx.state.ubuntuUser, timeout: 60_000, logger: ctx.logger });
  },
  async validate(ctx) { return this.detect(ctx); },
};

// -------- step 15 — download imp-interface portable + shortcut -----------
const step15DownloadInterface = {
  id: 'step_15_download_interface',
  title: 'Baixar IMP-Squad-Comando + atalho Desktop',
  description: 'Pega o release latest (com fallback v0.3.1) e cria shortcut Squad Comando.lnk.',
  category: 'AUTO',
  async detect() {
    try {
      const script = `
        $desktop = [Environment]::GetFolderPath("Desktop")
        $lnk = Join-Path $desktop 'Squad Comando.lnk'
        if ((Test-Path $lnk) -and (Test-Path "$env:LOCALAPPDATA\\IMP-Squad\\IMP-Squad.exe")) { 'OK' } else { 'MISSING' }
      `;
      const { stdout } = await powershell(script);
      return /OK/.test(stdout);
    } catch (_) { return false; }
  },
  async execute(ctx) {
    const ps = `
      $ErrorActionPreference = 'Stop'
      $ExeDir  = "$env:LOCALAPPDATA\\IMP-Squad"
      $ExePath = "$ExeDir\\IMP-Squad.exe"
      $Desktop = [Environment]::GetFolderPath("Desktop")
      $LnkPath = Join-Path $Desktop 'Squad Comando.lnk'
      New-Item -ItemType Directory -Force -Path $ExeDir | Out-Null

      # Resolve latest release URL via GitHub API; fallback to pinned v0.3.1.
      $UrlLatest = $null
      try {
        $api = Invoke-RestMethod -Uri 'https://api.github.com/repos/kennrick69/imp-interface/releases/latest' -Headers @{ 'User-Agent' = 'imp-installer' } -TimeoutSec 15
        $asset = $api.assets | Where-Object { $_.name -like '*portable*.exe' } | Select-Object -First 1
        if ($asset) { $UrlLatest = $asset.browser_download_url }
      } catch {}
      if (-not $UrlLatest) {
        $UrlLatest = 'https://github.com/kennrick69/imp-interface/releases/download/v0.3.1/IMP-Squad-Comando-0.3.1-portable.exe'
      }

      curl.exe -L --fail --retry 3 -o $ExePath $UrlLatest
      if (-not (Test-Path $ExePath)) { throw "Download falhou: $UrlLatest" }

      $WshShell = New-Object -ComObject WScript.Shell
      $Shortcut = $WshShell.CreateShortcut($LnkPath)
      $Shortcut.TargetPath       = $ExePath
      $Shortcut.WorkingDirectory = $ExeDir
      $Shortcut.IconLocation     = "$ExePath,0"
      $Shortcut.Description      = 'IMP Squad - Painel de Comando'
      $Shortcut.Save()
      "OK"
    `;
    await withRetry(
      () => powershell(ps, { timeout: 600_000 }),
      { label: 'download interface', attempts: 3, backoff: [5, 20, 60], logger: ctx.logger }
    );
  },
  async validate() { return this.detect(); },
};

// -------- step 16 — end-to-end validation ---------------------------------
const step16ValidateEndToEnd = {
  id: 'step_16_e2e',
  title: 'Validação end-to-end',
  description: 'Confirma que sessão imp tem 7 panes com claude vivo + .exe pronto pra abrir.',
  category: 'AUTO',
  async detect() {
    // E2E is always re-run on demand.
    return false;
  },
  async execute(ctx) {
    // 1) tmux has 7 panes
    const { stdout: p } = await wsl(`tmux list-panes -t imp 2>/dev/null | wc -l`,
      { distro: ctx.state.distro, user: ctx.state.ubuntuUser });
    if (parseInt(p.trim(), 10) !== 7) throw new Error(`sessão imp não tem 7 panes (achou ${p.trim()})`);

    // 2) At least one pane shows claude prompt activity
    const { stdout: cap } = await wsl(`tmux capture-pane -t imp.0 -p -S -100 | tail -50`,
      { distro: ctx.state.distro, user: ctx.state.ubuntuUser });
    if (!/claude|>|■|│/i.test(cap)) {
      ctx.logger.warn('e2e', 'pane 0 não mostra prompt do Claude — pode estar carregando ainda');
    }

    // 3) interface .exe and shortcut exist
    const { stdout } = await powershell(`
      $desktop = [Environment]::GetFolderPath("Desktop")
      $lnk = Join-Path $desktop 'Squad Comando.lnk'
      if ((Test-Path $lnk) -and (Test-Path "$env:LOCALAPPDATA\\IMP-Squad\\IMP-Squad.exe")) { 'OK' } else { 'MISSING' }
    `);
    if (!/OK/.test(stdout)) throw new Error('Squad Comando shortcut/.exe ausente');
  },
  async validate() { return true; },
};

// Ordered list — runner iterates this.
const ALL_STEPS = [
  step00Preflight,
  step01EnableFeatures,
  step02SetWslDefaultV2,
  step03WslInstall,
  step04UbuntuFirstBoot,
  step05AptBase,
  step06NodeViaNvm,
  step07NpmPrefix,
  step08ClaudeCli,
  step09ClaudeLogin,
  step10GhAuth,
  step11CloneSquad,
  step12CloneOrchestrator,
  step13Sala3D,
  step14TmuxSession,
  step15DownloadInterface,
  step16ValidateEndToEnd,
];

module.exports = {
  ALL_STEPS,
  step00Preflight,
  step01EnableFeatures,
  step02SetWslDefaultV2,
  step03WslInstall,
  step04UbuntuFirstBoot,
  step05AptBase,
  step06NodeViaNvm,
  step07NpmPrefix,
  step08ClaudeCli,
  step09ClaudeLogin,
  step10GhAuth,
  step11CloneSquad,
  step12CloneOrchestrator,
  step13Sala3D,
  step14TmuxSession,
  step15DownloadInterface,
  step16ValidateEndToEnd,
};
