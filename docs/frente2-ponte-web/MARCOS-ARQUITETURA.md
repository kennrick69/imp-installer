# MARCOS — Arquitetura da ponte web pra squad

> Frente 2 — análise arquitetural sem viés. Notebook segue dono da squad (tmux + Claude Code logado conta Max). Ponte é camada web POR CIMA.

## TL;DR
**Recomendação: Opção B (Cloudflare Tunnel direto do notebook)**, com Opção C (Tailscale) como fallback se segurança/privacidade for prioridade máxima. Justificativas detalhadas abaixo.

---

## 1. Premissas técnicas

Antes das opções, é importante fixar o que NÃO muda:

- **Squad atual intocada**: imp-orchestrator, imp-squad, tmux sessions permanecem como hoje.
- **Sem API Claude**: agentes seguem logados via Claude Code CLI conta Max do JOs.
- **Bridge é processo separado**: pequeno servidor Node (Express + WebSocket) que importa o equivalente do `tmux-bridge.js` da imp-interface — mesma mecânica de `capture-pane` + `load-buffer` + `paste-buffer` + `send-keys`. Zero modificação no projeto da squad.
- **Acesso**: desktop (navegador) + celular (navegador mobile). Print upload necessário (objetivo JOs #1).

---

## 2. Opções analisadas

### Opção A — Railway hospeda interface + túnel reverso pro notebook

**Topologia:**
```
[Celular/Desktop] ──HTTPS──> [Railway app público]
                                    │
                                    │ WebSocket via túnel reverso
                                    ▼
                             [Notebook (agente leve)]
                                    │
                                    ▼ tmux-bridge local
                             [tmux + squad]
```

**Componentes:**
- App Node/Express em Railway (interface web, auth, upload prints, render terminal).
- Agente leve no notebook que abre WebSocket *outbound* pro Railway (firewall-friendly) e expõe a interface de tmux via esse canal.

**Prós:**
- URL pública estável (`squad.kennrick.com.br` apontando pro Railway).
- HTTPS automático (Railway gerencia certs).
- Sem mexer DNS residencial do JOs.
- Logs/observabilidade centralizados no Railway (familiar pra ele).
- Se o notebook reiniciar, Railway continua online — usuário vê tela "notebook offline" em vez de erro DNS.

**Contras:**
- **2 saltos de rede** (cliente → Railway → notebook) = latência somada.
- Custo Railway ~$5/mês (e ele já tem outras coisas lá; não é blocker, mas é custo).
- Maior complexidade: precisa manter agente reconectante + protocolo entre Railway e notebook (mais um sistema pra debugar).
- Lock-in Railway (não grave, mas considerar).
- Upload de print pesa 2x na banda (cliente → Railway → notebook).

---

### Opção B — Cloudflare Tunnel direto do notebook (sem Railway)

**Topologia:**
```
[Celular/Desktop] ──HTTPS──> [Cloudflare Edge] ──tunnel──> [Notebook]
                                                              │
                                                              ▼
                                                  [Express + WS + tmux-bridge]
                                                              │
                                                              ▼
                                                       [tmux + squad]
```

**Componentes:**
- App Node/Express + WebSocket roda 100% no notebook (porta local, ex: 7777).
- `cloudflared` daemon no notebook abre conexão outbound persistente com Cloudflare.
- Domínio `squad.kennrick.com.br` (ou subdomínio Cloudflare grátis tipo `xxx.trycloudflare.com`) aponta pro túnel.

**Prós:**
- **1 salto lógico**: cliente → Cloudflare edge → notebook. Cloudflare tem POPs no Brasil, latência baixa.
- **Custo zero** (Cloudflare Tunnel é grátis no plano free; basta conta Cloudflare).
- HTTPS automático com certs gerenciados pela Cloudflare.
- Configuração 1x (`cloudflared tunnel create` + DNS), depois é "set and forget".
- Notebook firewall-friendly: outbound only, não precisa abrir portas no router.
- Cloudflare oferece **Cloudflare Access** opcional (auth por Google/email/etc no edge) — ganho de segurança grátis depois.
- Sem 3º servidor pra manter.

**Contras:**
- Notebook precisa estar online — se cair, URL retorna erro 502 do Cloudflare. (Mas isso é verdade em qualquer opção que tenha notebook como única fonte.)
- Depende de conta Cloudflare (já é commodity; JOs provavelmente tem; senão grátis).
- Se Cloudflare tiver outage global rara, fica fora (já aconteceu, mas raro).
- Configuração inicial do túnel exige ~10 min de setup (1x).

---

### Opção C — Tailscale (rede privada / WireGuard mesh)

**Topologia:**
```
[Notebook]      [Desktop]       [Celular]
    │               │               │
    └───── tailnet (WireGuard mesh, criptografado) ─────┘

Cliente acessa http://notebook-hostname:7777 dentro da tailnet.
```

**Componentes:**
- App web roda no notebook (mesmo Express + WS).
- Tailscale instalado em notebook, desktop, celular.
- Acesso via hostname mágico (`notebook.tail-xxx.ts.net`) ou IP da tailnet.

**Prós:**
- **Segurança intrínseca**: nada na internet pública, só dispositivos autenticados na tailnet enxergam.
- Zero auth adicional na app (Tailscale já autenticou o device).
- Latência ótima (WireGuard direto, peer-to-peer quando possível).
- Setup trivial (instala app, login Google, pronto).
- Plano free pessoal cobre até 100 dispositivos.

**Contras:**
- **Precisa app Tailscale instalado em cada device** — celular incluso. Não é "URL pública compartilhável".
- Compartilhar com terceiro (ex: mostrar pra alguém) exige convidar pra tailnet ou usar Tailscale Funnel (que basicamente vira a Opção B com etapas extras).
- Hostname não é "bonito" (squad.kennrick.com.br) — é `notebook.tail-xxx.ts.net` ou tem que configurar MagicDNS+CNAME manualmente.
- Se JOs trocar de celular ou usar device emprestado, precisa logar Tailscale lá antes.

---

### Opção D — VPS dedicado (DO/Hetzner droplet)

**Topologia:** igual Railway (Opção A), mas trocando Railway por VPS Linux que JOs administra.

**Prós:**
- Controle total, IP fixo, custo previsível (~$4-6/mês).
- Pode rodar outras coisas no VPS.

**Contras:**
- Manutenção de VPS (security updates, monitoring, backup).
- Mesma complexidade de 2 saltos que Railway, sem o managed.
- JOs não pediu poder operacional extra; é tempo desperdiçado.

**Veredito:** dominado pela Opção A em todos os critérios práticos.

---

### Opção E — Port forward + DDNS no router residencial

**Prós:** zero terceiros.

**Contras:**
- ISP residencial (Vivo/Claro/Tim no Brasil) frequentemente faz CGNAT — IP público não existe, port forward não funciona.
- Mesmo sem CGNAT: IP dinâmico, DDNS frágil, exposição direta da LAN, certificados HTTPS são dor (Let's Encrypt + renovação).
- Segurança ruim (porta aberta na LAN do JOs apontando pro notebook).

**Veredito:** descartar. Risco/esforço não compensa.

---

## 3. Tradeoffs — tabela comparativa

| Critério            | A (Railway) | B (Cloudflare Tunnel) | C (Tailscale) | D (VPS) | E (Port fwd) |
|---------------------|-------------|-----------------------|---------------|---------|--------------|
| Custo mensal        | ~$5         | $0                    | $0            | ~$4-6   | $0           |
| Complexidade setup  | Média       | Baixa                 | Muito baixa   | Alta    | Alta+frágil  |
| Manutenção contínua | Baixa       | Quase zero            | Quase zero    | Média   | Alta         |
| Latência            | Média (2 saltos) | Baixa (CF edge BR) | Muito baixa (P2P) | Média | Baixa (se ISP deixar) |
| Segurança default   | Boa (auth app) | Boa (HTTPS, +Access opcional) | Excelente (rede privada) | Boa | Ruim |
| URL pública compartilhável | Sim    | Sim                   | Não (sem Funnel) | Sim   | Sim, mas frágil |
| Acesso "qualquer celular" sem instalar nada | Sim | Sim | Não | Sim | Sim |
| Lock-in             | Médio (Railway) | Baixo (CF é commodity) | Baixo  | Nenhum  | Nenhum |
| Resiliência se notebook cair | Página carrega, mostra "offline" | 502 do CF | Timeout | Página carrega | DNS lookup falha |
| Tempo até funcionar (estimado) | 1-2 dias dev | 4-6 horas | 1-2 horas | 2-3 dias dev | 1 dia + sorte ISP |

---

## 4. Recomendação

### Primeira escolha: **Opção B — Cloudflare Tunnel**

**Três critérios decisivos:**

1. **Latência e simplicidade arquitetural** — 1 salto via Cloudflare edge (POP em SP) é mais rápido que 2 saltos via Railway, e é UM componente novo (cloudflared) em vez de DOIS (Railway app + agente reconectante no notebook).

2. **Custo zero e zero lock-in** — Cloudflare Tunnel é grátis pra sempre no plano free. Migrar pra outra opção depois custa só trocar o entrypoint do túnel (a app Node/Express no notebook é a mesma).

3. **Cobre os 4 objetivos do JOs sem comprometer nenhum** — URL pública (desktop + celular sem instalar nada), upload de print funciona, prático (cloudflared é 1 comando), replicável (qualquer outro device que ele compre só precisa do navegador).

### Segunda escolha: **Opção C — Tailscale**

Se segurança/privacidade for mais valiosa que "URL bonita compartilhável", Tailscale ganha. Setup ainda mais rápido. Mas perde o requisito "celular emprestado de alguém" ou "mostrar pra terceiro" — esses precisam app Tailscale instalado.

### Risco principal da recomendada (Opção B)

**Dependência do notebook estar online.** Se ele dormir, fechar tampa, perder Wi-Fi, ou travar — `cloudflared` cai e o usuário vê erro 502 do Cloudflare em vez de tela amigável. Mitigação:
- Configurar notebook pra nunca dormir com tampa fechada (Power Settings Windows).
- Health-check via UptimeRobot batendo a URL a cada 5min (grátis) — JOs recebe alerta no celular se cair.
- (Opcional futuro) Página de fallback servida pelo Cloudflare Workers que mostra "notebook offline" em vez de 502 cru — 30 linhas de código.

**Risco secundário:** outage Cloudflare global (raro, ~1x/ano, dura minutos). Aceitável.

---

## 5. Diagrama da arquitetura recomendada (ASCII)

```
┌─────────────────────────────────────────────────────────────────────┐
│                      INTERNET PÚBLICA                               │
│                                                                     │
│   [Desktop                    [Celular                              │
│    navegador]                  navegador]                           │
│        │                            │                               │
│        │  HTTPS (TLS 1.3)           │  HTTPS (TLS 1.3)              │
│        │  squad.kennrick.com.br     │  squad.kennrick.com.br        │
│        └──────────────┬─────────────┘                               │
│                       ▼                                             │
│            ┌──────────────────────┐                                 │
│            │  Cloudflare Edge     │   ← POP São Paulo               │
│            │  (HTTPS termination, │     latência ~5-15ms BR         │
│            │   WAF, DDoS, opt.    │                                 │
│            │   Cloudflare Access) │                                 │
│            └──────────┬───────────┘                                 │
└───────────────────────│─────────────────────────────────────────────┘
                        │
                        │  Túnel persistente outbound
                        │  (QUIC/HTTP2, mTLS, iniciado pelo notebook)
                        │
┌───────────────────────│─────────────────────────────────────────────┐
│                       ▼                                             │
│               ┌──────────────────┐                                  │
│               │   cloudflared    │   ← daemon, processo isolado     │
│               │   (notebook)     │     systemd/autostart            │
│               └────────┬─────────┘                                  │
│                        │ http://localhost:7777                      │
│                        ▼                                            │
│               ┌──────────────────────────────┐                      │
│               │  imp-bridge-web (PROCESSO    │                      │
│               │  NOVO, separado)             │                      │
│               │                              │                      │
│               │  • Express (REST + estáticos)│                      │
│               │  • WebSocket (stream pane)   │                      │
│               │  • Upload print (multer)     │                      │
│               │  • Auth (Patrícia define)    │                      │
│               │  • Reutiliza tmux-bridge.js  │                      │
│               └────────┬─────────────────────┘                      │
│                        │ execFile('tmux', ...)                      │
│                        ▼                                            │
│               ┌──────────────────────────┐                          │
│               │  tmux server (intocado)  │                          │
│               │  ┌────────────────────┐  │                          │
│               │  │ session: squad     │  │                          │
│               │  │  pane 0: Camila    │  │                          │
│               │  │  pane 1: Marcos    │  │                          │
│               │  │  pane 2: Patricia  │  │                          │
│               │  │  ...               │  │                          │
│               │  └────────────────────┘  │                          │
│               └──────────────────────────┘                          │
│                                                                     │
│               ┌──────────────────────────┐                          │
│               │  imp-orchestrator        │  ← INTOCADO              │
│               │  imp-squad               │  ← INTOCADO              │
│               └──────────────────────────┘                          │
│                                                                     │
│                    NOTEBOOK DO JOs                                  │
└─────────────────────────────────────────────────────────────────────┘
```

**Legenda:**
- Tudo fora da caixa "NOTEBOOK DO JOs" é commodity (Cloudflare, internet).
- `imp-bridge-web` é **processo novo, separado**. Roda em porta local.
- `cloudflared` é **processo novo, separado**. Não conhece a squad.
- `imp-orchestrator` e `imp-squad` **não importam** nada de bridge nem cloudflared.

---

## 6. Prova de isolamento — "a ponte NÃO toca a squad"

A ponte é segura por construção. Quatro garantias:

1. **Processo separado.** `imp-bridge-web` roda como processo Node independente, em porta 7777 (ou qualquer porta livre). Não é importado, requireado, nem spawnado pelo imp-orchestrator. Se o bridge crashar, a squad nem é notificada.

2. **Comunicação via interface pública do tmux.** Bridge fala com a squad SÓ via comandos `tmux` shell (`tmux send-keys`, `tmux capture-pane`, `tmux load-buffer`, `tmux paste-buffer`) — exatamente como imp-interface já faz hoje. Não importa código JS do imp-squad nem do imp-orchestrator. O contrato é o socket Unix do tmux server, que é a API estável que o próprio tmux expõe pra qualquer processo no sistema.

3. **Filesystem read-only sobre arquivos da squad.** Bridge pode LER `~/imp-orchestrator/...` se precisar exibir estado, mas NUNCA escreve. Toda escrita acontece via `send-keys` no pane do Claude, que então decide o que fazer — mesma porta de entrada que JOs usa hoje no terminal. Não há atalho privilegiado.

4. **Reversibilidade total.** Desligar a ponte é `pkill imp-bridge-web && pkill cloudflared`. Estado da squad é idêntico ao de antes. Não há migração, não há schema, não há side-effect persistente.

**Repositório recomendado:** novo repo `imp-bridge-web` (irmão de imp-orchestrator, imp-squad, imp-interface). NUNCA dentro de imp-orchestrator. Sem dependências cruzadas em package.json.

---

## 7. Roadmap de implementação (para Bruno/Camila/Patrícia depois)

Esta análise NÃO implementa. Mas pra orientar quem vier:

**Fase 1 — Bridge HTTP local (1 dia):**
- Repo `imp-bridge-web`, Express servindo `/api/sessions`, `/api/panes/:session`, `/api/capture/:session/:pane`, `/api/send`.
- Copiar/adaptar `tmux-bridge.js` da imp-interface (módulo já maduro).
- UI mínima: lista panes, mostra capture, input de envio. Funciona em localhost:7777.

**Fase 2 — Cloudflare Tunnel (2 horas):**
- `cloudflared tunnel login`, `cloudflared tunnel create squad`, configurar DNS no Cloudflare apontando subdomínio pro túnel.
- Rodar `cloudflared tunnel run squad` apontando pra `http://localhost:7777`.
- Testar do celular fora do Wi-Fi.

**Fase 3 — Auth forte (Patrícia define):**
- Opção rápida: Cloudflare Access (Google login no edge, zero código).
- Opção autônoma: login email+senha estilo painel Maria.

**Fase 4 — UX mobile + upload print (Camila define):**
- Drag-and-drop / botão upload no mobile.
- Print salvo em `~/.imp-bridge-uploads/` com nome único; path enviado pro pane via `send-keys` ("/path/to/print.png").

**Fase 5 — Robustez:**
- Systemd unit pra bridge + cloudflared (auto-restart).
- UptimeRobot health-check.
- Página de fallback Cloudflare Workers.

---

## 8. Conclusão

Cloudflare Tunnel direto do notebook é a opção mais simples, mais barata, mais rápida de implementar e com menor superfície de manutenção. Não compromete nenhum dos 4 objetivos do JOs e mantém a squad 100% isolada. Tailscale é o plano B se a prioridade pender pra privacidade absoluta. Railway só faz sentido se aparecer requisito futuro de "interface continua viva mesmo com notebook off" — o que não é o caso hoje.

— Marcos, arquiteto IMP Dev Squad
