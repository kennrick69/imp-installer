# CAMILA — UX da ponte web da squad

**Frente 2** · análise UX mobile-first · sem código
**Autora:** Camila (criativa IMP Dev Squad)
**Data:** 2026-05-27

---

## TL;DR (pro JOs)

3 telas: **Login**, **Chat com squad** e **Caixa de envio com print**.
Stack: **HTML + vanilla JS + Lit (web components leves) + PWA**. Sem framework pesado.
Fluxo print celular: tira screenshot Android → abre squad.kennrick.com.br (já logado por cookie) → toca câmera/galeria → preview → Enviar.
**PWA cabe, e MUITO** — é o que torna o caso "no semáforo" viável: ícone na home, sem barra de browser, push notification quando Claudio responde.

---

## 1. Princípios de design

Antes das telas:

1. **Mobile-first, não mobile-also.** A tela principal é projetada pro iPhone SE (375px portrait). Desktop é "mobile com mais espaço lateral", não o contrário.
2. **Um único objetivo por tela.** Login = logar. Chat = ler/responder. Print = anexar/enviar. Nada de modais empilhados, nada de sidebars complicadas.
3. **Touch first.** Botões >=44×44px. Sem hover-only. Sem tooltips que escondem info crítica.
4. **Conteúdo > cromos.** Bolhas do chat ocupam ~85% da tela mobile. Header e input minimalistas.
5. **Latência percebida = 0.** Mensagem do JOs aparece IMEDIATAMENTE na tela (optimistic UI), com ✓ pendente, vira ✓✓ quando tmux confirma.
6. **Funciona com mão suja, dirigindo parado.** Botão de enviar grande, na zona de alcance do polegar (parte inferior).
7. **Dark default.** Lê melhor de dia no carro (menos reflexo) e à noite (não cega). Toggle opcional pra light.

---

## 2. Paleta e identidade

Reaproveita identidade IMP (consistente com imp-interface dark):

| Token | Hex | Uso |
|---|---|---|
| `--bg` | `#0a0a0f` | Fundo geral |
| `--bg-card` | `#12121a` | Bolha agente, header |
| `--accent` | `#0D9488` | **Teal IMP** — botões primários, bolha do JOs, foco |
| `--accent-hover` | `#0F766E` | Hover/active |
| `--text` | `#ffffff` | Texto principal |
| `--text-muted` | `#8888aa` | Timestamp, hints |
| `--ok` | `#22c55e` | ✓✓ entregue |
| `--warn` | `#fbbf24` | Conectando |
| `--err` | `#ef4444` | Erro envio |

**Cor por persona** (bolha do agente — ajuda a identificar de relance):

- Líder (Carlos): `#3b82f6` azul
- Arquiteto (Marcos): `#8b5cf6` roxo
- Criativo (Camila): `#ec4899` rosa
- Debugger (Bruno): `#fbbf24` âmbar
- QA (Patrícia): `#22c55e` verde
- Revisor (Eduardo): `#f97316` laranja
- TODOS / sistema: cinza `--text-muted`

---

## 3. Mockup ASCII — Tela 1: LOGIN

**Mobile (375px portrait):**

```
┌─────────────────────────────────────┐
│                                     │
│                                     │
│              ▢ ▢ ▢                  │  ← logo IMP (teal)
│              IMP                    │
│         Dev Squad — Comando         │
│                                     │
│           Acesso restrito           │
│                                     │
│  ┌───────────────────────────────┐  │
│  │ usuário                       │  │  ← 48px altura
│  └───────────────────────────────┘  │
│                                     │
│  ┌───────────────────────────────┐  │
│  │ senha               👁          │  │  ← olhinho ver/ocultar
│  └───────────────────────────────┘  │
│                                     │
│  ☑ Lembrar este dispositivo (30d)   │
│                                     │
│  ┌───────────────────────────────┐  │
│  │         ENTRAR                │  │  ← teal #0D9488, 52px
│  └───────────────────────────────┘  │
│                                     │
│      Esqueci a senha →              │  ← link sutil
│                                     │
│                                     │
│       conexão segura · v0.1         │  ← rodapé tiny
└─────────────────────────────────────┘
```

**Desktop (≥768px):**
Mesmo layout, centralizado em card de 400px de largura, com plano de fundo levemente gradiente. Foco automático no campo usuário. Enter avança/loga.

**Notas:**
- "Esqueci a senha" abre um modal explicando "Reset manual — fale com JOs no WhatsApp." (não é caso de uso real, JOs admin único)
- Cookie "lembrar" = JWT httpOnly 30 dias (não localStorage — Patrícia vai amar)
- Após login, redireciona pra `/chat` (mesma URL, view diferente — SPA leve)
- Em telas <600px largura: ocupa 100% com padding 24px horizontal

---

## 4. Mockup ASCII — Tela 2: CHAT (vista principal)

**Mobile (375px portrait):**

```
┌─────────────────────────────────────┐
│ ☰  Squad ao vivo            ⚙ ↻    │  ← header 56px
│ 🟢 tmux:imp · 6 agentes              │  ← status bar 32px
├─────────────────────────────────────┤
│                                     │
│  ┌──────────────────────┐           │
│  │ Carlos · 14:22       │           │  ← bolha agente esquerda
│  │ Pronto pra missão.   │           │
│  │ Pode mandar o brief. │           │
│  └──────────────────────┘           │
│                                     │
│           ┌────────────────────┐    │
│           │ JOs · 14:23     ✓✓ │    │  ← bolha JOs direita
│           │ olha esse bug do   │    │
│           │ Maria, tabela tá   │    │
│           │ estourando layout  │    │
│           │ ┌──────────────┐   │    │
│           │ │  [thumb.png] │   │    │  ← print inline (tap = full)
│           │ └──────────────┘   │    │
│           └────────────────────┘    │
│                                     │
│  ┌──────────────────────┐           │
│  │ Bruno · 14:23        │           │
│  │ Vi. O `overflow-x`   │           │
│  │ tá faltando no       │           │
│  │ container .casos-... │           │
│  └──────────────────────┘           │
│                                     │
│  ┌────────────────┐                 │
│  │ Patrícia digi… │                 │  ← indicador (3 pontos pulsando)
│  └────────────────┘                 │
│                                     │
├─────────────────────────────────────┤
│ Para: [🎯 TODOS         ▼]          │  ← selector agente (44px)
│ ┌──────────────────────┐ ┌──┐ ┌──┐  │
│ │ digite ou cole...    │ │📷│ │➤ │  │  ← textarea + foto + enviar
│ └──────────────────────┘ └──┘ └──┘  │
└─────────────────────────────────────┘
```

**Desktop (≥1024px):**

```
┌─────────────────────────────────────────────────────────────┐
│ IMP Squad · Comando                  🟢 tmux:imp   ⚙ JOs ▾  │
├──────────────┬──────────────────────────────────────────────┤
│  AGENTES     │  Conversa com TODOS                          │
│              │                                              │
│  ◉ Líder     │  ┌─────────────────┐                         │
│  ○ Arquiteto │  │ Carlos · 14:22  │                         │
│  ○ Criativo  │  │ Pronto.         │                         │
│  ○ Debugger  │  └─────────────────┘                         │
│  ○ QA        │                       ┌──────────────────┐   │
│  ○ Revisor   │                       │ JOs · 14:23   ✓✓ │   │
│  ● TODOS     │                       │ olha esse bug    │   │
│              │                       │ [thumb]          │   │
│  ─────────   │                       └──────────────────┘   │
│  Filtros     │  ┌─────────────────┐                         │
│  ☑ Só @meu   │  │ Bruno · 14:23   │                         │
│  ☐ Pings     │  │ Vi. overflow-x..│                         │
│              │  └─────────────────┘                         │
│              │                                              │
│              ├──────────────────────────────────────────────┤
│              │ [TODOS ▼] ┌───────────────────┐ 📷 📎 ➤      │
│              │           │ Ctrl+V cola print │              │
│              │           └───────────────────┘              │
└──────────────┴──────────────────────────────────────────────┘
```

**Detalhes:**
- **Auto-scroll** segue o fim, MAS pausa se usuário rolar pra cima (para não interromper leitura). Botão flutuante "↓ novas mensagens" volta ao final.
- **Bolha JOs:** fundo teal `#0D9488`, texto branco, alinhada direita, raio 16px com canto inferior direito 4px.
- **Bolha agente:** fundo `#12121a`, borda esquerda 3px cor-da-persona, alinhada esquerda, mesma forma espelhada.
- **Timestamp + nome** acima da bolha, cinza muted, 11px.
- **Indicador "digitando..."** — 3 pontinhos animados em bolha vazia. Detectado por polling tmux do agente cujo painel mudou nos últimos 2s mas sem `@@FIM@@`.
- **Tap longo na bolha:** copia texto (mobile). No desktop, hover mostra botão `Copiar`.
- **Tap em thumb de print:** abre fullscreen com pinch-zoom.

---

## 5. Mockup ASCII — Tela 3: CAIXA DE ENVIO + PREVIEW DE PRINT

**Mobile com print anexado (estado expandido):**

```
├─────────────────────────────────────┤
│ Para: [🎯 TODOS         ▼]          │
│                                     │
│ ┌─────────────┐                     │  ← preview do anexo
│ │ [thumb 80x] │ ✕                   │     toca ✕ pra remover
│ │             │                     │     thumb 80×80px
│ └─────────────┘                     │
│                                     │
│ ┌─────────────────────────────────┐ │
│ │ olha esse bug, a tabela tá      │ │  ← textarea expande
│ │ estourando o layout no mobile   │ │     até 5 linhas, depois rola
│ │                                 │ │
│ └─────────────────────────────────┘ │
│                                     │
│ ┌──┐ ┌──┐                  ┌──────┐ │
│ │📷│ │📎│  ☑ incluir @@FIM@@│ ➤   │ │  ← enviar grande (teal)
│ └──┘ └──┘                  └──────┘ │
└─────────────────────────────────────┘
```

**Estados do botão 📷 no mobile:**

Quando JOs toca 📷, abre **action sheet nativo do OS**:
```
┌─────────────────────────────────────┐
│         Anexar print                │
├─────────────────────────────────────┤
│  📸 Tirar foto agora                │  ← capture=environment
│  🖼  Escolher da galeria            │
│  📋 Colar do clipboard              │
│  ❌ Cancelar                        │
└─────────────────────────────────────┘
```

Tecnicamente são 2 `<input type="file">`:
- `accept="image/*" capture="environment"` → abre câmera direto
- `accept="image/*"` (sem capture) → abre seletor (que no Android inclui "última captura")

**Desktop:**
- Ctrl+V dentro da textarea cola screenshot (handler já existe na imp-interface, reaproveita 1:1)
- Drag-and-drop arquivo na textarea ou na área de chat
- Botão 📎 pra dialog de arquivo
- Múltiplos prints por mensagem (preview horizontal scroll de thumbs)

**Após Enviar:**
1. Optimistic UI: bolha do JOs aparece IMEDIATA com ✓ pendente
2. Upload do(s) print(s) → POST multipart pro server (notebook)
3. Server salva em `/tmp/imp-paste-<timestamp>.png`
4. Server faz `tmux send-keys`: `texto + [PRINT: /tmp/imp-paste-XXX.png] @@FIM@@`
5. ✓ vira ✓✓ quando confirma
6. Limpa textarea + preview

---

## 6. Stack frontend recomendado

**Recomendação: HTML + CSS + vanilla JS + Lit + Workbox (PWA)**

| Camada | Escolha | Por quê |
|---|---|---|
| Base | HTML semântico + CSS custom (sem Tailwind) | bundle < 20KB, carrega instantâneo no 3G |
| Componentes | **Lit 3.x** (web components) | 5KB gzip, sem build pesado, encapsula bolhas/preview |
| Estado | localStorage + EventTarget custom | não precisa Redux/Zustand pra um chat |
| Transporte | **fetch + EventSource (SSE)** pro tail tmux | mais simples que WebSocket, suficiente, atrás de Cloudflare aguenta bem |
| Upload | `FormData` + `fetch` multipart | nativo, sem libs |
| PWA | **Workbox** ou Service Worker artesanal | cache de shell + offline UI |
| Build | **esbuild** ou nada (ESM direto) | <1s build, sem webpack |

**Por que NÃO React/Vue/Svelte/HTMX:**
- React/Vue: >40KB gzip + tooling pesado. Overkill pra 3 telas.
- Svelte: ótimo mas exige build step e o JOs vai querer editar manualmente
- HTMX: bom pro lado server-rendered, mas a UX de chat com bolhas/preview/optimistic UI pede JS client-side mesmo

**Resultado-alvo:**
- First Contentful Paint < 1s no 4G
- Bundle inicial < 30KB gzip
- Funciona offline (shell + última conversa cacheada)

---

## 7. Mobile-first: detalhes técnicos

| Requisito | Solução |
|---|---|
| Touch target | mínimo 44×44px (Apple HIG) — botões 48px, ícones com padding |
| Sem hover | toda interação tem feedback de tap (ripple/scale 0.97) |
| Fonte input | `16px` mínimo (evita iOS zoom-on-focus) |
| Portrait 375px | grid fluido, sem horizontal scroll |
| Landscape | header colapsa pra 40px, lista cresce |
| Safe area | `env(safe-area-inset-*)` pro notch/home bar iOS |
| Teclado on-screen | usa `100dvh` (não `vh`) — evita bug iOS Safari |
| Pull-to-refresh | desabilitado no body (interfere com scroll do chat) |

---

## 8. PWA — cabe? **SIM, OBRIGATÓRIO.**

Razões:

1. **Ícone na home** — JOs toca uma vez, não precisa abrir browser, digitar URL. Comportamento de app nativo.
2. **Sem barra do browser** — `display: standalone` no manifest. Mais tela útil no celular pequeno.
3. **Offline UI** — service worker cacheia HTML/CSS/JS. Quando entra no túnel/elevador, app abre, mostra histórico cacheado, fila mensagem pra enviar quando voltar conexão.
4. **Push notification** — Web Push API (suportado iOS 16.4+, Android sempre). Quando Claudio responde, badge no ícone + notificação na lockscreen.
5. **Não precisa app store** — distribui via URL, instala num tap.

**Manifest mínimo:**
```json
{
  "name": "IMP Squad",
  "short_name": "Squad",
  "start_url": "/chat",
  "display": "standalone",
  "background_color": "#0a0a0f",
  "theme_color": "#0D9488",
  "icons": [{ "src": "/icon-512.png", "sizes": "512x512", "type": "image/png" }]
}
```

**Push notification fluxo:**
1. Primeiro login no celular → prompt nativo "Permitir notificações?"
2. JOs aceita → subscription enviada pro server (notebook)
3. Server tem watcher tmux que detecta `@@FIM@@` em painel de agente
4. Server dispara web-push pro endpoint do JOs com payload `{ agente: "Claudio", preview: "Vi. O overflow..." }`
5. Notificação chega no lockscreen do iPhone/Android
6. Tap → abre PWA direto na conversa

**Som opcional:** toggle em settings. Default OFF (JOs dirigindo não quer som inesperado).

---

## 9. Fluxo print celular — passo a passo

```
JOs no carro, semáforo vermelho:
1. Vê bug no Maria (app dele) → segura Power+Volume-Down → screenshot salvo
2. Toca ícone "Squad" na home → PWA abre direto no chat (cookie 30d, já logado)
3. Toca 📷 → action sheet → "Escolher da galeria" → última foto (screenshot) selecionada
4. Preview thumb aparece acima da textarea
5. Toca textarea → digita "olha esse bug" (16px, sem zoom)
6. Toca botão grande teal ➤
7. Optimistic: bolha dele aparece imediata com ✓
8. Upload 200KB → 2s no 4G → ✓✓
9. Server cola `[PRINT: /tmp/imp-paste-XXX.png]` no tmux do Claudio
10. Claudio lê print via Read tool, responde
11. Server detecta @@FIM@@ no painel → dispara push
12. iPhone do JOs vibra: "Claudio: Vi. O overflow-x tá faltando..."
13. Sinal verde, segue dirigindo. Lê na próxima parada.
```

---

## 10. Reaproveitamento do paste handler imp-interface

A imp-interface (Electron) já resolveu o problema 80% — **adapta, não reescreve**:

### O que reaproveita 1:1

| Componente imp-interface | Adaptação web |
|---|---|
| `ta.addEventListener('paste', ...)` (app.js:691) | **IDÊNTICO** — clipboard API é igual em browser |
| `[PRINT: /path/file.png]` tag embedded | **IDÊNTICA** — Claude (Claudio) já entende, não muda |
| `getPendingPastes()` / `_pendingPastes[]` | **IDÊNTICA** — gerencia array em memória |
| `buildMessageWithPastes(text, pastes)` | **IDÊNTICA** — concatena tags antes do envio |
| `_renderPasteThumb(path)` UI thumb + ✕ | **MESMA LÓGICA**, mas `<img src>` muda |
| `clearPendingPastes()` após envio | **IDÊNTICA** |

### O que muda (camada de persistência)

| imp-interface (Electron) | Ponte web |
|---|---|
| `api.clipboard.savePastedImage(buf, ext)` via IPC → grava em /tmp localmente | `POST /api/paste` multipart → server salva em /tmp do notebook |
| `img.src = 'file://' + path` (Electron pode ler file://) | `img.src = URL.createObjectURL(blob)` (preview local) OU `/api/paste/<id>/thumb` (depois do upload) |
| Path retornado pelo IPC é o final | Server retorna `{ path: "/tmp/imp-paste-XXX.png" }` no JSON |

### Pseudocódigo da adaptação (só pra ilustrar — NÃO É CÓDIGO FINAL)

```
// Web — só muda a chamada de save
ta.addEventListener('paste', async (e) => {
  for (const item of e.clipboardData.items) {
    if (!item.type?.startsWith('image/')) continue;
    e.preventDefault();
    const blob = item.getAsFile();
    // PREVIEW LOCAL IMEDIATO (objectURL)
    const localUrl = URL.createObjectURL(blob);
    renderPasteThumb(localUrl, /* uploading */ true);
    // UPLOAD ASSÍNCRONO
    const fd = new FormData();
    fd.append('image', blob);
    const res = await fetch('/api/paste', { method: 'POST', body: fd });
    const { path } = await res.json();
    attachPastedImage(path); // server-side path, usado no [PRINT: ...]
  }
});
```

A **lógica de UX** (thumb, ✕, build da tag) é cópia carbono. Só a "ponte" muda de IPC → HTTP.

---

## 11. Temas e acessibilidade (não-bloqueante mas importante)

- **Dark default** (paleta acima)
- **Toggle light/dark** em settings, persistido em localStorage + cookie
- **Prefers-color-scheme** respeitado se nunca tocado
- **WCAG AA:**
  - Contraste texto/fundo >= 4.5:1 (testado: branco em `#0a0a0f` = 18.5:1 ✓)
  - Foco visível (outline teal 2px em todos interativos)
  - `aria-live="polite"` no chat (anuncia novas mensagens pra screen reader)
  - `aria-label` em todos botões ícone-only (📷 → "Anexar print")
  - Navegação 100% via teclado (Tab/Shift+Tab/Enter/Esc)
- **Reduced motion:** `@media (prefers-reduced-motion)` desliga animação de bolhas/digitando

---

## 12. O que NÃO entra (escopo claro)

- ❌ Edição de personas (já existe na imp-interface — fica lá)
- ❌ Sala 3D (não cabe no celular, e é entretenimento, não missão crítica)
- ❌ Settings de tmux/paths (só JOs no notebook configura)
- ❌ Multi-usuário/multi-tenant (só JOs usa)
- ❌ Histórico antigo paginado (V1 mostra os últimos 100 turnos da sessão atual)
- ❌ Reactions/emojis nas bolhas (V2 talvez)

---

## 13. Resumo executivo

| Pergunta | Resposta |
|---|---|
| Quantas telas? | **3** — Login, Chat, Caixa de envio (a "caixa" é parte do Chat, mas é uma região de design separada) |
| Framework? | **Vanilla JS + Lit + PWA** (sem React/Vue/Svelte) |
| PWA cabe? | **SIM, obrigatório** — ícone na home + push + offline = caso de uso real |
| Paste handler imp-interface? | **Reaproveita 80%** — só troca IPC por HTTP multipart |
| Mobile-first? | **Sim** — desktop é mobile com mais espaço |
| Tempo estimado de implementação UX (depois da arquitetura/auth prontas)? | **3-4 dias** dev focado (Bruno + Marcos) |

---

**Camila — IMP Dev Squad · criativa**
*"Se JOs não consegue mandar print no semáforo, a ponte falhou."*
