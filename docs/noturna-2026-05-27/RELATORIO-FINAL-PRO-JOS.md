# 🌙 Relatório da sessão noturna 2026-05-27 — pro JOs ler de manhã

## TL;DR
- **v0.2.18 publicada** (última da noite): https://github.com/kennrick69/imp-installer/releases/tag/v0.2.18
- **Causa raiz REAL**: WSL legado/inbox no Win10 19045 ≠ WSL moderno
- **Fix definitivo**: detector legacy/modern + instala WSL2 via MSI oficial Microsoft + reboot forçado + RunOnce + validação real + 2 telas dedicadas + plano B universal
- **Squad inteira em paralelo** (5 docs entregues em `docs/noturna-2026-05-27/`)
- **2 ferramentas de smoke automatizado** criadas (`scripts/contract-matcher.js` + `scripts/jsdom-smoke.js`) + GitHub Actions workflow
- **Lista não-regressão 10/10 itens preservados** (Eduardo conferiu linha-a-linha)

## 🎯 O que JOs vai ver ao rodar v0.2.18 no PC dele

1. Welcome → consent → Começar
2. Preflight ✓
3. Step 01 detecta **WSL legado** (Win10 19045 inbox) → **navega pra `#screen-wsl-upgrade`** automático
4. Tela "⚙️ Atualizando o WSL" com barra de progresso REAL + log peek
5. Baixa MSI oficial Microsoft (GitHub `microsoft/WSL/releases/latest`) → instala via `msiexec /qn`
6. Termina com exit 3010 (sucesso+reboot) → **navega pra `#screen-reboot`** automático
7. Tela "🔄 Vamos reiniciar o Windows" com botão **"💾 Salvar progresso e reiniciar agora"**
8. JOs aceita → `shutdown /r /t 30` + RunOnce no HKCU
9. Pós-reboot: instalador reabre sozinho → `wslIsFunctional()` confirma WSL funcional
10. Step 03 instala Ubuntu via `wsl --install -d <nome dinâmico via wsl --list --online>`
11. Step 04 (manual): **botão "🐧 Abrir Ubuntu"** abre terminal interativo + plano B copiável

## 📚 Docs da noturna (squad inteira em paralelo)

| Quem | Doc | TL;DR |
|---|---|---|
| **Marcos** | `MARCOS-ARQUITETURA.md` | Plano técnico fases A-F com gates reais; cascata WinGet→Store→MSI→DISM; schema state v2.0 |
| **Bruno-pesquisa** | `BRUNO-WSL-TECNICO.md` | 3 estados WSL (absent/legacy/modern); MSI GitHub Microsoft é caminho mais robusto; helpers prontos |
| **Patrícia** | `PATRICIA-CENARIOS-PROCESSO.md` | 23 cenários futuros mapeados; processo validação REAL por step; recomendação A+B+E+D pra squad testar .exe |
| **Camila** | `CAMILA-UX.md` | 2 telas novas + 1 long-wait + plano B universal no modal-error; bindings pro Bruno |
| **Eduardo** | `EDUARDO-META.md` | 7 padrões sistêmicos (top: contrato divergente 7×, validação fraca 10×, encoding 5×); lista não-regressão 10/10 OK |
| **Eduardo lastmile** | `EDUARDO-LASTMILE-v0.2.17.md` | Achou 3 emits faltando (cabo entre backend e UI) — Claudio aplicou na v0.2.18 |

## 🔧 Ferramentas novas (prevenção de regressão futura)

### `scripts/contract-matcher.js`
Valida em ~1s que TODO handler/invoke/evento bate entre main.js↔preload.js↔wizard.js.
- **28 handlers/invokes verificados** — todos casam ✅
- **12 eventos/listeners** — todos casam ✅
- **21 métodos `api.X()`** — todos casam ✅

### `scripts/jsdom-smoke.js`
Carrega `renderer/index.html` + `renderer/wizard.js` no jsdom, simula 11 cenários de eventos, valida DOM.
- **33/33 checks ✅** (inclui anti-regressão do botão fantasma v0.2.14)
- Cobre: onStepUpdate→sidebar, onPreflight→cards, onError→modal, onNeedsAdmin→modal-elevate, onScreen('reboot'|'wsl-upgrade')→tela ativa, onWslUpgradeProgress→barra atualiza, onManualPrompt→botão visível + fallback, etc.

### `.github/workflows/smoke.yml`
Roda os 2 scripts automaticamente em PR/push. Bloqueia merge se algum falhar.

## 🛡️ Defesas adicionadas na noturna

### Validação REAL em vez de proxy (Pattern A fixado)
- `wslIsFunctional()` chama `wsl --status` + 3 heurísticas pra detectar tela de help
- `ensureFeatures()` confirma `Get-WindowsOptionalFeature` retornou `Enabled` (não `EnablePending`)
- `detectWslState()` cascata `wsl --version` → `wsl --status` → fallback (3 estados distintos)

### Reboot é fluxo, não exceção
- `forceRebootWindows({delaySeconds: 30, reason})` → `shutdown /r /t /c`
- `cancelReboot()` → `shutdown /a`
- `scheduleRunOnceAfterReboot()` via HKCU RunOnce
- `rebootCount` cap em 3 (evita loop infinito)
- Tela dedicada `#screen-reboot` explica + 2 botões + plano B copiável
- `_markRebootAndScheduleRunOnce` emite `onScreen('reboot')` — UI mostra tela bonita

### Migração WSL legado→moderno via MSI
- `installWslModernViaMsi(ctx)` com **callback de progresso** pra UI mostrar barra real
- GitHub API `microsoft/WSL/releases/latest` filtrado por `.x64.msi`
- TLS 1.2 forçado (Win10 antigo)
- `msiexec /i ... /qn /norestart`, exit 3010 = sucesso + reboot
- step_01 navega pra `#screen-wsl-upgrade` automático ANTES de começar

### Plano B universal em CADA passo
- Manual: botão grande + 8 passos leigos + plano B copiável + verify real
- Erro: modal-error tem `.error-fallback` com comando copy quando catalog tem `fallback`
- Reboot: comando `shutdown /r /t 10` copiável
- WSL upgrade: `aka.ms/wsl2kernel` + 4 passos manuais

### 23 cenários antecipados (Patrícia)
Mapeados em `PATRICIA-CENARIOS-PROCESSO.md`: WSL1, Hyper-V Off, GPO Store, RunOnce falho, rede caindo, antivírus corporativo, AppX corrupto, etc. — pronto pra atacar se aparecerem.

## 📋 Lista não-regressão (Eduardo conferiu 10/10)

| Item | Origem | Status v0.2.18 |
|---|---|---|
| Janela maximizada | v0.2.11 | ✅ `screen.getPrimaryDisplay().workAreaSize` + maximize() |
| Sidebar 17 passos | v0.2.11 | ✅ `#step-sidebar` + SIDEBAR_SCREENS expandida (inclui 'reboot' e 'wsl-upgrade') |
| UAC auto-elevate | v0.2.6/8 | ✅ manifest `requireAdministrator` confirmado via strings |
| Preflight streaming | v0.2.2 | ✅ `onCheck` callback |
| Painel avisos âmbar | v0.2.4 | ✅ `#preflight-warnings` |
| Log decode UTF-16 | v0.2.9/12 | ✅ `decodeWslOutput` + `wslExec` |
| Modal de erro separado | v0.2.3 | ✅ `#modal-error` + agora com `.error-fallback` |
| Manual c/ botão+plano B | v0.2.13/15 | ✅ `#manual-action-btn` + `#manual-fallback` |
| safeHandle universal | v0.2.1 | ✅ 24 callsites |
| Asar bundle completo | v0.3.0 | ✅ 15 arquivos |

## ⚠️ O que ainda precisa testar no PC do JOs

- **Tela `#screen-wsl-upgrade`** renderiza com barra real durante MSI install
- **Download MSI** funciona (TLS 1.2 + GitHub releases — pode ter rate limit 60req/h sem token)
- **`msiexec` install** retorna 3010 esperado
- **Tela `#screen-reboot`** aparece automático quando reboot pendente
- **`shutdown /r /t 30`** funciona e RunOnce dispara pós-reboot
- **Pós-reboot**: `wsl --version` retorna válido (não mais help)
- **Step 03** chama `wsl --install -d <nome descoberto via wsl --list --online>`
- **Step 04** botão "Abrir Ubuntu" abre terminal interativo

Se algo der errado, logs em:
- `~/.imp-installer/logs/install-*.log` (geral)
- `~/.imp-installer/logs/wsl-diag-*.log` (diagnóstico WSL)
- `~/.imp-installer/logs/action-*.log` (botão Abrir Ubuntu)
- `~/.imp-installer/logs/boot-*.log` (boot + elevated check)

## 🔮 Recomendação pra JOs decidir
1. **Testar v0.2.18** no desktop (Win10 19045 com WSL legado)
2. Se passar → squad pode focar em refinos (médios/baixos não-bloqueantes)
3. Se falhar em cenário novo → 23 cenários já mapeados; um deles provavelmente cobre

## 📦 Versões publicadas hoje à noite

| Versão | O quê |
|---|---|
| v0.2.15 | Botão fantasma + 3 latentes (audit cruzado de 120 IDs) |
| v0.2.16 | wslIsFunctional + força reboot (mas assumiu wsl --status disponível — não no PC do JOs) |
| **v0.2.17** | WSL legado→moderno via MSI + 2 telas novas (Marcos+Bruno+Camila+Eduardo brainstorm) |
| **v0.2.18** | Lastmile: 3 emits faltando entre backend e UI (cabo final) |

Boa noite JOs. Squad trabalhou. Manhã com instalador muito mais sólido + ferramentas pra prevenir regressões.

— Claudio (e a squad: Marcos, Bruno, Patrícia, Camila, Eduardo)
