# REVIEW EDUARDO — v0.2.5 (auto-elevação UAC)

**Data:** 2026-05-26
**Revisor:** Eduardo
**Foco:** Fix do live-test #5 (JOs sem admin → Passo 1 dism falha).
**Mudanças:** Bruno (backend admin gate + IPC + error-catalog), Camila (modal-elevate + pre-check + listener UAC).

---

## Sumário executivo

**VEREDITO: GO COM RESSALVAS**

A implementação fecha o cenário principal: JOs sem admin clica "Começar", vê modal âmbar/teal explicando UAC, clica "Reabrir como administrador", Windows mostra UAC popup, JOs aceita, .exe reabre elevado, o state.json preservado faz Welcome reaparecer e o segundo clique em "Começar" passa pelo pre-check (agora elevado) e segue normal pro Passo 1, que executa dism com sucesso.

A arquitetura está limpa: `isElevated` + `relaunchAsAdmin` em shell.js, `requireAdminOrThrow` nos 3 steps Windows, interceptor dedicado em onError, modal + listener no renderer, fallback do error-catalog como cinturão de segurança. Bom desacoplamento.

**Mas há 1 blocker real (UAC cancel = instalador morto) e 5 ressalvas de severidade variável.** O cenário JOs aperta "Sim" funciona; o cenário JOs aperta "Não" no UAC quebra (instalador velho morre em 1.5s, novo nunca abre). Isso precisa mitigação antes de passar pra JOs.

---

## Achados

### 🔴 #1 — UAC cancelado deixa JOs sem nada (main.js:467-475 + shell.js:286-300)

**Onde:** `installer:relaunchAsAdmin` handler em main.js + `relaunchAsAdmin` em shell.js.

**Problema:** O fluxo é fire-and-forget — `Start-Process -Verb RunAs` dispara o UAC popup do Windows e o processo PowerShell retorna **imediatamente**, independente do user clicar Sim/Não. Em seguida o handler agenda `setTimeout(() => app.quit(), 1500)` incondicionalmente. Se JOs clica **"Não"** no UAC (ou ignora a janela por >1.5s), o instalador antigo MORRE de qualquer jeito, mas o novo elevado NUNCA abriu. Resultado: tela em branco, nada acontecendo, JOs precisa achar o .exe de novo e tentar tudo.

**Pior:** mesmo se JOs clica "Sim" mas demora >1.5s (alguns PCs lentos demoram pra renderizar o UAC), o handler já matou o instalador e o user fica sem visual de continuidade.

**Mitigação sugerida:**
- Bumpar o setTimeout pra 5s ou mais (UAC popup pode demorar 2-3s em máquinas lentas).
- OU mostrar uma tela "Aguardando confirmação do UAC… se você cancelou, clique aqui pra continuar manualmente" antes do quit, com botão fallback.
- OU detectar o exit code do Start-Process. Em PowerShell isso requer `-Wait -PassThru` mas trava esperando — incompatível com fire-and-forget. Alternativa: usar `ShellExecuteEx` (via .NET) com `lpVerb='runas'` que retorna erro distinguível quando UAC é negado (`ERROR_CANCELLED 1223`). Aí o handler poderia NÃO matar o self se relaunch falhou.

**Impacto:** Alto. Quebra silenciosamente o cenário "JOs leu o modal mas mudou de ideia". Em live test isso vai acontecer.

---

### 🟠 #2 — Race entre auto-advance preflight e pre-check de admin (wizard.js:916-933)

**Onde:** `bindWelcome()` → click handler do `#btn-start`.

**Problema:** A sequência é: clica Começar → `await api.isElevated()` → se NÃO elevado, mostra modal e return. **MAS:** `runPreflightFlow` (chamado se elevado) faz `await api.start()` que internamente roda preflight + emite onPreflight events. O `showElevateModal` chama `cancelPreflightAdvance()` defensivamente — bom — mas isso só protege contra timer já agendado. Se o backend já mandou `installer:onScreen → preflight` ANTES da resposta de `isElevated` chegar (improvável mas possível com `start()` rápido), o user pode ver flash da tela preflight ANTES do modal aparecer.

**Mitigação:** Pre-check deveria acontecer **antes** de qualquer chance do backend mudar tela. Atualmente está OK porque `api.start()` só é chamado dentro de `runPreflightFlow()` que só roda APÓS o pre-check resolver. Mas vale um comentário deixando explícito que a ordem importa.

**Impacto:** Médio — improvável em prática mas a documentação interna do bindWelcome não explicita a dependência.

---

### 🟠 #3 — `isElevated` defaults pra `false` em qualquer erro (shell.js:281-283)

**Onde:** `isElevated()` catch block: `catch (_) { return false; }`.

**Problema:** Se PowerShell estiver indisponível, timeout, política bloqueada, ou qualquer outra falha, retorna `false`. Combinado com o pre-check no welcome, isso significa que um PowerShell quebrado **abre o modal de elevação** mesmo se o user JÁ estiver rodando como admin. Resultado: JOs admin clica Reabrir como admin, dispara outro UAC desnecessário, recursão sem fim possível se PS continuar quebrado.

**Mitigação:** Logar o erro no catch (`logger.warn`), OU expor o erro pro renderer pra distinguir "não-elevado certo" de "não-consegui-checar". Renderer já tem `console.warn` se a IPC inteira falhar (wizard.js:929), mas perde a granularidade. Idealmente o handler retorna `{ok: true, elevated: bool, uncertain: bool}` e o wizard só abre modal se `uncertain === false`.

**Impacto:** Médio — borda, mas existe e é frustrante quando bate.

---

### 🟠 #4 — Modal-elevate pode sobrepor modal-error sem fechar o anterior (wizard.js:505-518)

**Onde:** `showElevateModal()` + `bindBackendEvents` linhas ~1230 (onError → openModal('modal-error')) e 1243 (onNeedsAdmin → showElevateModal).

**Problema:** Os dois modais usam `.modal-overlay` em fixed inset:0 com z-index:1000. Não há lógica que feche outros modais antes de abrir. Cenário: step_01 falha por outro motivo (não admin) → modal-error abre. Algum evento subsequente emite onNeedsAdmin (raro mas possível com retries) → modal-elevate abre POR CIMA do modal-error. Pode confundir.

Caminho normal (interceptor em main.js:140-143 garante NEEDS_ADMIN não cai em onError) isso não acontece. Mas defesa em profundidade ajuda.

**Mitigação:** `showElevateModal` chama `closeModal('modal-error')` antes do `openModal`. Símile pra `showErrorModal` (não tão necessário aqui porque elevate é prioritário).

**Impacto:** Médio-baixo — borda, mas trivial de mitigar.

---

### 🟡 #5 — Fallback do error-catalog tem regex `/precisa de administrador/i` que pode falsificar (error-catalog.js:16, 28, 40)

**Onde:** 3 entradas NEEDS_ADMIN regex.

**Problema:** Se algum outro erro contiver a string "precisa de administrador" (ex.: mensagem de outro componente, log de stderr arbitrário), vai casar com o catálogo e mostrar como NEEDS_ADMIN sem que o interceptor em main.js tenha pego. O resultado: o user vê o headline "Preciso de administrador" e os botões do modal-error (Tentar de novo / Ver logs), **mas o modal-elevate nunca aparece** (porque não é o caminho do interceptor). É só fallback de mensagem, não de UI.

A intenção é boa (cinturão), mas a UX fica meia-boca: mostra texto de admin no modal genérico em vez de abrir o modal específico. Isso confunde.

**Mitigação:** Os 3 entries do error-catalog poderiam ser mais restritos (`NEEDS_ADMIN` literal ou `requires elevation` em inglês especificamente). OU o handler de onError no wizard.js (showErrorModal) poderia detectar headline === 'Preciso de administrador' e abrir modal-elevate em vez de modal-error.

**Impacto:** Baixo. Casos onde isso ocorre são raros, e o user ainda vê suggestion "Clico em Reabrir como administrador" no modal-error que orienta.

---

### 🟡 #6 — `relaunchAsAdmin` não escapa exePath robustamente (shell.js:288-289)

**Onde:** `relaunchAsAdmin(exePath)`.

**Problema:** `(exePath || '').replace(/'/g, "''")` cobre só single quotes. Em Windows o exePath via `process.execPath` em portable build normalmente é algo tipo `C:\Users\Joana\Downloads\IMP-Squad-Instalador-0.2.5-portable.exe` — sem aspas, sem chars especiais usuais. MAS se o user baixou pra uma pasta com caracter exótico (ex.: `C:\Users\JoãoPaixão\…` com chars Unicode válidos em path), o `Start-Process -FilePath '…'` pode ter problemas de encoding já que o spawn usa cmdline string. Encoding é geralmente OK no Win10/11, mas vale.

**Mitigação:** Usar `-ArgumentList` ou passar via stdin (igual `scheduleRunOnceAfterReboot` faz com `param($Exe)`). Pequeno refactor, melhora robustez.

**Impacto:** Baixo. Não vi report disso em testes prévios.

---

### 🟢 #7 — Bundle (build.files cobre tudo)

`package.json` build.files inclui `src/**/*` e `renderer/**/*`. Confirmei `error-catalog.js` está em src/, `wizard.js` + `index.html` + `style.css` em renderer/. Sem arquivo novo solto na raiz. Asar:check script existe pra validar pós-build.

**Sem ação.**

---

### 🟢 #8 — Regressão path admin já

Se JOs já é admin: pre-check passa em 1 round-trip (~50-200ms via powershell call), `runPreflightFlow` segue. `requireAdminOrThrow` nos steps passa silencioso. Nenhuma mudança visível pro user. Sem regressão.

**Sem ação.** A única latência extra é a chamada `isElevated()` no clique de Começar (≤5s timeout) — aceitável.

---

## Cenário JOs sem admin — passo a passo verificado

1. ✅ JOs roda .exe sem admin
2. ✅ Welcome aparece (state.json novo OU preservado)
3. ✅ Marca consent → btn-start habilita
4. ✅ Click Começar → `await api.isElevated()` → `{ok: true, elevated: false}`
5. ✅ `showElevateModal()` → `cancelPreflightAdvance()` defensivo → `openModal('modal-elevate')`
6. ✅ Modal âmbar/teal mostra: header escudo + lead + card "o que vai acontecer" (4 passos UAC) + alt manual + 3 botões
7. ✅ Click "Reabrir como administrador" → btn disabled + label "Abrindo permissão…" → `await api.relaunchAsAdmin()`
8. ✅ Backend chama `relaunchAsAdmin(process.execPath)` → `Start-Process -FilePath '…' -Verb RunAs` em PowerShell detached
9. ✅ Toast "Reabrindo como administrador…" 5s
10. ⚠️ **JOs aceita UAC → .exe reabre elevado** (caminho feliz funciona; caminho cancelado quebra — achado #1)
11. ✅ Antigo morre em 1.5s via setTimeout app.quit
12. ✅ Novo elevado abre → state.json preservado → Welcome reaparece com consent já marcado (se persiste) ou pede recheck
13. ✅ Click Começar → `isElevated()` retorna `true` → `runPreflightFlow()` → preflight + auto-advance 3s → progress
14. ✅ Step 01 → `requireAdminOrThrow()` passa (elevado) → dism.exe roda → ok

**Confiança no caminho feliz: ~88%.**
**Confiança no caminho UAC cancelado: ~0% (achado #1 bloqueia).**

---

## Veredito

**GO COM RESSALVAS**

A v0.2.5 resolve o bug principal do live-test #5 e tem boa arquitetura. **Bloqueia release pra JOs** apenas se você quer cobrir o cenário "user clica Não no UAC" — vale 10min de fix (achado #1: bumpar timeout pra 5s + tela "esperando UAC… clique aqui se cancelou"). Os outros 5 achados são polimento que pode entrar em v0.2.6 sem urgência.

**Blockers:** 1 (achado #1).
**Recomendado fixar antes do release JOs:** Achado #1.
**Pode ir pra v0.2.6:** #2, #3, #4, #5, #6.
