# TESTE v0.2.4 — Patrícia (QA)

Data: 2026-05-26
Foco: validar fix do bug "tela trava na verificação sem botão" da v0.2.3.
Método: análise estática de `renderer/wizard.js`, `renderer/style.css`, `renderer/index.html`, cruzamento com contrato de `main.js`. `node --check wizard.js` OK.

## Veredito final

**GO-COM-RESSALVAS.** O fix do Bruno resolve o bug raiz (gate travado em pending forever) e o caminho feliz do JOs (0 blockers + 2 warnings) funciona. Há **3 ressalvas cosméticas/observabilidade** (não-bloqueantes) e **1 edge case real** que merece atenção em v0.2.5.

Confiança que JOs vê o botão E pode avançar pra Passo 1: **alta (~92%)**.

---

## Resultado dos testes

### Teste 1 — Cenário JOs (0 blockers + 2 warnings) — PASSA

Rastreio do fluxo em `wizard.js`:

1. `bindWelcome()` linha 797: click em `#btn-start` → `runPreflightFlow()`.
2. `runPreflightFlow()` linha 710-734:
   - `showScreen('preflight')` (714)
   - `await api.start()` (721)
   - Backend retorna `{ ok: true, preflight: { ok: true, blocking: [], warnings: [w1, w2] } }` (contrato confirmado em `main.js:293`)
   - Como `res.ok !== false`, cai em `schedulePreflightAdvance(res.preflight)` (729).
3. `schedulePreflightAdvance(preflightResult)` linha 738-765:
   - `cancelPreflightAdvance()` limpa timer prévio (739).
   - `evaluatePreflightGate({ force: true })` (740) — chave do fix: força gate aberto mesmo com cards pending.
   - `warnings.length === 2` → `baseLabel = "Ambiente pronto com 2 aviso(s). Avançando em 3s…"` (743) — CONFERE com brief.
   - `toast(baseLabel, 'info', 3500)` (745).
   - `setStatusPill('success', 'Ambiente pronto (2 aviso)')` (746).
   - `btn.disabled = false` + `btn.textContent = "Continuar agora (3)"` (752-754).
   - `setInterval(... 1000)` decrementa 3 → 2 → 1; em `count <= 0` chama `advanceToProgress()` (758).
4. `advanceToProgress()` linha 777-786:
   - `showScreen('progress')` (779).
   - `api.runAll()` (782) — IPC confirmado em `preload.js:18` + `main.js:303`.

**Conclusão:** JOs vê o botão verde-teal pulsando com countdown "(3)→(2)→(1)" e em ~3s é levado pra tela de progresso com os 17 passos rodando.

### Teste 2 — Cenário 0 blockers + 0 warnings — PASSA

Mesma rota; `warnings.length === 0` → label "Ambiente pronto! Avançando em 3s…" (744). CONFERE com brief.

### Teste 3 — Cenário 1+ blockers — PASSA

1. `api.start()` retorna `{ ok: false, ..., preflight: { ok: false, blocking: [...] } }` (`main.js:289`).
2. Em paralelo, `main.js:283-287` emite `onError` com payload de blocking.
3. Em `runPreflightFlow` linha 724-727: `res.ok === false` → `setStatusPill('error', ...)` + `return`. `schedulePreflightAdvance` NÃO é chamado. CONFERE.
4. `onError` (linha 1096-1104) chama `showErrorModal(payload)`.
5. `showErrorModal` linha 487 chama `cancelPreflightAdvance()` — defesa em profundidade.
6. `evaluatePreflightGate` linha 391: como `force=false` (default) e cards podem estar pending, gate fica disabled. Combinado com nunca chamar `schedulePreflightAdvance`, botão NÃO habilita. CONFERE.

### Teste 4 — Cancel hooks — PASSA

- **Recheck durante countdown** (`bindPreflight` linha 822-843): primeira linha é `cancelPreflightAdvance()` (823). `clearInterval(adv.timer)` em linha 770. CONFERE.
- **Click "Continuar agora" durante countdown** (linha 844-847): chama `advanceToProgress()` que chama `cancelPreflightAdvance({ keepBtnLabel: false })` (778) antes de trocar tela. CONFERE — cancela timer e avança imediato.
- **Modal-error abre durante countdown**: `showErrorModal` chama `cancelPreflightAdvance()` na linha 487. CONFERE — Bruno cumpriu o que disse.

### Teste 5 — CSS visual — PASSA com 1 ressalva

- `.preflight-foot { position: sticky; bottom: 0; z-index: 10; }` (style.css:630-640) — OK. Gradiente de bg pra disfarçar borda. Boa prática.
- `#btn-preflight-next:not(:disabled)` gradiente teal #0D9488→#14B8A6 + `pulse-ready` 1.5s infinite (style.css:662-672) — OK. Paleta teal canônica do JOs (alinhado com perfil dele).
- `#btn-preflight-next[data-state="countdown"]:not(:disabled)` gradiente âmbar F59E0B→FBBF24 (style.css:675-679) — CSS existe, mas **RESSALVA #1**: `wizard.js` NÃO seta `data-state="countdown"` em lugar nenhum durante o countdown. O HTML tem `data-state="waiting"` inicial (index.html:198), e o JS só muda `textContent`. Resultado: o botão fica **teal** durante o countdown em vez de âmbar. CSS âmbar é dead code hoje.
- `.preflight-footer-hint[data-tone="warn"]` âmbar (style.css:702-706) — CSS OK, mas **RESSALVA #2**: o JS não toca em `#preflight-footer-hint` nem no `data-tone`. O hint permanece `hidden` (index.html:194). O usuário recebe a info via toast, mas o hint persistente abaixo do botão fica oculto. Perde-se reforço visual pós-toast (toast some em 3.5s).

### Teste 6 — node --check wizard.js — PASSA

`node --check /mnt/c/Projetos/imp-installer/renderer/wizard.js` → `SYNTAX OK`. Confirmado.

---

## Edge cases analisados

### EC1 — Backend nunca retorna `ok:true` (silencioso, sem throw)

Se `api.start()` retorna `{ ok: undefined }` ou `null`: a condição `res && res.ok === false` (724) é falsa → cai em `schedulePreflightAdvance(res && res.preflight)`. Como `preflight` é undefined, `warnings = []` (default em linha 741), e o auto-advance dispara como "0 warnings". **Isso é um problema sutil:** se houve bug no backend retornando undefined, o instalador avança mesmo assim. Não é regressão (v0.2.3 também não tratava), mas merece um `if (!res || typeof res.ok !== 'boolean')` em v0.2.5.

Se `api.start()` **trava sem resolver nunca** (promise pendente eterna): `await` na linha 721 nunca volta → tela fica em "Iniciando verificações…" forever. NÃO há timeout. O safety-net de 200ms (linha 719) marca cards como running, mas o gate continua locked. **JOs continuaria preso** nesse cenário, sem botão. Bruno não cobriu timeout no `api.start()`. RECOMENDO `Promise.race` com timeout de 5min em v0.2.5.

Se `api.start()` lança: `catch` linha 730-733 mostra toast de erro + status pill. OK.

### EC2 — Race: `onPreflight` chega DEPOIS de `api.start()` resolver

Cenário: `api.start()` resolveu `ok:true`, `schedulePreflightAdvance` rodou, `evaluatePreflightGate({force:true})` liberou botão. Daí chega um `onPreflight({state:'pending'})` atrasado. Esse evento chama `setPreflightResult` → `evaluatePreflightGate()` (linha 372) **SEM force** → como `pending=true`, o gate é re-fechado (`btn.disabled = !allDone || hasErr` linha 391).

**Isso é um bug latente.** Se o evento late chegar durante o countdown, o botão fica disabled enquanto o JS ainda decrementa o textContent. Click do JOs em "Continuar agora" funciona via `addEventListener` mesmo com `disabled=true`? NÃO — botão disabled não emite click. Resultado: o `setInterval` continua e ao chegar em 0 chama `advanceToProgress()` direto (sem depender do click), então **avança mesmo assim** após 3s. Mas o UX fica estranho: botão fica cinza durante countdown se evento atrasou.

**RESSALVA #3:** `evaluatePreflightGate()` deveria respeitar uma flag `ui.preflightAdvance` ativa e nunca re-disabled o botão. Fix simples: `if (ui.preflightAdvance?.timer) return;` no topo da função. Não bloqueante pra v0.2.4 (auto-advance via setInterval salva), mas confunde.

### EC3 — `position:sticky` compat

Electron usa Chromium recente — sticky funciona universalmente desde Chrome 56 (2017). Sem risco. O container pai `.screen` precisa ter `overflow:visible` (ou não-overflow:hidden) pra sticky funcionar. Não verifiquei explicitamente, mas o gradiente bg cobrindo a transição sugere que Camila testou visualmente. **Baixo risco.**

---

## Achados resumidos

| # | Severidade | Onde | O quê |
|---|---|---|---|
| 1 | LOW (cosmético) | wizard.js + style.css | Botão countdown não recebe `data-state="countdown"` → CSS âmbar é dead code, botão fica teal durante countdown |
| 2 | LOW (UX) | wizard.js + index.html | `#preflight-footer-hint` nunca é desabilitado/preenchido pelo JS → reforço visual pós-toast perdido |
| 3 | MEDIUM (latente) | wizard.js:383-392 | `evaluatePreflightGate()` sem force pode re-disabled botão se `onPreflight` chega atrasado; mitigado pelo setInterval mas confunde UX |
| 4 | MEDIUM (defensivo) | wizard.js:710-734 | Sem timeout em `api.start()` — se travar, JOs fica preso forever sem botão e sem erro |
| 5 | LOW (defensivo) | wizard.js:724 | `res.ok === undefined` cai no caminho de sucesso silenciosamente |

Nenhum dos achados invalida o fix do bug original. O caminho feliz do JOs (cenário #1 do brief) funciona end-to-end e ele consegue avançar pro Passo 1 em ≤3s.

## Recomendação de release

**Liberar v0.2.4 pra próximo live-test com JOs.** Os achados 1-2 são cosméticos e Camila pode pegar em micro-iteração. Achados 3-5 são defensivos pra v0.2.5 (não regridem comportamento atual; só endurecem edge cases).

Build do `.exe` recomendada: `IMP-Squad-Instalador-0.2.4-portable.exe`.

---

## Limites respeitados
- Não modifiquei código.
- Atuei somente em `imp-installer/`.
- `node --check` rodado (passa).
