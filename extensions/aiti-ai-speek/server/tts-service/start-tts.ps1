# =============================================================================
# aiti-ai-speek · local TTS service one-shot manager — Windows (PowerShell 5.1+)
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
  [int]$IdleTimeout = $(if ($env:AITI_TTS_IDLE_TIMEOUT) { [int]$env:AITI_TTS_IDLE_TIMEOUT } else { 1800 })
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ScriptDir

$HomeDir = if ($env:AITI_TTS_HOME) { $env:AITI_TTS_HOME } else { Join-Path $HOME ".pi\web\data\aiti-ai-speek\cache\tts-service" }
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
    Write-Host "[tts] $up 运行中 (pid: $($pids -join ' ')) · provider: $Provider"
    Write-Host "[tts] 健康检查: http://127.0.0.1:$up/health"
  } else {
    Write-Host "[tts] $Port 未运行"
    if (Test-Path $LogFile) {
      Write-Host "[tts] ── 日志尾部（tts.log）──"
      Get-Content $LogFile -Tail 8 | ForEach-Object { Write-Host $_ }
    }
    Write-Host "[tts] 启动: powershell -File $ScriptDir\start-tts.ps1 start -Provider $Provider"
  }
}

function Resolve-Python {
  $candidates = @()
  if (Get-Command uv -ErrorAction SilentlyContinue) {
    & uv python find 3.12 *> $null
    if ($LASTEXITCODE -eq 0) {
      $venvArgs = @("venv", "--python", "3.12", $Venv)
      & uv @venvArgs
      if ($LASTEXITCODE -eq 0) { return (Join-Path $Venv "Scripts\python.exe") }
    }
  }
  $candidates += "py -3.12", "py -3.11", "python3.12", "python"
  foreach ($c in $candidates) {
    $parts = $c.Split(" ")
    $exe = Get-Command $parts[0] -ErrorAction SilentlyContinue
    if (-not $exe) { continue }
    $ver = & $parts[0] @($parts[1..($parts.Length - 1)] + @("-c", "import sys;print('%d.%d' % sys.version_info[:2])")) 2>$null
    if ($ver -match "^3\.(1[0-2])$") {
      & $parts[0] @($parts[1..($parts.Length - 1)] + @("-m", "venv", $Venv))
      if ($LASTEXITCODE -eq 0) { return (Join-Path $Venv "Scripts\python.exe") }
    }
  }
  return ""
}

function Invoke-Bootstrap {
  $Py = Join-Path $Venv "Scripts\python.exe"
  if (!(Test-Path $Py)) {
    Write-Prepare "venv" 5 "creating Python 3.12 environment"
    $Py = Resolve-Python
    if (-not $Py) {
      Write-Prepare "failed" 100 "Python 3.12 not available (install uv or Python 3.12)"
      throw "Python 3.10-3.12 not found; install uv (https://docs.astral.sh/uv/) and retry"
    }
  }
  Write-Prepare "venv" 15 "python env ready"

  $hashSrc = (Get-FileHash $Req -Algorithm SHA256).Hash + "|$Family|$($env:AITI_TTS_PIP_INDEX)"
  $hash = [BitConverter]::ToString(
    [System.Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($hashSrc))
  ).Replace("-", "").ToLower()
  $stamp = Join-Path $Venv ".deps-sha256"
  $needInstall = $true
  if (Test-Path $stamp) { if ((Get-Content $stamp -Raw).Trim() -eq $hash) { $needInstall = $false } }
  if ($needInstall) {
    Write-Prepare "deps" 18 "installing python deps (first run may take a few minutes)"
    & $Py -m pip install --upgrade pip -q 2>&1 | Out-Null
    $pipArgs = @("-m", "pip", "install", "-q", "-r", $Req)
    if ($env:AITI_TTS_PIP_INDEX) { $pipArgs += @("--index-url", $env:AITI_TTS_PIP_INDEX) }
    $ok = $false
    for ($i = 1; $i -le 3; $i++) {
      & $Py @pipArgs
      if ($LASTEXITCODE -eq 0) { $ok = $true; break }
      Start-Sleep -Seconds ($i * 3)
    }
    if (-not $ok) { Write-Prepare "failed" 100 "pip install failed"; throw "pip install failed" }
    Set-Content -Path $stamp -Value $hash -NoNewline
  }
  Write-Prepare "deps" 40 "python deps ready"

  if ($Family -eq "hojo" -and $env:AITI_TTS_TN -ne "0") {
    & $Py -c "import tn" *> $null
    if ($LASTEXITCODE -ne 0) {
      Write-Prepare "deps" 44 "installing text normalization (optional)"
      & $Py -m pip install -q "WeTextProcessing>=1.0.4.1" 2>&1 | Out-Null
      if ($LASTEXITCODE -ne 0) { Set-Content -Path (Join-Path $HomeDir "tn-disabled") -Value "no-tn" }
    }
  }

  Write-Prepare "download" 40 "preparing model files"
  $modelArgs = @((Join-Path $ScriptDir "bootstrap_models.py"), "--provider", $Provider, "--home", $HomeDir, "--prepare-json", $Prepare)
  if ($HfEndpoint) { $modelArgs += @("--hf-endpoint", $HfEndpoint) }
  $ModelDir = (& $Py @modelArgs | Select-Object -Last 1)
  $tn = -not (Test-Path (Join-Path $HomeDir "tn-disabled"))
  $ready = [ordered]@{ provider = $Provider; family = $Family; venv = $Venv; modelDir = "$ModelDir"; depsHash = $hash; tn = $tn; at = [int][double]::Parse((Get-Date -UFormat %s)) }
  ($ready | ConvertTo-Json -Compress) | Set-Content -Path (Join-Path $HomeDir "ready.json") -Encoding utf8
  Write-Prepare "download" 88 "model ready"
  return $Py
}

function Start-Tts {
  $existing = Find-OurPort (@($Port) + (8769..8778))
  if ($existing -gt 0) { Write-Host "[tts] $existing 已在运行（幂等，跳过启动）"; Show-Status; exit 0 }

  $UsePort = $Port
  if (@(Get-PortPids $UsePort).Count -gt 0) {
    $UsePort = 0
    foreach ($p in (8769..8778)) { if (@(Get-PortPids $p).Count -eq 0) { $UsePort = $p; break } }
    if ($UsePort -eq 0) { Write-Prepare "failed" 100 "no free port in 8768-8778"; throw "8768-8778 all busy" }
    Write-Host "[tts] 端口 $Port 被其他进程占用，改用 $UsePort"
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

  ([ordered]@{ port = $UsePort; provider = $Provider; pid = $PID; at = [int][double]::Parse((Get-Date -UFormat %s)) } | ConvertTo-Json -Compress) |
    Set-Content -Path $Runtime -Encoding utf8
  Write-Prepare "load" 90 "starting service on port $UsePort"
  Write-Host "[tts] 启动 uvicorn @127.0.0.1:$UsePort · provider=$Provider · 日志: $LogFile"
  Write-Host "[tts] 停止: powershell -File $ScriptDir\start-tts.ps1 stop"
  $args = @(
    (Join-Path $ScriptDir "tts_server.py"), "--provider", $Provider, "--host", "127.0.0.1",
    "--port", "$UsePort", "--model-dir", $ModelDir,
    "--voices-json", "$env:AITI_TTS_VOICES_JSON", "--prepare-json", $Prepare,
    "--idle-timeout", "$IdleTimeout"
  ) + $TnFlag
  & $Py @args 2>&1 | Tee-Object -FilePath $LogFile -Append
  exit $LASTEXITCODE
}

function Stop-Tts {
  $targets = @()
  foreach ($p in (@($Port) + (8768..8778) | Select-Object -Unique)) {
    if (@(Get-PortPids $p).Count -gt 0 -and (Test-ServiceHealthy $p)) { $targets += $p }
  }
  if ($targets.Count -eq 0) { Write-Host "[tts] 没有在监听的 TTS 服务"; Remove-Item $Runtime -ErrorAction SilentlyContinue; exit 0 }
  foreach ($p in $targets) {
    $pids = @(Get-PortPids $p)
    Write-Host "[tts] 停止 $p → taskkill /T /F: $($pids -join ' ')"
    foreach ($procId in $pids) { taskkill /PID $procId /T /F 2>$null | Out-Null }
    $waited = 0
    while ((@(Get-PortPids $p).Count -gt 0) -and $waited -lt 10) { Start-Sleep -Seconds 1; $waited++ }
  }
  Remove-Item $Runtime -ErrorAction SilentlyContinue
  Write-Host "[tts] 已停止"
}

switch ($Action) {
  "start"   { Start-Tts }
  "stop"    { Stop-Tts }
  "status"  { Show-Status }
  "restart" { Stop-Tts; Start-Sleep -Seconds 1; Start-Tts }
  default   { Write-Host "用法: start-tts.ps1 [start|status|stop|restart]"; exit 2 }
}
