# MARCOS — Pipeline de build do runtime embarcado

**Autor:** Marcos (arquiteto IMP Squad)
**Data:** 2026-05-27
**Fase:** 2 — implementação pós-decisão MSYS2
**Escopo:** Como o `.exe` ganha o `runtime.7z` de 250–300 MB embutido. Quem roda o quê, em que ordem, com que ferramenta.

Complementa: `DECISAO-FASE1.md` (escolha técnica) e `MARCOS-EMBARCAR.md` (arquitetura runtime no `.exe`).

---

## 1. Visão geral do pipeline

```
                  [JOs / máquina Windows]
                          │
                          ▼
              scripts\build-runtime.ps1    (1x por release)
                          │
                          ├── baixa MSYS2 base 51 MB
                          ├── pacman tmux + git + node + base-devel
                          ├── claude.exe (install.ps1 Anthropic)
                          ├── gh repo clone seed (opcional)
                          ├── gera imp-squad.bat + setup.sh
                          └── 7z mx=9 ms=on  →  runtime\runtime.7z
                                                 (~250–300 MB)
                          │
                          ▼
              git ignora runtime.7z   (gitignore em runtime/)
                          │
                          ▼
                  npm run dist:win
                          │
                          ├── electron-builder lê package.json
                          ├── extraResources: runtime/runtime.7z + .sha256
                          └── empacota tudo em IMP-Squad-Instalador-X.Y.Z-portable.exe
                                                                  (~350–400 MB)
                          │
                          ▼
                  [Máquina do usuário final]
                          │
                          ├── duplo-clique .exe (7zSFX extrai pra TEMP)
                          ├── electron app sobe, Step 01: bootstrap.ps1
                          ├── descompacta resources/runtime/runtime.7z
                          │   → %LOCALAPPDATA%\IMP-Squad-Runtime\<ver>\msys64\
                          ├── Step 02: setup.sh (mkpasswd, .bashrc, validações)
                          ├── Step 03–05: gh auth + tmux session + atalho
                          └── squad rodando offline, PATH isolado
```

---

## 2. Arquivos novos / modificados

| Arquivo | Origem | Função |
|---|---|---|
| `scripts/build-runtime.ps1` | NOVO (Marcos) | Pipeline PowerShell que gera o `.7z` |
| `scripts/build-runtime.md` | NOVO (Marcos) | Docs operacionais (pré-req, troubleshooting) |
| `runtime/.gitkeep` | NOVO (Marcos) | Pasta versionada |
| `runtime/.gitignore` | NOVO (Marcos) | Ignora `runtime.7z` e `.sha256` |
| `package.json` | EDITADO (Marcos) | Adicionado `build.extraResources` |
| `docs/fase-autossuficiente/MARCOS-PIPELINE.md` | NOVO (este arquivo) | Visão completa do fluxo |

**Não tocado:** `main.js`, `preload.js`, `src/**`, `renderer/**` — separação de responsabilidades respeitada (Bruno cuida do bootstrap.ps1 + executors.js; Camila cuida da UI).

---

## 3. Sequência operacional por release

### 3.1 JOs (1x antes do release)

```powershell
cd C:\Projetos\imp-installer
.\scripts\build-runtime.ps1
# 8–15 min...
# OK Runtime gerado
#   Tamanho: 268 MB
#   SHA256 : a1b2c3...
```

Após sucesso: `runtime\runtime.7z` + `runtime\runtime.7z.sha256` existem (mas git ignora).

### 3.2 Build do `.exe`

```powershell
npm run dist:win
# electron-builder:
#   • copying extraResources: runtime/runtime.7z → resources/runtime/runtime.7z
#   • copying extraResources: runtime/runtime.7z.sha256 → resources/runtime/runtime.7z.sha256
#   • building portable installer
# dist/IMP-Squad-Instalador-0.3.0-portable.exe   (~350 MB)
```

### 3.3 Release

`gh release create v0.3.0 dist/IMP-Squad-Instalador-0.3.0-portable.exe` — JOs faz manual ou via workflow existente.

### 3.4 Usuário final

Roda `.exe`. Step 01 (Bruno) detecta `runtime.7z` em `process.resourcesPath\runtime\` e descompacta. Step 02–05 conforme MARCOS-EMBARCAR §4.

---

## 4. Versionamento e hash

- O `runtime.7z` **não é versionado independente do `.exe`** — sempre acoplado a `package.json` `version`.
- O hash SHA256 vai junto (`runtime.7z.sha256`) pra Bruno validar integridade antes de descompactar (defesa contra corrupção em disco/AV truncando o `.exe`).
- A versão MSYS2 base (`20260322`) está pinada no topo de `build-runtime.ps1`. Atualizar manual + commit quando upgradar.

---

## 5. Tamanho-alvo

| Componente | Bruto | No `.7z` |
|---|---|---|
| MSYS2 base 487 binários | 317 MB | ~80 MB |
| + tmux/git/node/base-devel | +280 MB | +150 MB |
| + claude.exe + node_modules | +80 MB | +35 MB |
| + squad-seed (depth=1) | +5 MB | +2 MB |
| + scripts | <1 MB | <1 MB |
| **Total esperado** | **~680 MB** | **~265 MB** |

Se `.7z` passar 400 MB, investigar:
1. cache pacman não limpo (`/var/cache/pacman/pkg`)
2. `--depth=1` não aplicado nos `gh repo clone`
3. compressão LZMA2 não ativada (`-mx=9`)

---

## 6. Pontos de integração com outros squad members

| Member | Depende de Marcos | Como |
|---|---|---|
| **Bruno** | sim | `bootstrap.ps1` lê `process.resourcesPath\runtime\runtime.7z` + `.sha256`; valida hash; chama 7zip embarcado (ou usa `Expand-Archive` se reformatarmos pra .zip). Bruno define a chamada de extração e detecção de "já extraído". |
| **Camila** | sim (indireto) | Step 01 sidebar = "Preparar runtime" — Camila desenha tela com barra de progresso real durante extração do `.7z` (Bruno emite eventos IPC com `bytesExtracted/totalBytes`). |
| **Patrícia** | sim | Cenários novos: AV bloqueando `.7z` em `resources/`, AppLocker barrando `bash.exe`, OneDrive sincronizando msys64. Patrícia escreve esses cenários em `PATRICIA-CENARIOS-NOVOS.md` (já existe). |
| **Eduardo** | sim | Não-regressão: confere que `extraResources` não engorda `app.asar` (binários ficam fora), que `.7z` está presente em `dist/win-unpacked/resources/runtime/`. |
| **Claudio** | sim | Coordena merge desta PR + branch pré-Fase-2 do Bruno + PR do Camila; faz primeiro release manual `v0.3.0` com `.exe` completo e mede tamanho real. |

---

## 7. Decisão: `.7z` vs `.zip` vs `.tar.zst`

| Formato | Tamanho típico | Decompressor no Win sem dep | Stream extract |
|---|---|---|---|
| `.zip` | 320–360 MB | `Expand-Archive` (PowerShell nativo) | sim |
| `.7z` | **250–290 MB** | precisa 7z.exe embarcado | sim |
| `.tar.zst` | 230–270 MB | precisa zstd.exe | sim |

**Escolha: `.7z`**. Economia de 60–100 MB no `.exe` final compensa embarcar `7za.exe` (1 MB, standalone CLI 7-Zip) dentro de `app.asar.unpacked\bin\7za.exe`. Bruno embarca esse binário; o `bootstrap.ps1` chama `7za x runtime.7z -o<destino>` em vez de depender de `Expand-Archive`.

> **TODO Bruno:** baixar `7za.exe` standalone (https://www.7-zip.org/a/7z-extra-XX.XX.7z, extrair só `7za.exe`) e adicionar em `app.asar.unpacked\bin\7za.exe`. Não é responsabilidade desta PR.

---

## 8. Riscos do pipeline

| # | Risco | Mitigação |
|---|---|---|
| **P1** | `pacman.archlinux.org` mirror cai durante build | Re-executa script (idempotente, limpa WorkDir) |
| **P2** | Anthropic muda URL `install.ps1` | Pin em variável topo do script + falha visível ("URL retornou 404") |
| **P3** | MSYS2 lança nova base + URL muda | Pin de data (`20260322`) — atualização manual + commit |
| **P4** | `gh` desautentica entre builds | `-SkipSeed` permite build sem seed, 1º launch baixa online |
| **P5** | 7-Zip não instalado na máquina de build | Pre-check no Step 0 aborta com mensagem clara |
| **P6** | claude.exe `install.ps1` ignora `CLAUDE_INSTALL_DIR` | Fallback: copia de `~/.local/bin/claude.exe` (caminho padrão) |

---

## 9. Quando NÃO regerar o runtime

Se a PR só toca UI/scripts JS, **não precisa regerar** `runtime.7z`. Reusa o `.7z` da última release.

Regerar quando:
- bump de versão MSYS2/tmux/git/node (raro)
- claude CLI release com fix importante
- mudança em `imp-squad.bat` ou `setup.sh` (estes vivem dentro do `.7z`)
- seed repos mudaram estrutura

---

## 10. Próximos passos sugeridos (não-bloqueantes)

1. **CI Windows**: `.github/workflows/build-runtime.yml` rodando em `windows-latest`, gerando `runtime.7z` como artifact + cache mensal. JOs faz `gh run download` antes do `npm run dist:win`.
2. **Hash check em runtime**: bootstrap.ps1 do Bruno valida `sha256(runtime.7z) == .sha256` antes de extrair. Aborta com modal-error se falhar.
3. **Delta updates**: na v2 do instalador, gerar `runtime-delta-v0.3.0-to-v0.4.0.7z` (só diffs) — economiza banda em upgrades. Adia.
4. **Authenticode sign**: assinar `IMP-Squad-Instalador.exe` com cert EV reduz falso-positivo Defender em 90%. Requer cert pago (~$300/ano). Adia.

---

*Fim do MARCOS-PIPELINE.md*
