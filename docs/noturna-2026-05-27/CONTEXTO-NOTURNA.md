# CONTEXTO — Sessão noturna 2026-05-27

JOs foi dormir. Squad trabalha a noite toda. NÃO é ciclo reativo bug→fix.
Brainstorm sistêmico + implementação WSL robusta.

## Descoberta crítica desta noite
PC do JOs (Win 10 build 19045) tem **WSL LEGADO/INBOX**, não o moderno:
- `wsl.exe --version` → "Opção de linha de comando inválida: --version"
- `wsl.exe --install -d Ubuntu --no-launch` → "--install: unrecognized option: no-launch"
- Help do wsl.exe só mostra: --exec, -e, --cd, -- (SEM --install, --list, --update, --version)

**Diagnóstico**: build do Windows suportar WSL moderno ≠ ter o wsl.exe moderno INSTALADO.
A detecção atual "build >= 19041 = moderno" está ERRADA.

## Outras causas raiz confirmadas hoje
1. **Reboot obrigatório** não era forçado — JOs reiniciou manual, e SÓ DEPOIS WSL funcionou
2. **Validação mentirosa** — passos 01-03 diziam "ok" sem testar resultado real
3. **"Retomar" se perde** — clica e nada acontece
4. **Detecção WSL flaky** — falso positivo/negativo por idioma PT-BR + UTF-16 + build vs binário

## Lista de NÃO-REGRESSÃO (já funciona, preservar)
- ✅ Janela maximizada (v0.2.11)
- ✅ Sidebar 17 passos em todas as telas (v0.2.11)
- ✅ Auto-elevação UAC (v0.2.6, PORTABLE_EXECUTABLE_FILE + lock file)
- ✅ Preflight com feedback visual streaming (v0.2.2)
- ✅ Painel avisos âmbar + countdown (v0.2.4)
- ✅ Log decode UTF-16 (v0.2.9/v0.2.12)
- ✅ Modal de erro separado com sugestões (v0.2.3)
- ✅ Telas manual com botão+instruções+plano B (v0.2.13/v0.2.15)
- ✅ safeHandle universal (v0.2.1)
- ✅ Asar bundle completo (lição v0.3.0)

## Estado atual do código
- v0.2.16 publicada (wslIsFunctional novo + validação via wsl --status + força reboot + comando do botão via PowerShell Start-Process)
- LIMITAÇÃO da v0.2.16: assume que `wsl --status` está disponível. No PC do JOs com WSL LEGADO, `wsl --status` também retorna help! Então mesmo o wslIsFunctional pode falhar a detectar corretamente o caso "wsl legado instalado".

## Brainstorm individual
Cada agente entrega seu doc em `docs/noturna-2026-05-27/` com nome próprio.
Depois Claudio consolida + implementa.
