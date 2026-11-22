# =============================================================================
# aiti-ai-speek - local TTS service one-shot manager (Windows, PowerShell 5.1+).
# Pure ASCII so PS 5.1 parses it correctly without a BOM (same rule as bootstrap.ps1).
#
# Mirrors start-tts.sh: start / status / stop / restart, with the same bootstrap
# (venv -> deps -> model download) so the user never installs or downloads by hand.
#
#   powershell -File start-tts.ps1 start [-Provider hojo-40m] [-Port 8768]
#   powershell -File start-tts.ps1 status | stop | restart
#
# Port cleanup uses taskkill /T /F on the exact listening PID (no fuzzy kills).
# =============================================================================
param(
  [string]$Action = "start",
  [string]$Provider = $(if ($env:AITI_TTS_PROVIDER) { $env:AITI_TTS_PROVIDER } else { "hojo-40m" }),
  [int]$Port = $(if ($env:AITI_TTS_PORT) { [int]$env:AITI_TTS_PORT } else { 8768 }),
  [string]$HfEndpoint = $(if ($env:AITI_TTS_HF_ENDPOINT) { $env:AITI_TTS_HF_ENDPOINT } else { "" }),
  [int]$IdleTimeout = $(if ($env:AITI_TTS_IDLE_TIMEOUT) { [int]$env:AITI_TTS_IDLE_TIMEOUT } else { 1800 }),
  [string]$HomeDir = $(if ($env:AITI_TTS_HOME) { $env:AITI_TTS_HOME } else { "" }),
  [string]$VoicesJson = $(if ($env:AITI_TTS_VOICES_JSON) { $env:AITI_TTS_VOICES_JSON } else { "" }),
  [string]$BootSource = $(if ($env:AITI_TTS_SOURCE) { $env:AITI_TTS_SOURCE } else { "hf" }),
  # "1" forces the optional text-normalization attempt (pynini has no Windows wheel by default)
  [string]$Tn = $(if ($env:AITI_TTS_TN) { $env:AITI_TTS_TN } else { "" })
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ScriptDir

if (-not $HomeDir) { $HomeDir = Join-Path $HOME ".pi\web\data\aiti-ai-speek\cache\tts-service" }
$env:AITI_TTS_HOME = $HomeDir
if ($VoicesJson) { $env:AITI_TTS_VOICES_JSON = $VoicesJson }
if ($Tn -ne "") { $env:AITI_TTS_TN = $Tn }
$LogDir = Join-Path $HomeDir "logs"
$LogFile = Join-Path $LogDir "tts.log"
$Prepare = Join-Path $HomeDir "prepare.json"
$Runtime = Join-Path $HomeDir "runtime.json"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

$Family = if ($Provider -like "qwen3-*") { "qwen3" } else { "hojo" }
$Venv = Join-Path $HomeDir "venv-$Family"
$Req = Join-Path $ScriptDir "requirements-$Family.txt"

function Write-Prepare([string]$phase, $percent, [string]$message) {
  $obj = [ordered]@{ phase = $phase; percent = $percent; message = $message; at = [int][double]::Parse((Get-Date -UFormat %s)) }
  try { ($obj | ConvertTo-Json -Compress) | Set-Content -Path $Prepare -Encoding utf8 } catch {}
}

function Get-PortPids([int]$P) {
  try {
    (Get-NetTCPConnection -LocalPort $P -State Listen -ErrorAction Stop).OwningProcess | Sort-Object -Unique
  } catch {
    netstat -ano | Select-String ":${P}\s" | Select-String "LISTENING" | ForEach-Object { ($_ -split "\s+")[-1] } | Sort-Object -Unique
  }
}

function Test-ServiceHealthy([int]$P) {
  try {
    $r = Invoke-RestMethod -Uri "http://127.0.0.1:$P/health" -TimeoutSec 2
    return [bool]$r.provider
  } catch { return $false }
}

function Find-OurPort([int[]]$ports) {
  foreach ($p in $ports) { if (@(Get-PortPids $p).Count -gt 0 -and (Test-ServiceHealthy $p)) { return $p } }
  return 0
}

function Get-RuntimePort {
  try {
    if (Test-Path $Runtime) { return [int](Get-Content $Runtime -Raw | ConvertFrom-Json).port }
  } catch {}
  return 0
}

function Show-Status {
  $candidates = @($Port)
  $rp = Get-RuntimePort
  if ($rp -gt 0 -and $rp -ne $Port) { $candidates += $rp }
  $up = Find-OurPort $candidates
  if ($up -gt 0) {
    $pids = @(Get-PortPids $up)
    Write-Host "[tts] $up running (pid: $($pids -join ' ')) | provider: $Provider"
    Write-Host "[tts] health check: http://127.0.0.1:$up/health"
  } else {
    Write-Host "[tts] $Port not running"
    if (Test-Path $LogFile) {
      Write-Host "[tts] ---- last log lines (tts.log) ----"
      Get-Content $LogFile -Tail 8 | ForEach-Object { Write-Host $_ }
    }
    Write-Host "[tts] start: powershell -File $ScriptDir\start-tts.ps1 start -Provider $Provider"
  }
}

function Invoke-Bootstrap {
  # Single implementation on Windows too: bootstrap.ps1 owns venv/uv/deps/model/prepare.json.
  # Running it as a child process keeps its `exit 3/4` from terminating this script and lets us
  # tee the whole preparation log into logs\tts.log (the panel reads that file).
  $boot = Join-Path $ScriptDir "bootstrap.ps1"
  if (!(Test-Path $boot)) { throw "bootstrap.ps1 missing: $boot" }
  $bootArgs = @("-Provider", $Provider, "-Source", $BootSource)
  if ($HfEndpoint) { $bootArgs += @("-HfEndpoint", $HfEndpoint) }
  if ($env:AITI_TTS_TN -eq "0") { $bootArgs += @("-NoTn") }
  # Child process inherits these; keep them explicit so a manual run behaves the same.
  $env:AITI_TTS_HOME = $HomeDir
  $env:AITI_TTS_PROVIDER = $Provider
  $env:AITI_TTS_VOICES_JSON = $VoicesJson
  # Native stderr becomes an ErrorRecord; with ErrorActionPreference=Stop that would abort this
  # script on the first uv/pip warning (seen with the pynini build failure). Capture it instead.
  $prevEap = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    $out = @(& powershell -NoProfile -ExecutionPolicy Bypass -File $boot @bootArgs 2>&1)
    $code = $LASTEXITCODE
  } finally { $ErrorActionPreference = $prevEap }
  $out | ForEach-Object { Write-Host $_ } 
  try { $out | Out-File -FilePath $LogFile -Append -Encoding utf8 } catch {}
  if ($code -ne 0) {
    Write-Prepare "failed" 100 "bootstrap failed (see logs/tts.log)"
    throw "bootstrap failed (exit $code); see $LogFile"
  }
  $py = Join-Path (Join-Path $HomeDir "venv-$Family") "Scripts\python.exe"
  if (!(Test-Path $py)) { throw "bootstrap finished but $py is missing" }
  return $py
}


function Start-Tts {
  $existing = Find-OurPort (@($Port) + (8769..8778))
  if ($existing -gt 0) { Write-Host "[tts] $existing already running (idempotent, skipping start)"; Show-Status; exit 0 }

  $UsePort = $Port
  if (@(Get-PortPids $UsePort).Count -gt 0) {
    $UsePort = 0
    foreach ($p in (8769..8778)) { if (@(Get-PortPids $p).Count -eq 0) { $UsePort = $p; break } }
    if ($UsePort -eq 0) { Write-Prepare "failed" 100 "no free port in 8768-8778"; throw "8768-8778 all busy" }
    Write-Host "[tts] port $Port busy, falling back to $UsePort"
  }

  $Py = Invoke-Bootstrap
  $ModelDir = ""
  $TnFlag = @()
  $readyPath = Join-Path $HomeDir "ready.json"
  if (Test-Path $readyPath) {
    $ready = Get-Content $readyPath -Raw | ConvertFrom-Json
    $ModelDir = "$($ready.modelDir)"
    if (-not $ready.tn) { $TnFlag = @("--no-tn") }
  }

  $hfEnv = Join-Path $HomeDir "hf-env.json"
  if (Test-Path $hfEnv) {
    try {
      $hf = Get-Content $hfEnv -Raw | ConvertFrom-Json
      if ($hf.HF_ENDPOINT) { $env:HF_ENDPOINT = "$($hf.HF_ENDPOINT)" }
      if ($hf.HF_HUB_DISABLE_XET) { $env:HF_HUB_DISABLE_XET = "$($hf.HF_HUB_DISABLE_XET)" }
    } catch {}
  }

  ([ordered]@{ port = $UsePort; provider = $Provider; pid = $PID; at = [int][double]::Parse((Get-Date -UFormat %s)) } | ConvertTo-Json -Compress) |
    Set-Content -Path $Runtime -Encoding utf8
  Write-Prepare "load" 90 "starting service on port $UsePort"
  Write-Host "[tts] starting uvicorn @127.0.0.1:$UsePort | provider=$Provider | log: $LogFile"
  Write-Host "[tts] stop: powershell -File $ScriptDir\start-tts.ps1 stop"
  # NB: PS 5.1 drops empty strings from native argument lists -> only add --voices-json when set,
  # otherwise argparse would consume the next flag as its value.
  $srvArgs = @(
    (Join-Path $ScriptDir "tts_server.py"), "--provider", $Provider, "--host", "127.0.0.1",
    "--port", "$UsePort", "--model-dir", $ModelDir,
    "--prepare-json", $Prepare, "--idle-timeout", "$IdleTimeout"
  )
  if ($VoicesJson) { $srvArgs += @("--voices-json", $VoicesJson) }
  $srvArgs += $TnFlag
  # uvicorn writes INFO to stderr; with ErrorActionPreference=Stop PS 5.1 turns that into a
  # terminating NativeCommandError and kills the server right after startup. Keep it as data.
  # Out-File -Encoding utf8 (Tee-Object writes UTF-16 in PS 5.1, unreadable for the panel tail).
  $prevEap = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    & $Py @srvArgs 2>&1 | Out-File -FilePath $LogFile -Append -Encoding utf8
    $code = $LASTEXITCODE
  } finally { $ErrorActionPreference = $prevEap }
  exit $code
}

function Stop-Tts {
  $targets = @()
  foreach ($p in (@($Port) + (8768..8778) | Select-Object -Unique)) {
    if (@(Get-PortPids $p).Count -gt 0 -and (Test-ServiceHealthy $p)) { $targets += $p }
  }
  if ($targets.Count -eq 0) { Write-Host "[tts] no listening TTS service"; Remove-Item $Runtime -ErrorAction SilentlyContinue; exit 0 }
  foreach ($p in $targets) {
    $pids = @(Get-PortPids $p)
    Write-Host "[tts] stopping $p -> taskkill /T /F: $($pids -join ' ')"
    foreach ($procId in $pids) { taskkill /PID $procId /T /F 2>$null | Out-Null }
    $waited = 0
    while ((@(Get-PortPids $p).Count -gt 0) -and $waited -lt 10) { Start-Sleep -Seconds 1; $waited++ }
  }
  Remove-Item $Runtime -ErrorAction SilentlyContinue
  Write-Host "[tts] stopped"
}

switch ($Action) {
  "start"   { Start-Tts }
  "stop"    { Stop-Tts }
  "status"  { Show-Status }
  "restart" { Stop-Tts; Start-Sleep -Seconds 1; Start-Tts }
  default   { Write-Host "usage: start-tts.ps1 [start|status|stop|restart]"; exit 2 }
}
