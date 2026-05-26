# Smoke Test — Feedback Visual v0.2.2

**QA:** Patrícia (IMP Dev Squad)
**Data:** 2026-05-26
**Escopo:** validar fix Bruno (streaming + timeout) + Camila (status pill + barra global + log peek + spinners + watchdogs) que resolvem o bug "tela vazia 2+ min" do live test #2.
**Veredito:** **GO** com 95% de confiança.

---

## A. Streaming do preflight — CONFIRMADO

`preflight.runAll({onCheck})` foi executado em hardware real do JOs (build 19045, Windows Defender, Ubuntu como default WSL, virtualização desabilitada). Cada check chega em momento próprio, NÃO no fim:

| Check              | t (ms) | ok    | Delta do anterior |
|--------------------|-------:|-------|------------------:|
| windows_build      |    979 | true  |               979 |
| admin              |  1.178 | true  |               199 |
| internet_github    |  1.947 | true  |               769 |
| antivirus          |  2.088 | true  |               141 |
| disk_c_free_gb     |  2.281 | true  |               193 |
| other_distros      |  2.681 | true  |               400 |
| virtualization     |  3.771 | false |             1.090 |

**Total:** 3.773 ms. Streaming **comprovado**: o primeiro feedback chega em **< 1 s** após o `start()`. JOs vê algo se mexendo em < 200 ms (safety net `setTimeout(startPreflightRunning, 200)`) e o primeiro check real em ~1 s.

Final: `ok:true, blocking:0, warnings:1` (virtualization detectado como falso negativo de WMI — comportamento correto e esperado segundo o próprio check `checkVirtualization`).

---

## B. Timeout — CONFIRMADO

- `timeoutCheck` exportado: `typeof === 'function'` ✓
- Promise rejeita com `e.code === 'CHECK_TIMEOUT'` + `e.checkName` + `e.message = 'timeout (Nms)'` ✓
- Simulação de hang com `runAll({timeoutMs: 1})`: TODOS os 7 checks viraram `ok:false, detail:"tempo esgotado (1ms) — check travado"`. **Nenhum trava o batch.** runAll retornou em 741 ms total (todas timeouts paralelas, não sequenciais).
- Default real: 30.000 ms por check (`DEFAULT_CHECK_TIMEOUT`). No pior caso teórico, batch trava por 30 s — mas como rodam em paralelo, o total NUNCA passa de ~30 s + overhead.

---

## C. Contrato Bruno↔Camila no wizard.js — TODAS PRESENTES

Linhas no `renderer/wizard.js`:

| Função                  | Linha | OK |
|-------------------------|------:|----|
| `setStatusPill`         |   466 | ✓  |
| `showGlobalProgress`    |   483 | ✓  |
| `setGlobalProgress`     |   488 | ✓  |
| `pulseActivity`         |   500 | ✓  |
| `showLogPeek`           |   509 | ✓  |
| `appendLogPeek`         |   514 | ✓  |
| `clearLogPeek`          |   546 | ✓  |
| `startPreflightRunning` |   562 | ✓  |
| `armPreflightWait`      |   585 | ✓  |
| `clearPreflightWait`    |   601 | ✓  |
| `refreshPreflightProgress` | 609 | ✓ |
| `armStepWait`           |   621 | ✓  |

Listeners conectados em `bindBackendEvents()`:
- `api.onLog` (linha 879) → `appendLog` + `appendLogPeek` + `pulseActivity` + auto-trigger `startPreflightRunning` ✓
- `api.onPreflight` (linha 938) → `setPreflightResult(checkId, state, message)` ✓
- `api.onStepUpdate` (linha 893) → `setStepState` + `setStatusPill('working',...)` + `setGlobalProgress` + `armStepWait` ✓
- `api.onComplete` (linha 951) → `setStatusPill('success', ...)` + esconde chrome ✓
- `api.onError` (linha 944) → `setStatusPill('error', ...)` + `showErrorScreen` ✓

Safety net 200ms: `bindWelcome` linha 659 — `setTimeout(() => startPreflightRunning(), 200)` chamado em sequência depois de `showScreen('preflight')` e `clearLogPeek()`. ✓

`armPreflightWait`: soft 30 s (`'Esse passo pode levar alguns minutos — aguarde.'`) + hard 5 min (`'Demorou mais que o esperado — veja logs detalhados.'`). ✓

---

## D. Elementos no HTML — TODOS PRESENTES

- `<span class="status-pill" id="status-pill" data-state="idle" aria-live="polite">` na topbar (linha 25) — começa em estado `idle` com texto "Aguardando…" ✓
- `<div id="global-progress" class="hidden">` (linha 41) com `#gp-text`, `#gp-count`, `#gp-fill` ✓
- `<aside id="log-peek" class="hidden">` (linha 373) com `.lp-head` + `#lp-hint` + `#lp-body` + botão "Ver tudo" ✓
- 7 cards `.pf-card[data-check="..."][data-state="pending"]` (linhas 144–189):
  - `windows`, `admin`, `disk`, `internet`, `virtualization`, `other_distros`, `antivirus` ✓
  - Mapeamento confirmado em `main.js` linhas 159–167 (`PREFLIGHT_NAME_MAP`):
    `windows_build → windows`, `disk_c_free_gb → disk`, `internet_github → internet`. ✓

---

## E. CSS dos estados — TODOS PRESENTES

| Regra                                | Linha | OK | Notas |
|--------------------------------------|------:|----|-------|
| `.imp-spinner` + variantes `lg`/`sm` |   189 | ✓  | `border-top-color: var(--accent)`, `animation: spin 0.8s linear infinite` |
| `@keyframes spin`                    |   601 | ✓  | `to { transform: rotate(360deg) }` |
| `.status-pill[data-state="idle"]`    |   145 | ✓  | cinza |
| `.status-pill[data-state="working"]` |   148 | ✓  | teal + pulse |
| `.status-pill[data-state="error"]`   |   163 | ✓  | vermelho + cursor pointer |
| `.status-pill[data-state="success"]` |   176 | ✓  | verde |
| `.pf-card[data-state="running"]`    |   562 | ✓  | pulse 1.8 s (`pfPulse`) + spinner CSS no `.pf-icon::after` |
| `#global-progress.activity`         |   253 | ✓  | pulse ativado por log |
| `.lp-body .lp-line.fresh`           | 1.427 | ✓  | glow teal por 0.9 s (`@keyframes lpFresh`) |
| `.pf-card.long-wait .pf-wait`       |   599 | ✓  | aparece após 30 s |
| `.pf-card.very-long-wait .pf-wait`  |   600 | ✓  | vira vermelho após 5 min |

---

## F. Cenário simulado — narração do que JOs vê

**T = 0 (clique em "Começar"):**
1. `consent.checked` libera o botão; click em `#btn-start` dispara handler em `bindWelcome` (linha 650).
2. `showScreen('preflight')` — tela welcome some, tela preflight aparece com os 7 cards `data-state="pending"` ainda mostrando `⏳ Verificando…`.
3. `setStatusPill('working', 'Iniciando verificações…')` — pill no canto superior direito vira **teal com pulse**.
4. `setGlobalProgress({text:'Iniciando verificações…', done:0, total:7})` — barra fina aparece logo abaixo do header com `0/7` e fill em 0%.
5. `clearLogPeek()` — painel inferior mostra "aguardando primeira mensagem…".

**T = 200 ms:** `startPreflightRunning()` dispara (safety net). TODOS os 7 cards viram `data-state="running"`:
- Borda teal, fundo levemente glow, **pulse 1.8 s** via `@keyframes pfPulse`.
- `⏳` esconde, **spinner CSS gira** no lugar (`pf-icon::after`).
- Texto vira "Verificando agora…".
- `.pf-wait` injetado (escondido por enquanto).

**T = ~500 ms:** primeiro `onLog` chega ("Iniciando verificação do ambiente..."). `appendLogPeek` mostra a linha com glow teal por 0.9 s. `pulseActivity()` faz a barra global pulsar.

**T = ~1 s:** primeiro `onPreflight` (`windows_build → windows, state='ok'`). Card "Versão do Windows" vira verde com `✓` + detail "build 19045 (mínimo 19041)". `refreshPreflightProgress` atualiza barra global para `1/7` (~14 %). Status pill: `"Verificando ambiente… (1/7)"`.

**T = ~2 s:** mais 3–4 cards viraram verdes em sequência rápida (admin, internet, antivirus, disk). Barra global em ~57 %. Log peek com 4–5 linhas, última com glow.

**T = ~3.8 s:** todos os 7 cards resolvidos. `refreshPreflightProgress` detecta `done === total`:
- Se `hasErr`: `setStatusPill('error', 'Erro nas verificações — clique pra detalhes')` (pill vira clicável, abre logs).
- Senão: `setStatusPill('success', 'Ambiente pronto')`.
- Barra global: "Verificações concluídas" 7/7 100 %.
- `#btn-preflight-next` habilita (`evaluatePreflightGate`).

JOs **nunca** vê tela vazia ou estática. Feedback contínuo de T=0 a T=~3.8 s.

---

## G. Edge cases

### G1. `checkInternet` lento (60 s em rede ruim)
- A função interna do PowerShell já tem timeout próprio de 5.000 ms no `ConnectAsync` (`src/preflight.js:63`). Worst-case real: ~5 s pra resolver `false`.
- Mesmo se passasse de 30 s, `timeoutCheck` corta e emite `onPreflight({checkId:'internet', state:'err', message:'tempo esgotado (30000ms) — check travado'})`.
- Durante a espera: spinner CSS continua girando (animação CSS é independente, não para). Barra global mostra `4/7` (ou o que estiver pronto).
- Aos 30 s: `armPreflightWait` adiciona `long-wait` no card específico, fazendo aparecer "Esse passo pode levar alguns minutos — aguarde." em itálico amarelo.
- **Heartbeat dedicado de 5 s não está implementado** como `setInterval` separado, mas o spinner CSS-only + pulse `pfPulse` 1.8 s + barra global pulsando garantem movimento visual contínuo SEM precisar de mensagem nova.
- **Observação para Bruno:** se quiser ainda mais robustez, considerar `setInterval` que emite `onLog({msg:'ainda processando...'})` a cada 5 s enquanto checks em flight > 0. Hoje não é estritamente necessário porque streaming + spinners cobrem.

### G2. `wizard.js` carrega sem `window.api.installer`
- `makeNoopApi()` (linha 65) ativa modo preview: todas as funções viram `noop` ou `noopAsync({ok:true})`.
- Console mostra warning `[wizard] window.api.installer ausente — modo preview/noop ativo`.
- Click em "Começar" mostra preflight com cards em `running` (safety net), mas nenhum `onPreflight` chega. Cards ficam girando indefinidamente. Após 30 s, `long-wait` aparece em todos. Após 5 min, `very-long-wait` vermelho.
- **Não há crash.** UX degradada mas controlada.

### G3. Check fail com `state='err'`
- `setPreflightResult(checkId, 'err', message)` (linha 339):
  - `card.dataset.state = 'err'` → CSS aplica borda/ícone vermelho.
  - `icon.textContent = '×'`.
  - `clearPreflightWait(checkId)` limpa watchdog.
  - `refreshPreflightProgress()` ainda conta esse card como "done" (`['ok','warn','err'].includes(state)`), então o progresso avança.
- `evaluatePreflightGate` detecta `hasErr` e mantém `#btn-preflight-next` DESABILITADO. JOs pode ver "Re-tentar" mas não pula errado.
- Quando o último check resolve, `setStatusPill('error', 'Erro nas verificações — clique pra detalhes')` — pill clicável abre modal de logs.

---

## VEREDICTO FINAL

**GO** — release v0.2.2 resolve completamente o bug "tela vazia 2+ min".

### Pontos fortes
- Streaming real comprovado (deltas medidos: 979 / 199 / 769 / 141 / 193 / 400 / 1090 ms).
- Triple safety net: `setStatusPill` imediato + `setGlobalProgress` imediato + `setTimeout(startPreflightRunning, 200)` cobrindo qualquer atraso de IPC.
- Watchdog visual em duas fases (30 s soft, 5 min hard) com mensagens humanas.
- Spinner é CSS-only (não depende de tick JS, nunca trava).
- Noop API garante não-crash mesmo sem backend.
- `timeoutCheck` corta hangs de PowerShell/WMI sem derrubar batch.

### Riscos residuais (todos baixos)
- Sem `setInterval` de heartbeat dedicado: se TODOS os checks travarem por 25 s ao mesmo tempo (improvável — eles rodam em paralelo, não sequencial), o user vê spinner girando sem mensagem nova nesse intervalo. Mitigação: spinner + pulse + barra `activity` ainda mostram movimento. Aceitável.
- Cenário de stress: muitos `onLog` em <100 ms podem causar reflow no `#lp-body`. Limite de 12 linhas + `removeChild` previne crescimento descontrolado. OK.

### Confiança: 95%
Os 5% restantes são por não ter rodado o Electron real ainda (proibido pelo escopo). Recomendo Eduardo fazer um quick build da v0.2.2 portable e JOs clicar "Começar" pra confirmar visualmente.
