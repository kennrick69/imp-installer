# scripts/ — smoke automatizado (Patrícia, QA)

Dois scripts Node.js que rodam em ~10s e pegam, em conjunto, ~80% dos bugs
de contrato/UI que já apareceram em live test (família v0.2.14 / v0.2.15).

**Quem deve rodar:** qualquer um da squad antes de cada `npm run dist:win`.
**Onde rola sozinho:** GitHub Actions em pull_request — bloqueia merge se falha.

---

## 1. `contract-matcher.js`

Cruza, em ~1s, os 3 arquivos críticos do IPC:

```
main.js  ←→  preload.js  ←→  renderer/wizard.js
```

Detecta 4 famílias de mismatch:

| # | Mismatch | Exemplo histórico |
|---|---|---|
| 1 | `ipcMain.handle('X')` sem `ipcRenderer.invoke('X')` correspondente | (handler órfão) |
| 2 | `ipcRenderer.invoke('X')` sem `ipcMain.handle('X')` | promise pende eterna |
| 3 | `sendToRenderer('onY')` sem `on('onY')` no preload | evento vai pro vácuo |
| 4 | `api.installer.Z(...)` no wizard sem declaração `Z:` no preload | "botão fantasma" v0.2.14 |

### Rodar

```bash
cd /mnt/c/Projetos/imp-installer
node scripts/contract-matcher.js
```

### Saída esperada (PASS)

```
IMP Installer — Contract Matcher (Patrícia, QA)

── 1. ipcMain.handle ↔ ipcRenderer.invoke ──────────────────────
  ✓ 28 handlers / 28 invokes — match

── 2. sendToRenderer ↔ on() listener ───────────────────────────
  11/11 eventos têm listener no preload
  ⚠ ÓRFÃO: preload.js escuta 'installer:onToast' mas main.js nunca envia
  ⚠ ÓRFÃO: preload.js escuta 'installer:onWslUpgradeProgress' mas main.js nunca envia

── 3. api.X em wizard.js ↔ métodos em preload.installer ────────
  ✓ 21 métodos usados / todos declarados no preload

── 4. api.onX em wizard.js ↔ listeners em preload.installer ────
  ✓ 12 listeners usados / todos declarados no preload

── SUMÁRIO ─────────────────────────────────────────────────────
✓ PASS — 0 mismatches.
```

Exit code **0** = passou. Exit code **1** = mismatch real (bloqueia release).
Exit code **2** = script crashou.

### O que NÃO pega

- Bugs de runtime (handler retorna shape errado).
- Encoding / quoting de Windows.
- Comportamento Windows-only (UAC, WSL legacy, RunOnce).

Pra isso → ver `jsdom-smoke.js` (contratos UI) e A/B/D do
`docs/noturna-2026-05-27/PATRICIA-CENARIOS-PROCESSO.md` (VM Win + JOs).

---

## 2. `jsdom-smoke.js`

Carrega `renderer/index.html` em jsdom, mocka `window.api.installer.*` e
simula os eventos do backend, verificando que a UI responde como esperado.

### Cenários cobertos

1. wizard.js cadastrou listeners (`onStepUpdate`, `onPreflight`, `onManualPrompt`).
2. Sidebar renderiza com 17 step-items.
3. `onStepUpdate({running})` → item da sidebar vira `data-state=running`.
4. `onPreflight({admin, ok})` → `.pf-card[data-check="admin"]` vira `data-state=ok`.
5. `onError({...})` → `#modal-error` aparece com headline + suggestions.
6. `onNeedsAdmin({stepId})` → `#modal-elevate` aparece com botão habilitado.
7. `onScreen({screen:"reboot"})` → `#screen-reboot.active` (bug v0.2.15).
8. `onScreen({screen:"wsl-upgrade"})` → `#screen-wsl-upgrade.active`.
9. `onWslUpgradeProgress({pct:47})` → `#wsl-up-fill` width = "47%".
10. `onManualPrompt({action top-level})` → `#manual-action-btn` NÃO `hidden`
    (bug v0.2.14 — "botão fantasma").
11. `onManualPrompt(fallback)` → `#manual-fallback` aparece.
12. `onManualPrompt(sem action)` → `#manual-action-btn` fica `hidden=true`.
13. `onLog` → executa sem crash.
14. `onComplete` → `#screen-done.active` + tempo mostrado.

### Rodar

```bash
cd /mnt/c/Projetos/imp-installer
npm i --no-save jsdom    # uma vez por máquina (não persiste em package.json)
node scripts/jsdom-smoke.js
```

**Nota WSL + Windows mount (`/mnt/c/`)**: o `npm i` direto na pasta pode falhar
com `EPERM: chmod` em alguns arquivos do node_modules (problema de permissão
WSL→NTFS conhecido). Workaround:

```bash
# instala jsdom num tmp Linux puro
mkdir -p /tmp/jsdom-install && cd /tmp/jsdom-install && npm init -y && npm i jsdom

# roda o smoke apontando NODE_PATH pra lá
cd /mnt/c/Projetos/imp-installer
NODE_PATH=/tmp/jsdom-install/node_modules node scripts/jsdom-smoke.js
```

No GitHub Actions runner (Ubuntu nativo) o `npm i --no-save jsdom` funciona
sem essa dança — o problema é só WSL+NTFS local.

### Saída esperada (PASS)

```
IMP Installer — jsdom Smoke (Patrícia, QA)

── RESULTADOS ─────────────────────────────────────...
  ✓ wizard.js rodou e cadastrou onStepUpdate
  ✓ wizard.js cadastrou onPreflight
  ✓ ...
TOTAL: 28 pass, 0 fail, 28 total
```

Exit code **0** = todos os checks passaram.
Exit code **1** = algum check falhou.
Exit code **2** = jsdom ausente ou script crashou (mensagem clara como instalar).

### O que NÃO pega

- Renderização visual real (Electron+Chromium, não jsdom).
- Comandos Windows reais.
- Bugs de assar/empacotamento.

Pra isso → GHA Windows runner + JOs valida (opções B+D do PATRICIA-CENARIOS).

---

## 3. Integração no fluxo pré-release

### Pre-release manual (Claudio antes de `npm run dist:win`)

```bash
node scripts/contract-matcher.js && node scripts/jsdom-smoke.js && npm run dist:win
```

Se qualquer um falhar, **NÃO builda**. Conserta primeiro.

### Pre-commit hook (sugestão)

Em `.git/hooks/pre-commit`:

```bash
#!/bin/sh
node scripts/contract-matcher.js || exit 1
node scripts/jsdom-smoke.js || exit 1
```

### CI (GitHub Actions)

Workflow `.github/workflows/smoke.yml` (criado nesta noturna) roda os 2
scripts a cada pull_request contra master. Falha bloqueia o merge.

---

## 4. ROI esperado (Patrícia, honesta)

Os 14 bugs do live-test 2026-05-25 → 2026-05-27:

- **7 bugs** do tipo "contrato divergente main↔wizard" (Eduardo Pattern B):
  `contract-matcher.js` pegaria todos em ~1s.
- **3 bugs** do tipo "DOM não atualiza com payload" (Pattern C):
  `jsdom-smoke.js` pegaria os que envolvem element-id/data-state/hidden.
- **4 bugs** Windows-only (encoding, UAC, WSL legacy):
  exigem VM Windows / GHA Win runner / JOs validar (fora deste escopo).

**Sumário**: estes 2 scripts pegariam ~70% dos bugs históricos em ~10s.
Os outros 30% exigem ambiente Windows real.

---

— Patrícia, QA da IMP Dev Squad
2026-05-27 (sessão noturna autônoma)
