# Smoke Test — v0.2.6 (Patrícia QA)

Data: 2026-05-26
Escopo: read-only. Bug crítico v0.2.5 (UAC nunca aparecia + instalador morria em 8s).

## VEREDITO: GO

Confiança alta de que JOs sem admin clica → UAC popup APARECE → JOs aceita → ciclo completa.

## 1. Causa raiz documentada — OK

`src/shell.js` linhas 286-300: comentário extenso explicando que electron-builder portable extrai pra `%TEMP%\<random>` e que `process.execPath` aponta pro temp (não pro .exe original). Fix usa `process.env.PORTABLE_EXECUTABLE_FILE` que é a env var **canônica oficial do electron-builder** (referência citada: `https://www.electron.build/configuration/nsis#portable`).

Fallback pra `process.execPath` em dev confirmado (shell.js linha 313):
```js
const portableExe = process.env.PORTABLE_EXECUTABLE_FILE;
const fallbackExe = (opts && opts.exePath) || process.execPath;
const target = portableExe || fallbackExe;
```

`existsSync(target)` (linha 330) protege contra path inválido — retorna `{ok:false, error:'caminho do .exe não encontrado pra elevar'}`.

## 2. Lock file mecanismo — OK

- **main.js 73-87** — `whenReady` faz `execSync` PowerShell pra detectar `IsInRole(Administrator)`. Se true, escreve `~/.imp-installer/.elevated.lock` com `{pid, startedAt}`. Best-effort (try/catch wrap, falha silenciosa = velho dá timeout).
- **main.js 518-585** (handler `installer:relaunchAsAdmin`):
  - Linha 520: limpa lock antigo antes de elevar (cobre cliques duplos).
  - Linha 532-582: setInterval 500ms, monitora lock até 60s.
  - Linha 555: **freshness window** — `data.startedAt > startedAt - 10000` (lock criado depois do pedido, com 10s de skew tolerance).
  - Heartbeat log a cada 5s (bucket discretizado).
  - 60s sem lock → emite `onElevateTimeout` e mantém velho vivo.
- **main.js 97-105** (before-quit) — PID-gated cleanup: `parsed.pid === process.pid` antes de `unlink`. Evita race onde velho deletaria lock do novo.

## 3. Stderr capture — OK

`relaunchAsAdmin` (shell.js 305-383) usa `spawn` com `stdio:['ignore','pipe','pipe']`, acumula stdout/stderr, e classifica no `close`:
- `code===0 && stdout.includes('SPAWNED:')` → `{ok:true, elevatedPid}`
- stderr match `/canceled by the user|cancelled by the user/i` → `{ok:false, error:'UAC_CANCELLED'}` (linhas 365-370)
- stderr inclui `UAC_FAILED` → `{ok:false, error:'UAC_FAILED'}`
- outro → `{ok:false, error:'falha desconhecida (code=N)'}`

Log diagnóstico em `~/.imp-installer/logs/elevate-<ts>.log` com `portableExe`, `execPath`, `target`, exit code e ambos os streams.

## 4. UI consumindo novos shapes — OK

`renderer/wizard.js` handler `#btn-elevate-relaunch` (linhas 558-593):
- 576: `if (r && r.ok && r.monitoring) { startElevateCountdown(); }` ✓
- 579-581: `r.error === 'UAC_CANCELLED'` → reset + amber "Você cancelou o UAC" ✓
- 582-584: outros `!r.ok` → reset + vermelho com mensagem dinâmica ✓

Listener `api.onElevateTimeout` (1318-1321) chama `resetElevateModalButtons()` e `showElevateStatus('Esperei 1 minuto…', 'error')` ✓

`preload.js` 36-37, 49 expõe `relaunchAsAdmin`, `cancelRelaunch`, `onElevateTimeout` ✓

Countdown (541-554) incrementa a cada 1s; para em 60s.

## 5. Cenários

| Cenário | Status |
|---|---|
| **A** — UAC aceito | PASSA. Click → relaunchAsAdmin → spawn elevated → `whenReady` do novo escreve lock (`startedAt` > velho-startedAt-10s) → monitor velho detecta dentro de 500ms → log "Processo elevado detectado" → `setTimeout(app.quit, 500)` → novo segue admin. |
| **B** — UAC cancelado | PASSA. PowerShell stderr "canceled by the user" → handler retorna `{ok:false, error:'UAC_CANCELLED'}` → UI mostra amber → velho vivo. |
| **C** — Timeout 60s | PASSA. UAC aceito mas elevado não escreve lock (PS isAdm falha) → 60s monitor → `onElevateTimeout` emitido → UI vermelho → velho vivo. |
| **D** — Cancelar durante aguardo | PASSA. `cancelBtn.dataset.cancelRelaunch==='1'` → `api.cancelRelaunch()` → `clearInterval(_elevateMonitor)` no main → reset UI. |

## Edge cases observados

- **Dupla elevação rápida**: `unlinkSync(ELEVATED_LOCK)` no início do handler (main.js 520) limpa lock obsoleto antes de novo pedido. OK.
- **`PORTABLE_EXECUTABLE_FILE` ausente em dev + execPath é o electron binário**: target existe, mas elevar electron dev é benigno (Bruno aceita esse fallback).
- **Lock corrompido**: monitor try/catch (main.js 569) ignora e tenta na próxima iteração.

## Ressalva única (não bloqueia GO)

`whenReady` usa `execSync` PowerShell síncrono com timeout 5s — bloqueia event loop ~100-500ms no boot. Aceitável (uma única vez, no startup). Se quiser zero-block depois, dá pra mover pra `setImmediate` + async powershell helper.
