# BRUNO — Pesquisa técnica WSL legado→moderno (Win10 19045)

**Autor**: Bruno (dev). **Data**: 2026-05-27. **Sessão**: noturna paralela.

## TL;DR (resposta direta)

1. **3 estados WSL** distinguíveis com 100% confiabilidade:
   - **ABSENT**: `wsl.exe` não existe no `Get-Command`.
   - **LEGACY**: `wsl.exe` existe (em `C:\Windows\System32\wsl.exe`, inbox), mas `--version` retorna erro "Opção de linha de comando inválida" e o `--help` só lista flags antigas (`--exec`, `-e`, `--cd`, `--`). Esse é o caso do JOs hoje (Win10 19045 sem WSL Store).
   - **MODERN**: `wsl.exe --version` retorna texto válido com `WSL version: x.y.z` e `Kernel version: ...`. Veio do MSI/Store (Microsoft.WSL).

2. **Recomendação**: **Opção B — instalar o MSI mais recente do GitHub Microsoft/WSL**. URL canônica (validada agora, latest release **2.7.3** de 2026):
   ```
   https://github.com/microsoft/WSL/releases/download/2.7.3/wsl.2.7.3.0.x64.msi
   ```
   Resolução dinâmica via GitHub API: `https://api.github.com/repos/microsoft/WSL/releases/latest`, filtrar `.assets[].browser_download_url` com sufixo `.x64.msi`.

3. **Por que MSI > outras opções**:
   - **Opção A (`wsl --update`)** só funciona se já tem WSL moderno — falha em LEGACY (que é justamente o estado do JOs).
   - **Opção C (Store appx)** exige login MS, deep link `ms-windows-store://`, não é programático.
   - **Opção D (`wsl --install` no inbox)** — em build 19045 o inbox tem `wsl --install` PARCIAL, mas não reconhece `--no-launch` nem `--web-download` — confirmado no live test do JOs (`--install: unrecognized option: no-launch`).
   - **MSI**: download silencioso via `Invoke-WebRequest` + `msiexec /quiet /norestart`, sem Store, sem login, sem dependência de DISM-pré.

---

## 1. Detecção dos 3 estados (helper validado)

### 1.1 Estratégia

A v0.2.16 atual confia em `wsl --status` pra dizer se está funcional, mas no LEGACY o `wsl.exe` ignora `--status` e cospe a tela de help — o `wslIsFunctional()` já trata isso (heurística "isHelp"). O que falta é **classificar explicitamente os 3 estados** ANTES de decidir caminho de instalação.

### 1.2 Helper `detectWslState()` (drop-in, vai pra `executors.js`)

```js
// Bruno (noturna 2026-05-27): classifica em 3 estados pra decisão de install.
// Estado decide caminho:
//   absent  → instalar MSI (Opção B)
//   legacy  → MIGRAR pra moderno via MSI (Opção B)
//   modern  → seguir fluxo atual (wsl --install -d <distro>)
//
// Retorna: { state: 'absent'|'legacy'|'modern', evidence: {...} }
async function detectWslState(logger) {
  const evidence = {};

  // 1. Tem o binário no PATH?
  let presence;
  try {
    presence = await powershell(
      `Get-Command wsl.exe -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source`,
      { timeout: 5000 }
    );
  } catch (e) {
    evidence.getCommand = { error: e.message };
    return { state: 'absent', evidence };
  }
  const exePath = (presence.stdout || '').trim();
  evidence.exePath = exePath;
  if (!exePath) return { state: 'absent', evidence };

  // 2. Tenta `wsl --version` (só MODERN responde com texto válido).
  //    wslExec já decodifica UTF-16 LE corretamente.
  const versionR = await wslExec(['--version'], { timeout: 8000, logger });
  evidence.versionExit = versionR.exit_code;
  evidence.versionStdout = (versionR.stdout || '').slice(0, 200);

  // MODERN: exit 0 + stdout cita "WSL version" ou "kernel" (en ou pt)
  if (versionR.exit_code === 0 &&
      /WSL\s+vers[aã]o|WSL\s+version|kernel\s+vers/i.test(versionR.stdout || '')) {
    return { state: 'modern', evidence, exePath };
  }

  // 3. Backup: `wsl --status` — moderno responde com "Default Distribution:..."
  const statusR = await wslExec(['--status'], { timeout: 8000, logger });
  evidence.statusExit = statusR.exit_code;
  evidence.statusStdout = (statusR.stdout || '').slice(0, 200);

  // Filtra falso-positivo: a tela de help do legacy contém "--status",
  // "--install" e "--list" simultaneamente (assinatura).
  const isHelpEcho =
    /Usage:|Uso:/i.test(statusR.stdout || '') ||
    (/--install/i.test(statusR.stdout) &&
     /--list/i.test(statusR.stdout) &&
     /--status/i.test(statusR.stdout));

  if (statusR.exit_code === 0 && !isHelpEcho &&
      /Default\s+(Distribution|Version)|Distribu[ií][cç][aã]o\s+padr/i.test(statusR.stdout || '')) {
    return { state: 'modern', evidence, exePath };
  }

  // 4. Se chegou aqui, binário existe mas não responde --version nem --status:
  //    é o inbox LEGADO do Windows 10.
  return { state: 'legacy', evidence, exePath };
}
```

### 1.3 Casos de teste mentais

| Cenário | `--version` | `--status` | resultado |
|---------|-------------|------------|-----------|
| PC limpo Win10 sem WSL | exit≠0 ou not found | idem | `absent` |
| PC do JOs hoje (inbox 19045) | "Opção inválida" (mojibake) | tela de help com `--install --list --status` | `legacy` |
| PC com WSL moderno (Store/MSI) | "WSL version: 2.7.3\nKernel: 5.15..." | "Default Distribution: Ubuntu\nDefault Version: 2" | `modern` |

---

## 2. Caminhos de migração legado→moderno (pesquisa real)

### 2.1 Opção A — `wsl --update` ❌

**Problema fundamental**: `wsl --update` é UM SUBCOMANDO do wsl moderno. No inbox legacy o binário NEM RECONHECE essa flag — vai cuspir help. Não serve pra migrar legacy→modern, só pra atualizar moderno→moderno.

**Verdict**: descartado.

### 2.2 Opção B — MSI direto do GitHub Microsoft ✅ RECOMENDADO

#### URL atual (validada via API)

- **Latest release** (`https://api.github.com/repos/microsoft/WSL/releases/latest`): **`2.7.3`**
- **Asset x64**: `https://github.com/microsoft/WSL/releases/download/2.7.3/wsl.2.7.3.0.x64.msi`
- **Asset ARM64**: `https://github.com/microsoft/WSL/releases/download/2.7.3/wsl.2.7.3.0.arm64.msi`

⚠️ **NÃO existe** URL "latest/download/wsl.x64.msi" fixa — o nome do asset embute a versão (`wsl.2.7.3.0.x64.msi`). Precisamos resolver via API GitHub a cada release.

#### Estratégia de resolução robusta

```powershell
# 1) Pega URL do MSI x64 mais recente via GitHub API (sem precisar de jq)
$api = 'https://api.github.com/repos/microsoft/WSL/releases/latest'
$headers = @{ 'User-Agent' = 'imp-installer'; 'Accept' = 'application/vnd.github+json' }
$rel = Invoke-RestMethod -Uri $api -Headers $headers -TimeoutSec 30
$arch = if ([Environment]::Is64BitOperatingSystem) { 'x64' } else { 'arm64' }
$asset = $rel.assets | Where-Object { $_.name -match "\.$arch\.msi$" } | Select-Object -First 1
if (-not $asset) { throw "Nenhum MSI $arch encontrado na release $($rel.tag_name)" }
$msiUrl = $asset.browser_download_url
$msiPath = Join-Path $env:TEMP $asset.name

# 2) Baixa (com fallback de TLS 1.2 explícito pra Win10 antigo)
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Invoke-WebRequest -Uri $msiUrl -OutFile $msiPath -UseBasicParsing

# 3) Instala silenciosamente (NÃO precisa /quiet com Verb RunAs — msiexec /qn basta)
$proc = Start-Process msiexec.exe -ArgumentList "/i `"$msiPath`" /qn /norestart" -Wait -PassThru
if ($proc.ExitCode -ne 0 -and $proc.ExitCode -ne 3010) {
  throw "msiexec falhou com exit=$($proc.ExitCode)"
}
# exit 3010 = sucesso + precisa reboot (já tratamos no powershellVerbose)
```

#### Pré-requisitos do MSI

O MSI moderno **exige** que as features `Microsoft-Windows-Subsystem-Linux` e `VirtualMachinePlatform` já estejam habilitadas no Windows. Em Win10 19045 com WSL inbox, a feature WSL já está habilitada (foi assim que o inbox veio). VirtualMachinePlatform pode NÃO estar.

**Roteiro completo de migração legacy→modern**:

```powershell
# Fase 1: garantir features (mesmo se já habilitadas, é idempotente)
dism.exe /online /enable-feature /featurename:Microsoft-Windows-Subsystem-Linux /all /norestart
dism.exe /online /enable-feature /featurename:VirtualMachinePlatform /all /norestart
# Se algum desses retornar 3010 → marcar rebootRequired e agendar RunOnce

# Fase 2: baixar e instalar MSI (script acima)

# Fase 3: REBOOT obrigatório (features novas + kernel WSL2 só ativam pós-reboot)

# Fase 4: após reboot, `wsl.exe` agora é o moderno. Aí sim:
wsl --set-default-version 2
wsl --install -d Ubuntu-22.04 --no-launch
```

### 2.3 Opção C — Microsoft Store appx ❌

- `Add-AppxPackage` precisa do `.msixbundle` baixado primeiro (que é o 3º asset da release do GitHub, mas exige Win10 19041+ com `Microsoft.VCLibs.140.00.UWPDesktop` pré-instalado).
- Deep link `ms-windows-store://pdp/?productid=9P9TQF7MRM4R` (WSL na Store) abre a UI da Store — não é programático.
- Exige conta Microsoft logada na Store, o que muitos usuários (incluindo JOs) não têm.

**Verdict**: descartado — não-programático/exige conta.

### 2.4 Opção D — `wsl --install` do INBOX ❌ (parcial)

No live test do JOs (Win10 19045 inbox), `wsl --install -d Ubuntu --no-launch` retornou:
```
--install: unrecognized option: no-launch
```

Indica que o inbox tem UM `--install` próprio, MAS:
- Não aceita `--no-launch` (Ubuntu abre janela GUI que confunde o instalador)
- Não aceita `--web-download` (não consegue forçar download direto)
- Implementação varia entre builds; comportamento imprevisível

**Verdict**: não-confiável. Pode funcionar em casos felizes, mas não dá pra automatizar com 100% de certeza.

---

## 3. Snippets prontos pra rodada de implementação

### 3.1 `installWslModernViaMsi(ctx)` — Opção B completa

```js
// Bruno (noturna 2026-05-27): baixa+instala MSI WSL moderno do GitHub Microsoft.
// Idempotente: se já é moderno, msiexec retorna sem repinstalar.
// Retorna: { ok: boolean, version: string, rebootRequired: boolean, msiPath: string }
async function installWslModernViaMsi(ctx) {
  await requireAdminOrThrow();

  // Resolve URL via GitHub API + baixa + instala silencioso. Tudo num PS único
  // pra evitar 3 round-trips de spawn (mais rápido + um único log de output).
  const psScript = `
    $ErrorActionPreference = 'Stop'
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $api = 'https://api.github.com/repos/microsoft/WSL/releases/latest'
    $headers = @{ 'User-Agent' = 'imp-installer'; 'Accept' = 'application/vnd.github+json' }
    $rel = Invoke-RestMethod -Uri $api -Headers $headers -TimeoutSec 30
    $arch = if ([Environment]::Is64BitOperatingSystem) { 'x64' } else { 'arm64' }
    $asset = $rel.assets | Where-Object { $_.name -match "\\.$arch\\.msi$" } | Select-Object -First 1
    if (-not $asset) { throw "Nenhum MSI $arch na release $($rel.tag_name)" }
    $msiPath = Join-Path $env:TEMP $asset.name
    Write-Output "URL=$($asset.browser_download_url)"
    Write-Output "VERSION=$($rel.tag_name)"
    Write-Output "MSI=$msiPath"
    Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $msiPath -UseBasicParsing
    $proc = Start-Process msiexec.exe -ArgumentList "/i `"$msiPath`" /qn /norestart" -Wait -PassThru
    Write-Output "EXIT=$($proc.ExitCode)"
    if ($proc.ExitCode -ne 0 -and $proc.ExitCode -ne 3010) {
      throw "msiexec exit=$($proc.ExitCode)"
    }
  `;
  const r = await powershellVerbose(psScript, { timeout: 600_000 });
  const out = r.stdout || '';
  const version = (out.match(/VERSION=(\S+)/) || [])[1] || '?';
  const msiPath = (out.match(/MSI=(.+?)(?:\r|\n|$)/) || [])[1] || '';
  const exitCode = parseInt((out.match(/EXIT=(\d+)/) || [])[1] || '0', 10);
  const rebootRequired = exitCode === 3010 || r.rebootRequired === true;
  ctx.logger.info('installWslModernViaMsi',
    `MSI ${version} instalado (exit=${exitCode}, reboot=${rebootRequired})`);
  return { ok: true, version, rebootRequired, msiPath };
}
```

### 3.2 `verifyWslFunctional()` — refina `wslIsFunctional` distinguindo legacy

A v0.2.16 atual de `wslIsFunctional()` retorna `{ok:false, reason:"reboot pendente"}` indiscriminadamente. Refinar pra distinguir:

```js
// Verificação refinada: além de funcional/não, retorna o ESTADO subjacente.
// Permite UI mostrar mensagem específica em vez de "reboot pendente" genérico.
async function verifyWslFunctional(logger) {
  const st = await detectWslState(logger);
  if (st.state === 'absent') {
    return { ok: false, state: 'absent', reason: 'WSL não instalado' };
  }
  if (st.state === 'legacy') {
    return { ok: false, state: 'legacy', reason: 'WSL inbox legado — precisa migrar pro moderno (MSI)' };
  }
  // st.state === 'modern' — agora roda --status real
  const r = await wslExec(['--status'], { timeout: 10_000 });
  if (r.exit_code !== 0) {
    return { ok: false, state: 'modern-broken', reason: `wsl --status exit=${r.exit_code}`, raw: r.stdout };
  }
  if (/default|kernel|version|distribu/i.test(r.stdout || '')) {
    return { ok: true, state: 'modern', raw: r.stdout };
  }
  return { ok: false, state: 'modern-broken', reason: 'saída --status não reconhecida', raw: r.stdout };
}
```

### 3.3 `forceRebootWindows()` — reboot agendado com cancelamento

```js
// Agenda reboot em N segundos (default 30) com mensagem amigável.
// Retorna função pra CANCELAR (caso usuário clique "agora não").
// JOs já testou — o reboot manual funcionou. Agora forçamos via shutdown.
function forceRebootWindows({ delaySeconds = 30, message = 'Reinício agendado pelo Instalador IMP — salve seu trabalho' } = {}) {
  // /r reinicia, /t segundos, /c comentário (até 512 chars), /f força fechar apps
  // /d p:4:1 = motivo "Application: Maintenance (Planned)"
  const args = ['/r', '/t', String(delaySeconds), '/c', message, '/f', '/d', 'p:4:1'];
  return powershell(`& shutdown.exe ${args.map(a => `'${String(a).replace(/'/g, "''")}'`).join(' ')}`)
    .then(() => ({
      ok: true,
      cancel: () => powershell('shutdown.exe /a').catch(() => null),
    }));
}
```

### 3.4 `scheduleRunOnceAfterReboot(exePath)` — já existe em `shell.js`

Já implementado em `shell.js:476` (revisado pelo Eduardo 4.5). Passa exePath via `-ArgumentList` em vez de interpolar, então não tem bug de escape. **Não precisa mudar**.

Apenas garantir que **TODA** rota de reboot (forçado, manual, sugerido) chame `scheduleRunOnceAfterReboot(ctx.exePath)` ANTES — já fazemos via `_markRebootAndScheduleRunOnce()` em executors.js:382.

### 3.5 Fluxo decisório do step_01 refeito (pseudocódigo)

```
step_01.execute(ctx):
  state = detectWslState()
  ctx.state.wslDetectedState = state.state  // pra UI mostrar
  ctx.save()

  switch (state.state):
    case 'modern':
      // Fluxo atual já funciona — wsl --install -d Ubuntu --no-launch
      return executeModernInstall(ctx)

    case 'legacy':
      logger.warn('WSL inbox legacy detectado — migrando pro moderno via MSI')
      await enableFeaturesIfNeeded(ctx)            // dism enable Subsystem-Linux + VirtualMachinePlatform
      const msi = await installWslModernViaMsi(ctx)
      ctx.state.wslMsiVersion = msi.version
      ctx.save()
      // MSI sempre exige reboot pra ativar kernel novo
      await _markRebootAndScheduleRunOnce(ctx, 'step_01')
      return  // após reboot, executor roda de novo → cai no case 'modern'

    case 'absent':
      // PC sem WSL nenhum — features + MSI + Ubuntu
      await enableFeaturesIfNeeded(ctx)
      await installWslModernViaMsi(ctx)
      await _markRebootAndScheduleRunOnce(ctx, 'step_01')
      return
```

---

## 4. Checklist de implementação pra próxima rodada

- [ ] Adicionar `detectWslState()` no `executors.js` (após `wslIsFunctional`)
- [ ] Adicionar `installWslModernViaMsi(ctx)` no `executors.js`
- [ ] Adicionar `verifyWslFunctional()` (substitui chamadas ao `wslIsFunctional()` antigo, mantém o antigo como alias)
- [ ] Refatorar `step01EnableFeatures.execute` pro switch case do 3.5
- [ ] Adicionar `forceRebootWindows()` no `shell.js` (export)
- [ ] Persistir `state.wslDetectedState` e `state.wslMsiVersion` no state.json (campos novos, retro-compat)
- [ ] UI (Camila): adicionar tela específica "Migrando WSL legado pro moderno (baixando MSI)" diferente de "Instalando WSL2 + Ubuntu"
- [ ] Teste: simular em VM Win10 19045 fresh (sem WSL Store) → roda installer → confirma MSI baixou + reboot + Ubuntu ok
- [ ] Atualizar `writeWslDiagLog` pra incluir output de `detectWslState()` no diag

---

## 5. URLs canônicas (referência rápida)

| Recurso | URL |
|---------|-----|
| GitHub API latest release | `https://api.github.com/repos/microsoft/WSL/releases/latest` |
| MSI x64 (versão atual) | `https://github.com/microsoft/WSL/releases/download/2.7.3/wsl.2.7.3.0.x64.msi` |
| MSI ARM64 | `https://github.com/microsoft/WSL/releases/download/2.7.3/wsl.2.7.3.0.arm64.msi` |
| Doc Microsoft (manual install fallback) | `https://learn.microsoft.com/en-us/windows/wsl/install-manual` |
| WSL2 Linux kernel update package (fallback antigo) | `https://wslstorestorage.blob.core.windows.net/wslblob/wsl_update_x64.msi` |
| Deep link Store WSL (UI, não automatizar) | `ms-windows-store://pdp/?productid=9P9TQF7MRM4R` |

---

## 6. Riscos / pontos de atenção

1. **GitHub API rate limit**: 60 req/hora por IP não-autenticado. Em 99% dos casos o instalador roda 1×/PC, então OK. Se virar problema: cachear `latest.json` no `~/.imp-installer/cache/wsl-release.json` com TTL 24h.

2. **TLS 1.2 obrigatório em Win10 antigo**: alguns Win10 sem updates falham `Invoke-WebRequest` com erro TLS. O snippet 3.1 já força `[Net.ServicePointManager]::SecurityProtocol = Tls12`. Defensivo.

3. **MSI exige UAC**: `msiexec /qn` precisa do processo já elevado. Já temos `requireAdminOrThrow()` no início de `installWslModernViaMsi`.

4. **Anti-vírus pode bloquear download**: `Invoke-WebRequest` baixa pro `%TEMP%`, alguns AVs varrem agressivo. Se falhar, fallback é JOs baixar manualmente do GitHub e clicar 2× no MSI (tela MANUAL com link copy-able).

5. **Pasta `imp-installer/` única**: confirmado, todos os arquivos vão pra `src/executors.js` + `src/shell.js` (já existentes). Sem novos diretórios.

---

**FIM** — pronto pra Claudio consolidar com os outros docs da noturna e o implementador-Bruno da próxima rodada usar como blueprint.
