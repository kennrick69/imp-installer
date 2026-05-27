'use strict';

// Catálogo de erros amigáveis. Mapeia stepId + padrão regex → mensagem humana.
// Cada entrada: { match: RegExp ou função, headline, what, suggestions[], canRetry, canSkip }
//
// `enrichError(stepId, errorMessage)` retorna a primeira entrada que casa, ou um fallback genérico.
// Texto baseado em RISCOS-INSTALACAO.md (Patrícia).

const ENTRIES = [
  // ─── FASE 2 — runtime MSYS2 embarcado (Bruno 2026-05-27) ──────────────

  {
    stepId: '*',
    match: /RUNTIME_ARCHIVE_MISSING|runtime\.7z não foi gerado/i,
    headline: 'Arquivo do runtime ausente no instalador',
    what: 'O instalador foi construído sem o runtime.7z embarcado. Sem ele, não há como copiar o ambiente.',
    suggestions: [
      'Se você está rodando uma build dev: rode `scripts/build-runtime.ps1` numa máquina Windows pra gerar `resources/runtime.7z`.',
      'Se baixou de um release: baixe novamente, o arquivo veio incompleto.',
    ],
    canRetry: false,
    canSkip: false,
  },
  {
    stepId: '*',
    match: /RUNTIME_DISK_FULL|disco encheu|precisa de \d+ GB livres/i,
    headline: 'Disco cheio — preciso de 2 GB livres',
    what: 'O drive de destino (geralmente C:) não tem espaço suficiente pra copiar o runtime.',
    suggestions: [
      'Libere ao menos 2 GB no drive C: (execute "Limpeza de Disco" do Windows).',
      'Apague arquivos grandes em Downloads/Vídeos/Documents.',
      'Tente de novo — o instalador faz um pré-check antes de copiar.',
    ],
    canRetry: true,
    canSkip: false,
  },
  {
    stepId: '*',
    match: /AV_QUARANTINE|antivírus pode ter removido|binários|tmux\.exe ausente|bash\.exe ausente/i,
    headline: 'Antivírus removeu arquivos do runtime',
    what: 'Seu antivírus achou que `tmux.exe`/`bash.exe`/`nc.exe` são suspeitos e removeu silenciosamente. São ferramentas de terminal antigas, inofensivas.',
    suggestions: [
      'Adicione a pasta do runtime como exceção no Defender (o instalador oferece um botão pra fazer isso com 1 clique — precisa admin).',
      'Se for Avast/Kaspersky/Trend: abra o painel do antivírus, vá em Exclusões, adicione `%LOCALAPPDATA%\\IMP-Squad-Runtime\\`.',
      'Restaure os arquivos quarentenados manualmente OU clique "Tentar de novo" depois da exclusão.',
    ],
    canRetry: true,
    canSkip: false,
  },
  {
    stepId: '*',
    match: /APPLOCKER_BLOCKED|AppLocker corporativo bloqueia/i,
    headline: 'AppLocker corporativo bloqueia execução',
    what: 'Seu PC tem AppLocker (política corporativa) que impede executar programas em pastas pessoais. O runtime não vai rodar até o TI liberar.',
    suggestions: [
      'Peça ao TI corporativo pra adicionar uma exceção AppLocker — o instalador gerou o XML de regra pronto em `~/.imp-installer/applocker-rule.xml`.',
      'Alternativa: rodar o instalador como admin pra extrair em `%PROGRAMDATA%` (algumas políticas liberam essa pasta).',
      'Sem liberação do TI, este PC não vai rodar a squad.',
    ],
    canRetry: false,
    canSkip: false,
  },
  {
    stepId: '*',
    match: /RUNTIME_BASH_MISSING|RUNTIME_7Z_TOOL_MISSING/i,
    headline: 'Ferramentas internas do runtime ausentes',
    what: 'O runtime extraído está incompleto (faltam binários esperados). Pode ser extração corrompida ou AV agindo no meio.',
    suggestions: [
      'Verifique se o antivírus removeu arquivos (vide opção acima).',
      'Apague `%LOCALAPPDATA%\\IMP-Squad-Runtime\\` e tente de novo do zero.',
      'Se persistir, baixe o instalador novamente.',
    ],
    canRetry: true,
    canSkip: false,
  },
  {
    stepId: 'step_x4_launch_tmux',
    match: /tmux launch falhou|not a terminal|open terminal failed/i,
    headline: 'tmux não conseguiu subir a sessão',
    what: 'O tmux precisa de um terminal PTY pra rodar. No Windows isso depende do ConPTY do MSYS2.',
    suggestions: [
      'Tente de novo — primeira chamada às vezes falha por timing.',
      'Se persistir, abra o `imp-squad.bat` manualmente (em %LOCALAPPDATA%\\IMP-Squad-Runtime\\current\\scripts\\) e rode `tmux new-session -s imp`.',
    ],
    canRetry: true,
    canSkip: false,
  },

  // ─── steps 01/02/03 — admin gate (Bruno live-test #3) ─────────────────
  // Cobertura caso a flag NEEDS_ADMIN escape do interceptor em main.js
  // (defesa em profundidade). Caminho normal: main.js trata e emite
  // installer:onNeedsAdmin sem chegar aqui.
  {
    stepId: 'step_01_enable_features',
    match: /precisa de administrador|NEEDS_ADMIN|Access.*denied|requires elevation/i,
    headline: 'Preciso de administrador',
    what: 'Este passo configura o Windows (WSL) e o sistema só permite isso com privilégios de administrador.',
    suggestions: [
      'Clico em "Reabrir como administrador" no aviso amarelo (recomendado)',
      'OU feche este instalador, clique nele com botão direito e escolha "Executar como administrador"',
    ],
    canRetry: true,
    canSkip: false,
  },
  {
    stepId: 'step_02_set_wsl_default_v2',
    match: /precisa de administrador|NEEDS_ADMIN|Access.*denied|requires elevation/i,
    headline: 'Preciso de administrador',
    what: 'Este passo configura o Windows (WSL) e o sistema só permite isso com privilégios de administrador.',
    suggestions: [
      'Clico em "Reabrir como administrador" no aviso amarelo (recomendado)',
      'OU feche este instalador, clique nele com botão direito e escolha "Executar como administrador"',
    ],
    canRetry: true,
    canSkip: false,
  },
  {
    stepId: 'step_03_wsl_install',
    match: /precisa de administrador|NEEDS_ADMIN|requires elevation/i,
    headline: 'Preciso de administrador',
    what: 'Este passo configura o Windows (WSL) e o sistema só permite isso com privilégios de administrador.',
    suggestions: [
      'Clico em "Reabrir como administrador" no aviso amarelo (recomendado)',
      'OU feche este instalador, clique nele com botão direito e escolha "Executar como administrador"',
    ],
    canRetry: true,
    canSkip: false,
  },

  // ─── step_03 — WSL install ─────────────────────────────────────────────
  {
    stepId: 'step_03_wsl_install',
    match: /access (?:is )?denied|access denied|elevation|administrator|requires elevation/i,
    headline: 'Permissão de administrador negada',
    what: 'O Windows recusou a instalação do WSL porque o instalador não está rodando como administrador.',
    suggestions: [
      'Feche este instalador e abra de novo com o botão direito → "Executar como administrador".',
      'Se já abriu como admin, verifique se o UAC não cancelou a elevação.',
    ],
    canRetry: false,
    canSkip: false,
  },
  {
    stepId: 'step_03_wsl_install',
    match: /virtual machine platform|VirtualMachinePlatform|hypervisor|HCS_E_HYPERV_NOT_INSTALLED|0x80370102/i,
    headline: 'Virtualização não está habilitada no BIOS',
    what: 'O WSL2 precisa que a virtualização (Intel VT-x / AMD-V) esteja ligada no firmware do PC.',
    suggestions: [
      'Reinicie o PC e entre no BIOS/UEFI (geralmente F2, F10 ou DEL ao ligar).',
      'Procure por "Virtualization Technology", "Intel VT-x", "AMD-V" ou "SVM" e habilite.',
      'Salve, reinicie e tente de novo.',
    ],
    canRetry: true,
    canSkip: false,
  },
  {
    stepId: 'step_03_wsl_install',
    match: /0x80072f8f|0x80070005|download.*fail|could not download/i,
    headline: 'Falha ao baixar o WSL2 / Ubuntu',
    what: 'O Windows não conseguiu baixar o pacote do WSL ou da imagem Ubuntu-22.04.',
    suggestions: [
      'Confirme que a internet está estável (abra https://github.com no navegador).',
      'Se a empresa usa proxy, configure-o nas variáveis do Windows.',
      'Tente novamente em alguns minutos.',
    ],
    canRetry: true,
    canSkip: false,
  },

  // ─── step_05 — apt base ────────────────────────────────────────────────
  {
    stepId: 'step_05_apt_base',
    match: /dpkg.*lock|Could not get lock|frontend.*locked|E:\s*dpkg|dpkg --configure -a/i,
    headline: 'Instalação anterior do Ubuntu ficou pendente',
    what: 'O apt detectou um lock do dpkg — outra instalação travou ou foi interrompida.',
    suggestions: [
      'Abra o Ubuntu pelo menu Iniciar.',
      'Rode: sudo dpkg --configure -a',
      'Depois: sudo apt-get -f install',
      'Volte aqui e clique "Tentar de novo".',
    ],
    canRetry: true,
    canSkip: false,
  },
  {
    stepId: 'step_05_apt_base',
    match: /sudo:.*(incorrect password|3 incorrect|sorry, try again)/i,
    headline: 'Senha do Ubuntu incorreta',
    what: 'A senha digitada não corresponde ao usuário do Ubuntu.',
    suggestions: [
      'Tente de novo — é a senha do usuário Linux que você criou no passo "Primeira boot do Ubuntu".',
      'Se esqueceu: abra o Ubuntu pelo menu Iniciar, faça o reset e volte aqui.',
    ],
    canRetry: true,
    canSkip: false,
  },
  {
    stepId: 'step_05_apt_base',
    match: /Unable to (?:fetch|locate)|Could not resolve|Temporary failure resolving|503\s|404\s/i,
    headline: 'apt não conseguiu baixar pacotes',
    what: 'Repositórios do Ubuntu não responderam (rede instável, DNS, ou espelho fora do ar).',
    suggestions: [
      'Verifique sua conexão.',
      'Aguarde 1 min e tente de novo.',
      'Se persistir, abra o Ubuntu e rode: sudo apt-get update — vai mostrar qual repositório está com problema.',
    ],
    canRetry: true,
    canSkip: false,
  },

  // ─── step_10 — gh auth ─────────────────────────────────────────────────
  {
    stepId: 'step_10_gh_auth',
    match: /timeout esperando gh auth|timeout/i,
    headline: 'Login GitHub não foi concluído a tempo',
    what: 'Esperamos 15 min pelo login do gh CLI e ele não terminou.',
    suggestions: [
      'Abra o terminal de novo e complete o login no browser.',
      'No final, volte aqui e clique "Tentar de novo".',
    ],
    canRetry: true,
    canSkip: false,
  },
  {
    stepId: 'step_10_gh_auth',
    match: /HTTP 403|403 Forbidden|rate limit/i,
    headline: 'GitHub recusou a autenticação (403)',
    what: 'O GitHub recusou a requisição — pode ser rate-limit, conta sem permissão, ou token expirado.',
    suggestions: [
      'Aguarde 5 min (rate-limit costuma liberar rápido).',
      'Confirme que sua conta GitHub tem acesso ao repo kennrick69/imp-squad.',
      'Tente de novo.',
    ],
    canRetry: true,
    canSkip: false,
  },

  // ─── step_11 — clone _squad ────────────────────────────────────────────
  {
    stepId: 'step_11_clone_squad',
    match: /403|forbidden|could not read from remote|repository not found|authentication failed|exit (?:status )?128|fatal: could not read/i,
    headline: 'Não consegui clonar o repo da squad (privado)',
    what: 'O repo kennrick69/imp-squad é privado — sua conta GitHub precisa ter sido adicionada como colaboradora.',
    suggestions: [
      'Verifique se você foi adicionada/o como colaboradora no repo kennrick69/imp-squad.',
      'Confirme que o login do gh CLI (passo anterior) foi com a conta correta — rode `gh auth status` no Ubuntu.',
      'Se acabou de ser adicionada, espere 1 min e tente de novo.',
    ],
    canRetry: true,
    canSkip: false,
  },
  {
    stepId: 'step_11_clone_squad',
    match: /exit (?:status )?3$|seed.*not found|tarball/i,
    headline: 'Clone falhou e não há tarball de fallback',
    what: 'Nem o git clone nem o seed local (_squad.tar.gz) funcionaram.',
    suggestions: [
      'Verifique se sua conta GitHub tem acesso ao repo kennrick69/imp-squad.',
      'Refaça o login do gh CLI no passo anterior.',
      'Como último recurso, peça ao JOs um arquivo _squad.tar.gz e coloque em /mnt/c/Projetos/imp-installer/seeds/',
    ],
    canRetry: true,
    canSkip: false,
  },

  // ─── network genéricos (qualquer step) ────────────────────────────────
  {
    stepId: '*',
    match: /curl:\s*\(6\)|could not resolve host|getaddrinfo|ENOTFOUND/i,
    headline: 'Sem conexão com a internet',
    what: 'O DNS não respondeu — provavelmente Wi-Fi caiu ou está num modo offline.',
    suggestions: [
      'Confirme que está conectada(o) à internet (abra https://github.com).',
      'Se tem VPN, desligue temporariamente.',
      'Tente de novo.',
    ],
    canRetry: true,
    canSkip: false,
  },
  {
    stepId: '*',
    match: /curl:\s*\(7\)|connection refused|ECONNREFUSED/i,
    headline: 'Conexão recusada pelo servidor',
    what: 'O servidor existe mas recusou a conexão (pode ser firewall, antivírus, ou serviço fora do ar).',
    suggestions: [
      'Verifique se algum antivírus / firewall está bloqueando o instalador.',
      'Espere 1 min e tente de novo.',
    ],
    canRetry: true,
    canSkip: false,
  },
  {
    stepId: '*',
    match: /fatal:\s|git.*exit (?:status )?128/i,
    headline: 'Git falhou na operação',
    what: 'O git encontrou um erro — credenciais, rede, ou arquivos corrompidos.',
    suggestions: [
      'Confirme que o login do GitHub está válido (`gh auth status` no Ubuntu).',
      'Verifique sua conexão.',
      'Tente de novo.',
    ],
    canRetry: true,
    canSkip: false,
  },

  // ─── WSL legacy/MSI/loop (Bruno noturna 2026-05-27 — fluxo WSL moderno) ──
  {
    stepId: '*',
    match: /WSL_LEGACY_DETECTED|wsl[\s_-]?state=legacy|inbox legad/i,
    headline: 'Seu Windows tem WSL antigo',
    what: 'O Windows 10 veio com uma versão antiga do WSL (inbox/legacy). O instalador vai baixar a versão moderna automaticamente.',
    suggestions: [
      'Clique em "Tentar de novo" — o instalador vai baixar e instalar o WSL2 moderno.',
      'A instalação pode pedir 1 reboot do Windows pra ativar o kernel novo.',
    ],
    canRetry: true,
    canSkip: false,
  },
  {
    stepId: '*',
    match: /WSL_MSI_INSTALL_FAILED|MSI install exit|n[ãa]o consegui (baixar|instalar) o WSL/i,
    headline: 'Não consegui instalar o WSL2 (MSI)',
    what: 'Falhei ao baixar/instalar o pacote MSI do WSL moderno do GitHub Microsoft.',
    suggestions: [
      'Verifique sua conexão (abra https://github.com).',
      'Se a empresa usa proxy/firewall, libere github.com e githubusercontent.com.',
      'Antivírus muito agressivo (Avast, Norton) pode bloquear MSI baixado — desligue temporariamente.',
      'Tente de novo em alguns minutos.',
    ],
    canRetry: true,
    canSkip: false,
  },
  {
    stepId: '*',
    match: /WSL_TOO_MANY_REBOOTS|Reinícios excessivos|rebootCount/i,
    headline: 'Reinícios excessivos sem sucesso',
    what: 'Já fizemos 3+ reinícios e o WSL ainda não está funcionando. Algo no Windows está impedindo o WSL de subir.',
    suggestions: [
      'Verifique se a virtualização (Intel VT-x / AMD-V / SVM) está habilitada no BIOS.',
      'Se tem VirtualBox/VMware instalado, ele pode estar conflitando com Hyper-V — desinstale e tente de novo.',
      'Exporte os logs e mande pro JOs — diagnóstico mais profundo necessário.',
    ],
    canRetry: false,
    canSkip: false,
  },

  // ─── WSL não funcional (Bruno v0.2.16 — live-test #3 causa raiz real) ──
  // Sintoma: features WSL habilitadas + distro listada, MAS qualquer comando
  // `wsl` mostra apenas a tela de help. Causa raiz: reboot do Windows nunca
  // aconteceu, então o kernel WSL não ativou. wsl --update sem efeito sem
  // reboot do host. Único caminho: REINICIAR.
  //
  // IMPORTANTE: precisa vir ANTES da entrada genérica "/reboot pendente/" mais
  // abaixo — senão a mensagem genérica intercepta (porque a string de erro
  // contém "reboot pendente"). Ordem do array = ordem de prioridade.
  {
    stepId: '*',
    match: /WSL (ainda )?n[ãa]o (est[áa] )?funcional|wsl mostra help|WSL incompleto|reboot pendente.*WSL/i,
    headline: 'O WSL precisa de um reinício do Windows',
    what: 'As features do WSL foram habilitadas, mas o Windows precisa REINICIAR pra ativar o kernel do WSL. Sem reboot, qualquer comando `wsl` mostra a tela de ajuda em vez de funcionar.',
    suggestions: [
      'Salve qualquer trabalho aberto e reinicie o Windows agora.',
      'Quando voltar, o instalador reabre sozinho e continua de onde parou.',
      'Se já reiniciou e ainda dá esse erro: abra um cmd como administrador e rode `wsl --update`, depois tente de novo aqui.',
    ],
    canRetry: true,
    canSkip: false,
  },

  // ─── reboot ────────────────────────────────────────────────────────────
  {
    stepId: '*',
    match: /reboot pendente|reinicie o windows/i,
    headline: 'Reinicie o Windows antes de continuar',
    what: 'O passo anterior (instalação do WSL2) exige reboot. O instalador volta automaticamente.',
    suggestions: [
      'Salve seu trabalho e reinicie o PC agora.',
      'Quando o Windows voltar, o instalador abre sozinho (via RunOnce).',
      'Se não abrir, abra ele manualmente — vai retomar de onde parou.',
    ],
    canRetry: false,
    canSkip: false,
  },

  // ─── tmux ──────────────────────────────────────────────────────────────
  {
    stepId: 'step_14_tmux_session',
    match: /no server running|failed to connect to server/i,
    headline: 'tmux não conseguiu subir',
    what: 'O servidor do tmux não respondeu.',
    suggestions: [
      'Abra o Ubuntu pelo menu Iniciar e rode: tmux kill-server',
      'Volte aqui e clique "Tentar de novo".',
    ],
    canRetry: true,
    canSkip: false,
  },
];

// Fallback genérico.
const GENERIC = {
  headline: 'Algo deu errado',
  what: 'O passo falhou e o erro não bate com nenhum padrão conhecido.',
  suggestions: [
    'Tente de novo — às vezes é só rede instável.',
    'Se persistir, clique em "Exportar logs" e mande pro JOs.',
  ],
  canRetry: true,
  canSkip: true,
};

function enrichError(stepId, errorMessage) {
  // Defensiva (Bruno — live-test #1): enrichError é chamado em catch handlers
  // críticos, ele MESMO nunca pode lançar. Qualquer falha aqui = silent fallback.
  try {
    const msg = String(errorMessage == null ? '' : errorMessage);
    for (const e of ENTRIES) {
      try {
        if (e.stepId !== '*' && e.stepId !== stepId) continue;
        const hit = e.match instanceof RegExp
          ? e.match.test(msg)
          : (typeof e.match === 'function' && e.match(msg));
        if (hit) {
          return {
            stepId: stepId || null,
            headline: e.headline,
            what: e.what,
            suggestions: Array.isArray(e.suggestions) ? e.suggestions.slice() : [],
            canRetry: e.canRetry !== false,
            canSkip: e.canSkip === true,
            raw: msg.slice(0, 500),
          };
        }
      } catch (_) { /* entrada malformada — pula */ }
    }
    return {
      stepId: stepId || null,
      headline: GENERIC.headline,
      what: msg ? `${GENERIC.what}\n\nDetalhe técnico: ${msg.slice(0, 300)}` : GENERIC.what,
      suggestions: GENERIC.suggestions.slice(),
      canRetry: GENERIC.canRetry,
      canSkip: GENERIC.canSkip,
      raw: msg.slice(0, 500),
    };
  } catch (_) {
    // Fallback ABSOLUTO — nunca propaga.
    return {
      stepId: stepId || null,
      headline: 'Erro desconhecido',
      what: 'Algo deu errado e nem o enriquecimento do erro funcionou.',
      suggestions: ['Exporte os logs e mande pro JOs.'],
      canRetry: true,
      canSkip: true,
      raw: '',
    };
  }
}

module.exports = { enrichError, ENTRIES };
