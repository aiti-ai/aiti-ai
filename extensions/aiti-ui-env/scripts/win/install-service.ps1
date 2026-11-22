# aiti-ui-env · Windows 服务化（两种模式：计划任务 / NSSM）
#
# 用法（管理员 PowerShell）：
#   .\install-service.ps1 -ScheduledTask     # 计划任务：开机触发 + 登录后运行 vnc-bridge/noVNC 守护（node，零依赖）
#   .\install-service.ps1 -NSSM              # NSSM 包裹 noVNC 服务（真 Windows 服务，Session 0 OK——纯网络组件无 GUI 限制）
#   .\install-service.ps1 -Uninstall         # 卸载
#
# 关键认知（服务场景的"虚拟环境有限"）：
#   - Windows 服务 = Session 0（非交互）：GUI 应用渲染不到桌面 → 不能把 GUI 放服务里。
#   - 等效架构：
#       · 纯网络/无 GUI 组件（vnc-bridge、noVNC 静态、VNC server）→ 真服务/计划任务，随便跑。
#       · GUI 应用（被调试的目标）→ 自动登录交互会话 + 虚拟显示驱动（setup-windows.ps1），
#         由 agent 用 ui_env_run 按模式拉起，绝不放进服务。
#   - 对应 Linux 的 systemd user + linger：计划任务"登录时运行" + 虚拟显示器即等效。
param(
  [switch]$ScheduledTask,
  [switch]$NSSM,
  [switch]$Uninstall,
  [int]$VncPort = 5900,
  [int]$WebPort = 6080
)
$ErrorActionPreference = "Stop"
$novncDir = "$env:ProgramData\aiti-ui-env\novnc"
$taskName = "aiti-ui-env-novnc"
$svcName = "aiti-ui-env-novnc"
$logDir = "$env:ProgramData\aiti-ui-env\logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

function Log($m) { Write-Host "[aiti-ui-env] $m" }

if ($Uninstall) {
  if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false; Log "计划任务已删除" }
  if (Get-Service $svcName -ErrorAction SilentlyContinue) {
    & "$env:ProgramFiles\NSSM\nssm.exe" stop $svcName 2>$null; & "$env:ProgramFiles\NSSM\nssm.exe" remove $svcName confirm 2>$null
    Log "NSSM 服务已删除"
  }
  exit 0
}

if ($NSSM) {
  if (-not (Test-Path "$env:ProgramFiles\NSSM\nssm.exe")) {
    Log "安装 NSSM（非官方服务包装器，MIT）…"
    $u = "https://nssm.cc/release/nssm-2.24.zip"
    $z = "$env:TEMP\nssm.zip"
    # justget/curl 兜底下载
    $jg = $env:JUSTGET_BIN
    if ($jg) { node $jg $u -o $z -m "https://gh-proxy.com/$u" | Out-Null } else { curl.exe -fSL $u -o $z }
    New-Item -ItemType Directory -Force -Path "$env:ProgramFiles\NSSM" | Out-Null
    Expand-Archive $z "$env:ProgramFiles\NSSM\tmp" -Force
    Copy-Item "$env:ProgramFiles\NSSM\tmp\nssm-2.24\win64\nssm.exe" "$env:ProgramFiles\NSSM\" -Force
    Remove-Item "$env:ProgramFiles\NSSM\tmp" -Recurse -Force
  }
  $nssm = "$env:ProgramFiles\NSSM\nssm.exe"
  if (Get-Service $svcName -ErrorAction SilentlyContinue) { & $nssm stop $svcName 2>$null; & $nssm remove $svcName confirm 2>$null }
  # VNC web 层：node vnc-bridge（零依赖）——需 node + 部署扩展
  # 源地址在脚本内固定 127.0.0.1（不对外开端口；外部经站点 middleware 代理访问）
  $node = (Get-Command node -ErrorAction SilentlyContinue).Source
  if (-not $node) { throw "缺 node：vnc-bridge 是 node 脚本（pi-web 依赖）" }
  $bridge = "$env:USERPROFILE\.pi\web\data\aiti-ui-env\cache\vnc-bridge.mjs" # 数据分层：<extRoot>\cache
  if (-not (Test-Path $bridge)) { throw "缺 $bridge（先部署扩展 node tools/deploy.mjs）" }
  $tokenFile = "$env:USERPROFILE\.pi\web\data\aiti-ui-env\config\vnc-token"
  $token = if (Test-Path $tokenFile) { (Get-Content $tokenFile -Raw).Trim() } else { -join ((1..16) | ForEach-Object { '{0:x2}' -f (Get-Random -Max 256) }) }
  & $nssm install $svcName $node $bridge
  & $nssm set $svcName AppDirectory $logDir
  & $nssm set $svcName AppEnvironmentExtra "UI_ENV_VNC_TOKEN=$token" "UI_ENV_VNC_WEB_PORT=$WebPort" "UI_ENV_VNC_PORT=$VncPort" "UI_ENV_NOVNC_DIR=$novncDir"
  & $nssm set $svcName AppStdout "$logDir\vnc-bridge.out.log"
  & $nssm set $svcName AppStderr "$logDir\vnc-bridge.err.log"
  & $nssm set $svcName Start SERVICE_AUTO_START
  & $nssm start $svcName
  Log "OK NSSM 服务 $svcName 已启动（:${WebPort} → rfbserver :$VncPort，node vnc-bridge）"
}

if ($ScheduledTask) {
  # 计划任务 = 登录会话内守护（更接近 Linux user systemd；Web 组件不依赖会话也能跑，托管进程一样 OK）
  # node vnc-bridge（零依赖）；env 经 cmd /c set 包装（计划任务 Action 无 env 参数）；源地址脚本内固定 127.0.0.1
  $node = (Get-Command node -ErrorAction SilentlyContinue).Source
  if (-not $node) { throw "缺 node：vnc-bridge 是 node 脚本（pi-web 依赖）" }
  $bridge = "$env:USERPROFILE\.pi\web\data\aiti-ui-env\cache\vnc-bridge.mjs" # 数据分层：<extRoot>\cache
  if (-not (Test-Path $bridge)) { throw "缺 $bridge（先部署扩展 node tools/deploy.mjs）" }
  $tokenFile = "$env:USERPROFILE\.pi\web\data\aiti-ui-env\config\vnc-token"
  $token = if (Test-Path $tokenFile) { (Get-Content $tokenFile -Raw).Trim() } else { -join ((1..16) | ForEach-Object { '{0:x2}' -f (Get-Random -Max 256) }) }
  $envLine = "set UI_ENV_VNC_TOKEN=$token&&set UI_ENV_VNC_WEB_PORT=$WebPort&&set UI_ENV_VNC_PORT=$VncPort&&set UI_ENV_NOVNC_DIR=$novncDir&&"
  $act = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c $envLine `"$node`" `"$bridge`"" -WorkingDirectory $logDir
  $trig1 = New-ScheduledTaskTrigger -AtStartup
  $trig2 = New-ScheduledTaskTrigger -AtLogOn
  $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Days 9999)
  Register-ScheduledTask -TaskName $taskName -Action $act -Trigger $trig1, $trig2 -Settings $settings -RunLevel Limited -Force | Out-Null
  Start-ScheduledTask -TaskName $taskName
  Log "OK 计划任务 $taskName 已注册并启动（:${WebPort} → rfbserver :$VncPort）"
}

if (-not $ScheduledTask -and -not $NSSM) {
  Log "未指定模式。用法："
  Log "  .\install-service.ps1 -NSSM          # 真服务（Session 0，纯网络组件 OK）"
  Log "  .\install-service.ps1 -ScheduledTask # 登录守护（等效 Linux user systemd）"
  Log "GUI 应用不要放进服务（Session 0 无桌面）——用 setup-windows.ps1 的自动登录会话 + ui_env_run 拉起"
}