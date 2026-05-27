# Frente 2 — Análise de Segurança da Ponte Web

**Autora:** Patrícia (QA, IMP Dev Squad)
**Data:** 2026-05-27
**Escopo:** SÓ análise. Não cabe a mim codar, decidir custo, nem desenhar arquitetura — isso é com Marcos / Bruno. Eu olho o que pode dar ruim e como proteger.

---

## 0. TL;DR (leia se tiver pressa)

1. **Recomendação primária: Tailscale puro (tailnet privada, sem URL pública).** Reduz a superfície de ataque a praticamente zero. JOs precisa do app Tailscale no celular e no desktop — *one-time setup*, depois transparente.
2. **Se for URL pública (Cloudflare Tunnel ou similar): nunca sem TODAS as 6 camadas de auth listadas abaixo.** A ponte expõe um `tmux send-keys` arbitrário ligado a Claude com permissões de shell — risco de RCE remoto se vazar.
3. **Stack auth (caso público): bcryptjs cost 12 + JWT em cookie HttpOnly+Secure+SameSite=Strict + express-rate-limit + helmet + CSRF token + audit log.** Copia o padrão do LocaCar (já validado pelo JOs).

---

## 1. Modelo de ameaça (threat model)

### O que a ponte expõe (assets em risco)

| Asset | Impacto se vazar |
|---|---|
| `tmux send-keys` arbitrário | RCE remoto no notebook do JOs, com privilégios do user. Atacante manda `rm -rf`, exfiltra `~/.ssh/`, instala backdoor |
| `tmux capture-pane` | Leitura de TODA conversa da squad — segredos comerciais, código privado, credenciais que aparecerem em qualquer log |
| Conta Claude Max do JOs | Abuse de uso (rate limit aguenta, mas atacante pode poluir conversation history) e potencial flag de TOS |
| Persistência | Atacante injeta payload num prompt e volta dias depois pra colher resultado |

### Atacantes (threat actors)

| Perfil | Probabilidade | Mitigação suficiente |
|---|---|---|
| **Script kiddie** (varredura de `*.trycloudflare.com`, brute force genérico) | ALTA (varredura é automática 24/7) | Auth + rate limit + URL não-óbvia |
| **Atacante direcionado** (sabe que é JOs, conhece o stack, leu este doc num leak) | BAIXA mas catastrófica | Precisa TODAS as 6 camadas + Tailscale ou 2FA |
| **Insider** com acesso físico ao notebook | N/A | Fora do escopo da ponte. Cabe ao JOs trancar tela |
| **Cloudflare/provider comprometido** | Muito baixa | Tailscale evita (não passa por intermediário público) |

### Pior caso realista
Atacante varre subdomínios `*.trycloudflare.com`, encontra a ponte, vê uma tela de login. Tenta dicionário em cima de `admin/password`. Se passar → controla o notebook do JOs full-shell. Tempo médio até comprometer: 2-6 horas sem rate limit, **inviável com** rate limit de 5/15min.

---

## 2. Comparação honesta: Tailscale vs URL pública

| Critério | Tailscale puro | Cloudflare Tunnel + auth |
|---|---|---|
| **Superfície de ataque** | Praticamente nula — só dispositivos com chave da tailnet enxergam | Internet inteira enxerga; depende 100% de auth |
| **Setup celular** | Instalar app Tailscale + login Google uma vez | Abrir URL no browser |
| **Setup desktop** | App Tailscale + login uma vez | URL no browser |
| **Custo** | Free tier cobre (até 100 devices, 3 users) | Free tier do Cloudflare Tunnel |
| **Risco de "esqueci a senha"** | Não tem senha — perde acesso só se perder Google account | Auth da app é mais um ponto de falha |
| **Risco RCE se vazar URL** | Não vaza — Tailscale não tem URL pública | URL exposta é a única barreira além de auth |
| **Funciona em rede pública (4G/Wi-Fi café)** | Sim | Sim |
| **Funciona se Tailscale tiver outage** | Não (uso doméstico aceita) | Cloudflare tem outage também (raro) |
| **Compartilhar com outra pessoa rápido** | Convidar pra tailnet | Mandar URL + senha |

**Veredito Patrícia:** Tailscale puro é DRASTICAMENTE mais seguro. A única razão pra escolher URL pública é se JOs quiser eventualmente compartilhar a ponte com terceiro sem instalar app — mas isso, pelo CONTEXTO-FRENTE2.md, **não está no escopo** ("SÓ o JOs pode acessar"). Logo:

> **Recomendação: Tailscale puro.** URL pública é plano B se Tailscale falhar a usabilidade no celular do JOs em 4G dinâmico (improvável — Tailscale lida com NAT/4G nativo).

Se for URL pública, segue o restante deste doc (camadas 1-6 obrigatórias).

---

## 3. Camadas de defesa (defesa em profundidade)

Mesmo no cenário Tailscale, recomendo manter **Camada 2 (auth de aplicação) + Camada 6 (log)**. Tailscale protege a rede, mas se um device da tailnet for comprometido (celular roubado), auth de app ainda barra.

### Camada 1 — Transporte: HTTPS obrigatório
- Cloudflare Tunnel já entrega HTTPS de graça (sem certificado próprio)
- Tailscale Funnel idem; Tailscale puro usa MagicDNS interno (criptografado WireGuard, dispensa HTTPS mas pode ter)
- HSTS header com `max-age >= 31536000; includeSubDomains`
- **Bloqueio total** de HTTP — redirect 301 → HTTPS, nunca servir conteúdo em :80

### Camada 2 — Auth de aplicação (login + senha forte)
**Stack exato (copia LocaCar):**
- `bcryptjs` com `cost = 12` (LocaCar usa 10; pra ponte aumento porque é alvo maior)
- Salt único por hash (bcrypt já faz nativo)
- Hash NUNCA logado, NUNCA serializado em resposta JSON
- Senha admin: **mínimo 16 chars**, mix de classes obrigatório, validado client + server
- Email único permitido: lido de env `IMP_BRIDGE_ADMIN_EMAIL`
- Hash gerado uma vez no setup e salvo em `~/.imp-bridge/admin.hash` (chmod 600)

**Por que 16 chars e não 14:** ponte é alvo de alto valor. 14 já é OK na maioria dos casos, 16 me dá margem de segurança contra GPUs futuras. Custo de UX é desprezível (JOs salva no gerenciador de senha).

**Reset de senha:** sem reset automático. Se JOs esquecer, regenera o hash no notebook via CLI da ponte (`imp-bridge set-password`). Magic link via email é overkill pra single-user e adiciona vetor de ataque (email comprometido = ponte comprometida).

### Camada 3 — Rate limiting
- `express-rate-limit` (já no LocaCar, libs validadas):
  - `/api/login`: **5 tentativas por IP por 15min** + ban 15min após o 5º fail
  - `/api/*` geral: 100/15min
  - WebSocket connect: 10 conexões/IP/min
- Trust proxy = 1 (pra ler IP real atrás do Cloudflare Tunnel)
- Resposta **sempre genérica** ("credencial inválida") — não revela se email existe (anti-enumeração)

### Camada 4 — Session: cookie HttpOnly + Secure + SameSite=Strict
- JWT assinado com `JWT_SECRET` (256 bits, `crypto.randomBytes(32)`, gerado no install)
- TTL curto: **2 horas** (não 7 dias como LocaCar — ponte tem janela ativa, não app diário)
- Cookie attrs: `HttpOnly; Secure; SameSite=Strict; Path=/`
- **Sliding refresh** desligado: depois de 2h, login de novo. Reduz janela de roubo de cookie
- **Logout inatividade**: WS heartbeat — se não houver atividade por 30min, invalida session server-side

### Camada 5 — CSRF
- Token CSRF em todo POST/PUT/DELETE (mesmo com SameSite=Strict, é cinturão+suspensório)
- Endpoint `/api/csrf-token` retorna token vinculado ao JWT
- Cliente envia em header `X-CSRF-Token`
- Lib sugerida: `csurf` (deprecated mas ainda padrão), ou implementar HMAC manual (preferência minha — menos uma dep)

### Camada 6 — Audit log
- TODA tentativa de login (sucesso E falha): timestamp, IP, user-agent, resultado
- TODO comando enviado via `tmux send-keys`: timestamp, IP, user-agent, primeiros 200 chars do comando
- Log em arquivo `~/.imp-bridge/audit.log`, append-only, rotação por dia
- Logs NUNCA contêm senha, hash, JWT, ou conteúdo de prompts sensíveis (truncar)

### Opcional — Camada 7: 2FA TOTP
- Lib `speakeasy` + QR code no setup
- JOs lê código de 6 dígitos do Google Authenticator/Authy
- **Recomendo se URL pública.** Dispensável se Tailscale.

### Opcional — Camada 8: IP allowlist
- Casa + trabalho: IPs estáticos viáveis
- Celular 4G: IP dinâmico, allowlist quebra UX
- **Não recomendo** — gera falso senso de segurança e atrapalha mobile (que é objetivo 2 do JOs)

---

## 4. Sete riscos específicos + mitigações

| # | Risco | Probabilidade | Impacto | Mitigação |
|---|---|---|---|---|
| 1 | **RCE via comando arbitrário** — atacante autenticado (ou que bypassou auth) manda `tmux send-keys "rm -rf ~"` direto pro pane do shell | Média (se auth quebrar) | Catastrófico | Whitelist de panes alvo (só panes da squad, nunca shell raw); validar que pane target está num `tmux session` específico (`imp-squad`); confirmar antes de enviar `Ctrl+C/Ctrl+D` |
| 2 | **Vazamento de conversa** via `capture-pane` — atacante lê histórico, descobre segredos, credenciais que apareceram | Média | Alto | Sanitizar capture-pane antes de mandar pro frontend (regex em padrões `sk-...`, `ghp_...`, `AKIA...`, etc.); rate-limit em capture (max 1 req/seg); log de quem capturou |
| 3 | **Brute force na senha admin** | Alta sem mitigação | Catastrófico | Rate limit 5/15min + ban progressivo (5min, 15min, 1h, 24h); senha mínima 16 chars; alerta JOs no 3º fail |
| 4 | **Roubo de cookie de sessão** (XSS, MITM em rede pública) | Baixa | Alto | HttpOnly+Secure+SameSite=Strict; TTL 2h; CSP estrito sem inline scripts (`unsafe-inline` proibido); Subresource Integrity nos assets |
| 5 | **Custo/abuse da conta Claude Max** — atacante usa conta Max ilimitada como proxy | Média (se vazar) | Médio (Max não cobra por uso, mas TOS pode flagar) | Rate limit em quantidade de mensagens enviadas/min (10/min); kill switch (`~/.imp-bridge-disabled`); alerta JOs por email/Telegram em login bem-sucedido de IP novo |
| 6 | **Persistência via prompt injection** — atacante manda `claude, execute X toda vez que Y` na squad | Média (se vazar) | Alto | Audit log de todos os prompts; revisão semanal pelo JOs; comando `imp-bridge clear-history` que limpa contexto da squad |
| 7 | **Supply chain** (lib npm com backdoor) | Baixa mas crescente | Catastrófico | `npm audit` em CI; pinning de versão exato (`==`, sem `^`); lockfile commitado; minimizar deps (regra: cada dep nova precisa justificativa); evitar libs com <1 ano de história |

---

## 5. Comparação com padrão do LocaCar

Olhei `proj_maria` (só leitura): **Maria não tem painel admin com senha** — admin é Firebase Auth + Firestore rules. Não serve de referência direta.

**Onde JOs tem painel admin com login custom**: LocaCar (`/mnt/c/Projetos/locacar/backend`). Lá rola:

| Componente | LocaCar | Recomendação ponte web |
|---|---|---|
| Hash de senha | `bcryptjs` cost 10 | `bcryptjs` cost **12** (alvo maior) |
| Token de sessão | JWT 7d em body de resposta | JWT **2h** em **cookie HttpOnly** |
| Rate limit login | `express-rate-limit` 30/15min | **5/15min** + ban progressivo |
| Helmet | Sim, com CSP custom | Sim, CSP **mais estrito** (sem unsafe-inline/unsafe-eval) |
| Login admin | Magic link via email (senha desabilitada pra defender contra roubo de credencial MP) | Senha local + opcional 2FA TOTP (magic link adiciona dep de email, overkill pra single-user no mesmo notebook) |
| CSRF | Não vi explícito | **Adicionar** (cookie-based auth precisa) |
| Audit log | `audit_log` table no PG | Arquivo append-only (sem PG na ponte) |

**Vantagem de seguir LocaCar:** JOs já entende o padrão, mesmas libs já estão no `node_modules` cache, mesmo mental model de debug. Recomendo manter `bcryptjs + jsonwebtoken + helmet + express-rate-limit` exatos do LocaCar.

**Divergências propositais:**
- Cost 10→12 (alvo de maior valor)
- JWT em cookie ao invés de body (defesa contra XSS)
- TTL 7d→2h (janela de uso da ponte é curta)
- Adicionar CSRF (cookie auth exige)
- Sem magic link (single-user no mesmo device dispensa email loop)

---

## 6. Kill switch e contingência

### Kill switch (obrigatório)
- Arquivo `~/.imp-bridge-disabled` — se existe, bridge **recusa-se a iniciar** e ignora WebSocket conexões existentes (encerra)
- Comando CLI: `imp-bridge panic` cria o arquivo + mata processo
- JOs pode rodar isso de qualquer terminal (incluindo SSH de outra máquina) se suspeitar de comprometimento

### Notificação de login
- Telegram bot é a forma mais leve (não precisa SMTP setup):
  - Bot token + chat ID em env
  - Notifica em: login OK, login fail 3x seguidas, novo IP, kill switch ativado
- Alternativa: webhook pro Discord pessoal do JOs

### Botão "matar todas as sessions"
- Endpoint admin `POST /api/admin/revoke-all` invalida JWT_SECRET (gera novo), forçando relogin
- Útil se cookie vazar (laptop esquecido aberto, screenshot da DevTools)

### Backup de conversas
- `tmux capture-pane -p -S -10000` dump diário em `~/.imp-bridge/backups/YYYY-MM-DD.log`
- Retenção 30 dias
- Permite forense post-mortem se algo der ruim

---

## 7. Entregáveis (checklist pra Marcos/Bruno)

Se Marcos definir URL pública, garantir que implementação tenha:

- [ ] HTTPS only (HSTS header)
- [ ] bcryptjs cost 12, hash em `~/.imp-bridge/admin.hash` chmod 600
- [ ] JWT 2h em cookie HttpOnly+Secure+SameSite=Strict
- [ ] CSRF token em todo POST/PUT/DELETE
- [ ] express-rate-limit 5/15min no login, ban progressivo
- [ ] helmet com CSP **sem** unsafe-inline/unsafe-eval
- [ ] Audit log append-only em `~/.imp-bridge/audit.log`
- [ ] Sanitização de capture-pane (regex em segredos comuns)
- [ ] Whitelist de panes tmux (só `imp-squad:*`)
- [ ] Kill switch `~/.imp-bridge-disabled`
- [ ] Notificação Telegram em login
- [ ] Endpoint revoke-all
- [ ] Backup diário capture-pane
- [ ] Senha admin mín. 16 chars validado client+server
- [ ] Opcional mas recomendado: 2FA TOTP via speakeasy

Se Marcos definir Tailscale puro:
- [ ] Tailscale ACL restringindo só os devices do JOs
- [ ] Ainda assim: bcrypt auth de app + audit log + kill switch (defesa em profundidade pra caso de device da tailnet comprometido)
- [ ] HTTPS interno opcional (WireGuard já criptografa transport)

---

## 8. O que eu NÃO analisei (fora do meu escopo)

- Custo financeiro (Eduardo)
- Arquitetura de deploy (Marcos)
- Escolha de lib específica de transporte (Bruno: ttyd vs gotty vs WebSocket custom)
- UX mobile (Camila)
- Comparação web vs pocket nos 4 objetivos (Eduardo)

---

## 9. Constraints respeitadas
- [x] Não modifiquei código
- [x] Li `proj_maria` só pra referência (descobri que não tem o que JOs descreveu — admin custom existe é no **LocaCar**, e usei aquilo como base)
- [x] Documento salvo em `imp-installer/docs/frente2-ponte-web/`
- [x] Sem viés — Tailscale ganhou na análise técnica, não por preferência minha

— Patrícia, QA
