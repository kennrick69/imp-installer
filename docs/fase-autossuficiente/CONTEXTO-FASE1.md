# FASE 1 — Decisão técnica do ambiente Linux-like sem virtualização

## Contexto
JOs cansou. 48h + 20 versões brigando com WSL legado/moderno, virtualização BIOS, reboots, encoding pt-BR. Decisão FINAL: **abandona WSL, embarca tudo no instalador**.

## Restrição CRÍTICA (não negociável)
**ZERO dependência de virtualização**. WSL2 falhava em "VirtualMachinePlatform not enabled" — não quero trocar WSL2 por Hyper-V/VirtualBox e bater no MESMO muro.

## Restrição SUAVE
Tamanho não importa. **1GB+ OK**. Funciona offline. Embarcado.

## O que a squad PRECISA do ambiente
- `bash` (rodar scripts)
- `tmux` (multiplexar 7 painéis de agentes)
- `git` (clone, autenticação device flow)
- `node 20` (runtime do claude CLI)
- `npm` (instalar claude CLI)
- `claude` CLI (`@anthropic-ai/claude-code`)
- `curl` / `wget` (downloads opcionais)
- básicos POSIX (`coreutils`, `sed`, `grep`)

## Opções a testar (em ordem de probabilidade)
1. **MSYS2 portable** — distribuição POSIX completa pra Windows, pacman, NÃO usa VM. Tem tmux, git, bash, node? Tamanho?
2. **Cygwin portable** — similar, mais antigo, menos atualizado
3. **Git for Windows + binários POSIX** — Git for Windows usa MSYS2 internamente; expandir com tmux/node nativos
4. **Busybox-w32 + complementos** — minimalista, falta tmux confiável
5. **Container engine sem WSL2** — Docker Desktop precisa WSL2 ou Hyper-V (volta ao problema)

## Não-regressão (preservar)
- Janela maximizada
- Sidebar 17 passos
- UAC manifest
- Preflight feedback visual
- Painel avisos âmbar
- Log UTF-16 decode
- Modal-error com sugestões
- Telas manual com botão+plano B
- safeHandle universal
- Asar bundle completo

## Tarefas dos agentes
- Bruno (dev): TESTAR MSYS2 portable + claude CLI + tmux DE VERDADE (não teorizar). Documentar resultado.
- Marcos (arquiteto): plano de embarque (extraResources, paths, cleanup)
- Patrícia (QA): cenários sem virtualização (AppLocker, AV, disco, conflito)

## Após FASE 1
Cláudio consolida decisão, FASE 2 implementa o instalador novo.
