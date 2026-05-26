# IMP Squad Instalador

Instalador guiado da IMP Dev Squad. Sai de **Windows zerado** e chega em **sessão tmux `imp` com 7 Claudes + interface conectada**.

## Pra que serve

O JOs roda a squad no notebook. Pra rodar no desktop (ou em qualquer máquina nova), tem 17 passos manuais: instalar WSL2, Ubuntu, Node, Claude CLI, autenticar GitHub, clonar repos, configurar tmux… Este instalador faz isso pra você.

## Como usar

1. Baixa o `.exe` portable da [última release](https://github.com/kennrick69/imp-installer/releases/latest)
2. Duplo-clique → "Mais informações" → "Executar assim mesmo" (não tem code signing)
3. Segue o wizard:
   - Cada passo mostra o que vai fazer + categoria (AUTO / MANUAL / HÍBRIDO)
   - Passos AUTO: instalador executa, mostra log ao vivo, valida
   - Passos MANUAL: instalador guia e abre janelas pra você completar (ex: login Claude, login GitHub, primeiro boot do Ubuntu)
   - Estado salvo em `%USERPROFILE%\.imp-installer\state.json` — pode fechar e retomar
4. Ao final: abre a interface IMP Squad Comando, squad pronta

## Cenários cobertos

- ✅ Windows 10/11 x64 sem nada instalado
- ✅ Windows com WSL1 (oferece upgrade pra WSL2)
- ✅ Windows com WSL2 mas sem Ubuntu (instala distro)
- ✅ Windows com tudo (passa direto, só configura squad/repos)
- ✅ Reentrada após reboot (RunOnce + state.json)
- ✅ Retomar depois de fechar/crashar

## Arquitetura

- **Electron** (main + preload + renderer)
- **`src/`** — engine pura Node (sem dependência do Electron): state, runner, executors, shell, preflight, logger
- **`renderer/`** — wizard visual (HTML/CSS/JS)
- **`main.js`** — orquestra: pluga engine em IPC handlers + abre janela
- **`~/.imp-installer/state.json`** — schema versionado + escrita atômica + backup `.bak`

## Decisões-chave

- **Node**: nvm v0.40.4 (não nodesource — evita EACCES + PATH)
- **Claude Code CLI**: native installer (`claude.ai/install.sh`) com npm como fallback
- **GitHub auth**: `gh auth login --web` (Device Flow, sem PAT manual)
- **Ubuntu**: 22.04 LTS (24.04 ainda tem edge cases no WSL2)
- **Sala 3D** (130MB): release asset opcional ("instalar depois?")
- **Repo `imp-squad`**: privado (tem URLs prod / IPs)

## Status

`v0.1.0` — em desenvolvimento. Squad inteira da IMP envolvida:
- Marcos (arquiteto): roteiro completo (17 passos)
- Patrícia (QA): 40 riscos mapeados + 30 testes de validação shell
- Bruno (dev): comandos de automação + engine
- Camila (criativa): UI do wizard
- Eduardo (revisor): auditoria pré-build
- Claudio (CTO): coordenação + integração Electron

## Repo da squad

A squad fica em `kennrick69/imp-squad` (privado). O instalador clona pra `C:\Projetos\_squad` (pasta local mantém o nome `_squad` por compatibilidade).
