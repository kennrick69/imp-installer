# Workflows — IMP Squad Instalador

Pipelines automáticos no GitHub Actions. Squad roda no WSL/Linux — esses
workflows existem porque o build final precisa Windows nativo (PowerShell,
MSYS2, electron-builder pra .exe portable).

---

## `smoke.yml` — Smoke tests (Linux, ~30s)

**Trigger:** todo `push`/`pull_request` contra `master`/`main`.

Roda `scripts/contract-matcher.js` + `scripts/jsdom-smoke.js`. Cobre ~70% dos
bugs históricos (contratos main↔preload↔wizard, DOM reagindo a eventos).
Falha → bloqueia merge.

Custo: Linux runner, irrelevante.

---

## `build-windows.yml` — Build .exe com runtime embutido (Windows, 15-25min)

Pipeline ponta-a-ponta que substitui máquina Windows local. Sai .exe portable
(~340MB) com `runtime.7z` MSYS2 embutido — pronto pra publicar como Release.

### Como disparar

#### Opção A — Push de tag (recomendado, dispara release automático)

```bash
# 1. Bump version no package.json pra 0.3.1
# 2. Commit + tag + push
git add package.json
git commit -m "chore: bump v0.3.1"
git tag v0.3.1
git push origin master
git push origin v0.3.1
```

Workflow detecta `refs/tags/v*.*.*` e:
1. Builda runtime.7z
2. Builda .exe portable
3. Sobe .exe como artifact (retenção 30d)
4. Publica **GitHub Release v0.3.1** com .exe anexado e changelog auto-gerado

#### Opção B — Manual via GitHub UI

1. Vai em **Actions** → **Build Windows .exe (com runtime MSYS2 embutido)**
2. Clica em **Run workflow** (botão direito superior)
3. Branch: `master` (ou outro)
4. `release_tag` (opcional): preenche `v0.3.1-test` se quiser criar release
   prerelease draft, ou deixa vazio pra só gerar artifact

### O que sai

| Output | Onde | Retenção |
|---|---|---|
| `IMP-Squad-Instalador-X.Y.Z-portable.exe` (~340MB) | Artifact `IMP-Squad-Instalador-portable` | 30 dias |
| `runtime.7z.sha256` | Artifact `runtime-sha256` (debug) | 30 dias |
| GitHub Release (se trigger foi tag) | `Releases` na home do repo | Permanente |

### Tempo estimado

| Step | Tempo |
|---|---|
| Checkout + Setup Node | ~30s |
| Download MSYS2 base (~250MB) | 2-4 min |
| `pacman -Syuu` (2 corridas) | 5-8 min |
| Install pacotes squad (tmux/git/node/base-devel) | 2-3 min |
| Install claude.exe nativo | 1-2 min |
| Compactação `.7z` solid (`mx=9 ms=on`) | 4-6 min |
| `npm ci` + `npm run dist:win` | 3-5 min |
| Upload artifact + Release publish | 1-2 min |
| **Total** | **15-25 min** |

### Custo (free tier GitHub Actions)

- Windows runner = **2x minutos** consumidos.
- Free tier conta pessoal: 2.000 min/mês.
- 25 min × 2 (Windows multiplier) = 50 min consumidos por build.
- ≈ **40 builds/mês** dentro do free tier.

### Permissões

Workflow usa `${{ secrets.GITHUB_TOKEN }}` (built-in). Sem precisar configurar
nada. `permissions: contents: write` no job permite criar releases.

---

## Troubleshooting

### `runtime.7z não foi gerado`

`build-runtime.ps1` falhou. Vê o log do step **"Build Runtime"**. Causas comuns:

- MSYS2 URL pinada quebrou (atualizar `$MSYS2_DATE` em `scripts/build-runtime.ps1`).
- `pacman -Syu` travou (raro no runner, mas pode acontecer). Re-roda o workflow.
- 7-Zip ausente (workflow instala via choco — vê step **"Confirmar 7-Zip"**).

### Timeout no step de build runtime (30 min)

Provável `pacman` lento ou MSYS2 mirror caiu. Re-roda. Se persistir, considera
subir o `timeout-minutes` do step ou usar `--SkipClaude` no ps1.

### `.exe portable não foi gerado`

`electron-builder` falhou. Vê o log do step **"Build Electron portable .exe"**.
Comum: `extraResources` aponta pra `runtime/runtime.7z` que não existe — mas o
step anterior já valida isso, então provavelmente é bug do package.json.

### Release não publicou apesar do push de tag

- Confere se a tag bate o padrão `v*.*.*` (com prefixo `v` e 3 partes).
- Confere se `permissions: contents: write` está no job.
- Se já existe release com a tag, o workflow falha (apaga o release no GitHub
  UI e re-roda, ou usa nova tag).

### Build deu certo mas .exe não roda no Windows do JOs

Esse pipeline NÃO testa o .exe rodando. Pra isso temos o `smoke.yml` (cobre
contratos JS) + teste manual do JOs. Sintomas no .exe (UAC, encoding, paths)
precisam VM Windows pra debugar — fora do escopo desse workflow.

---

## Versão & manutenção

- Pinned `actions/checkout@v4`, `actions/setup-node@v4`, `actions/upload-artifact@v4`,
  `softprops/action-gh-release@v2` — tags major estáveis.
- MSYS2 base date pinada em `scripts/build-runtime.ps1` (`$MSYS2_DATE`).
  Atualizar manualmente quando MSYS2 lançar nova base e a antiga sair do mirror.
- `runs-on: windows-latest` aponta hoje pra Windows Server 2022. Se GitHub
  promover pra 2025 e quebrar algo, fixar `windows-2022`.
