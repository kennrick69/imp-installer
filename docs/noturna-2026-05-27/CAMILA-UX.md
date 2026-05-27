# CAMILA-UX — Sessão noturna 2026-05-27

Autora: **Camila** (criativa IMP Dev Squad)
Status: brainstorm + mockups + snippets prontos pra Bruno colar/iterar
Princípio: discreto, profissional, acolhedor, JOs nunca se sente burro.

---

## 0. Tom & vocabulário (recap)

Texto sempre na 1ª pessoa do instalador ("eu cuido", "vou abrir", "se travar, te aviso"). Nunca culpa o usuário. Nunca jargão técnico solto — se aparecer (PowerShell, kernel WSL, MSI), explica em 6 palavras.

Erros = "travei", não "fatal". Espera = "vai um cafézin", não "loading". Reboot = "reinicia o Windows", nunca "perform system restart".

---

## 1. Tela de REBOOT FORÇADO (nova) — `#screen-reboot`

### Quando aparece
Detectado `rebootRequired=true` AND `wslIsFunctional===false` AND `getRebootPending().pending===true`. Backend emite `installer:onScreen('reboot', payload)` e o wizard troca de tela.

### Mockup ASCII
```
┌───────────────────────────────────────────────────────────────┐
│ ◆ IMP Squad / Instalador                v0.3.0  [pill] [Logs]│
├───────────────────────────────────────────────────────────────┤
│                                                               │
│            ╭─────────────────────────────────────╮            │
│            │  ↻  Vamos reiniciar o Windows       │            │
│            ╰─────────────────────────────────────╯            │
│                                                               │
│   Habilitei as features do WSL mas o Windows precisa          │
│   REINICIAR pra ativar o kernel novo. Sem reboot, o resto     │
│   da instalação não vai funcionar.                            │
│                                                               │
│   Boa notícia: depois do reboot, eu reabro SOZINHO e          │
│   continuo do passo onde paramos (Passo 03). Você não         │
│   perde nada.                                                 │
│                                                               │
│   ┌─────────────────────────────────────────────────┐         │
│   │  ⚠  Antes de clicar:                            │         │
│   │     • Salve trabalhos abertos (Word, Excel…)    │         │
│   │     • Feche o que estiver no meio               │         │
│   │     • Deixe o cabo de força ligado se for note  │         │
│   └─────────────────────────────────────────────────┘         │
│                                                               │
│      [ 💾 Salvar progresso e reiniciar agora ]                │
│      [ Vou reiniciar manualmente daqui a pouco ]              │
│                                                               │
│   ──── Plano B (se o botão não funcionar) ────                │
│   Aperte Win+R, digite `shutdown /r /t 10` e Enter.           │
│   Vai reiniciar em 10 segundos.                               │
│   [ Copiar comando ]                                          │
│                                                               │
└───────────────────────────────────────────────────────────────┘
```

### Comportamento
- Botão primário "Salvar e reiniciar agora": chama `api.installer.scheduleRebootAndQuit()` (PEDIDO BRUNO #1 abaixo). Backend faz: salva state.json com `nextStep: step_03_wsl_install` + cria autostart no Windows (HKCU\…\RunOnce, valor = path do .exe) + agenda `shutdown /r /t 10 /c "IMP Squad: reiniciando pra habilitar WSL"`. Depois `app.quit()`.
- Botão secundário "Vou reiniciar manual": fecha o instalador (`api.closeApp()`) com toast: "Beleza. Quando reiniciar, clique de novo no atalho da Área de Trabalho — eu retomo do passo 03."
- Plano B: comando copiável `shutdown /r /t 10` + 3 passos (Win+R, cola, Enter).

### HTML (pra colar em `index.html`, depois de `#screen-progress`)
```html
<!-- TELA — REBOOT FORÇADO (Camila noturna 2026-05-27) -->
<section class="screen" id="screen-reboot" aria-labelledby="reboot-title">
  <div class="screen-inner reboot-wrap">
    <div class="reboot-hero">
      <div class="reboot-icon" aria-hidden="true">↻</div>
      <h1 id="reboot-title">Vamos reiniciar o Windows</h1>
      <p class="reboot-lead">
        Habilitei as features do WSL, mas o Windows precisa <strong>reiniciar</strong>
        pra ativar o kernel novo. Sem o reboot, o resto da instalação não vai funcionar.
      </p>
    </div>

    <div class="reboot-good-news">
      <span class="rbg-ico" aria-hidden="true">✓</span>
      <div>
        <strong>Boa notícia:</strong> depois do reboot, eu <strong>reabro sozinho</strong>
        e continuo do passo onde paramos. Você não perde nada.
      </div>
    </div>

    <div class="reboot-checklist" role="region" aria-label="Antes de reiniciar">
      <h3>Antes de clicar:</h3>
      <ul>
        <li>Salve trabalhos abertos (Word, Excel, navegadores…)</li>
        <li>Feche o que estiver no meio de fazer</li>
        <li>Se for notebook, deixe o cabo de força ligado</li>
      </ul>
    </div>

    <div class="reboot-actions">
      <button class="btn-primary btn-large" id="btn-reboot-now">
        💾 Salvar progresso e reiniciar agora
      </button>
      <button class="btn-ghost" id="btn-reboot-later">
        Vou reiniciar manualmente daqui a pouco
      </button>
    </div>

    <!-- PLANO B sempre visível -->
    <div class="reboot-fallback">
      <header class="rbf-header">
        <span class="rbf-ico" aria-hidden="true">🛟</span>
        <h3>Plano B — se o botão não funcionar</h3>
      </header>
      <p class="rbf-intro">
        Aperte <kbd>Win</kbd>+<kbd>R</kbd>, cole o comando abaixo e dê Enter.
        O Windows vai reiniciar em 10 segundos.
      </p>
      <div class="rbf-cmd-row">
        <code class="rbf-code" id="reboot-fallback-code">shutdown /r /t 10</code>
        <button class="rbf-copy" id="reboot-fallback-copy" type="button">Copiar</button>
      </div>
      <ol class="rbf-steps">
        <li>Aperte <kbd>Win</kbd>+<kbd>R</kbd> (abre a janelinha "Executar")</li>
        <li>Cole o comando e dê <kbd>Enter</kbd></li>
        <li>Quando voltar do reboot, clique no atalho da IMP Squad de novo</li>
      </ol>
    </div>

    <p class="reboot-resume-hint">
      Salvei seu progresso. Vou retomar no <strong>Passo <span id="reboot-resume-step">03</span></strong>
      quando você voltar.
    </p>
  </div>
</section>
```

### CSS (anexar em `style.css`)
```css
/* ═══ TELA — REBOOT FORÇADO (Camila noturna 2026-05-27) ═══ */
.reboot-wrap {
  max-width: 640px;
  display: flex; flex-direction: column;
  gap: 18px;
  padding-top: 32px;
}
.reboot-hero { text-align: center; padding: 12px 0 4px; }
.reboot-icon {
  width: 72px; height: 72px;
  margin: 0 auto 14px;
  background: var(--accent-soft);
  border: 2px solid var(--accent);
  border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  font-size: 38px; color: var(--accent-hover);
  box-shadow: 0 0 24px var(--accent-glow);
  animation: rebootSpin 4s linear infinite;
}
@keyframes rebootSpin { from { transform: rotate(0); } to { transform: rotate(360deg); } }
#reboot-title {
  font-size: 26px; font-weight: 700;
  letter-spacing: -0.02em;
  margin-bottom: 10px;
}
.reboot-lead {
  color: var(--text-secondary);
  font-size: 14px; line-height: 1.6;
  max-width: 520px; margin: 0 auto;
}

.reboot-good-news {
  display: flex; gap: 12px; align-items: flex-start;
  background: rgba(16, 185, 129, 0.08);
  border: 1px solid rgba(16, 185, 129, 0.30);
  border-left: 4px solid var(--ok);
  border-radius: 8px;
  padding: 12px 16px;
  font-size: 13px;
  line-height: 1.55;
}
.rbg-ico { color: var(--ok); font-weight: 700; font-size: 16px; flex-shrink: 0; }
.reboot-good-news strong { color: var(--ok); }

.reboot-checklist {
  background: rgba(245, 158, 11, 0.08);
  border: 1px solid rgba(245, 158, 11, 0.30);
  border-left: 4px solid var(--warn);
  border-radius: 8px;
  padding: 14px 18px;
}
.reboot-checklist h3 {
  font-size: 13px; font-weight: 700;
  color: #fbbf24;
  margin-bottom: 8px;
}
.reboot-checklist ul {
  list-style: none;
  display: flex; flex-direction: column; gap: 4px;
  font-size: 13px;
  color: var(--text-secondary);
}
.reboot-checklist li::before {
  content: '•';
  color: var(--warn);
  margin-right: 8px;
}

.reboot-actions {
  display: flex; flex-direction: column; gap: 8px;
  align-items: stretch;
  padding: 4px 0;
}
.reboot-actions .btn-primary {
  background: linear-gradient(135deg, var(--accent) 0%, var(--accent-hover) 100%);
  font-size: 15px;
  padding: 14px 24px;
  box-shadow: 0 4px 20px var(--accent-glow);
}
.reboot-actions .btn-primary:hover:not(:disabled) {
  box-shadow: 0 6px 28px rgba(13, 148, 136, 0.55);
}

/* Plano B (mesma família do .manual-fallback) */
.reboot-fallback {
  background: rgba(245, 158, 11, 0.08);
  border: 1px solid rgba(245, 158, 11, 0.30);
  border-left: 4px solid var(--warn);
  border-radius: 8px;
  padding: 14px 16px;
}
.rbf-header {
  display: flex; align-items: center; gap: 10px;
  margin-bottom: 8px;
}
.rbf-header h3 {
  margin: 0;
  font-size: 13px; font-weight: 600;
  color: #fbbf24;
}
.rbf-ico { font-size: 1.2em; }
.rbf-intro {
  font-size: 12px;
  color: var(--text-secondary);
  margin-bottom: 10px;
  line-height: 1.5;
}
.rbf-intro kbd {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-bottom-width: 2px;
  border-radius: 4px;
  padding: 1px 6px;
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  font-size: 11px;
  color: var(--text-primary);
}
.rbf-cmd-row {
  display: flex; gap: 8px; align-items: center;
  background: rgba(0, 0, 0, 0.35);
  border-radius: 6px;
  padding: 8px 12px;
  margin-bottom: 10px;
}
.rbf-code {
  flex: 1;
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  font-size: 13px;
  color: var(--text-primary);
}
.rbf-copy {
  flex: 0 0 auto;
  font-size: 12px;
  padding: 5px 12px;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 4px;
  color: #fbbf24;
  cursor: pointer;
  font-weight: 600;
  font-family: inherit;
}
.rbf-copy:hover { border-color: #fbbf24; }
.rbf-copy.copied { background: var(--ok); color: #fff; border-color: var(--ok); }
.rbf-steps {
  margin: 0;
  padding-left: 22px;
  display: flex; flex-direction: column; gap: 4px;
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1.5;
}
.rbf-steps li::marker { color: #fbbf24; font-weight: 600; }
.rbf-steps kbd {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 0 5px;
  font-family: ui-monospace, monospace;
  font-size: 11px;
}

.reboot-resume-hint {
  text-align: center;
  font-size: 12px;
  color: var(--text-muted);
  font-style: italic;
}
```

### JS bindings (anexar em `wizard.js`, dentro do IIFE)
```js
// ─── Tela REBOOT FORÇADO (Camila noturna 2026-05-27) ───────
function bindReboot() {
  $('#btn-reboot-now').addEventListener('click', async () => {
    const btn = $('#btn-reboot-now');
    btn.disabled = true;
    btn.innerHTML = '<span class="imp-spinner"></span> Salvando progresso e agendando reboot…';
    try {
      const r = api.scheduleRebootAndQuit
        ? await api.scheduleRebootAndQuit()
        : { ok: false, error: 'scheduleRebootAndQuit não disponível' };
      if (r && r.ok) {
        btn.innerHTML = '✓ Pronto. Windows reinicia em 10s…';
        toast('Reboot agendado. Vou reabrir sozinho depois.', 'success', 8000);
        // backend chamará app.quit() — não fazemos nada além disso
      } else {
        btn.disabled = false;
        btn.innerHTML = '💾 Salvar progresso e reiniciar agora';
        toast('Não consegui agendar o reboot: ' + (r && r.error || 'erro') +
              '. Use o Plano B abaixo.', 'error', 9000);
      }
    } catch (e) {
      btn.disabled = false;
      btn.innerHTML = '💾 Salvar progresso e reiniciar agora';
      toast('Erro: ' + (e?.message || ''), 'error');
    }
  });

  $('#btn-reboot-later').addEventListener('click', () => {
    toast('Beleza. Quando reiniciar, clique no atalho da IMP Squad — eu retomo do passo 03.',
          'info', 9000);
    setTimeout(() => api.closeApp ? api.closeApp() : window.close(), 1500);
  });

  $('#reboot-fallback-copy').addEventListener('click', async () => {
    const code = $('#reboot-fallback-code').textContent;
    const btn = $('#reboot-fallback-copy');
    try {
      await navigator.clipboard.writeText(code);
      btn.textContent = '✓ Copiado';
      btn.classList.add('copied');
      setTimeout(() => { btn.textContent = 'Copiar'; btn.classList.remove('copied'); }, 1800);
    } catch (e) {
      toast('Não consegui copiar: ' + (e?.message || ''), 'error');
    }
  });
}

// Adicionar 'reboot' no SIDEBAR_SCREENS pra sidebar ficar visível
// E em init(): bindReboot();
```

### Pedido Bruno #1
Handler novo no main.js:
```js
ipcMain.handle('installer:scheduleRebootAndQuit', async () => {
  // 1) Persiste state.json com nextStep e flag retomar-pos-reboot
  await stateStore.update({ awaitingReboot: true, nextStep: 'step_03_wsl_install' });
  // 2) Registra autostart no RunOnce do registro
  await registerRunOnce(process.execPath);  // HKCU\Software\Microsoft\Windows\CurrentVersion\RunOnce
  // 3) Agenda reboot em 10s com mensagem amigável
  spawn('shutdown', ['/r', '/t', '10', '/c', 'IMP Squad: reiniciando pra habilitar WSL'], { detached: true });
  // 4) Quit em 500ms (dá tempo do shutdown registrar)
  setTimeout(() => app.quit(), 500);
  return { ok: true };
});
```
+ no preload: `scheduleRebootAndQuit: () => ipcRenderer.invoke('installer:scheduleRebootAndQuit')`

---

## 2. Tela de MIGRAÇÃO WSL legado→moderno (nova) — `#screen-wsl-upgrade`

### Quando aparece
Detectado `wslIsLegacy === true` (build do Windows suporta wsl moderno mas `wsl.exe --version` falha com "opção inválida"). Backend baixa o MSI oficial da Microsoft (wsl_update_x64.msi ~50MB) e instala silenciosamente.

### Mockup ASCII
```
┌───────────────────────────────────────────────────────────────┐
│            ╭─────────────────────────────────────╮            │
│            │  ⚙  Atualizando o WSL               │            │
│            ╰─────────────────────────────────────╯            │
│                                                               │
│   Seu computador tem uma versão antiga do WSL                 │
│   (a que veio com o Windows). Vou baixar e instalar a         │
│   versão mais nova — oficial da Microsoft.                    │
│                                                               │
│   ⏱ Demora 1-2 minutos · 📦 ~50 MB de download                │
│                                                               │
│   [Etapa atual]                                               │
│   ⏳ Baixando wsl_update_x64.msi …                            │
│   ▰▰▰▰▰▰▰▱▱▱  73%   (37 MB de 51 MB)                          │
│                                                               │
│   ┌──────────────────────────────────────────────┐            │
│   │ Atividade ao vivo                            │            │
│   │ 00:12  GET aka.ms/wsl2kernel → 302 redirect  │            │
│   │ 00:13  Baixando wsl_update_x64.msi (51 MB)   │            │
│   │ 00:34  37 MB recebidos (3.1 MB/s)            │            │
│   └──────────────────────────────────────────────┘            │
│                                                               │
│   Não precisa fazer nada — eu cuido.                          │
│                                                               │
│   ──── Plano B (se travar) ────                               │
│   Baixe manualmente: https://aka.ms/wsl2kernel                │
│   Execute o MSI baixado. Volte aqui e clique "Já fiz".        │
│   [ Abrir link no navegador ]  [ ✓ Já fiz, continuar ]        │
│                                                               │
└───────────────────────────────────────────────────────────────┘
```

### Fases do progresso (frases humanas)
- 0-10%: "Verificando se o link tá no ar…"
- 10-90%: "Baixando wsl_update_x64.msi… {pct}%"
- 90-95%: "Download pronto. Instalando o pacote…"
- 95-100%: "Quase lá! Conferindo se ficou tudo certo…"
- 100%: "Pronto! WSL atualizado. Seguindo pro Ubuntu."

### HTML (anexar em `index.html`)
```html
<!-- TELA — MIGRAÇÃO WSL legado→moderno (Camila noturna 2026-05-27) -->
<section class="screen" id="screen-wsl-upgrade" aria-labelledby="wsl-up-title">
  <div class="screen-inner wsl-upgrade-wrap">
    <header class="wsl-up-head">
      <div class="wsl-up-icon" aria-hidden="true">⚙</div>
      <h1 id="wsl-up-title">Atualizando o WSL</h1>
      <p class="wsl-up-sub">
        Seu computador tem uma versão antiga do WSL (a que veio com o Windows).
        Vou baixar e instalar a versão mais nova — oficial da Microsoft.
      </p>
    </header>

    <div class="wsl-up-meta">
      <span class="wum-pill"><span class="wum-ico">⏱</span> 1–2 minutos</span>
      <span class="wum-pill"><span class="wum-ico">📦</span> ~50 MB</span>
      <span class="wum-pill"><span class="wum-ico">🔒</span> aka.ms/wsl2kernel (oficial MS)</span>
    </div>

    <div class="wsl-up-progress" aria-live="polite">
      <header>
        <span class="wup-stage" id="wsl-up-stage">⏳ Baixando wsl_update_x64.msi…</span>
        <span class="wup-pct" id="wsl-up-pct">0%</span>
      </header>
      <div class="wup-bar"><div class="wup-fill" id="wsl-up-fill" style="width:0%"></div></div>
      <span class="wup-detail" id="wsl-up-detail">0 MB de 51 MB</span>
    </div>

    <!-- log peek dedicado pra essa tela -->
    <section class="wsl-up-log" aria-label="Atividade ao vivo">
      <header>Atividade ao vivo</header>
      <div class="wul-body" id="wsl-up-log-body" tabindex="0"></div>
    </section>

    <p class="wsl-up-zen">Não precisa fazer nada — eu cuido.</p>

    <!-- PLANO B -->
    <div class="wsl-up-fallback">
      <header class="wuf-header">
        <span class="wuf-ico">🛟</span>
        <h3>Plano B — se travar mais que 3 minutos</h3>
      </header>
      <ol class="wuf-steps">
        <li>Clique no botão abaixo (abre o link oficial da Microsoft)</li>
        <li>Baixe o arquivo <code>wsl_update_x64.msi</code></li>
        <li>Dê duplo-clique nele e siga o instalador</li>
        <li>Volte aqui e clique em "Já fiz, continuar"</li>
      </ol>
      <div class="wuf-actions">
        <button class="btn-ghost" id="btn-wsl-up-open-link">Abrir aka.ms/wsl2kernel</button>
        <button class="btn-primary" id="btn-wsl-up-manual-done">✓ Já fiz, continuar →</button>
      </div>
    </div>
  </div>
</section>
```

### CSS
```css
/* ═══ TELA — MIGRAÇÃO WSL LEGADO→MODERNO ═══ */
.wsl-upgrade-wrap { display: flex; flex-direction: column; gap: 18px; max-width: 680px; }
.wsl-up-head { text-align: center; padding: 12px 0; }
.wsl-up-icon {
  width: 64px; height: 64px;
  margin: 0 auto 12px;
  background: var(--accent-soft);
  border: 2px solid var(--accent);
  border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  font-size: 32px; color: var(--accent-hover);
  animation: spin 3s linear infinite;
}
#wsl-up-title { font-size: 24px; font-weight: 700; margin-bottom: 8px; }
.wsl-up-sub {
  color: var(--text-secondary);
  font-size: 13px; line-height: 1.6;
  max-width: 540px; margin: 0 auto;
}
.wsl-up-meta {
  display: flex; flex-wrap: wrap; gap: 8px;
  justify-content: center;
}
.wum-pill {
  display: inline-flex; align-items: center; gap: 6px;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 16px;
  padding: 4px 12px;
  font-size: 11px;
  color: var(--text-secondary);
}
.wum-ico { color: var(--accent); }

.wsl-up-progress {
  background: var(--grad-card);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 14px 18px;
}
.wsl-up-progress header {
  display: flex; justify-content: space-between; align-items: center;
  margin-bottom: 8px;
  font-size: 13px;
  font-weight: 600;
}
.wup-stage { color: var(--text-primary); }
.wup-pct { color: var(--accent); font-variant-numeric: tabular-nums; }
.wup-bar {
  height: 8px;
  background: var(--bg-dark);
  border: 1px solid var(--border);
  border-radius: 4px;
  overflow: hidden;
  margin-bottom: 6px;
}
.wup-fill {
  height: 100%;
  background: linear-gradient(90deg, var(--accent), var(--accent-hover));
  transition: width 0.4s ease;
  box-shadow: 0 0 8px var(--accent-glow);
}
.wup-detail {
  font-size: 11px;
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
}

.wsl-up-log {
  background: var(--bg-darker);
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
}
.wsl-up-log header {
  padding: 6px 14px;
  background: var(--bg-card);
  border-bottom: 1px solid var(--border);
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.6px;
  color: var(--text-secondary);
}
.wul-body {
  max-height: 140px;
  overflow-y: auto;
  padding: 8px 14px;
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  font-size: 11.5px;
  line-height: 1.5;
  color: var(--text-secondary);
}

.wsl-up-zen {
  text-align: center;
  font-size: 13px;
  color: var(--text-muted);
  font-style: italic;
  padding: 4px 0;
}

.wsl-up-fallback {
  background: rgba(245, 158, 11, 0.08);
  border: 1px solid rgba(245, 158, 11, 0.30);
  border-left: 4px solid var(--warn);
  border-radius: 8px;
  padding: 14px 18px;
}
.wuf-header { display: flex; gap: 10px; align-items: center; margin-bottom: 8px; }
.wuf-header h3 { font-size: 13px; color: #fbbf24; font-weight: 600; }
.wuf-steps {
  margin: 0 0 12px;
  padding-left: 22px;
  display: flex; flex-direction: column; gap: 4px;
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1.5;
}
.wuf-steps code {
  background: rgba(0,0,0,0.3);
  border-radius: 3px;
  padding: 1px 5px;
  font-family: ui-monospace, monospace;
  color: var(--text-primary);
}
.wuf-actions {
  display: flex; gap: 8px; flex-wrap: wrap;
}
```

### JS bindings
```js
// ─── Tela WSL UPGRADE ──────────────────────────────────────
function bindWslUpgrade() {
  $('#btn-wsl-up-open-link').addEventListener('click', () => {
    if (api.openBrowser) api.openBrowser('https://aka.ms/wsl2kernel');
    else window.open('https://aka.ms/wsl2kernel', '_blank');
  });
  $('#btn-wsl-up-manual-done').addEventListener('click', async () => {
    try {
      const r = await api.markManualDone('step_03_wsl_install');
      if (r && r.status === 'done') {
        toast('Verificado! Seguindo pra próxima etapa.', 'success');
        showScreen('progress');
      } else {
        toast('Ainda não detectei o WSL moderno. Reinicia o Windows e tenta de novo.', 'warn', 8000);
      }
    } catch (e) {
      toast('Erro: ' + (e?.message || ''), 'error');
    }
  });
}

// Atualiza progresso vindo do backend
function updateWslUpgrade({ stage, pct, detail, logLine }) {
  if (stage) $('#wsl-up-stage').textContent = stage;
  if (typeof pct === 'number') {
    $('#wsl-up-pct').textContent = Math.round(pct) + '%';
    $('#wsl-up-fill').style.width = Math.max(0, Math.min(100, pct)) + '%';
  }
  if (detail) $('#wsl-up-detail').textContent = detail;
  if (logLine) {
    const body = $('#wsl-up-log-body');
    const line = el('div', {},
      el('span', { className: 'lp-ts' }, formatClock(Date.now()) + '  '),
      logLine
    );
    body.appendChild(line);
    while (body.children.length > 30) body.removeChild(body.firstChild);
    body.scrollTop = body.scrollHeight;
  }
}
```

### Pedido Bruno #2
Evento novo `installer:onWslUpgradeProgress` que emite `{ stage, pct, detail, logLine }` durante o download/instalação. Sequência canônica:
1. `stage: 'Verificando link…', pct: 5`
2. `stage: 'Baixando wsl_update_x64.msi…', pct: 10..90, detail: 'X MB de 51 MB'`
3. `stage: 'Instalando o pacote…', pct: 92, detail: 'msiexec rodando em silêncio'`
4. `stage: 'Conferindo…', pct: 96`
5. `stage: 'Pronto!', pct: 100` → 2s depois `showScreen('progress')` automático.

---

## 3. Tela "INSTALANDO UBUNTU, PACIÊNCIA" — `#screen-long-wait`

Genérica pra QUALQUER step que demore (>2min): step 03 (wsl --install), step 05 (apt), step 06 (nvm + node), step 11/12 (git clone + npm install).

### Mockup ASCII
```
┌───────────────────────────────────────────────────────────────┐
│        Passo 03 · Instalando WSL2 + Ubuntu 22.04              │
│                                                               │
│        ╭─────────────────────────────╮                        │
│        │  ☕  Vai um cafézin?        │                        │
│        ╰─────────────────────────────╯                        │
│                                                               │
│   Isso aqui demora uns 5-15 minutos — a Microsoft tá          │
│   baixando o Ubuntu (~500 MB) e configurando tudo.            │
│                                                               │
│   Não fechar a janela. Pode minimizar.                        │
│                                                               │
│   ▰▰▰▰▰▰▰▰▰▰  (rodando…)                                      │
│   Tempo decorrido: 04:32                                      │
│   Última atividade: há 8s                                     │
│                                                               │
│   ┌──────────────────────────────────────────────┐            │
│   │ Atividade ao vivo                            │            │
│   │ 04:15  Installing: Distribution              │            │
│   │ 04:28  Downloading appx package (438 MB)     │            │
│   │ 04:32  Registering distribution…             │            │
│   └──────────────────────────────────────────────┘            │
│                                                               │
│   💡 Dica: enquanto espera, pode ir num bom café.             │
│      Eu te chamo quando precisar de você.                     │
│                                                               │
│   [ Cancelar (cuidado — vai precisar começar de novo) ]       │
│                                                               │
└───────────────────────────────────────────────────────────────┘
```

### Notas de design
- **NÃO usar barra de progresso falsa**: usa barra animada indeterminada (shimmer) + tempo decorrido + "última atividade há Xs". Mostrar % falso quebra confiança.
- **Frases rotativas** a cada 30s, escolhidas por seed:
  - "Tá rolando. Vai um cafézin?"
  - "A Microsoft tá baixando o Ubuntu — depende da sua internet."
  - "Calma. Esse é normal demorar."
  - "Se passar de 15min sem progresso, eu te aviso."
- **Cancelar**: modal de confirmação ("vai perder o progresso desse passo e o WSL fica pela metade"). Default = NÃO.

### Brief implementação
Mais leve — reusar o `#screen-progress` existente e adicionar variante visual quando `step.kind === 'long-wait'` (badge mudada, hero icon ☕, mensagem rotativa). Bruno: emitir `{ longWait: true }` no `onStepUpdate` pra wizard ativar visual.

### CSS adicional (cabe na existente, só adicionar)
```css
/* Variante de long-wait dentro do .step-detail */
.step-detail[data-mode="long-wait"] .detail-head {
  background: linear-gradient(180deg, rgba(13, 148, 136, 0.06), transparent);
}
.step-detail[data-mode="long-wait"] .step-fill {
  /* shimmer indeterminado em vez de barra com % */
  width: 100% !important;
  background: linear-gradient(90deg,
    transparent 0%,
    var(--accent) 30%,
    var(--accent-hover) 50%,
    var(--accent) 70%,
    transparent 100%);
  background-size: 200% 100%;
  animation: longWaitShimmer 2s linear infinite;
}
@keyframes longWaitShimmer {
  0%   { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}
.long-wait-hint {
  margin-top: 8px;
  padding: 10px 14px;
  background: var(--accent-soft);
  border-left: 3px solid var(--accent);
  border-radius: 4px;
  font-size: 13px;
  color: var(--text-secondary);
  font-style: italic;
}
.long-wait-meta {
  display: flex; gap: 16px;
  font-size: 11px;
  color: var(--text-muted);
  margin-top: 6px;
  font-variant-numeric: tabular-nums;
}
```

---

## 4. PLANO B padronizado em CADA passo manual

Auditoria do estado atual: telas manual (v0.2.15) já têm `.manual-fallback` com comando + 3 passos. Padrão BOM. Falta:

### Checklist de regularização
| Passo | Tem botão? | Tem plano B? | Status |
|---|---|---|---|
| 04 (Ubuntu first boot) | sim ("Abrir Ubuntu") | parcial | precisa comando `wsl -d Ubuntu` no plano B |
| 09 (Claude login) | sim ("Abrir login Claude") | parcial | precisa `wsl claude login` no plano B |
| 10 (GitHub auth) | sim ("Copiar código + abrir browser") | sim | OK |

### Padrão final (template Camila)
Para CADA passo manual:
```yaml
action:
  label: "Verbo + objeto" (ex: "Abrir Ubuntu pra mim")
  kind: open-ubuntu | open-browser | spawn-wsl | …
  payload: { ... }
  hint: "Vou abrir aqui pra você."

steps:                              # 3-5 passos numerados, frases curtas
  - "Quando abrir, você vai ver…"
  - "Digite isso, isso e isso"
  - "Aperte Enter"

fallback:                           # SEMPRE presente em manual
  title: "Se o botão não funcionar:"
  command: "wsl -d Ubuntu"          # comando único copiável
  steps:
    - "Aperte Win+R"
    - "Cole o comando e dê Enter"
    - "Siga os mesmos passos acima"

expected: "Você vai saber que deu certo quando aparecer o prompt $"
note: "Se travar mais de 5min, clique em Pular — eu sigo."
```

### Brief Bruno
Garantir que TODOS os steps manuais (04, 09, e o reboot novo) tenham `fallback: { command, steps[3] }` no payload do `onManualPrompt`. Schema validado no main.js — se algum step manual emitir prompt SEM fallback, log de warning.

---

## 5. PLANO B em steps AUTO (novo)

Hoje só os manuais têm plano B. Steps auto que falham só mostram o modal de erro. Falta dar agência pro JOs.

### Extensão proposta
No modal de erro (`#modal-error`), adicionar bloco opcional "Plano B manual" antes das suggestions:

```
┌──────────────────────────────────────────────────────┐
│ ● Detalhes do problema                          ×    │
├──────────────────────────────────────────────────────┤
│ ! Travei no passo 05 — apt update falhou             │
│                                                      │
│ Tentei `sudo apt update && sudo apt install …` mas   │
│ o apt retornou erro de DNS.                          │
│                                                      │
│ ┌── 🛟 Plano B — você roda manual ────────────┐      │
│ │ wsl bash -lc 'sudo apt update &&            │      │
│ │   sudo apt install -y tmux git curl'        │      │
│ │ [ Copiar comando ]  [ Abrir terminal Ubuntu ]│      │
│ │                                              │      │
│ │ Depois de rodar, clique em "Tentei manual,  │      │
│ │ verifica de novo" abaixo.                   │      │
│ └─────────────────────────────────────────────┘      │
│                                                      │
│ O que tentar:                                        │
│ → Conferir conexão de internet                       │
│ → Rodar de novo (às vezes é só rede instável)        │
│                                                      │
│ [Ignorar e continuar] [Ver logs] [✓ Tentei manual]   │
│                       [Tentar de novo automático]    │
└──────────────────────────────────────────────────────┘
```

### Brief Bruno
Adicionar `fallback?: { command, terminalKind: 'wsl'|'ps'|'cmd', verifyAfter: boolean }` ao payload do `onError`. Wizard renderiza o bloco se presente.

### HTML novo dentro de #modal-error (depois de .error-headline-box)
```html
<!-- bloco condicional renderizado por JS -->
<div class="error-fallback hidden" id="error-fallback" role="region" aria-label="Plano B manual">
  <header class="ef-header">
    <span class="ef-ico" aria-hidden="true">🛟</span>
    <h4>Plano B — você roda manual</h4>
  </header>
  <div class="ef-cmd-row">
    <code class="ef-code" id="error-fallback-code"></code>
    <button class="ef-copy" id="error-fallback-copy" type="button">Copiar</button>
  </div>
  <div class="ef-actions">
    <button class="btn-ghost btn-mini" id="error-fallback-open-term">Abrir terminal Ubuntu</button>
  </div>
  <p class="ef-hint">Depois de rodar o comando, clique em <strong>"Tentei manual, verifica"</strong> abaixo.</p>
</div>
```
+ botão extra no footer: `<button class="btn-ghost" id="btn-error-fallback-verify" hidden>✓ Tentei manual, verifica</button>`

### CSS
```css
.error-fallback {
  background: rgba(245, 158, 11, 0.08);
  border: 1px solid rgba(245, 158, 11, 0.30);
  border-left: 4px solid var(--warn);
  border-radius: 8px;
  padding: 12px 14px;
  margin: 4px 0;
}
.ef-header { display: flex; gap: 8px; align-items: center; margin-bottom: 8px; }
.ef-header h4 { font-size: 12px; color: #fbbf24; font-weight: 600; margin: 0; }
.ef-cmd-row {
  display: flex; gap: 8px; align-items: center;
  background: rgba(0,0,0,0.30);
  border-radius: 6px;
  padding: 6px 10px;
  margin-bottom: 8px;
}
.ef-code {
  flex: 1;
  font-family: ui-monospace, monospace;
  font-size: 12px;
  color: var(--text-primary);
  white-space: pre-wrap;
  word-break: break-all;
}
.ef-copy {
  flex: 0 0 auto;
  font-size: 11px;
  padding: 4px 10px;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 4px;
  color: #fbbf24;
  cursor: pointer;
  font-family: inherit;
  font-weight: 600;
}
.ef-copy.copied { background: var(--ok); color: #fff; border-color: var(--ok); }
.ef-actions { display: flex; gap: 6px; margin-bottom: 6px; }
.ef-hint { font-size: 11px; color: var(--text-secondary); font-style: italic; }
```

### Comandos pré-fab por step (sugestão Camila)
| Step | Fallback command |
|---|---|
| step_05_apt_base | `wsl bash -lc 'sudo apt update && sudo apt install -y tmux git curl build-essential'` |
| step_06_node_nvm | `wsl bash -lc 'curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh \| bash && source ~/.bashrc && nvm install 20'` |
| step_07_npm_prefix | `wsl bash -lc 'mkdir -p ~/.npm-global && npm config set prefix ~/.npm-global && echo "export PATH=~/.npm-global/bin:\$PATH" >> ~/.bashrc'` |
| step_08_claude_cli | `wsl bash -lc 'npm install -g @anthropic-ai/claude-code'` |
| step_11_clone_squad | `wsl bash -lc 'cd /mnt/c/Projetos && git clone https://github.com/kennrick69/imp-squad.git'` |
| step_12_clone_orchestrator | `wsl bash -lc 'cd /mnt/c/Projetos && git clone https://github.com/kennrick69/imp-orchestrator.git && cd imp-orchestrator && npm install'` |

---

## 6. Aprimoramento: status pill comunica MELHOR

Análise: hoje status pill mostra "Processando passo 03/16: Instalar WSL2 + Ubuntu". Em long-wait JOs olha 5min depois e vê o MESMO texto — parece travado.

### Solução
Adicionar variante `data-state="long-wait"` (cor teal pulsando devagar, ícone ☕):
```css
.status-pill[data-state="long-wait"] {
  color: var(--accent-hover);
  border-color: var(--accent);
  background: var(--accent-soft);
}
.status-pill[data-state="long-wait"] .sp-ico {
  background: transparent;
  border: 0;
  font-size: 11px;
  width: auto; height: auto;
  animation: none;
  box-shadow: none;
}
.status-pill[data-state="long-wait"] .sp-ico::after {
  content: '☕';
  filter: none;
}
```
Texto rotativo a cada 30s pela JS: "Passo 03 (4min)… vai um café?" / "Ainda baixando Ubuntu (5min)… normal" / "Continua trabalhando (6min)…"

---

## 7. Não-regressão visual — CONFIRMADO

| Item | Status |
|---|---|
| Sidebar sticky 17 passos visível em preflight/progress/manual/error | OK (`SIDEBAR_SCREENS` no wizard.js) |
| Janela maximizada | OK (main.js v0.2.11) |
| Status pill no topo | OK (`#status-pill`) |
| Painel avisos amber consolidado | OK (`#preflight-warnings`) |
| Botão preflight pulse-ready quando pronto | OK |
| Plano B já presente nas manuais | OK (parcial — regularizar todos no item 4) |
| Modal de erro separado | OK |
| Auto-elevação UAC | OK |

**Adicionar telas novas em `SIDEBAR_SCREENS`** (wizard.js):
```js
const SIDEBAR_SCREENS = new Set([
  'preflight', 'progress', 'manual', 'error',
  'reboot',        // NOVO
  'wsl-upgrade'    // NOVO
]);
```

---

## 8. Resumo de PEDIDOS pro Bruno (main.js / preload)

| # | Handler/Evento | Para que serve |
|---|---|---|
| B1 | `installer:scheduleRebootAndQuit` (IPC handler) | Persiste state + autostart RunOnce + agenda `shutdown /r /t 10` + quit |
| B2 | `installer:onWslUpgradeProgress` (evento) | Emite `{stage, pct, detail, logLine}` durante download MSI |
| B3 | `installer:onScreen('reboot')` + `onScreen('wsl-upgrade')` | Comando do main pra wizard trocar de tela |
| B4 | `installer:detectWslLegacy()` (handler) | Detecta wsl LEGACY corretamente (não confiar em `wsl --version` que falha) — fallback: `wsl --help` parsing |
| B5 | `onError` payload extension: `fallback?: {command, terminalKind}` | Renderiza Plano B dentro do modal de erro pros AUTO steps |
| B6 | `installer:openTerminal(kind)` | Abre PowerShell, cmd ou `wsl` no terminal nativo — usado no botão "Abrir terminal" do plano B |
| B7 | `onStepUpdate` extension: `longWait?: boolean` | Wizard ativa visual de long-wait + frases rotativas |
| B8 | `onManualPrompt` payload: garantir `fallback` SEMPRE presente | Validar schema no main.js, warn se faltar |

---

## 9. O que IMPLEMENTEI nesta sessão

Apenas DOCUMENTEI (HTML+CSS+JS snippets prontos pra Bruno colar). Não toquei nos arquivos `index.html`, `style.css`, `wizard.js` ainda — Bruno deve revisar a integração e definir ordem das mudanças com Claudio. Todo código aqui está copy-paste-ready, sem inventar IDs/classes novas que conflitem com o existente.

Razão de não implementar:
1. Sessão noturna em paralelo — Bruno pode estar mexendo no mesmo `wizard.js` (conflito de merge ruim).
2. Os handlers `scheduleRebootAndQuit` / `onWslUpgradeProgress` precisam existir ANTES — sem eles, os botões viram no-op silencioso e dá impressão de regressão.
3. Mantém o doc auditável: tudo está num lugar só e Claudio decide a ordem.

Se Bruno preferir, posso implementar os 3 snippets HTML/CSS já no próximo turno — basta o sinal verde dele de que os handlers vão existir.

---

Fim do brief Camila — noturna 2026-05-27.
