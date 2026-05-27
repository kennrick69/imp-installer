# 🌐 FRENTE 2 — Análise consolidada: ponte web pra squad

## TL;DR — Recomendação honesta da squad (sem viés)

**SIM, a ponte web cobre 3 dos 4 objetivos do JOs MELHOR que o pocket.**

| Objetivo | Pocket Windows | Ponte Web |
|---|---|---|
| 1. Print desktop | ✓ já tem (imp-interface) | ✓ trivial codar |
| 2. **Celular dirigindo** | ❌ Electron não roda mobile | ✓✓ **WEB GANHA POR KO** |
| 3. Prático/replicável | ⚠️ 48h+20 versões/PC | ✓ 1 servidor, N clientes |
| 4. Terminar pocket | — (Frente 1) | — (irrelevante) |

**São complementares, não exclusivos**: pocket serve "PC novo sem squad" (colaborador); ponte serve "JOs acessa squad de N dispositivos" (uso real).

## ⚠️ SEM API confirmado por código

Bruno (F2 técnico) e Eduardo confirmaram lendo `/mnt/c/Projetos/imp-interface/src/tmux-bridge.js`:
- Só `execFile('tmux', ...)` — zero referência a `anthropic`/`api`/chaves
- Claudes rodam Claude Code CLI logados conta Max do JOs (no notebook)
- Ponte só faz `tmux send-keys` + `tmux capture-pane`
- **ZERO custo extra, ZERO API**

## Arquitetura recomendada (Marcos)

**Cloudflare Tunnel direto do notebook** (Opção B):
```
[Celular/Desktop browser]
         ↓
  https://squad.kennrick.com.br  ← Cloudflare Edge (POP SP, HTTPS auto)
         ↓
  cloudflared tunnel              ← processo leve no notebook
         ↓
  Node Express + ws (porta 7777)  ← ponte web (processo separado)
         ↓
  tmux send-keys / capture-pane   ← squad existente, INTOCADA
         ↓
  Claudes Claude Code CLI Max
```

**Razões (top 3)**:
1. 1 salto via Cloudflare edge (vs 2 saltos do Railway) — latência menor
2. Custo zero, lock-in baixo
3. URL pública compartilhável (celular emprestado, mostrar pra terceiro)

**2ª melhor**: Tailscale puro (Patrícia confirma — segurança intrínseca, sem URL pública atacável). Perde flexibilidade "compartilhar".

## Segurança (Patrícia)

**Decisão Tailscale vs URL pública**: Tailscale **vence drasticamente** se single-user (caso JOs).
- Zero superfície de ataque pública
- App no celular/desktop instalado 1x
- NAT/4G nativo
- Custo zero
- URL pública só faz sentido pra "compartilhar com terceiro sem app" — não é o caso

**Se URL pública**: stack auth do LocaCar (não Maria — Maria usa Firebase Auth):
- bcryptjs cost 12
- JWT 2h em cookie HttpOnly+Secure+SameSite=Strict
- express-rate-limit (5/15min, ban progressivo)
- helmet com CSP estrito
- CSRF token

**Top 3 mitigações imprescindíveis**:
1. Kill switch `~/.imp-bridge-disabled` (mata ponte em segundos)
2. Whitelist panes + sanitização (impede RCE + vaza segredos `sk-...`, `ghp_...`)
3. Audit log + Telegram em login (sem detecção, ataque silencioso dias)

## Stack técnico (Bruno F2)

**FAB**: Node + Express + ws + multer + `@imp/tmux-bridge` (extraído da imp-interface — já é Node puro sem Electron) + frontend vanilla mobile-first + Cloudflare Tunnel.

**ttyd + cloudflared + senha NÃO resolve TUDO**:
1. Paste imagem do celular falha (tmux só passa texto)
2. Sem chat dos 6 agentes (ttyd é 1 pane por aba)
3. UX mobile dirigindo ruim em terminal cru

→ **Precisa interface custom** (lightweight), reusa `tmux-bridge.js` como pacote interno.

## UX mobile (Camila)

**3 telas projetadas**: Login (cookie 30d), Chat WhatsApp-style (bolhas teal direita/agente esquerda), Caixa envio (textarea + 📷 com action-sheet câmera/galeria/clipboard).

**Framework**: vanilla JS + Lit 3.x (web components, 5KB gzip) + esbuild + Workbox PWA. Bundle <30KB gzip, FCP <1s 4G.

**PWA OBRIGATÓRIO** — manifest standalone (sem barra browser), service worker offline, Web Push Notification quando agente responde (`@@FIM@@`). É o que torna o caso "no semáforo" viável.

**Paste handler**: 80% reusável de `imp-interface/renderer/app.js` linhas 687-714. Só troca `api.clipboard.savePastedImage` (IPC) por `POST /api/paste` multipart. **Tag `[PRINT: /tmp/...]` é IDÊNTICA** — Claudio já lê com Read tool, testado.

## Isolamento provado (Eduardo)

- Bridge é **processo separado** (node Express em pasta `~/imp-bridge/`)
- Comunicação via **socket Unix do tmux** (mesma porta que JOs usa hoje)
- Repo irmão sem dependência cruzada
- Não modifica `~/_squad/`, `~/imp-orchestrator/`
- **Reversível com `pkill`**: mata ponte, squad continua rodando

## Esforço honesto (Eduardo)

**~10 dias trabalhando focado**:
- Backend (Express + ws + node-pty + auth): 3-5 dias
- Frontend (vanilla mobile-first + paste/upload): 2-4 dias
- Cloudflare Tunnel setup: 1-2 horas
- Auth forte (bcrypt + JWT + rate limit): 1-2 dias
- Testes + iteração: 2-3 dias

**Risco de bater novo "muro WSL"**: BAIXO (stack maduro, sem deps Windows).

## Riscos não-óbvios (Eduardo + Patrícia)

- Latência mobile via túnel: 200-400ms (digitação tem lag)
- Reconexão WebSocket Wi-Fi ↔ 4G no celular
- Buffer tmux pode estourar em conversas longas
- Sessão Max simultânea desktop+celular: TOS permite (mesmo CLI), mas precisa lock visual
- Notebook 24/7: energia, sleep mode (desabilitar com tampa fechada)
- Cookie expira sessão no celular durante uso

## ORDEM RECOMENDADA (Eduardo)

**PARALELO controlado**:
1. **Fechar pocket** em prazo duro (~1 semana) — Frente 1, JÁ NO AR via CI
2. **Começar MVP local da ponte** em paralelo (1-2 dias) — roda em `localhost:7777` testável via Wi-Fi local
3. **Auth forte ANTES de URL pública** — não negociável
4. **Cloudflare Tunnel** só DEPOIS do MVP local validado

## Documentos da squad

Em `docs/frente2-ponte-web/`:
- `MARCOS-ARQUITETURA.md` — arquitetura Cloudflare Tunnel direto
- `BRUNO-TECNICO.md` — stack técnico, túneis, por que ttyd não resolve
- `PATRICIA-SEGURANCA.md` — Tailscale vs URL pública, stack auth LocaCar
- `CAMILA-UX.md` — 3 telas, PWA, paste handler reuso
- `EDUARDO-ANALISE-HONESTA.md` — comparativo honesto, esforço, riscos

## Pergunta pro JOs decidir

Antes de implementar (semana próxima):
1. **Tailscale puro ou URL pública?** (recomendação: Tailscale se single-user)
2. **Repo novo `imp-bridge` ou subpasta no orquestrador?**
3. **Prioridade**: pocket termina primeiro OU pode codar ponte em paralelo já?
