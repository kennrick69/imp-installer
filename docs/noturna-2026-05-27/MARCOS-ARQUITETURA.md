# MARCOS — Arquitetura do Instalador WSL Robusto (Win10 19045 + legacy)

Autor: Marcos (arquiteto, IMP Dev Squad)
Sessão: noturna 2026-05-27
Status: PLANO — não-implementação. Bruno executa.
Audiência: Bruno (implementador), Camila (UI dos prompts/reboot), Patrícia (edge cases).

---

## 0. Revelação que muda tudo

PC do JOs (Win10 build 19045, 22H2 pt-BR) tem **`wsl.exe` LEGADO/INBOX**:

- `wsl.exe --version` → "Opção de linha de comando inválida"
- `wsl.exe --install` → "--install: unrecognized option"
- `wsl --help` mostra apenas `--exec`, `-e`, `--cd`, `--` (sem `--install`, `--list`, `--status`, `--update`, `--version`)

**Diagnóstico**: build do Windows **suportar** WSL moderno ≠ ter o binário moderno **instalado**. O `wsl.exe` que vem de fábrica em Win10 é o "inbox" (lxss.dll, WSL1-era). Pra ter o WSL moderno (Microsoft Store, wsl2.msi, Add-AppxPackage) é uma instalação SEPARADA.

A detecção atual (`build >= 19041 → moderno`) está semanticamente errada — ela detecta **capacidade do SO**, não **presença do binário**. Resultado: instalador caminha pelo fluxo moderno, chama `wsl --install -d Ubuntu --no-launch`, o binário legado ignora os flags, retorna help, instalador interpreta como sucesso silencioso, prossegue, quebra 3 passos depois sem mensagem clara.

---

## 1. Princípios arquiteturais

Regras INVIOLÁVEIS daqui pra frente:

1. **Validação testa RESULTADO REAL, nunca proxy**.
   - Feature `Enabled` em DISM ≠ WSL funcional.
   - Distro listada em `wsl -l -v` ≠ distro funcional.
   - `wsl --status` retornar exit 0 ≠ resposta válida (legacy retorna 0 com help).
   - Cada `validate()` deve executar a operação MÍNIMA real que o próximo step precisa, e só retornar `true` quando isso funcionar.

2. **Cada `validate()` documenta seu critério de "ok"** num comentário JSDoc acima da função. Quem ler o código sabe o que está sendo testado SEM ter que rodar.

3. **Reboot é PARTE do fluxo, não exceção**.
   - Em Win10 legado-WSL → moderno-WSL, vamos precisar de **dois reboots no pior caso**:
     - Reboot A: após habilitar features (DISM /enable-feature)
     - Reboot B: após instalar WSL moderno via Store/MSI (raramente, mas pode)
   - O instalador deve TRATAR reboot como passagem natural: marca estado, agenda RunOnce, mostra tela "Reiniciar agora" com botão `shutdown /r /t 0`, e retoma sozinho pós-boot.

4. **Estado tem `wslState` EXPLÍCITO**.
   - Enum: `'absent' | 'legacy' | 'modern_installed' | 'functional' | 'broken'`.
   - Cada transição tem um único responsável e uma validação clara.
   - Sem isso, ficamos adivinhando.

5. **Mensagens humanas em pt-BR pra cada falha**.
   - Tela de erro nunca mostra "exit_code=-1" sem tradução.
   - Cada erro conhecido (740, 3010, ELEVATION_REQUIRED, ERROR_WSL_NOT_INSTALLED, etc.) tem texto humano + ação sugerida.

6. **Idempotência ABSOLUTA**. Rodar o instalador 5x em sequência num PC já instalado deve fazer 5x a mesma coisa: detectar tudo `done`, mostrar tela final em <30s.

7. **Diagnóstico SEMPRE gravado**. Cada execução de cada step (incluindo as que dão certo) escreve um snippet no log. Quando algo falha, o JOs manda o log e o Bruno entende em 5min, não em 2h.

8. **Sem mentiras de progresso**. Se o step demora 3min e a UI mostra "ok" em 5s sem realmente validar, isso é pior que mostrar erro. Slow & honest > fast & lying.

---

## 2. Schema `state.json` v2.0 (atualizado)

```json
{
  "version": "2.0",
  "startedAt": "2026-05-27T03:00:00Z",
  "lastStepCompleted": "step_01b_wsl_modern_install",

  "wslState": "functional",
  "wslMigrationAttempted": true,
  "wslMigrationStrategy": "store_appx",
  "wslLegacyDetectedAt": "2026-05-27T03:01:12Z",
  "wslModernInstalledAt": "2026-05-27T03:04:45Z",
  "wslFunctionalAt": "2026-05-27T03:08:30Z",

  "featuresEnabled": {
    "wsl": true,
    "vmp": true,
    "checkedAt": "2026-05-27T03:00:42Z"
  },

  "distroState": "user_created",
  "ubuntuDistroName": "Ubuntu-22.04",
  "ubuntuUser": "jos",

  "rebootRequired": false,
  "rebootDone": true,
  "rebootRequiredReason": null,
  "rebootSchedule": {
    "scheduledAt": "2026-05-27T03:02:00Z",
    "runOnceKey": "IMPInstallerResume",
    "expectedReturn": "2026-05-27T03:05:00Z",
    "actualReturn": "2026-05-27T03:04:55Z",
    "rebootCount": 1
  },

  "decisions": {
    "wslInstallStrategy": "store_appx",
    "nodeInstallVia": "nvm"
  },

  "steps": {
    "step_00_preflight": "done",
    "step_01a_enable_features": "done",
    "step_01b_wsl_modern_install": "done",
    "step_02_wsl_functional_validate": "done",
    "step_03_ubuntu_install": "done",
    "step_04_ubuntu_first_boot": "done"
  }
}
```

### Enum `wslState` — semântica precisa

| Valor | Significado | Como detectar | Próximo passo |
|---|---|---|---|
| `absent` | `wsl.exe` não existe (Win sem WSL nem inbox) | `Get-Command wsl.exe -ErrorAction SilentlyContinue` retorna null | Habilitar features → instalar WSL moderno |
| `legacy` | `wsl.exe` existe mas é inbox (sem `--install`/`--status`/`--version`) | `wsl --version` exit ≠ 0 OU stdout sem token `WSL`/`kernel`; help mostra só `--exec`/`-e`/`--cd` | Migrar pra moderno (Store/MSI/winget) |
| `modern_installed` | binário moderno presente, mas WSL não funcional ainda (reboot pendente, kernel não ativo) | `wsl --version` exit 0 com stdout válido; `wsl --status` mostra help OU erro de kernel | Reboot OU `wsl --update` |
| `functional` | `wsl --status` retorna distro default + version 2; consigo `wsl -d X -- whoami` | `wsl --status` + parse de "Default Version: 2" / "Versão padrão: 2" | Instalar Ubuntu (se ainda não) ou prosseguir |
| `broken` | algo intermediário inválido (features habilitadas mas binário sumiu, distro corrompida) | qualquer combinação inconsistente detectada | Tela manual de recuperação com diagnóstico |

### Enum `distroState`

| Valor | Significado |
|---|---|
| `none` | nenhuma distro Ubuntu instalada |
| `installed` | `wsl -l -v` mostra Ubuntu, mas sem usuário UNIX (sem first boot) |
| `user_created` | first boot completo, `wsl -d X -- whoami` retorna non-root |

### Enum `wslMigrationStrategy`

`'store_appx' | 'msi_download' | 'winget' | 'dism_only' | 'wsl_update'`

Grava qual caminho FOI usado, pra retomada e telemetria.

---

## 3. Estratégia escolhida pra migrar legado → moderno

### Análise das 4 opções

| Estratégia | Funciona em Win10 19045 sem moderno? | Sem reboot extra? | Sem interação humana? | Confiável em rede ruim? | Veredito |
|---|---|---|---|---|---|
| **C1. `wsl --update`** | ❌ binário legado não tem `--update` | — | — | — | DESCARTADO |
| **C2. Store appx (Add-AppxPackage)** | ✅ funciona se Store estiver ativa | ✅ geralmente | ✅ silent | ⚠️ depende do Store backend | **PRIMÁRIO** |
| **C3. winget** | ⚠️ depende do winget estar presente (Win10 21H2+ tem por padrão, 19045 = 22H2 → sim) | ✅ | ✅ silent | ✅ | **SECUNDÁRIO** |
| **C4. DISM + reboot + `wsl --install`** | ✅ sempre, mas é o caminho mais lento e exige 2 reboots | ❌ | ✅ | ✅ | **FALLBACK ÚLTIMO** |

### Decisão: **CASCATA C3 → C2 → C4**

Motivos pra inverter da ordem que JOs sugeriu (C1→C2→C3→C4):

1. **C1 está fora** (binário legado não suporta).
2. **C3 (winget) ANTES de C2 (Store appx)** porque:
   - Win10 22H2 (build 19045) **já tem winget pré-instalado** desde maio/2023.
   - `winget install Microsoft.WSL` é **1 comando**, exit code claro, log limpo, instala a versão GA mais recente, idempotente, sem precisar conhecer URL de appx.
   - Add-AppxPackage exige conhecer/baixar o `.appx` certo, e a Store está cada vez mais restritiva pra apps de sistema.
3. **C2 (Store appx)** vira backup: se `winget` não existir (desativado por GPO em PCs corporativos, ou Win10 LTSC sem Store), baixamos o `.msixbundle` do GitHub Microsoft releases (`https://github.com/microsoft/WSL/releases/latest`) e instalamos via `Add-AppxPackage -Path ... -ForceApplicationShutdown`.
4. **C4 (DISM + reboot + `wsl --install`)** é o fallback final pra Windows muito velho/restrito onde nem winget nem Store funcionam. Custa 1 reboot extra mas funciona em qualquer cenário.

### Pré-requisito comum: features Windows

ANTES de qualquer C2/C3/C4, **features têm que estar Enabled**:

```powershell
dism.exe /online /enable-feature /featurename:Microsoft-Windows-Subsystem-Linux /all /norestart
dism.exe /online /enable-feature /featurename:VirtualMachinePlatform /all /norestart
```

DISM **pode** retornar 3010 (sucesso-com-reboot). Tratamos como sucesso e SETAMOS `rebootRequired=true`. Se exit 0 sem 3010, features já estavam ok e seguimos sem reboot.

---

## 4. Fases com gates

Cada fase tem **entrada**, **ação**, **gate de saída** (validação real) e **failure mode**.

### Fase A — Diagnóstico inicial (`step_00b_wsl_diagnostic`)

**Entrada**: instalador acabou de subir.
**Ação**: zero efeitos colaterais. Apenas leituras.

| Check | Comando | Resultado → wslState |
|---|---|---|
| A1 | `Get-Command wsl.exe -ErrorAction SilentlyContinue` retorna null | `absent` |
| A2 | `wsl.exe --version` (timeout 10s) — exit 0 + stdout contém "WSL"/"kernel"/"versão" | candidato a `modern_installed` ou `functional` |
| A3 | A2 falhou: `wsl.exe -h` — stdout contém **apenas** `--exec`, `-e`, `--cd`, `--` (sem `--install`/`--list`/`--status`) | `legacy` |
| A4 | Era candidato moderno (A2 ok), agora `wsl.exe --status` retorna saída real (não help) com "Default Version: 2"/"Versão padrão: 2" | `functional` |
| A5 | Era candidato moderno mas A4 falhou (help/erro) | `modern_installed` (reboot ou `wsl --update` pendente) |
| A6 | `Get-WindowsOptionalFeature -Online -FeatureName Microsoft-Windows-Subsystem-Linux` State | grava `featuresEnabled.wsl` |
| A7 | idem VirtualMachinePlatform | grava `featuresEnabled.vmp` |

**Gate de saída**: `state.wslState` setado pra UM dos valores do enum + `featuresEnabled.{wsl,vmp}` gravados + log diagnóstico (`wsl-diag-<ts>.log`) escrito.
**Failure mode**: se nem A1 nem qualquer outro check funcionar (PowerShell quebrado), tela manual "Reinstale o Windows / contate suporte" — caso terminal raro.

---

### Fase B — Habilitar features (`step_01a_enable_features`)

**Entrada**: `featuresEnabled.wsl === false OR featuresEnabled.vmp === false`.
**Skip condition**: ambas true → pula direto pra Fase C.

**Ação**:

```powershell
chcp 65001 > $null
dism.exe /online /enable-feature /featurename:Microsoft-Windows-Subsystem-Linux /all /norestart
dism.exe /online /enable-feature /featurename:VirtualMachinePlatform /all /norestart
```

Cada DISM rodado em comando separado (não chained), porque um pode dar 3010 e o outro 0 — temos que registrar os dois.

**Gate de saída**:

```powershell
(Get-WindowsOptionalFeature -Online -FeatureName Microsoft-Windows-Subsystem-Linux).State -eq 'Enabled'
(Get-WindowsOptionalFeature -Online -FeatureName VirtualMachinePlatform).State -eq 'Enabled'
```

Ambos `Enabled`. Não basta `EnablePending` — pendente significa "reboot necessário pra ativar".

Se algum vier `EnablePending` ou DISM retornou 3010 → `state.rebootRequired = true`, `state.rebootRequiredReason = 'features pendentes ativação'`, agenda RunOnce, mostra tela "Reboot necessário".

**Failure mode**: DISM exit ≠ 0, ≠ 3010 → erro humano "Não consegui habilitar WSL no Windows. Você está rodando como administrador? (código X)" + log + botão "Tentar novamente" / "Sair".

---

### Fase C — Migrar WSL legado → moderno (`step_01b_wsl_modern_install`)

**Entrada**: `featuresEnabled.{wsl,vmp} === true`, `wslState ∈ {'absent', 'legacy'}`.
**Skip condition**: `wslState ∈ {'modern_installed', 'functional'}`.

**Ação em cascata (3 tentativas independentes)**:

**C-try-1: winget**
```powershell
Get-Command winget -ErrorAction SilentlyContinue
# se existe:
winget install --id Microsoft.WSL --accept-package-agreements --accept-source-agreements --silent
```
Sucesso se exit 0 OU stdout contém "already installed".
`state.wslMigrationStrategy = 'winget'`.

**C-try-2: Store appx (se winget falhou)**
```powershell
# baixa o latest .msixbundle do GitHub Microsoft/WSL
$tag = (Invoke-RestMethod 'https://api.github.com/repos/microsoft/WSL/releases/latest').tag_name
$asset = (Invoke-RestMethod "https://api.github.com/repos/microsoft/WSL/releases/latest").assets |
  Where-Object { $_.name -like '*x64.msixbundle' } | Select-Object -First 1
Invoke-WebRequest -Uri $asset.browser_download_url -OutFile "$env:TEMP\wsl.msixbundle"
Add-AppxPackage -Path "$env:TEMP\wsl.msixbundle" -ForceApplicationShutdown
```
Sucesso se `Get-AppxPackage MicrosoftCorporationII.WindowsSubsystemForLinux` retorna pacote.
`state.wslMigrationStrategy = 'store_appx'`.

**C-try-3: DISM-only (último recurso, sempre funciona mas exige reboot)**
Features já habilitadas na Fase B. Sem moderno → seguimos com o legado pós-reboot. O `wsl.exe` inbox **após reboot com VMP ativo** consegue rodar `wsl --install` na maioria dos Win10 22H2 (porque o `wsl --install` foi backportado pro inbox no 22H2).

Se C-try-3 também falhar: tela manual "Não consegui instalar o WSL moderno automaticamente. Por favor abra a Microsoft Store, busque 'Windows Subsystem for Linux', clique em Instalar, e volte aqui."

**Gate de saída**:
```powershell
wsl.exe --version
# exit 0 + stdout contém "WSL" + número de versão (ex: "WSL version: 2.0.x")
```

Após sucesso: `state.wslState = 'modern_installed'`, grava `wslModernInstalledAt`.

**Se reboot necessário pós-install**: `state.rebootRequired=true`, agenda RunOnce, mostra tela "Reiniciar".

**Failure mode**: todas as 3 tentativas falharam → tela manual com link da Store + instruções passo-a-passo + botão "Já instalei, verificar de novo".

---

### Fase D — Validar WSL funcional (`step_02_wsl_functional_validate`)

**Entrada**: `wslState ∈ {'modern_installed', 'functional'}`.
**Skip condition**: `wslState === 'functional'`.

**Ação**: SEM efeito colateral (só leituras), exceto possivelmente `wsl --update`.

```powershell
# D1: --version
wsl.exe --version
# Espera-se: exit 0, stdout com "WSL version: X.Y.Z", "Kernel version: ...", "WSLg version: ...".

# D2: --status
wsl.exe --status
# Espera-se: exit 0, stdout NÃO é help, contém "Default Version: 2" ou "Versão padrão: 2".
```

Se D2 falhar com saída de help OU "kernel not running":

```powershell
# Tentativa de cura sem reboot:
wsl.exe --update
# Re-testar --status.
```

Se ainda falhar: `state.rebootRequired = true`, `rebootRequiredReason = 'kernel WSL não ativo'`, RunOnce, tela reboot.

**Gate de saída**: `wslIsFunctional()` retorna `{ok:true}`. `state.wslState = 'functional'`, grava `wslFunctionalAt`.

**Failure mode**: 2 reboots já tentados e ainda não funcional → tela manual "Algo no seu Windows está impedindo o WSL de iniciar. Verifique BIOS (virtualização habilitada?). Anexe o log: ~/.imp-installer/logs/wsl-diag-<ts>.log".

---

### Fase E — Instalar Ubuntu (`step_03_ubuntu_install`)

**Entrada**: `wslState === 'functional'`, `distroState === 'none'`.
**Skip condition**: `distroState ∈ {'installed', 'user_created'}` (Ubuntu já presente).

**Ação**:

```powershell
# E1: descobrir nome canônico da distro no catálogo do host
wsl.exe --list --online
# parse: pega primeira linha que começa com "Ubuntu-22.04" > "Ubuntu-24.04" > "Ubuntu-20.04" > "Ubuntu".

# E2: instalar
wsl.exe --install -d <NomeEscolhido> --no-launch
# --no-launch IMPORTANTE: não abre janela do Ubuntu (queremos controlar o first boot no step seguinte).
```

**Gate de saída**:
```powershell
wsl.exe --list --verbose
# Espera-se: linha com <NomeEscolhido>, STATE qualquer (Stopped/Running), VERSION 2.
```

Após sucesso: `state.distroState = 'installed'`, `state.ubuntuDistroName = <NomeEscolhido>`.

**Failure mode**: `wsl --install -d` falha com "Nome de distribuição inválido" → re-roda E1 (descoberta), tenta novamente sem `-d` (instala default do host, geralmente `Ubuntu`). Se ainda falhar: tela manual com lista das distros disponíveis e botão pra escolher.

---

### Fase F — Primeira boot do Ubuntu (`step_04_ubuntu_first_boot`)

**Entrada**: `distroState === 'installed'`.
**Skip condition**: `distroState === 'user_created'`.

**Ação**: MANUAL (interação humana obrigatória — senha do user UNIX).

- UI dispara `cmd /k wsl -d <distro>` (cmd /k mantém janela aberta).
- JOs digita username + senha 2x (instrução clara: "senha não aparece enquanto digita, isso é normal no Linux").
- JOs fecha a janela, clica "Verificar agora".

**Gate de saída**:
```powershell
wsl.exe -d <NomeEscolhido> -- whoami
# Espera-se: stdout = "<username>" (non-root), exit 0.
```

Após sucesso: `state.distroState = 'user_created'`, `state.ubuntuUser = <username>`.

**Failure mode**: `whoami` retorna `root` → user nunca foi criado → re-mostra tela manual com instruções.

---

## 5. Refatoração dos steps — DECISÃO: granular

JOs deu 2 opções: (a) step_01 unificado, ou (b) granular (01a features, 01b reboot+migration, etc.).

**Escolho granular**, com IDs antigos preservados como NO-OPs pra compat de `state.json` de instalações antigas.

### Mapa novo → antigo

| Step novo (granular) | ID | Compat com antigo |
|---|---|---|
| Diagnóstico inicial | `step_00b_wsl_diagnostic` | NOVO — sempre roda, não tem antigo |
| Habilitar features | `step_01a_enable_features` | substitui antigo `step_01_enable_features` |
| Instalar WSL moderno (Fase C) | `step_01b_wsl_modern_install` | NOVO |
| Validar funcional (Fase D) | `step_02_wsl_functional_validate` | reaproveita ID `step_02_set_wsl_default_v2` (que vira no-op + validate funcional) |
| Instalar Ubuntu | `step_03_ubuntu_install` | reaproveita ID `step_03_wsl_install` |
| First boot Ubuntu | `step_04_ubuntu_first_boot` | inalterado |
| ... | ... | resto inalterado |

### Por que granular > unificado

1. **Reboot natural entre fases**. Se step_01 unificado faz tudo, ele tem que gerenciar 2-3 retomadas internas. Granular: cada step pode marcar `rebootRequired` e sair limpo; runner sabe retomar.
2. **UX**: sidebar com 17 passos mostra progresso REAL. Unificado = 1 caixa "Instalando WSL..." rodando 8 minutos sem feedback granular.
3. **Debugging**: log diz "Falhou em step_01b_wsl_modern_install" — Bruno sabe exatamente qual fase quebrou. Unificado = "Falhou no step_01" sem pista.
4. **Re-execução parcial**: se C falha mas A/B foram ok, retry do step_01b é cirúrgico. Unificado teria que re-detectar tudo a cada retry.
5. **Compat**: instalações antigas com `state.steps.step_01_enable_features = 'done'` continuam válidas. Marcamos `state.steps.step_01a_enable_features = 'done'` automaticamente pra elas.

### Detect/Execute/Validate de cada step novo

Padrão único pra todos:

```javascript
async detect(ctx) {
  // retorna true se o GATE de saída desta fase já está satisfeito
  // (ex: step_01a: featuresEnabled.{wsl,vmp} === true via Get-WindowsOptionalFeature)
}

async execute(ctx) {
  await requireAdminOrThrow();  // se aplicável
  // executa a Fase. Pode marcar rebootRequired e sair.
}

async validate(ctx) {
  if (ctx.state.rebootRequired && !ctx.state.rebootDone) return true; // segura
  return this.detect(ctx);  // mesmo gate de detect
}
```

A **simetria detect/validate** garante idempotência absoluta.

---

## 6. Reboot forçado com RunOnce — fluxo end-to-end

### Componentes

1. **`scheduleRunOnceAfterReboot(exePath)`** (já existe em `src/shell.js`). Cria entrada em `HKCU\Software\Microsoft\Windows\CurrentVersion\RunOnce` com path do .exe.
2. **Tela "Reboot Necessário"** (UI Camila).
3. **Pós-boot detection**.

### Fluxo

```
[Step termina com rebootRequired=true]
        ↓
1. state.rebootRequired = true
   state.rebootRequiredReason = "features WSL pendentes ativação"
   state.rebootSchedule = {
     scheduledAt: now,
     runOnceKey: 'IMPInstallerResume',
     expectedReturn: now + 2min,
     rebootCount: (existing || 0)
   }
   ctx.save()
        ↓
2. scheduleRunOnceAfterReboot(exePath)  // RunOnce no registry
        ↓
3. UI mostra tela "Reboot Necessário":
   - título: "Precisamos reiniciar o Windows pra continuar"
   - razão humanizada: state.rebootRequiredReason
   - botão grande verde: [ Reiniciar agora ]  → shutdown /r /t 0
   - botão secundário: [ Reinicio depois manualmente ]  → fecha instalador
   - aviso: "Quando o PC voltar, o instalador abre sozinho e continua de onde parou"
        ↓
4. JOs clica "Reiniciar agora"
        ↓
5. shutdown /r /t 0  (temos admin — funciona)
        ↓
   [PC reinicia, RunOnce dispara o .exe]
        ↓
6. Instalador sobe, lê state.json:
   - vê rebootRequired=true, rebootDone=false
   - compara state.rebootSchedule.scheduledAt com (Get-Date).LastBootUpTime
     - se LastBootUpTime > scheduledAt → reboot aconteceu
   - state.rebootDone = true
     state.rebootSchedule.actualReturn = now
     state.rebootSchedule.rebootCount += 1
     ctx.save()
        ↓
7. Runner avança pro próximo step (que estava com validate=true mas era no-op).
   Re-roda validate REAL agora que reboot aconteceu.
        ↓
8. Tudo certo → state.rebootRequired = false (próximo write).
```

### Safety: rebootCount cap

Se `state.rebootSchedule.rebootCount > 3` → algo está em loop infinito de reboot. Para o fluxo, mostra tela manual "Reinicios excessivos. Anexe log e fale com suporte." Evita ciclo eterno em caso de bug.

### Safety: timeout do RunOnce

Se JOs demora dias pra reiniciar (clicou "depois manualmente"), na próxima vez que ele abrir o instalador o `state.rebootSchedule.scheduledAt` é antigo. Detectamos: se `now - scheduledAt > 24h`, perguntamos "Você reiniciou desde X? Vou re-verificar agora" — re-roda diagnóstico ao invés de assumir reboot.

---

## 7. Tela de erro humana — template

Toda falha de WSL passa pelo mesmo componente:

```
╔══════════════════════════════════════════════════════════╗
║  Não consegui [O QUÊ] no Windows                         ║
║                                                          ║
║  Motivo provável: [TRADUÇÃO HUMANA do erro]              ║
║                                                          ║
║  O que você pode fazer:                                  ║
║   1. [AÇÃO 1]                                            ║
║   2. [AÇÃO 2]                                            ║
║   3. Se nada funcionar, mande este log:                  ║
║      C:\Users\...\.imp-installer\logs\wsl-diag-X.log     ║
║                                                          ║
║  [ TENTAR DE NOVO ]  [ VER LOG ]  [ PULAR (avançado) ]   ║
╚══════════════════════════════════════════════════════════╝
```

Tabela de traduções (catálogo de erros conhecidos, em `src/error-catalog.js`):

| Código/sintoma | Tradução humana | Ação sugerida |
|---|---|---|
| `wsl.exe` não existe | "Seu Windows não tem o WSL instalado" | "Vou instalar pra você. Clique Continuar." |
| Help no `--status` | "O WSL precisa terminar de configurar (provavelmente faltou reiniciar)" | "Reinicie o Windows." |
| 740 ELEVATION_REQUIRED | "Este passo precisa de administrador" | "Feche o instalador, clique direito → Executar como administrador." |
| Virtualization disabled in BIOS | "Sua BIOS está com a virtualização desligada" | "Reinicie no BIOS, ative VT-x/AMD-V, salve e volte." |
| Hyper-V conflito | "Você tem outro virtualizador (VirtualBox/VMware) bloqueando o Hyper-V" | "Feche-os ou desative o Hyper-V manualmente." |
| Disk full | "Seu disco C: tem menos de 5 GB livres" | "Libere espaço e tente de novo." |

---

## 8. Checklist pra Bruno implementar

1. [ ] Adicionar `wslState`, `featuresEnabled`, `distroState`, `wslMigrationStrategy`, `rebootSchedule` ao schema `state.json`. Versão 2.0.
2. [ ] Migrar state.json antigo (versão 1.0) automaticamente no boot do instalador (lê step_01_enable_features done → seta step_01a_enable_features done).
3. [ ] Criar `src/wsl-diagnostic.js` com `diagnoseWsl()` retornando `{ wslState, featuresEnabled, evidence }`.
4. [ ] Criar `src/wsl-migration.js` com `migrateLegacyToModern(strategy='auto', logger)` que faz cascata C3→C2→C4.
5. [ ] Refatorar `executors.js`:
   - Criar `step_00b_wsl_diagnostic` (entre preflight e step_01a).
   - Renomear/dividir step_01 em step_01a (features) e step_01b (migration).
   - step_02 (antigo set-default-v2) vira `step_02_wsl_functional_validate` (no-op execute, valida funcional).
   - step_03 (antigo install) vira `step_03_ubuntu_install` (só Ubuntu via `wsl --install -d`).
   - step_04 inalterado.
6. [ ] Atualizar `sidebar` da UI (`wizard.js`/`renderer`) pra mostrar os 2 novos passos sem quebrar layout.
7. [ ] Implementar tela "Reboot Necessário" com countdown + botão `shutdown /r /t 0`.
8. [ ] Pós-boot: detector via `LastBootUpTime` vs `state.rebootSchedule.scheduledAt`.
9. [ ] Cap `rebootCount > 3` → tela manual.
10. [ ] Catálogo de erros traduzidos em `src/error-catalog.js`.
11. [ ] Cada step grava `wsl-diag-<ts>.log` no início e no fim.
12. [ ] Testar 3 cenários:
    - Win10 19045 com WSL legado (caso JOs)
    - Win10 19045 sem WSL nenhum
    - Win11 com tudo funcional (regressão)

---

## 9. Resumo executivo

- **Estratégia de migração legado→moderno**: cascata **winget (C3) → Store appx (C2) → DISM+reboot (C4)**. C1 (`wsl --update`) descartado porque o binário legado não tem o flag.
- **Sequência de fases com gates reais**: A (diagnóstico) → B (features) → C (instalar moderno) → D (validar funcional) → E (instalar Ubuntu) → F (first boot).
- **Schema state.json v2.0**: adiciona `wslState` (enum 5 valores), `featuresEnabled.{wsl,vmp}`, `distroState`, `wslMigrationStrategy`, `rebootSchedule` (com rebootCount cap).
- **Refator dos steps**: granular, preservando IDs antigos pra compat de instalações em andamento. step_01 vira step_01a (features) + step_01b (migration moderno). step_02 vira validação funcional. step_03 vira instalação Ubuntu.
- **Reboot**: parte natural do fluxo. RunOnce no registry + `shutdown /r /t 0` via botão UI + detector pós-boot via `LastBootUpTime`. Cap em 3 reboots.

— Marcos.
