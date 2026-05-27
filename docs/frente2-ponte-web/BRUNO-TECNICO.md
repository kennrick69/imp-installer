# BRUNO — pesquisa técnica FRENTE 2 (web bridge tmux squad)

**Autor:** Bruno (IMP Dev Squad) — 2026-05-27
**Escopo:** análise técnica SEM API, expondo tmux da squad via web. Não codei.
**Refs base:**
- `/mnt/c/Projetos/imp-installer/docs/frente2-ponte-web/CONTEXTO-FRENTE2.md`
- `/mnt/c/Projetos/imp-interface/src/tmux-bridge.js` (load-buffer + paste-buffer + capture-pane já implementado)
- LocaCar `backend/src/server.js` — padrão magic link + bcrypt já existente do JOs

---

## 1. Tabela comparativa — terminais web

| Ferramenta | Stack | Auth nativa | Tmux compat | Mobile UX | Paste imagem | Setup | Veredito |
|---|---|---|---|---|---|---|---|
| **ttyd** | C/libuv + xterm.js | Basic auth (`-c user:pass`) + TLS + readonly mode | `ttyd tmux attach -t squad` funciona direto; recomendado oficialmente | Menu top-left com special keys (Esc/Ctrl/Tab); funciona iOS/Android | ZMODEM/trzsz/Sixel — **não tem upload de imagem nativo**; tmux intercepta paste binário | `apt install ttyd` + 1 comando | **Pronto pra terminal — falha pra "paste print"** |
| **gotty** (sorenisanerd fork) | Go + xterm.js | Basic auth (`-c`) + URL aleatória (`-r`) + TLS | `gotty tmux new -A -s squad` (recomendado pra multi-client) | xterm.js — sem otimização mobile específica | Sem upload de arquivo nativo | Single binary Go | Funcional mas ttyd é melhor (CJK/IME, mais ativo) |
| **wetty** | Node 20 + xterm.js + websocket | password + SSH key, requer SSH backend ou `/bin/login` root | Roda comando arbitrário (logo, tmux), mas pensado pra SSH remoto | Igual xterm.js | "Downloading Files" documentado, sem upload de imagem | npm/Docker, mais pesado | Overkill — Node já assumimos no stack próprio |
| **xterm.js + node-pty custom** | Express + ws + node-pty + xterm.js | **0 nativa — você implementa** (e isso é vantagem: reusa bcrypt+magic link do LocaCar) | Total — node-pty spawna `tmux attach` igual a imp-interface faz | Total — você desenha mobile-first | **Total** — input file/drag-drop/Clipboard API, FormData → tmp + injeta path no tmux send-keys | ~200 linhas backend + 1 página HTML | **Único que cobre paste print + chat-style UI** |
| Hub.js/SuperShell | comercial | — | — | — | — | — | descartado |

**Observação crítica sobre paste de imagem em ttyd:** tmux **só repassa texto** do clipboard ao pane — binários/imagens são descartados (issue conhecida: anthropics/claude-code#25672 e ttyd#1454). Workarounds (tmux-paste-image plugin) salvam arquivo local e colam o path, mas exigem xclip/wl-paste no host — **não funciona do celular do JOs**, só do mesmo PC. Logo, ttyd puro não resolve o objetivo #1 ("enviar prints dos agentes do desktop") nem o #2 ("celular enquanto dirige").

---

## 2. Tabela comparativa — túneis

| Túnel | URL fixa | Custo | HTTPS auto | Limites | Persistência | Veredito |
|---|---|---|---|---|---|---|
| **Cloudflare Quick Tunnel** (`trycloudflare.com`) | Não — subdomínio aleatório a cada start | $0 | Sim | 200 reqs concorrentes; **sem SSE** | URL muda a cada restart do `cloudflared` | OK pra teste/dev — **ruim pra "deixar ligado pro celular"** |
| **Cloudflare Tunnel nomeado** (requer domínio na Cloudflare) | Sim — `squad.seudominio.com` | $0 + domínio (JOs já tem implocadora.com.br no Cloudflare?) | Sim | Sem limite hard | Persistente | **Recomendado** — URL fixa, gratuito, suporta WebSocket, Cloudflare Access opcional |
| **ngrok free** | Não, random | $0 | Sim (com página intersticial) | 4k req/min | Random a cada restart | Inferior ao Cloudflare |
| **ngrok paid** | $8/mês hobbyist; TCP fixo $0.01/h | pago | Sim | maiores | Sim | só se Cloudflare falhar |
| **Tailscale Funnel** | Sim — `notebook.tailnet.ts.net` | $0 (todos planos) | Sim | Portas 443/8443/10000 apenas; bandwidth limit não-configurável; Let's Encrypt 34h se exceder | Persistente | **Forte 2ª opção** — zero config DNS, mas bandwidth opaco |
| localtunnel / frp | — | $0/self-host | varia | — | varia | descartado (frp exige VPS) |

---

## 3. Auth web — reuso do padrão LocaCar

JOs **já tem em produção** (LocaCar `backend/src/server.js` linhas 75-586):
- bcrypt + ADMIN_PASSWORD env
- magic link email-based com `magic_link_tokens` (token_hash, expires_at, used_at)
- rate limit 5 req / 15 min na rota magic-link
- audit_log de ações sensíveis
- resposta genérica anti-enumeração

**Reaproveitar isto na ponte web (copy/paste + ajuste de schema sqlite/json).** Não inventar.

Para mobile/dirigindo: magic link por email é UX ruim (precisa abrir app). Recomendação:
1. **Login inicial via magic link** (1ª vez no celular)
2. **Cookie httpOnly + Secure de 30 dias** após auth (session token bcrypt no servidor)
3. Opcional fase 2: **WebAuthn/Passkey** (iOS 17+ e Android suportam, biometria do device, melhor UX dirigindo) — mas adicionar só se JOs pedir.

Descartado: OAuth GitHub (overkill, depende de 3º), JWT puro (refresh complica), HTTP Basic (frágil em mobile).

---

## 4. Paste de imagem mobile — viabilidade real

| Caminho | Desktop | iOS Safari | Android Chrome | Veredito |
|---|---|---|---|---|
| `<input type="file" accept="image/*">` | abre file picker | abre "Câmera / Fototeca / Arquivos" | idem + galeria | **Funciona em todos** |
| `<input ... capture="environment">` | ignorado | **iOS ignora `capture`** (abre seletor normal) | abre câmera direto | OK como hint |
| Drag-drop | sim | não (mobile) | não (mobile) | desktop only |
| Clipboard API `navigator.clipboard.read()` | Chrome/Edge OK | Safari 13.1+ só `image/png` + requer user gesture | Chrome Android OK | parcial — fallback file input |
| Camera Capture (getUserMedia) | sim | sim com HTTPS | sim com HTTPS | bom mas custa UX |

**Upload pipeline (igual imp-interface paste-handler):**
1. Frontend: `FormData` com fetch POST `/upload` (não WebSocket binário — complica retry/progress)
2. Backend: multer salva em `/tmp/squad-uploads/<uuid>.png`, retorna path
3. Backend ao receber msg do chat: prefixa path no texto e chama `tmux load-buffer + paste-buffer` (já implementado em `tmux-bridge.js sendKeys()`)
4. Claude Code do agent lê o path e processa (mesma UX que a imp-interface tem hoje no desktop)

---

## 5. Reuso imp-interface vs rewrite

| Aspecto | Reusar imp-interface (extrair) | Rewrite limpo |
|---|---|---|
| Tempo | 1-2 dias (extrair tmux-bridge.js + paste-handler.js, jogar em Express) | 3-5 dias |
| Risco quebra | Médio — está acoplado Electron/IPC | Zero |
| Manutenção dupla | Sim — fix em 2 lugares | Não |
| Headless | Possível: tmux-bridge.js **já é puro node** (execFile/spawn, sem Electron) ✅ | — |

**Decisão recomendada: extrair `tmux-bridge.js` como pacote npm interno** (`@imp/tmux-bridge`), tanto a imp-interface quanto a ponte web consomem. Paste-handler talvez rewrite porque mobile != desktop.

---

## 6. ttyd + cloudflared + senha cobre TUDO?

**NÃO.** Cobre o objetivo "acessar terminal do celular", mas falha em:

1. **Paste print do desktop pros agentes** — tmux engole binário do clipboard. Só funcionaria com tmux-paste-image plugin + xclip local no notebook, ou seja, **não funciona quando JOs estiver no celular** (objetivo #2).
2. **Chat-style UI dos 6 agentes** — ttyd mostra UM pane do tmux por aba. Pra "ver os 6 agentes em chat" precisa interface custom listando panes, marcando quem falou, scroll independente.
3. **UX mobile dirigindo** — terminal cru com keys especiais não é prático no semáforo. Chat com bubbles é.

ttyd resolveria se objetivo fosse só "ssh do meu celular". Não é.

---

## 7. Stack final recomendado

```
Backend:    Node + Express + ws (WebSocket) + multer (upload) + @imp/tmux-bridge (extraído)
            + bcrypt + magic_link_tokens (copiado do LocaCar)
Frontend:   HTML/CSS/JS vanilla, mobile-first
            <input type="file" accept="image/*"> + Clipboard API fallback
            Chat-bubble por agent (1 por pane do tmux), polling capture-pane 1s ou WS push
Túnel:      Cloudflare Tunnel nomeado (URL fixa) — fallback Tailscale Funnel
Auth:       Magic link 1x + cookie 30d httpOnly Secure SameSite=Lax
```

**Comando cloudflared (fixo, recomendado):**
```bash
# 1x — autenticar (abre browser)
cloudflared tunnel login

# Criar tunnel
cloudflared tunnel create squad-bridge

# Apontar DNS (ex: squad.implocadora.com.br)
cloudflared tunnel route dns squad-bridge squad.implocadora.com.br

# ~/.cloudflared/config.yml
# tunnel: <UUID>
# credentials-file: /home/jos/.cloudflared/<UUID>.json
# ingress:
#   - hostname: squad.implocadora.com.br
#     service: http://localhost:7777
#   - service: http_status:404

# Rodar (systemd ou nohup)
cloudflared tunnel run squad-bridge
```

**Comando cloudflared (rápido/teste):**
```bash
cloudflared tunnel --url http://localhost:7777
# devolve https://<random>.trycloudflare.com
```

---

## 8. Fontes

- [ttyd — github.com/tsl0922/ttyd](https://github.com/tsl0922/ttyd)
- [gotty — github.com/sorenisanerd/gotty](https://github.com/sorenisanerd/gotty)
- [wetty — github.com/butlerx/wetty](https://github.com/butlerx/wetty)
- [Cloudflare Quick Tunnels — try.cloudflare.com](https://try.cloudflare.com/)
- [Cloudflare Tunnel docs](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/)
- [Tailscale Funnel](https://tailscale.com/kb/1223/funnel)
- [Ngrok pricing](https://ngrok.com/pricing)
- [xterm.js — github.com/xtermjs/xterm.js](https://github.com/xtermjs/xterm.js)
- [tmux-paste-image plugin — github.com/jkhas8/tmux-paste-image](https://github.com/jkhas8/tmux-paste-image)
- [claude-code issue clipboard tmux — anthropics/claude-code#25672](https://github.com/anthropics/claude-code/issues/25672)
- [ttyd issue tmux copy — tsl0922/ttyd#1454](https://github.com/tsl0922/ttyd/issues/1454)
- [Web.dev — Capturing images](https://web.dev/media-capturing-images/)
- [WebKit async Clipboard API](https://webkit.org/blog/10855/async-clipboard-api/)
- [Karan Sharma — ttyd+tmux homelab](https://mrkaran.dev/posts/web-terminal-homelab/)
