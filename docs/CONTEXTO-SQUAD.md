# CONTEXTO COMPARTILHADO — pra Marcos/Patrícia/Bruno

## Cenário-alvo: desktop ZERADO
- Windows 10/11 x64
- Sem WSL, sem WSL2, sem Linux distro
- Sem tmux, sem node, sem git no WSL
- Sem Claude Code CLI
- Sem nenhum repo clonado
- Pode ter Git for Windows OU não

## Notebook do JOs hoje (referência do que precisa chegar lá)
- WSL2 Ubuntu
- tmux 3.x (`/usr/bin/tmux`)
- Node 20+ (`/usr/bin/node`)
- npm (`/usr/bin/npm`)
- git (`/usr/bin/git`)
- curl
- Claude Code CLI (`~/.npm-global/bin/claude`) — instalado via npm global
- `~/.git-credentials` com token GitHub (login Claude também separado)

## Componentes que o instalador precisa cuidar
1. **WSL2 + Ubuntu**: comando `wsl --install` no PowerShell admin → REBOOT
2. **Apt pkgs**: tmux, git, curl, build-essential (dentro do Ubuntu)
3. **Node 20 LTS**: nodesource OU nvm (decidir)
4. **Claude Code CLI**: `npm install -g @anthropic-ai/claude-code`
5. **Claude login**: `claude login` (MANUAL — usuário Max)
6. **GitHub auth**: token via git credential store OU gh cli
7. **Clonar repos**:
   - kennrick69/_squad ⚠️ AINDA NÃO EXISTE NO GITHUB — vou criar
   - kennrick69/imp-orchestrator (orquestrador atual)
   - escritorio-3d ⚠️ NÃO ESTÁ NO GITHUB ainda (130 MB) — decidir
8. **Sessão tmux `imp`**: criar + 7 paneis + claude code em cada
9. **imp-interface.exe**: download direto do release v0.3.1 e shortcut Desktop

## Auto vs Manual (rascunho — Marcos refina)
- AUTO: apt, npm, git clone, criação tmux session
- MANUAL: instalar WSL (precisa admin), reboot, login Claude (interativo), aceitar EULA Ubuntu na 1ª boot
- HÍBRIDO: GitHub auth (instalador pode pedir token e salvar)

## Diretórios alvo (convenção sugerida pelo Marcos no projeto imp-interface)
- `C:\Projetos\_squad` (e/ou `/mnt/c/Projetos/_squad`)
- `C:\Projetos\imp-orchestrator`
- `C:\Projetos\escritorio-3d`

## Pasta de trabalho do instalador
- `/mnt/c/Projetos/imp-installer/`
- Tudo isolado. NÃO toca proj_maria nem outros.

## Lição empacotamento (v0.3.0 → v0.3.1 da imp-interface)
- electron-builder `build.files` PRECISA listar todas as pastas (`src/**/*` foi esquecido e o app crashou).
- SEMPRE validar com `asar list` antes de release.

---

## Conflitos detectados entre os 3 docs da FASE 1

### nvm vs nodesource (Patrícia × Marcos)
- **Marcos (ROTEIRO)**: nodesource — paridade com setup atual, tmux herda PATH limpo
- **Patrícia (RISCOS)**: nvm — isola do sistema, elimina EACCES (Risco #3.3), permite versões múltiplas
- **Decisão temporária Claudio**: Bruno arbitra na COMANDOS-AUTOMACAO.md com base nos snippets reais que ele tem que escrever. Quem tiver MENOS edge cases ganha.

### Risco #7.1 (Patrícia) já resolvido por Claudio
- Patrícia listou "`_squad` não existe no GitHub" como risco #3 mais perigoso.
- ✅ Resolvido em G4: repo criado como `imp-squad` (privado).
