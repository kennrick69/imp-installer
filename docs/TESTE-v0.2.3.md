# TESTE v0.2.3 — Patrícia (QA)

**Data:** 2026-05-26
**Alvo:** Validar 3 fixes (Bruno + Camila) sobre v0.2.2:
- BUG 1: `checkAdmin` não bloqueia mais (warning); blockers reais ⊆ {`windows_build`, `disk_c_free_gb`, `internet_github`}
- BUG 2: `appendLog`/`refreshLogsModal`/log-peek normalizam `entry.message ?? entry.msg`
- BUG 3: `#modal-error` separado de `#modal-logs`; 3 botões com handlers próprios

**Veredito final: GO**

---

## NOTA sobre o stub do enunciado

O snippet original `sh.powershell = async ...` **não monkey-patcha** o módulo `preflight`, porque `preflight.js` faz `const { powershell } = require('./shell')` no topo — captura a referência por valor no require-time. Resultado: o teste rodava o powershell REAL via interop WSL→Windows (e batia no host de fato).

**Correção aplicada** (Patrícia): injetar o stub via `require.cache[stubPath] = { exports: { powershell: ... } }` ANTES do `require('./preflight')`. Assim a destruturação pega o stub.

> Esse não é bug do código — é bug do roteiro de teste. O preflight em si está correto. Recomendação pro próximo roteiro: usar `require.cache` ou refatorar preflight pra `require('./shell').powershell` no chamado (mais lento, mas testável).

---

## Test 1 — BUG 1, cenário JOs (Win 11, não-admin, sem WSL)

**Stub:**
- `OSVersion → 22000` (Win 11)
- `IsInRole → False` (não-admin)
- `Get-Command wsl.exe → ''` (sem WSL no PATH)
- `PSDrive C → 50` (50 GB livres)
- `TcpClient → true` (internet OK)
- `Win32_Processor → true` (virtualização OK)
- `AntiVirusProduct → ''` (nenhum AV)

**Resultado:**
```
BLOCKERS: []
WARNINGS: ["admin", "other_distros"]
OK: true
```

Todos 7 checks `ok:true`. `admin.warning=true`, `other_distros.warning=true`. **PASS** — JOs não trava no preflight.

---

## Test 2 — BUG 1 com blocker real (Win build < 19041)

**Stub:** mesmo que Test 1, mas `OSVersion → 18000`.

**Resultado:**
```
BLOCKERS: ["windows_build"]
OK: false
buildBlockingErrorPayload:
  headline: "Antes de continuar..."
  what:     "Algumas coisas precisam ser ajustadas no Windows..."
  suggestions: ["Seu Windows está em build 18000 — preciso de pelo menos 19041..."]
  canRetry: true
  canSkip:  false
```

**PASS** — Blocker correto, payload humano, retry liberado, skip bloqueado.

---

## Test 3 — BUG 2: `appendLog` aceita `message` e `msg`

**Inspeção** (`renderer/wizard.js`):
- Linha 271 `appendLog`: `const msg = (entry.message != null ? entry.message : entry.msg) || ''`
- Linha 340 `refreshLogsModal`: defensiva idêntica no render do modal
- Linha 577, 589 (`appendLogPeek` / hint): idem no log peek inline

**Smoke unitário** (entrada → saída renderizada):
| Entrada | Saída |
|---|---|
| `{ message: 'hello new' }` | `"hello new"` |
| `{ msg: 'hello old' }` (legacy) | `"hello old"` |
| `{ message: 'new', msg: 'old' }` | `"new"` (prefere `message`) |
| `{}` | `""` |
| `undefined` | `""` |
| `{ message: null, msg: 'fallback' }` | `"fallback"` |

**PASS** — Em nenhum caso renderiza literal `"undefined"`.

---

## Test 4 — BUG 3: `#modal-error` separado e listener correto

**HTML (`renderer/index.html`):**
- Linha 391 `<div id="modal-logs">` (modal de logs detalhados)
- Linha 479 `<div id="modal-error">` (modal de erro com headline + suggestions + 3 botões)
- Botões: `#btn-error-skip` (hidden quando `canSkip:false`), `#btn-error-logs`, `#btn-error-retry`

**JS (`renderer/wizard.js`):**
- Linha 1011-1019: `api.onError(payload)` → `setStatusPill('error', ...)` + `showErrorModal(payload)`
- `showErrorModal` (435-489) abre `#modal-error` (linha 488), NÃO `#modal-logs`
- Status-pill click (524-533): se `state=error` E `lastErrorPayload` existe → `showErrorModal` (modal-error); fallback sem payload → `openLogsModal` (defensivo)
- `bindError` (841-876): cada um dos 3 botões com handler próprio (retry chama `api.retry`/`api.start`; skip chama `api.skip`; logs fecha error+abre logs).

**PASS** — modais separados, handlers desambiguados.

---

## Test 5 — Contrato Bruno↔Camila no payload de erro

**Bruno emite** (`main.js` linhas 137-147, `preflight.js` linhas 376-386):
```js
{ stepId, headline, what, suggestions[], canRetry, canSkip, raw }
```

**Camila consome** (`wizard.js` 435-489):
| Campo | Consumido? | Onde |
|---|---|---|
| `stepId` | sim | `STEP_BY_ID[stepId]` → num pra headline fallback + `dataset.stepId` em retry/skip |
| `headline` | sim | `#error-headline-text` |
| `what` | sim | `#error-what-text` |
| `suggestions[]` | sim | `#error-suggestions-list <li>` |
| `canRetry` | sim | `#btn-error-retry.hidden = !canRetry` |
| `canSkip` | sim | `#btn-error-skip.hidden = !canSkip` |
| `raw` | sim | `<details>` colapsável; hidden se vazio |

**PASS** — Contrato 7/7 campos honrado.

---

## Edge cases

| Cenário | Comportamento | Status |
|---|---|---|
| `suggestions=[]` | Fallback `["Tentar de novo — às vezes é só rede instável."]` (wizard 458-461) | OK |
| `canSkip:false` | `#btn-error-skip` hidden | OK |
| `canRetry:false` | `#btn-error-retry` hidden | OK |
| Status-pill click sem `lastErrorPayload` | Fallback `openLogsModal` (não quebra) | OK |
| `raw` ausente | `<details>` hidden, `#error-raw-pre` vazio | OK |
| `payload` undefined | Defaults da destruturação → headline "Algo deu errado", suggestions fallback | OK |
| `stepId` inválido | `STEP_BY_ID[id]` undefined → headline fallback genérico, sem crash | OK |

---

## VEREDITO: **GO**

- **5/5 testes essenciais passaram**
- **7/7 edge cases não quebram**
- Cenário JOs (Win 11, não-admin, sem WSL): `BLOCKERS:[]` confirmado. **JOs roda v0.2.3 e AVANÇA pra instalação sem travar no preflight.**
- Único ajuste de processo (não-bloqueante): atualizar roteiro de testes pra usar `require.cache` em vez de monkey-patch tardio. Não impede o release.
