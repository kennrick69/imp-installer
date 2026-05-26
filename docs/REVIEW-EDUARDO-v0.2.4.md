# REVIEW EDUARDO — IMP Squad Instalador v0.2.4

**Foco:** fix do bug "tela trava na verificação sem botão" (live test #4 do JOs).
**Mudanças:** Bruno em `wizard.js` (runPreflightFlow / schedulePreflightAdvance / cancelPreflightAdvance / advanceToProgress / evaluatePreflightGate({force})). Camila em `index.html` linhas 192-200 (footer sticky + hint + label span) e `style.css` (.preflight-foot, pulse-ready, [data-state=countdown], .preflight-footer-hint, prefers-reduced-motion).

---

## VEREDITO: GO COM RESSALVAS

**Blockers:** 0
**Altos:** 3
**Médios:** 4
**Nits:** 5

O fix da causa raiz está correto e suficiente pra desbloquear o JOs no live test. Os altos são caminhos secundários (race de eventos atrasados, ausência de cancel-stay, label-span órfão) que NÃO travam o avanço quando o backend retorna `ok:true` — que é o caso esperado no desktop do JOs.

---

## 1. Bug Fix — análise de correção da causa raiz

| Item | Status | Observação |
|---|---|---|
| `runPreflightFlow()` usa `await api.start()` (Opção 3) | ✅ OK | linha 721. Retorno é fonte da verdade. |
| `schedulePreflightAdvance()` agenda 3s + countdown no botão | ✅ OK | linha 738-765. `setInterval` 1s decrementa. |
| `evaluatePreflightGate({force:true})` ignora `pending`/`running` | ✅ OK | linha 390 — `allDone = force \|\| !pending`. |
| Cancel em **recheck** | ✅ OK | linha 823. |
| Cancel em **modal-error** | ✅ OK | linha 487 (dentro de `showErrorModal`). |
| Cancel em **click no botão** | ✅ OK | linha 778 (dentro de `advanceToProgress`). |
| `api.start()` rejeita → handler | ✅ OK | linha 730 catch + toast + setStatusPill('error'). |

**Conclusão:** a causa raiz (gate só re-avaliado dentro de `setPreflightResult`) está resolvida. Backend agora dita a verdade via `res.ok`, e o force=true contorna cards UI travados em race.

---

## 2. Regressões — possíveis brechas

### 🟠 ALTO #1 — Race: `onPreflight` atrasado pode desabilitar botão mid-countdown
Linha 372: `setPreflightResult()` sempre chama `evaluatePreflightGate()` **sem `force:true`**. Cenário:
1. `api.start()` resolve `ok:true` → `schedulePreflightAdvance` → botão habilitado, countdown rodando.
2. Evento atrasado `onPreflight({checkId: 'antivirus', state: 'running'})` chega (latência IPC).
3. `setPreflightResult` → `evaluatePreflightGate()` (sem force) → vê estado `running` → `btn.disabled = true`.
4. Pulso teal some, botão fica cinza, mas `setInterval` continua e dispara `advanceToProgress()` em 0.

**Sintoma para JOs:** botão pisca/apaga durante os 3s — pode parecer que travou de novo, mesmo que avance no final.

**Sugestão (não implementar agora):** guardar `ui.preflightAdvance.gateForced = true` e respeitar no `evaluatePreflightGate`. Ou: parar de chamar `evaluatePreflightGate` em eventos `onPreflight` depois que advance foi agendado.

**Risco real para o live test do JOs:** baixo — só se IPC for lento o suficiente.

### 🟠 ALTO #2 — Sem affordance "ficar na tela" durante o countdown
Sem botão "Cancelar avanço" ou tecla Escape mapeada pra cancelar o countdown. JOs querendo ler warnings precisa clicar **Recheck** (que re-roda preflight todo) ou apertar **Continuar agora** (que avança). Não há "pausa".

**Mitigação atual:** 3s + toast informa "Avançando em 3s". Tolerável pra fluxo feliz, ruim se JOs quiser pensar.

### 🟠 ALTO #3 — `<span id="btn-preflight-next-label">` é morto
HTML linha 199 envolve o label num span. wizard.js linhas 754/761/773 chamam `btn.textContent = ...`, o que **destrói o span**. Funciona porque ninguém mais consulta `#btn-preflight-next-label`, mas é dívida — qualquer dev futuro vai assumir que o span é a fonte. Recomendo Bruno ou trocar `btn.textContent` por `$('#btn-preflight-next-label').textContent`, ou Camila remover o span.

### 🟡 MÉDIO #4 — Hint âmbar/verde do footer (`#preflight-footer-hint`) nunca aparece
HTML inicia o hint com atributo `hidden`. **Não encontrei nenhum lugar em wizard.js que faça `hint.hidden = false` ou ajuste `data-tone`.** CSS tem variante `.preflight-footer-hint[data-tone="warn"]` que nunca é ativada. A "hint âmbar pra warnings" prometida pela Camila não está conectada. Funcional: toast cobre a mensagem. Visual: o slot do hint fica vazio entre recheck e botão.

### 🟡 MÉDIO #5 — `[data-state="countdown"]` CSS órfão
`style.css:675` define variante âmbar pro botão em countdown. wizard.js nunca seta `btn.dataset.state = 'countdown'` (o HTML inicializa com `"waiting"`). O botão countdown fica **teal** em vez do âmbar planejado. Não bloqueia, mas o "alerta visual de tempo correndo" foi perdido.

### 🟡 MÉDIO #6 — Catch de `api.start()` deixa UI semi-travada
Linha 730: se `start()` lança, mostra toast e pill de erro mas **não volta pra welcome nem mostra botão "voltar"**. Recheck continua disponível, mas se a falha for ambiente (sem WSL etc.) o recheck também falhará. JOs pode ficar olhando pra tela com pill vermelho e sem saída clara. Considerar `showErrorModal` no catch ou mostrar botão "voltar".

### 🟡 MÉDIO #7 — `ui.preflightAdvance` nunca é zerado
`cancelPreflightAdvance` só limpa `timer`. O objeto persiste com `origLabel` da execução anterior. Em runs subsequentes pode confundir log/debug. Nit funcional. Sugiro `ui.preflightAdvance = null` ao final de `advanceToProgress`.

---

## 3. UX

| Critério | Resultado |
|---|---|
| Toast aparece | ✅ "Ambiente pronto! Avançando em 3s…" |
| Countdown visível no botão | ✅ "Continuar agora (3)" → (2) → (1) |
| Footer sticky | ✅ `position: sticky; bottom: 0` (CSS:636) |
| Botão pulsante teal | ✅ `pulse-ready` 1.5s infinite (CSS:666) |
| Variante âmbar countdown | ❌ ver MÉDIO #5 |
| Hint de warnings | ❌ ver MÉDIO #4 |
| 3s pra cancelar | 🟡 apertado — se backend demora 30s+ e JOs piscou, perde |

---

## 4. Acessibilidade

| Critério | Resultado |
|---|---|
| `aria-describedby` no botão | ✅ HTML:198 aponta pra `preflight-footer-hint` |
| `disabled` removido corretamente | ✅ linha 752 + via evaluatePreflightGate |
| Countdown anunciado (aria-live) | ❌ sem `aria-live` no botão ou hint. Screen reader não fala "3, 2, 1" |
| `prefers-reduced-motion` mata pulse | ✅ regra blanket em style.css:1652-1657 cobre `pulse-ready` |
| `aria-describedby` aponta pra `[hidden]` | 🟡 ATs ignoram referência a elementos hidden |

### 🟢 NIT a11y
Adicionar `aria-live="polite"` no `#btn-preflight-next-label` (ou container) faria o leitor de tela anunciar o countdown. Não bloqueia o JOs (vidente).

---

## 5. Bundle

- `package.json` versão `0.2.4` ✅
- `build.files` cobre `main.js`, `preload.js`, `src/**/*`, `renderer/**/*` ✅
- `src/` permanece com 7 arquivos (Bruno só mexeu em `wizard.js`) ✅
- Nenhum novo arquivo introduzido nesta versão ✅
- Exclusão de `docs/**` mantida ✅
- `asar:true`, `compression:normal` ✅

**Sem regressão de empacotamento.**

---

## NITs (cosméticos, não bloqueantes)

- 🟢 #N1 — Noop API em wizard.js (linha 74) não inclui `runAll`, `pause`, `reset` — só importa em modo preview standalone.
- 🟢 #N2 — Em `advanceToProgress` (linha 782), se `api.runAll` falhar/throw e o usuário já está na tela de progress, fica em tela em branco de progresso sem 17 passos. Toast aparece, mas sem caminho de recuperação.
- 🟢 #N3 — `cancelPreflightAdvance({keepBtnLabel: false})` deixa o botão com a última string do countdown (ex.: "Continuar agora (1)"). `advanceToProgress` muda de tela, então invisível — mas se voltar via `onScreen('preflight')` o botão mostra label velho.
- 🟢 #N4 — `schedulePreflightAdvance` lê `warnings = (preflightResult && preflightResult.warnings || []).length` — precedência: `&&` antes do `||`, então se `preflightResult` for null vira `[].length = 0`. OK, só feio. Parênteses extras ajudariam.
- 🟢 #N5 — Aria a11y: `aria-live="polite"` no label do countdown (ver seção 4).

---

## CHECKLIST FINAL

- [x] Bug raiz fixado (gate avalia force=true após start ok)
- [x] Auto-advance 3s funciona no caminho feliz
- [x] Cancel cobre recheck/modal-error/click
- [x] CSS pulse-ready + sticky footer entregues
- [x] prefers-reduced-motion respeitado
- [x] Bundle limpo, sem novos arquivos
- [ ] Hint do footer ativado (Camila esqueceu hook) — MÉDIO #4
- [ ] Variante countdown âmbar ativada — MÉDIO #5
- [ ] aria-live no countdown — NIT a11y
- [ ] Race de `onPreflight` atrasado neutralizada — ALTO #1

---

## RECOMENDAÇÃO

**GO COM RESSALVAS** — release v0.2.4 pode ir pro live test #5 do JOs. No fluxo feliz (preflight rápido, sem warnings, IPC saudável) o JOs **vai avançar da verificação pra instalação dos 17 passos sem trava**. Os 3 altos são caminhos secundários que pioram a experiência mas não bloqueiam o avanço.

**Próximo sprint (v0.2.5):** endereçar MÉDIO #4 (hint conectado), MÉDIO #5 (data-state countdown), ALTO #1 (gate forçado persistente), ALTO #3 (label-span).

---

— Eduardo, revisor IMP Dev Squad
2026-05-26
