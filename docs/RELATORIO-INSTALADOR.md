# RELATÓRIO — INSTALADOR IMP SQUAD v0.1.0

**Data**: 2026-05-26
**Coordenação**: Claudio (CTO)
**Status**: ✅ v0.1.0 publicada — https://github.com/kennrick69/imp-installer/releases/tag/v0.1.0

---

## Squad em paralelo (não solo)

| Quem | Papel | Entregou | Linhas/qtd |
|---|---|---|---|
| **Marcos** | arquiteto | `ROTEIRO-INSTALACAO-SQUAD.md` — 17 passos + 8 decisões | 447 linhas |
| **Patrícia** | QA | `RISCOS-INSTALACAO.md` — 40 riscos catalogados + 30 testes | 28 KB |
| **Bruno** | dev | `COMANDOS-AUTOMACAO.md` + engine completa (`src/*`) | 1499 linhas |
| **Camila** | criativa | Wizard visual (`renderer/*`) — paleta teal #0D9488 | 2353 linhas |
| **Eduardo** | revisor | `REVIEW-EDUARDO.md` — 4 blockers + 14 ressalvas | 309 linhas |
| **Claudio** | CTO | Coordenação + integração Electron (main.js + preload.js) + fix dos 4 blockers | 280 linhas |

Disparei Marcos+Patrícia+Bruno **paralelos** na FASE 1, depois Camila+Bruno **paralelos** na FASE 2 (Bruno fez 2 rodadas). Eduardo solo após integração. Eu fui só o coordenador e integrador — não escrevi nem o roteiro, nem o engine, nem o visual, nem a review.

**Setup boilerplate que fiz solo** (justificativa): `package.json`, `.gitignore`, `README.md` no estilo da imp-interface — meta-projeto, não cabe à squad. Tudo o resto foi delegado.

---

## FASE 1 — Mapeamento (concluída)

### Roteiro (Marcos)
17 passos:
- 12 AUTO (preflight, features WSL, version, apt, node, npm prefix, claude CLI, clones x2, tmux, download interface, E2E)
- 2 MANUAL (Ubuntu first boot, login Claude)
- 3 HÍBRIDO (WSL install+reboot, GitHub auth, sala 3D opcional)

### Riscos (Patrícia)
40 riscos:
- 12 ALTOS (virtualização BIOS, reboot interrompido, _squad GitHub, PATH Node, etc.)
- 18 MÉDIOS
- 10 BAIXOS

### Comandos (Bruno)
10 seções de snippets reais com web-verificação:
- nvm v0.40.4 confirmado (não v0.39.7)
- `@anthropic-ai/claude-code` confirmado no npm
- `wsl --install` Win11 confirmado oficial Microsoft Docs
- `gh auth login --web --git-protocol https` confirmado

### Decisões §8 (Claudio, autonomia §8)
| # | Tema | Decisão |
|---|---|---|
| D1 | Sudo | Senha interativa (não NOPASSWD) |
| D2 | Claude CLI | Latest por padrão + flag `--pin` |
| D3 | Sala 3D | Release asset opcional (botão "instalar depois") |
| D4 | imp-interface | Latest via API + fallback v0.3.1 |
| D5 | tmux | Respeita se saudável; recria se quebrado |
| D6 | Ubuntu | 22.04 LTS (24.04 ainda tem edge cases WSL2) |
| D7 | Repo squad | **PRIVADO** (tem URLs prod/IPs); renomeado `_squad` → `imp-squad` (GitHub bloqueia repos começando com `_`) |
| D8 | Claude credential | Bruno confirmou path no doc COMANDOS |

### Conflito resolvido: nvm vs nodesource
- Marcos sugeriu nodesource (paridade com setup atual)
- Patrícia sugeriu nvm (isola sistema, elimina EACCES)
- Bruno arbitrou: **nvm** (Anthropic proíbe `sudo npm install -g`; nvm + ~/.nvm sem fricção)

---

## FASE 2 — Implementação (concluída)

### Engine (Bruno) — `src/*` 1499 linhas
| Arquivo | Linhas | O quê |
|---|---|---|
| executors.js | 686 | 17 steps com detect/execute/validate/category |
| runner.js | 236 | Orquestrador, lockfile PID, reboot gate, eventos |
| shell.js | 190 | powershell(), wsl(), sudoInWsl(), withRetry, scheduleRunOnceAfterReboot |
| state.js | 168 | schema_version + write atômico + recovery via .bak |
| preflight.js | 134 | 6 checks paralelos (Windows, admin, disco, internet, virt, AV) |
| logger.js | 85 | Buffer + arquivo + mask tokens ghp_/sk-ant-/Bearer |

### Wizard (Camila) — `renderer/*` 2353 linhas
| Arquivo | Linhas | O quê |
|---|---|---|
| index.html | 452 | 7 telas + 4 modais + topbar + toast |
| style.css | 1164 | Paleta teal #0D9488, 6 estados de passo, dark theme |
| wizard.js | 737 | Comportamento, troca de telas, eventos, aria-labels |

### Integração (Claudio) — 280 linhas
- `main.js` — BrowserWindow + single instance + 17 IPC handlers + adapter de eventos engine→UI + sudo flow
- `preload.js` — contextBridge com 24 métodos (12 invoke + 12 events)

---

## Review (Eduardo)

**4 BLOCKERS encontrados** — todos pequenos, todos fixados:

| # | Problema | Fix |
|---|---|---|
| 2.1 | `onStepUpdate` runner emite `{id,status}` mas wizard espera `{stepId,state}` | adapter no main.js renomeia |
| 2.2 | `onPreflight` runner emite `{name,ok,detail}` mas wizard espera `{checkId,state,message}` | PREFLIGHT_NAME_MAP + mapeia booleano |
| 2.3 | Wizard não escutava `onSudoPrompt` — passo 05 (apt) travaria 10 min em timeout | adicionei modal HTML + handler JS |
| 2.4 | Typo `step_13_sala_3d` vs canônico `step_13_sala3d` | replace_all |

**+ 1 ALTO fixado**: openInterface apontava pra arquivo errado (`Desktop/IMP Squad Comando.exe` vs real `Desktop/Squad Comando.lnk`) — agora testa 3 candidates.

**Médios não fixados** (vão pra próxima onda):
- Pausa real (hoje no-op)
- Reset de state (btn "começar do zero" só esconde card)
- Mensagens de erro enriquecidas via error-catalog
- Cobertura de outras distros WSL conflitantes
- dpkg lock detection

---

## Build (anti-bug v0.3.0)

**Bug v0.3.0 da imp-interface**: `build.files` esqueceu `src/**/*` → `Cannot find module ./src/env`.

**Anti-bug aplicado aqui**:
1. `build.files` inclui `src/**/*` desde o início (não esquecido)
2. Eduardo auditou cada `require()` em runtime — todos cobertos
3. Validado pós-build via `npx asar list dist/win-unpacked/resources/app.asar`:

```
/main.js
/preload.js
/renderer/index.html, style.css, wizard.js
/src/executors.js, logger.js, preflight.js, runner.js, shell.js, state.js
+ package.json + electron internals
TOTAL: 11 arquivos do projeto, todos presentes
```

**Confirmação**: o .exe vai abrir sem `Cannot find module`.

---

## Release

- **Repo**: https://github.com/kennrick69/imp-installer (público)
- **Tag**: v0.1.0
- **Release**: https://github.com/kennrick69/imp-installer/releases/tag/v0.1.0
- **Assets**:
  - `IMP-Squad-Instalador-0.1.0-portable.exe` (70 MB)
  - `IMP-Squad-Instalador-v0.1.0.zip` (69 MB — com .exe + README + LEIA-ME)

---

## Repo `imp-squad` no GitHub

`_squad` local não estava no GitHub. Criei `kennrick69/imp-squad` (renomeado porque GitHub bloqueia `_squad`), **PRIVADO** (tem `PROJETOS.md` com URLs prod e IPs).

Conteúdo commitado:
- _shared/{REGRAS_GERAIS, REGRAS_LIDER, TEMPLATE_PERSONA, HISTORICO, PADROES, PROJETOS, PROTOCOLO}.md
- 6 personas: lider/arquiteto/criativo/debugger/qa/revisor (cada uma com CLAUDE.md + MEMORIA.md)
- qa/PLANO_TESTE_app-estudos.md
- .gitignore (ignora inbox/ = mensagens transitórias)

Instalador clona em `C:\Projetos\_squad` (pasta local mantém o nome `_squad` por compat).

---

## O que falta (próxima onda)

1. **Validação no desktop real do JOs** (cenário Windows zerado) — primeira pessoa a testar
2. **Médios do Eduardo** que ficaram pra próxima onda
3. **Ícone do .exe** (hoje usa ícone default do Electron)
4. **Mensagens de erro enriquecidas** via error-catalog (texto humano da Patrícia)
5. **Code signing** (alguma chave EV de futuro)
6. **Suporte a outras distros WSL** (Patrícia §1.7)

---

**Final**: missão grande, autonomia §8, squad inteira usada de verdade, 4 blockers do Eduardo todos fixados antes do build, anti-bug v0.3.0 validado. Bola pro JOs testar no desktop.

— Claudio
