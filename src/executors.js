'use strict';

const { powershell, wsl, sudoInWsl, openInteractiveTerminal, withRetry, scheduleRunOnceAfterReboot, shSingleQuote } = require('./shell');
const preflight = require('./preflight');
const { enrichError } = require('./error-catalog');

// Each executor exports: { id, title, description, category, detect, execute, validate, manualInstructions? }
//   detect():    Promise<boolean>  — true if step is already done (skip).
//   execute():   Promise<void>     — perform work. May throw to mark error.
//   validate():  Promise<boolean>  — confirm completion. False -> mark error.
//   category:    'AUTO' | 'MANUAL' | 'HYBRID'
//
// `ctx` is passed at runtime and contains: { state, save, logger, events, requestSudoPassword, ... }

const FOLDER_MARKER = '.imp-installer-managed';

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

// -------- step 01 — enable WSL features -----------------------------------
const step01EnableFeatures = {
  id: 'step_01_enable_features',
  title: 'Habilitar features WSL + VirtualMachinePlatform',
  description: 'dism.exe habilita Microsoft-Windows-Subsystem-Linux e VirtualMachinePlatform.',
  category: 'AUTO',
  async detect() {
    const script = `
      $w  = (Get-WindowsOptionalFeature -Online -FeatureName Microsoft-Windows-Subsystem-Linux).State
      $vm = (Get-WindowsOptionalFeature -Online -FeatureName VirtualMachinePlatform).State
      "$w|$vm"
    `;
    try {
      const { stdout } = await powershell(script);
      return /Enabled\|Enabled/i.test(stdout.trim());
    } catch (_) {
      return false;
    }
  },
  async execute() {
    await powershell(`dism.exe /online /enable-feature /featurename:Microsoft-Windows-Subsystem-Linux /all /norestart`);
    await powershell(`dism.exe /online /enable-feature /featurename:VirtualMachinePlatform /all /norestart`);
  },
  async validate() { return this.detect(); },
};

// -------- step 02 — wsl default v2 ----------------------------------------
const step02SetWslDefaultV2 = {
  id: 'step_02_set_wsl_default_v2',
  title: 'wsl --set-default-version 2',
  description: 'Garante que distros novas instalem como WSL2.',
  category: 'AUTO',
  async detect() {
    try {
      // shell.js decodeWslOutput desfaz mojibake UTF-16 LE de wsl.exe (#A4).
      // Regex tolera EN ("Default Version") e PT-BR ("Versão padrão").
      const { stdout } = await powershell(`wsl --status 2>&1`);
      return /(?:Default Version|Vers[aã]o padr[aã]o)\s*:\s*2/i.test(stdout);
    } catch (_) { return false; }
  },
  async execute() {
    await powershell(`wsl --set-default-version 2`);
  },
  async validate() { return this.detect(); },
};

// -------- step 03 — install WSL + Ubuntu (reboot trigger) -----------------
const step03WslInstall = {
  id: 'step_03_wsl_install',
  title: 'Instalar WSL2 + Ubuntu-22.04 (requer reboot)',
  description: 'Baixa kernel WSL2 + imagem Ubuntu-22.04. Pós-execução o Windows precisa reiniciar.',
  category: 'HYBRID',
  manualInstructions:
    'Depois que o WSL terminar de instalar, o Windows VAI precisar reiniciar. ' +
    'Salve seu trabalho. Quando o PC voltar, este instalador abre sozinho e retoma de onde parou.',
  async detect() {
    try {
      // decodeWslOutput em shell.js cobre o UTF-16 LE de wsl.exe (#A4).
      const { stdout } = await powershell(`wsl -l -v 2>&1`);
      // Ubuntu-22.04 present and version 2 (locale-agnostic: o "2" é numérico).
      return /Ubuntu-22\.04[\s\S]*\b2\b/m.test(stdout) || /Ubuntu[\s\S]*\b2\b/m.test(stdout);
    } catch (_) { return false; }
  },
  async execute(ctx) {
    // Checa se há outra distro como default (Debian/Kali/etc) e avisa.
    try {
      const { stdout: list } = await powershell(`wsl -l -v 2>&1`).catch(() => ({ stdout: '' }));
      if (list && /\*\s+(Debian|Kali|openSUSE|SLES|Oracle|Pengwin|Alpine)/i.test(list)) {
        ctx.logger.warn('step_03', 'Outra distro detectada como default (não-Ubuntu). Vamos instalar Ubuntu-22.04 mesmo assim e setar como default.');
      }
    } catch (_) {}

    await withRetry(
      () => powershell(`wsl --install -d Ubuntu-22.04 --no-launch`, { timeout: 600_000 }),
      { label: 'wsl --install', attempts: 2, backoff: [10, 30], logger: ctx.logger }
    );

    // Força Ubuntu-22.04 como default (idempotente; ignora erro se já é).
    try {
      await powershell(`wsl --set-default Ubuntu-22.04`).catch(() => {});
    } catch (_) {}

    // Mark reboot required; runner will halt and schedule RunOnce.
    ctx.state.rebootRequired = true;
    ctx.state.rebootDone = false;
    ctx.save();

    if (ctx.exePath) {
      try { await scheduleRunOnceAfterReboot(ctx.exePath); } catch (e) {
        ctx.logger.warn('reboot', `RunOnce schedule falhou: ${e.message}`);
      }
    }
  },
  async validate() { return this.detect(); },
};

// -------- step 04 — Ubuntu first boot (manual) ----------------------------
const step04UbuntuFirstBoot = {
  id: 'step_04_ubuntu_first_boot',
  title: 'Primeira boot do Ubuntu (criar usuário UNIX)',
  description: 'Usuário precisa abrir Ubuntu uma vez para criar username/senha. Não automatizável.',
  category: 'MANUAL',
  manualInstructions:
    'Abra a janela do Ubuntu que apareceu, defina seu usuário (em minúsculas, ex: jos) e uma senha. ' +
    'Quando ver o prompt "<user>@PC:~$", volte aqui — o instalador detecta sozinho e segue.',
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
  manualInstructions:
    'Um terminal vai abrir com o Claude pedindo login. Faça login no browser que abrir, ' +
    'depois feche a janela do terminal. O instalador segue automaticamente.',
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
  manualInstructions:
    'Vou abrir um terminal com `gh auth login --web`. Ele vai mostrar um código curto ' +
    '(ex.: ABCD-1234) e abrir o GitHub no seu browser. Cole o código, autorize com sua conta ' +
    'GitHub, e feche a janela do terminal. O instalador detecta sozinho e segue.',
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
