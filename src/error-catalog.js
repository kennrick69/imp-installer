'use strict';

// Catálogo de erros amigáveis. Mapeia stepId + padrão regex → mensagem humana.
// Cada entrada: { match: RegExp ou função, headline, what, suggestions[], canRetry, canSkip }
//
// `enrichError(stepId, errorMessage)` retorna a primeira entrada que casa, ou um fallback genérico.
// Texto baseado em RISCOS-INSTALACAO.md (Patrícia).

const ENTRIES = [
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
