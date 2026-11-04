# =============================================================================
# aiti-ai-input · 流式 ASR 服务（8767）一键管理脚本 —— Windows 版（PowerShell）
#
# 与 start-stream.sh 完全对应（同进退模型：经 aiti-cmd PTY 启动，pi-web 停则会话消失；
# 下次语音输入探测到端口不通会经 /asr/ensure 自动拉起）。
#
# 用法（默认 start）：
#   powershell -File start-stream.ps1            # 启动（幂等：已在运行则提示后退出 0）
#   powershell -File start-stream.ps1 status     # 状态（运行/停止 + 日志尾部）
#   powershell -File start-stream.ps1 stop       # 停止（按端口精确取 PID，taskkill /T 树杀）
#   powershell -File start-stream.ps1 restart    # 重启
#
# Linux 对应物：start-stream.sh（ss + kill）；官方服务器为 Linux，本脚本供 Windows 开发机/自托管用。
# 前置：Python 3.10+ 在 PATH；PowerShell 5.1+（Get-NetTCPConnection 需 PS 7 或降级 netstat）
# =============================================================================
param([string]$Action = "start")

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ScriptDir

$Port = if ($env:ASR_STREAM_PORT) { $env:ASR_STREAM_PORT } else { "8767" }
$LogDir = Join-Path $ScriptDir "logs"
$LogFile = Join-Path $LogDir "stream.log"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

# 端口监听的 PID（PowerShell 7 优先 Get-NetTCPConnection；5.1 降级 netstat）
function Get-PortPids {
  param([int]$P)
  try {
    (Get-NetTCPConnection -LocalPort $P -State Listen -ErrorAction Stop).OwningProcess | Sort-Object -Unique
  } catch {
    $lines = netstat -ano | Select-String ":${P}\s" | Select-String "LISTENING"
    $lines | ForEach-Object { ($_ -split "\s+")[-1] } | Sort-Object -Unique
  }
}

function Show-Status {
  $pids = @(Get-PortPids $Port)
  if ($pids.Count -gt 0) {
    $ConfigPath = if ($env:ASR_CONFIG_PATH) { $env:ASR_CONFIG_PATH } else { Join-Path $ScriptDir "asr-config.json" }
    $modelLabel = "paraformer-zh-streaming + seaco"
    try {
      if (Test-Path $ConfigPath) {
        $cfg = Get-Content $ConfigPath -Raw | ConvertFrom-Json
        if ("$($cfg.offline_model)".ToUpper().Contains("GLM")) { $modelLabel = "GLM (offline ASR)" }
      }
    } catch {}
    Write-Host "[asr] $Port 运行中 (pid: $($pids -join ' ')) · 模型: $modelLabel"
    Write-Host "[asr] 健康检查: http://127.0.0.1:$Port/health"
  } else {
    Write-Host "[asr] $Port 未运行"
    if (Test-Path $LogFile) {
      Write-Host "[asr] ── 日志尾部（logs\stream.log）──"
      Get-Content $LogFile -Tail 5 | ForEach-Object { Write-Host $_ }
    }
    Write-Host "[asr] 启动: powershell -File $ScriptDir\start-stream.ps1"
  }
}

function Start-Asr {
  if (@(Get-PortPids $Port).Count -gt 0) {
    Write-Host "[asr] $Port 已在运行，跳过启动（幂等）。"
    Show-Status
    exit 0
  }
  Write-Host "[asr] 启动前检查：venv / 依赖…"
  if (!(Test-Path ".venv")) { python -m venv .venv }
  & ".venv\Scripts\python.exe" -m pip install -q -r requirements.txt
  $env:ASR_STREAM_PORT = if ($env:ASR_STREAM_PORT) { $env:ASR_STREAM_PORT } else { "8767" }
  $env:ASR_STREAM_MODEL = if ($env:ASR_STREAM_MODEL) { $env:ASR_STREAM_MODEL } else { "paraformer-zh-streaming" }
  $env:ASR_OFFLINE_MODEL = if ($env:ASR_OFFLINE_MODEL) { $env:ASR_OFFLINE_MODEL } else { "iic/speech_seaco_paraformer_large_asr_nat-zh-cn-16k-common-vocab8404-pytorch" }
  $env:ASR_MAX_SECONDS = if ($env:ASR_MAX_SECONDS) { $env:ASR_MAX_SECONDS } else { "60" }
  # GLM 分流（与 start-stream.sh 同款）：config.offline_model 含 GLM → GLM 服务自监听 8767（完整协议），启动器只拉起
  $ConfigPath = if ($env:ASR_CONFIG_PATH) { $env:ASR_CONFIG_PATH } else { Join-Path $ScriptDir "asr-config.json" }
  $IsGlm = $false
  try {
    if (Test-Path $ConfigPath) {
      $cfgGlm = Get-Content $ConfigPath -Raw | ConvertFrom-Json
      if ("$($cfgGlm.offline_model)".ToUpper().Contains("GLM")) { $IsGlm = $true }
    }
  } catch {}
  if ($IsGlm) {
    $GlmVenv = Join-Path (Split-Path -Parent $ConfigPath) "glm-venv"
    $GlmPy = Join-Path $GlmVenv "Scripts\python.exe"
    if (Test-Path $GlmPy) {
      Write-Host "[asr] GLM 模式：拉起 GLM 服务（glm_asr_service.py 监听 $Port）并等待就绪…"
      & $GlmPy (Join-Path $ScriptDir "glm\glm_asr_service.py") 2>&1 | Tee-Object -FilePath $LogFile -Append
      exit $LASTEXITCODE
    } else {
      Write-Host "[asr] 警告: GLM venv 缺失（$GlmVenv）——先跑 glm\setup-glm-venv（或 sh 版）；回退 uvicorn"
    }
  }
  Write-Host "[asr] 启动 uvicorn voice-asr-stream:app @127.0.0.1:$Port"
  Write-Host "[asr] 停止本服务: powershell -File $ScriptDir\start-stream.ps1 stop"
  # 前台运行（日志进 PTY）；同时 tee 到日志文件（PS 5.1 无 tee 管道到文件 + 前台阻塞，用 Start-Process 后台 + 日志文件）
  . ".venv\Scripts\uvicorn.exe" voice-asr-stream:app --host 127.0.0.1 --port $Port 2>&1 | Tee-Object -FilePath $LogFile -Append
  exit $LASTEXITCODE
}

function Stop-Asr {
  $pids = @(Get-PortPids $Port)
  if ($pids.Count -eq 0) {
    Write-Host "[asr] $Port 未运行，无需停止。"
    exit 0
  }
  Write-Host "[asr] 停止 $Port → taskkill /T /F: $($pids -join ' ')"
  foreach ($pid in $pids) {
    taskkill /PID $pid /T /F 2>$null | Out-Null
  }
  # 最多等 10s 端口释放
  $waited = 0
  while ((@(Get-PortPids $Port).Count -gt 0) -and $waited -lt 10) {
    Start-Sleep -Seconds 1
    $waited++
  }
  if (@(Get-PortPids $Port).Count -gt 0) { Write-Host "[asr] 端口未在 10s 内释放（可手动 taskkill /F /IM python.exe 按需）" }
  else { Write-Host "[asr] 已停止（pid: $($pids -join ' ')）" }
}

switch ($Action) {
  "start" { Start-Asr }
  "stop" { Stop-Asr }
  "status" { Show-Status }
  "restart" { Stop-Asr; Start-Asr }
  default { Write-Host "用法: powershell -File $($MyInvocation.MyCommand.Name) [start|status|stop|restart]（默认 start）"; exit 2 }
}
