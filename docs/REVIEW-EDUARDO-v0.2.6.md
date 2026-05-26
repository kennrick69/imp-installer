# REVIEW EDUARDO — v0.2.6 (fix do "UAC nunca aparece" + lock-file coordination)

**Data:** 2026-05-26
**Revisor:** Eduardo
**Foco:** Live-test #6 — JOs sem admin clica Reabrir e nada acontece (UAC popup nunca renderiza).
**Mudanças principais:**
- Bruno: `PORTABLE_EXECUTABLE_FILE` como alvo de elevação, `.elevated.lock` coordena quit/spawn, captura stdout/stderr do PowerShell, log diagnóstico em arquivo.
- Camila: modal mostra `#elevate-status` com tone (info/warn/error) + countdown visual + handler `onElevateTimeout`.

---

## Sumário executivo

**VEREDITO: GO COM RESSALVAS**

O fix da causa raiz é convincente e a remoção do `setTimeout(app.quit, 8s)` cego do v0.2.5 fecha o blocker #1 da review anterior. O novo design — "só mata o velho quando o novo escrever lock fresco" — é correto e robusto contra UAC negado, UAC lento e falha de spawn.

**0 blockers.** **3 ressalvas relevantes** (todas comportamentais/edge — não impedem o cenário feliz). Confiança alta de que JOs sem admin → clica Reabrir → vê UAC → aceita → instalador continua elevado.

---

## Achados

### 🟢 #0 — Resolução do blocker v0.2.5 (fire-and-forget)
**Onde:** `main.js:518-585`, `src/shell.js:305-383`.

O `setTimeout(app.quit, 8000)` cego sumiu. Agora:
1. `relaunchAsAdmin()` aguarda PowerShell fechar e retorna `{ok, error, logFile}`.
2. Handler em `main.js` só inicia o monitor se `ok=true`.
3. Monitor de `.elevated.lock` (poll 500ms, teto 60s) só mata o velho quando vê lock com `startedAt > startedAt-10s` (proteção anti-stale).
4. UAC cancelado → stderr matcha `canceled by the user` → `ok:false`, **velho vive**.
5. Timeout 60s → emite `onElevateTimeout` e **velho vive** com UI mostrando erro.

Blocker v0.2.5 **fechado**.

---

### 🟠 #1 — Captura de stderr UAC_CANCELLED pode falhar em Windows pt-BR
**Severidade:** 🟠 (probabilidade alta no público-alvo de JOs).
**Onde:** `src/shell.js:365-369`.

```js
} else if (stderr.includes('UAC_FAILED') || /cancelled|canceled/i.test(stderr)) {
  const reason = /canceled by the user|cancelled by the user/i.test(stderr)
    ? 'UAC_CANCELLED' : 'UAC_FAILED';
```

O Windows pt-BR retorna mensagens UAC em português ("**A operação foi cancelada pelo usuário**" ou "**Operação cancelada pelo usuário**"). O regex atual NÃO matcha isso. Resultado: JOs em pt-BR clica Não no UAC → stderr vem em português → cai no branch genérico `falha desconhecida (code=X)`, com `error` = `"falha desconhecida (code=1)"`.

**Consequência prática:** o velho ainda VIVE (handler retorna `r.ok=false`), mas a UI mostra "Erro: falha desconhecida (code=1)" em vez do humano "Você cancelou o UAC". Funciona, mas vai gerar ticket de suporte.

**Mitigação sugerida (não bloqueia):** estender regex pra `/cancel(ad[ao]|lled|ed)|cancelad[ao] pelo/i` e/ou checar `code === 1` + ausência de SPAWNED como sinal forte de cancelamento.

---

### 🟠 #2 — Lock fresco pode ser confundido com lock de instância única legítima
**Severidade:** 🟠.
**Onde:** `main.js:21-25`, `main.js:69-87`, `main.js:97-105`.

Há DOIS mecanismos de lock convivendo:
1. `app.requestSingleInstanceLock()` (linha 21) — Electron nativo, baseado em IPC.
2. `.elevated.lock` em STATE_DIR (linha 19) — file-system, escrito no `whenReady`.

Cenário ruim: usuário tenta iniciar a v0.2.6 **enquanto a v0.2.5 já está rodando** (não-elevada). O single-instance da v0.2.5 mata a v0.2.6 nova (linha 22-25). MAS — se por algum motivo (race, crash) o `.elevated.lock` ficou de uma sessão anterior elevada, e o user re-tenta elevar agora… o filtro `startedAt > Date.now()-10000` (linha 555) protege bem contra esse stale.

**Verdadeiro risco:** `before-quit` (linha 97-105) lê o lock e só deleta se `parsed.pid === process.pid`. **Isso está correto** — o velho não-elevado NUNCA criou esse lock (linha 79 só escreve se `isAdm=true`), então não consegue deletar o do novo. Bom.

**Mas:** se o processo elevado crash (não chama `before-quit`), o lock fica órfão. Próxima execução do velho não-elevado VAI achar lock "fresco" se for em ≤10s do crash. Janela curta, mas existe. Improvável em prática, mas vale comentário ou validar via `process.kill(pid, 0)` antes de confiar no lock.

---

### 🟡 #3 — Heartbeat backend + countdown frontend divergem
**Severidade:** 🟡 (cosmético).
**Onde:** `main.js:539-548` (heartbeat 5s via onLog) vs `renderer/wizard.js:541-555` (countdown próprio).

O backend manda `onLog` a cada 5s ("Aguardando processo elevado iniciar… Ns"), e o frontend tem countdown próprio (`setInterval` 1s) iniciado em `startElevateCountdown()`. Os dois contadores rodam em paralelo, podem dessincronizar 200-500ms entre si.

Não quebra nada — apenas o `#elevate-countdown` mostra `(5s)` enquanto o `#log-peek` mostra `Aguardando… 4s`. Tolerável; manter como nota.

---

### 🟡 #4 — `windowsHide: true` no spawn pode esconder erro perceptível ao user
**Severidade:** 🟡.
**Onde:** `src/shell.js:350`.

PowerShell sumindo é bom (não polui tela), mas se em alguma máquina o `Start-Process -Verb RunAs` falhar por política de grupo (UAC desabilitado, EnableLUA=0), o erro só vai pro stderr capturado. Já está logado em arquivo (`elevate-${ts}.log`), então JOs consegue mandar. OK.

---

### 🟡 #5 — `existsSync(target)` não checa se é EXE real, só path
**Severidade:** 🟡.
**Onde:** `src/shell.js:330`.

`PORTABLE_EXECUTABLE_FILE` é env var — tecnicamente um agente malicioso podia setar pra um caminho não-EXE. Não é caminho de ataque real (electron-builder seta), mas vale checar extensão `.exe` ou `path.extname(target) === '.exe'`. Baixa prioridade.

---

### 🟢 #6 — Permissões do lock entre user/admin
**Severidade:** 🟢 (não-issue).

`STATE_DIR = ~/.imp-installer/` resolve via `os.homedir()` → `%USERPROFILE%`. UAC eleva preservando o user, então `homedir()` retorna o MESMO path no processo elevado. Permissões NTFS no `%USERPROFILE%` herdam Full Control pro owner → admin escreve, user lê: OK.

**Risco zero.** Mas se algum dia o instalador for chamado de uma conta secundária via `runas /user:OtherAdmin`, a divergência apareceria. Edge irrelevante pro caso JOs.

---

### 🟢 #7 — UX dos 3 cenários
**Severidade:** 🟢.

| Cenário | Backend | Frontend | OK? |
|---|---|---|---|
| A — Aceita UAC, novo abre rápido | lock detectado em <5s, `app.quit()` em 500ms | countdown rolando, modal some quando processo morre | ✅ |
| B — Cancela UAC | stderr "canceled by the user" → `UAC_CANCELLED` | `resetElevateModalButtons()` + status warn "Você cancelou o UAC" | ✅ (pt-BR ver #1) |
| C — Aceita mas demora 60s | monitor expira, `onElevateTimeout` | `resetElevateModalButtons()` + status error "Esperei 1 minuto…" | ✅ |

Boa cobertura visual. `aria-live` não aplicado em `.elevate-status` — screen readers não vão narrar mudança de tone. 🟡 acessibilidade, baixa.

---

### 🟢 #8 — Bundle
`build.files` (package.json:30-44) cobre `main.js`, `preload.js`, `src/**/*`, `renderer/**/*`. Nada novo fora dessas pastas. Sem deps novas. Versão bumpada pra 0.2.6 ✅.

---

## Race conditions analisadas

1. **2 cliques rápidos em Reabrir** — `_elevateMonitor` é cleared (linha 532-533) antes de re-spawn, lock antigo removido (linha 520). OK.
2. **Velho e novo elevado rodando simultaneamente por 500ms** — `before-quit` PID-gated impede velho de apagar lock do novo. OK.
3. **`requestSingleInstanceLock` x lock file novo** — single-instance é IPC-based, lock file é FS-based. Eles não interferem (single-instance só barra duplo-clique no MESMO contexto; quando velho morre, novo já tem o IPC lock). OK.
4. **`onElevateTimeout` dispara depois do user ter dado OK em UAC tardio (>60s)** — monitor cleared, mas o novo elevado existe e rodando. Velho fica vivo em paralelo. Usuário vê 2 janelas. 🟡 edge raro; o user pode fechar a velha manualmente.

---

## Veredito

**GO COM RESSALVAS** — 0 blockers, 2 ressalvas 🟠 (pt-BR regex, lock órfão pós-crash), 3 ressalvas 🟡 (cosméticas).

A correção da causa raiz (`PORTABLE_EXECUTABLE_FILE`) é a doc oficial do electron-builder e o fallback pra `execPath` em dev preserva o fluxo `npm start`. O lock file substitui bem o `setTimeout` cego e tem proteção contra stale via janela de frescor.

**Recomendação:** mergear v0.2.6, abrir issue de seguimento pra estender regex pt-BR (achado #1) — pode resolver no v0.2.7 sem reblock.

**Confiança no cenário-alvo (JOs sem admin → Reabrir → UAC popup APARECE → JOs aceita → instalador continua elevado): ~92%.**

Os 8% de incerteza são:
- Máquinas com EnableLUA=0 (UAC desabilitado por GPO empresarial) — `Start-Process -Verb RunAs` falha silenciosamente. Cobertura: log diagnóstico capturado, user vê erro humano.
- PCs muito lentos onde Start-Process demora >2s pra spawnar o PowerShell e mostrar UAC — coberto pelo monitor de 60s.
- Antivírus que bloqueia spawn de PowerShell elevado — coberto pelo error branch + logFile.
