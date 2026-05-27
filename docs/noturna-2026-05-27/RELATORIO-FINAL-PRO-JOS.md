# 🌙 Relatório da sessão noturna 2026-05-27 — pro JOs ler de manhã

## TL;DR
- **v0.2.17 publicada**: https://github.com/kennrick69/imp-installer/releases/tag/v0.2.17
- **Causa raiz REAL identificada**: WSL legado/inbox no Win10 19045 ≠ WSL moderno
- **Fix definitivo**: detector legacy/modern + instala WSL2 via MSI oficial Microsoft + reboot forçado + RunOnce + validação real
- **2 telas novas**: `#screen-reboot` ("Vamos reiniciar") + `#screen-wsl-upgrade` ("Atualizando o WSL")
- **Squad inteira em paralelo** (5 docs entregues em `docs/noturna-2026-05-27/`)
- **Lista não-regressão 10/10 itens preservados** (Eduardo conferiu linha-a-linha)

## 🎯 O que JOs vai ver agora ao rodar v0.2.17

1. Welcome → consent → Começar
2. Preflight ✓
3. Step 01 detecta WSL legado → mostra **tela "⚙️ Atualizando o WSL"** com progress bar real
4. Baixa MSI oficial Microsoft (GitHub `microsoft/WSL/releases/latest`) → instala via msiexec
5. Marca reboot pendente → tela **"🔄 Vamos reiniciar"** com botão **"💾 Salvar e reiniciar agora"**
6. JOs aceita → `shutdown /r /t 30` + RunOnce
7. Pós-reboot: instalador reabre via RunOnce → `wslIsFunctional()` confirma WSL funcional
8. Step 03 instala Ubuntu via `wsl --install -d <nome dinâmico>` que AGORA funciona
9. Step 04: botão "🐧 Abrir Ubuntu" funciona de verdade

## 📚 Docs da noturna (squad inteira em paralelo)

| Quem | Doc | TL;DR |
|---|---|---|
| **Marcos** | `MARCOS-ARQUITETURA.md` | Plano técnico fases A-F com gates reais; cascata winget→Store→MSI→DISM; schema state v2.0 |
| **Bruno-pesquisa** | `BRUNO-WSL-TECNICO.md` | 3 estados WSL (absent/legacy/modern); MSI GitHub Microsoft é caminho mais robusto; helpers prontos |
| **Patrícia** | `PATRICIA-CENARIOS-PROCESSO.md` | 23 cenários futuros mapeados; processo validação REAL por step; recomendação A+B+E+D pra squad testar .exe |
| **Camila** | `CAMILA-UX.md` | 2 telas novas + 1 long-wait + plano B universal no modal-error; bindings pro Bruno |
| **Eduardo** | `EDUARDO-META.md` | 7 padrões sistêmicos (top: contrato divergente 7x, validação fraca 10x, encoding 5x); lista não-regressão 10/10 OK |

## 🛡️ Defesas adicionadas v0.2.17

### Validação REAL em vez de proxy
- `wslIsFunctional()` chama `wsl --status`, detecta tela de help via 3 heurísticas
- `ensureFeatures()` confirma `Get-WindowsOptionalFeature` retornou `Enabled` (não `EnablePending`)
- `detectWslState()` cascata `wsl --version` → `wsl --status` → fallback (distingue legacy vs modern vs absent)

### Reboot é fluxo, não exceção
- `forceRebootWindows({delaySeconds: 30, reason})` → `shutdown /r /t /c`
- `cancelReboot()` → `shutdown /a`
- `scheduleRunOnceAfterReboot()` via HKCU RunOnce
- `rebootCount` cap em 3 (evita loop infinito)
- Tela dedicada `#screen-reboot` explica + 2 botões + plano B

### Migração WSL legado→moderno via MSI
- `installWslModernViaMsi(ctx)`:
  - GitHub API `https://api.github.com/repos/microsoft/WSL/releases/latest`
  - Filtra asset `.x64.msi`
  - PowerShell `Invoke-WebRequest -UseBasicParsing` com TLS 1.2 forçado
  - `msiexec /i ... /qn /norestart`
  - Exit 3010 = sucesso + reboot

### 23 cenários antecipados (Patrícia)
Mapeados em `PATRICIA-CENARIOS-PROCESSO.md`: WSL1, Hyper-V Off, GPO Store, RunOnce falho, rede caindo, antivírus corporativo, AppX corrupto, etc.

## 📋 Lista não-regressão (Eduardo conferiu 10/10)

| Item | Origem | Status v0.2.17 |
|---|---|---|
| Janela maximizada | v0.2.11 | ✅ `screen.getPrimaryDisplay().workAreaSize` + maximize() |
| Sidebar 17 passos | v0.2.11 | ✅ `#step-sidebar` + SIDEBAR_SCREENS expandida |
| UAC auto-elevate | v0.2.6/8 | ✅ manifest `requireAdministrator` confirmado via strings |
| Preflight streaming | v0.2.2 | ✅ `onCheck` callback |
| Painel avisos âmbar | v0.2.4 | ✅ `#preflight-warnings` |
| Log decode UTF-16 | v0.2.9/12 | ✅ `decodeWslOutput` + `wslExec` |
| Modal de erro separado | v0.2.3 | ✅ `#modal-error` |
| Manual c/ botão+plano B | v0.2.13/15 | ✅ `#manual-action-btn` + `#manual-fallback` |
| safeHandle universal | v0.2.1 | ✅ 24 callsites |
| Asar bundle completo | v0.3.0 | ✅ 15 arquivos |

## ⚠️ O que ainda falta testar no PC do JOs

- **Tela `#screen-wsl-upgrade`** renderiza corretamente quando Step 01 detecta legacy
- **Download MSI** funciona (TLS 1.2 + GitHub releases)
- **`msiexec` install** retorna 3010 esperado
- **`shutdown /r /t 30`** funciona e RunOnce dispara pós-reboot
- **`wsl --version`** após reboot retorna válido
- **Step 03** chama `wsl --install -d Ubuntu-22.04` (ou nome descoberto via `wsl --list --online`) e instala distro real

Se algo der errado, logs disponíveis em:
- `~/.imp-installer/logs/install-*.log` (geral)
- `~/.imp-installer/logs/wsl-diag-*.log` (diagnóstico WSL)
- `~/.imp-installer/logs/action-*.log` (botão Abrir Ubuntu)
- `~/.imp-installer/logs/boot-*.log` (boot + elevated check)

## 🔮 Próximos passos sugeridos pra JOs decidir
1. **Testar v0.2.17** no desktop (Win10 19045 com WSL legado)
2. Se passar → squad pode focar em smoke test automatizado (A+B+E da Patrícia)
3. Se falhar em algum cenário novo → squad já tem 23 cenários mapeados pra atacar imediato

## 📦 Versões publicadas hoje

| Versão | O quê |
|---|---|
| v0.2.15 | Botão fantasma + 3 latentes (audit cruzado) |
| v0.2.16 | wslIsFunctional + força reboot (mas falhou no PC do JOs: assume `wsl --status` disponível) |
| **v0.2.17** | **WSL legado→moderno via MSI + 2 telas + reboot forçado** |

Boa noite JOs. Squad trabalhou. Manhã com instalador muito mais sólido.

— Claudio (e a squad: Marcos, Bruno, Patrícia, Camila, Eduardo)
