# CONTEXTO V0.2 — finalização do instalador

## O que já existe (v0.1.0)
- `/mnt/c/Projetos/imp-installer/` — código completo (main.js, preload.js, src/*, renderer/*, package.json)
- Repo: https://github.com/kennrick69/imp-installer (público)
- Release v0.1.0: https://github.com/kennrick69/imp-installer/releases/tag/v0.1.0
- Repo squad clonável: https://github.com/kennrick69/imp-squad (privado, Device Flow autentica)

## Review v0.1.0 (Eduardo)
Doc completo: `docs/REVIEW-EDUARDO.md` — 4 blockers + 14 ressalvas.

### 4 BLOCKERS — JÁ FIXADOS por Claudio antes do v0.1.0
- B1 (2.1): `onStepUpdate` rename `id`→`stepId`, `status`→`state` no main.js adapter
- B2 (2.2): `onPreflight` PREFLIGHT_NAME_MAP + mapeia boolean→state
- B3 (2.3): modal #modal-sudo no HTML + handler `onSudoPrompt` no wizard.js
- B4 (2.4): typo `step_13_sala_3d` → `step_13_sala3d` (replace_all main.js)
- + bonus 2.5 ALTO: openInterface tenta 3 candidates (Squad Comando.lnk, %LOCALAPPDATA%, etc.)

### 14 RESSALVAS MÉDIAS — A FIXAR na v0.2
| # | Item | Onde | Severidade |
|---|---|---|---|
| 1.2 | `assets/**/*` listado mas pasta vazia | package.json:36 | 🟡 (e o ÍCONE — Camila resolve) |
| 2.6 | `installer:pause` é no-op | main.js:252 | 🟡 |
| 2.7 | `btn-fresh` não reseta state.json | main.js, wizard.js:462 | 🟡 |
| 2.8 | `onManualPrompt` só dispara em steps com manualInstructions; passos 03 e 10 (híbridos) não têm | main.js + executors.js | 🟡 |
| 3.4 | `runner.skipStep` sem CRITICAL_STEPS — pular step 05 quebra 06+ | runner.js | 🟠 |
| 3.5 | `getState` antes de `startWizard` doc | runner.js:80 | 🟡 (só doc) |
| 3.6 | Step 04 polling 10min sem feedback (FRUSTRANTE) | executors.js:120-154 | 🟠 |
| 3.7 | Step 04 swallow silencioso (Start-Process falha sem aviso) | executors.js:141 | 🟡 |
| 4.5 | `scheduleRunOnceAfterReboot` interpola exePath | shell.js:170 | 🟡 (nit) |
| 4.6 | Erro de clone não vaza nome real "kennrick69/imp-squad ainda é privado" | executors.js:404 | 🟡 |
| 4.7 | logger mask: adicionar `ANTHROPIC_API_KEY=`, `GH_TOKEN=` plain | logger.js | 🟢 |
| 5.3 | CSS pode não ter [data-state="blocked_user_action"], [data-state="manual"] | renderer/style.css | 🟠 |
| 5.4 | Mensagens erro genéricas — falta error-catalog.js | src/error-catalog.js (novo) + main.js adapter | 🟠 |
| 5.6 | makeNoopApi vira sucesso falso se preload quebrar | wizard.js:60 | 🟡 |
| 5.7 | Versão hardcoded `v0.1.0` no HTML | renderer/index.html:22 (JÁ FIXADO — wizard.js usa api.version()) | ✅ |
| 6.§1.7 | Sem detecção de outra distro WSL | preflight.js + executors.js | 🟠 |
| 6.§2.4 | dpkg lock não detectado | executors.js step_05 | 🟠 |

## Para v0.2
1. Bruno cuida da engine (todas as ressalvas exceto visual)
2. Camila cuida do ícone + visual final (CSS dos estados faltantes)
3. Patrícia smoke test
4. Eu integro + build
5. Eduardo review final
6. Release v0.2.0

## Constraints
- Repo isolado (`/mnt/c/Projetos/imp-installer/`)
- NÃO toca proj_maria nem produção
- Sem segredos no .exe
- Anti-bug v0.3.0: `build.files` deve listar tudo que require carrega
