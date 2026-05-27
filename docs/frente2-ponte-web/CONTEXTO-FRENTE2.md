# FRENTE 2 — Análise: ponte WEB pra squad

## OBJETIVOS JOs
1. Usar squad + ENVIAR PRINTS pros agentes, do DESKTOP
2. Notebook como SERVIDOR — acessar squad também do CELULAR enquanto dirige
3. Prático e replicável
4. (terminar o pocket = Frente 1)

## IDEIA
Squad JÁ roda no notebook (Claude Code no tmux logado conta Max). Em vez de REPLICAR a squad no desktop (custou 48h+20 versões de WSL), expõe URL WEB que dá acesso de qualquer lugar.

## ⚠️ SEM API — CRÍTICO
- Os Claudes da squad rodam logados na conta Max do JOs via Claude Code CLI
- Ponte web NÃO usa API do Claude, NÃO usa chaves, NÃO tem custo
- Ponte só faz `tmux send-keys` + `tmux capture-pane` — IGUAL imp-interface já faz hoje
- É camada web POR CIMA do tmux existente

## ISOLAMENTO TOTAL (não negociável)
- A squad atual está 99% funcional
- Ponte web NÃO pode tocar imp-orchestrator nem imp-squad
- Ponte é CAMADA SEPARADA — só lê/envia via tmux
- Se a ponte cair, a squad nem percebe

## SEM VIÉS na análise
JOs quer a verdade técnica, prós e contras reais.

## Tarefas
- Marcos: arquitetura (Railway vs túnel direto vs outras)
- Bruno-pesquisa: técnica (ttyd, gotty, cloudflare tunnel, tailscale, web custom)
- Patrícia: segurança/auth (login forte tipo painel Maria)
- Camila: UX mobile (paste/upload print do celular)
- Eduardo: análise HONESTA — web cobre os 4 objetivos melhor que pocket?

## Não tocar
proj_maria, produção, squad atual notebook, imp-interface existente
