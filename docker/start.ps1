# =============================================================================
# start.ps1 —— aiti Windows 原生部署器（S5 runner，aiti-docker-image-plan §9.3）
#
# 与容器 entrypoint.sh / Linux systemd 同一份 AITI_PHASES 语义（§9.3 验收口径：
# 差异只允许存在于 runner 实现，不允许存在于 phases 语义）：
#   piweb | bridge | gui | asr | term     —— 逗号分隔，缺省 "piweb,bridge"
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File start.ps1              # 前台启动（Ctrl+C 停全部）
#   powershell -File start.ps1 -Install                             # NSSM 注册 Windows 服务（piweb/bridge 常驻）
#   powershell -File start.ps1 -Remove                              # 移除 NSSM 服务
#   powershell -File start.ps1 -Status                              # 各 phase 端口状态
#
# 环境（可用 env 覆盖，S2 路径规范：env || 默认，不写死盘符）：
#   AITI_PHASES           默认 "piweb,bridge"
#   AITI_APP_DIR          pi-web 目录（需已 next build）      默认 ~\aiti\app
#   AITI_BRIDGE_DIR       aiti-bridge 仓库（bin/aiti-bridge.mjs）默认 ~\aiti\bridge
#   AITI_EXTENSIONS_DIR   PI_WEB_EXTENSIONS_DIR              默认 ~\.pi\web\extensions
#   AITI_DATA_DIR         PI_WEB_DATA_DIR                    默认 ~\.pi\web\data
#   AITI_AGENT_DIR        PI_CODING_AGENT_DIR                默认 ~\.pi\agent
#   AITI_PIWEB_PORT       默认 30142      AITI_BRIDGE_PORT   默认 8777
#   AITI_CDP_PORT         默认 9222（gui phase 的 Edge/Chrome CDP）
# =============================================================================
param(
  [switch]$Install,
  [switch]$Remove,
  [switch]$Status
)

$ErrorActionPreference = "Stop"

function EnvOr([string]$Name, [string]$Default) {
  $v = [Environment]::GetEnvironmentVariable($Name)
  if ([string]::IsNullOrWhiteSpace($v)) { return $Default }
  return $v
}

$Phases      = (EnvOr "AITI_PHASES" "piweb,bridge") -split "\s*,\s*"
$AppDir      = EnvOr "AITI_APP_DIR"        (Join-Path $HOME "aiti\app")
$BridgeDir   = EnvOr "AITI_BRIDGE_DIR"     (Join-Path $HOME "aiti\bridge")
$ExtDir      = EnvOr "AITI_EXTENSIONS_DIR" (Join-Path $HOME ".pi\web\extensions")
$DataDir     = EnvOr "AITI_DATA_DIR"       (Join-Path $HOME ".pi\web\data")
$AgentDir    = EnvOr "AITI_AGENT_DIR"      (Join-Path $HOME ".pi\agent")
$PiwebPort   = EnvOr "AITI_PIWEB_PORT"  "30142"
$BridgePort  = EnvOr "AITI_BRIDGE_PORT" "8777"
$CdpPort     = EnvOr "AITI_CDP_PORT"    "9222"

function Want([string]$p) { return $Phases -contains $p }

# ── 端口探测（PowerShell 7 优先 Get-NetTCPConnection；5.1 降级 netstat）────────
function Get-PortPids([int]$P) {
  try {
    (Get-NetTCPConnection -LocalPort $P -State Listen -ErrorAction Stop).OwningProcess | Sort-Object -Unique
  } catch {
    netstat -ano | Select-String ":${P}\s.*LISTENING" | ForEach-Object { ($_ -split "\s+")[-1] } | Sort-Object -Unique
  }
}

function Test-PortUp([int]$P) { return @(Get-PortPids $P).Count -gt 0 }

# ── phase 启动器（返回 Process 或 $null）──────────────────────────────────────
function Start-Piweb {
  if (Test-PortUp $PiwebPort) { Write-Host "[piweb] ${PiwebPort} 已在运行，跳过"; return $null }
  if (-not (Test-Path (Join-Path $AppDir ".next"))) { throw "[piweb] $AppDir 无 .next 构建产物——先在 AITI_APP_DIR 跑 next build" }
  $env:PI_WEB_EXTENSIONS_DIR = $ExtDir
  $env:PI_WEB_DATA_DIR = $DataDir
  $env:PI_CODING_AGENT_DIR = $AgentDir
  Write-Host "[piweb] next start :${PiwebPort}（ext=$ExtDir）"
  return Start-Process -FilePath "node" -ArgumentList "node_modules\next\dist\bin\next", "start", "-H", "0.0.0.0", "-p", $PiwebPort `
    -WorkingDirectory $AppDir -WindowStyle Hidden -PassThru
}

function Start-Bridge {
  if (Test-PortUp $BridgePort) { Write-Host "[bridge] ${BridgePort} 已在运行，跳过"; return $null }
  $env:AITI_BRIDGE_DATA_DIR = Join-Path $DataDir "aiti-bridge"
  Write-Host "[bridge] aiti-bridge :${BridgePort}"
  return Start-Process -FilePath "node" -ArgumentList (Join-Path $BridgeDir "bin\aiti-bridge.mjs"), "--host", "0.0.0.0", "--port", $BridgePort `
    -WindowStyle Hidden -PassThru
}

function Start-Gui {
  # Windows 原生 = 真实桌面（无 Xvfb/VNC，§9.2）；本 phase 只拉 CDP 调试浏览器（Edge 兜底 Chrome）
  $browser = @()
  foreach ($c in @("${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
                   "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
                   "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
                   "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe")) {
    if (Test-Path $c) { $browser += $c; break }
  }
  if ($browser.Count -eq 0) { Write-Host "[gui] 未找到 Edge/Chrome，跳过 CDP"; return $null }
  Write-Host "[gui] CDP :${CdpPort}（$($browser[0])）"
  return Start-Process -FilePath $browser[0] -ArgumentList "--remote-debugging-port=$CdpPort", "--remote-allow-origins=*", "--no-first-run", "about:blank" -PassThru
}

function Start-Asr {
  # 扩展自管：aiti-ai-input 有 start-stream.ps1（幂等）+ 端口探测自动 ensure——这里只是提前拉起
  $asrDir = EnvOr "AITI_ASR_SERVER_DIR" ""
  if ([string]::IsNullOrWhiteSpace($asrDir)) {
    $asrDir = Join-Path $PSScriptRoot "..\pi-web-ext\aiti-ai-input\server"
  }
  $ctl = Join-Path $asrDir "start-stream.ps1"
  if (-not (Test-Path $ctl)) { Write-Host "[asr] 未找到 $ctl——扩展首用时自动拉起，跳过"; return $null }
  Write-Host "[asr] start-stream.ps1 :8767"
  & powershell -NoProfile -ExecutionPolicy Bypass -File $ctl start
  return $null
}

function Start-Term {
  # Windows 原生用 Windows Terminal / pi CLI 即可（§9.2：ttyd 非必需）；预留 justget 装 ttyd 的提示
  Write-Host "[term] Windows 原生终端无需 ttyd；如需 Web 终端：just get ttyd 后运行 ttyd --port 7681 bash"
  return $null
}

# ── -Status / -Install / -Remove ──────────────────────────────────────────────
if ($Status) {
  foreach ($pair in @(@("piweb", $PiwebPort), @("bridge", $BridgePort), @("cdp", $CdpPort), @("asr", 8767))) {
    $up = Test-PortUp $pair[1]
    $pids = (Get-PortPids $pair[1]) -join " "
    Write-Host ("[{0}] :{1} {2}{3}" -f $pair[0], $pair[1], $(if ($up) { "运行中" } else { "未运行" }), $(if ($up) { " (pid: $pids)" } else { "" }))
  }
  return
}

if ($Install -or $Remove) {
  $nssm = Get-Command nssm -ErrorAction SilentlyContinue
  if (-not $nssm) { throw "nssm 不在 PATH——先安装（choco install nssm / scoop install nssm）" }
  $self = (Resolve-Path $MyInvocation.MyCommand.Path).Path
  if ($Remove) {
    foreach ($svc in @("AitiWeb", "AitiBridge")) {
      if (Get-Service $svc -ErrorAction SilentlyContinue) { nssm stop $svc; nssm remove $svc confirm; Write-Host "[-] 服务 $svc 已移除" }
      else { Write-Host "[.] 服务 $svc 不存在" }
    }
    return
  }
  # 服务化只收 piweb/bridge（常驻后台）；gui/asr/term 属交互会话，走前台或登录自启
  if (-not (Test-Path (Join-Path $AppDir ".next"))) { throw "[piweb] $AppDir 无 .next 构建产物" }
  nssm install AitiWeb  powershell -NoProfile -ExecutionPolicy Bypass -File $self
  nssm set AitiWeb AppDirectory $AppDir
  nssm set AitiWeb AppEnvironmentExtra "AITI_PHASES=piweb"
  nssm install AitiBridge powershell -NoProfile -ExecutionPolicy Bypass -File $self
  nssm set AitiBridge AppEnvironmentExtra "AITI_PHASES=bridge"
  foreach ($svc in @("AitiWeb", "AitiBridge")) { nssm start $svc; Write-Host "[+] 服务 $svc 已注册并启动" }
  Write-Host "[i] gui/asr/term 为交互 phase，不注册服务——登录后前台跑 start.ps1 或扩展自动拉起"
  return
}

# ── 前台启动（与 entrypoint.sh 的 wait 等价：Ctrl+C 全停）─────────────────────
$children = @()
try {
  if (Want "bridge") { $p = Start-Bridge;  if ($p) { $children += $p } }
  if (Want "piweb")  { $p = Start-Piweb;   if ($p) { $children += $p } }
  if (Want "gui")    { $p = Start-Gui;     if ($p) { $children += $p } }
  if (Want "asr")    { Start-Asr }
  if (Want "term")   { Start-Term }
  Write-Host "[start] phases=$($Phases -join ',')；Ctrl+C 停止全部"
  if ($children.Count -gt 0) { Wait-Process -Id ($children | ForEach-Object { $_.Id }) }
  else { Write-Host "[start] 无新起进程（各端口已在运行）" }
} finally {
  foreach ($p in $children) {
    if ($p -and -not $p.HasExited) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue }
  }
}
