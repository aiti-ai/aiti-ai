# aiti-ui-env · Windows 等效方案（无头虚拟屏 + VNC-on-web + 服务化）
#
# 用法（管理员 PowerShell）：
#   .\setup-windows.ps1              # 全流程：装虚拟显示驱动 + 自动登录 + TightVNC + noVNC
#   .\setup-windows.ps1 -NoDriver    # 跳过虚拟显示驱动（已有显示器/RDP 时）
#   .\setup-windows.ps1 -DryRun      # 只报告缺什么
#   .\setup-windows.ps1 -AskAI       # 失败时输出可投喂 AI 的排查上下文
#
# 原理（对照 Linux）：
#   Linux Xvfb :99        → Windows 虚拟显示驱动（IddSampleDriver / usbmmidd）产生的虚拟显示器
#   openbox WM            → Windows 交互会话（自动登录进入，RDP 断开仍保留）
#   AT-SPI                → UIA / WinAppDriver（语义树，无头读树+操作，与显示无关）
#   x11vnc + noVNC        → TightVNC/UltraVNC server :5900 + noVNC 网页客户端 :6080
#   systemd 服务          → 计划任务（开机触发 + 登录运行）或 NSSM 包裹
#
# 服务场景限制（重要）：Windows 服务跑在 Session 0（非交互，无桌面）
#   → GUI 应用不能直接放进服务里。等效做法 = 自动登录交互会话 + 虚拟显示器，
#     服务/计划任务只保 VNC/noVNC 等纯网络组件常驻（见 install-service.ps1）。
param(
  [switch]$NoDriver,
  [switch]$DryRun,
  [switch]$AskAI,
  [int]$VncPort = 5900,
  [int]$WebPort = 6080,
  [string]$VncPassword = ""
)
$ErrorActionPreference = "Stop"
$Log = "$env:TEMP\aiti-ui-env-setup.log"

function Log($m) { Write-Host "[aiti-ui-env] $m" }
function Warn($m) { Write-Host "[aiti-ui-env] WARN $m" -ForegroundColor Yellow }
function AskAI($topic, $detail) {
  Write-Host "`n══════════ AI 协助请求（把下面整段发给 AI） ══════════" -ForegroundColor Cyan
  Write-Host "目标：Windows 无头虚拟屏 + VNC-on-web（aiti-ui-env 等效）"
  Write-Host "故障：$topic"
  Write-Host "--- 系统信息 ---"
  Write-Host "OS: $([System.Environment]::OSVersion.VersionString)"
  Write-Host "--- 失败详情 ---"
  Write-Host $detail
  Write-Host "请给出：1) 缺什么/错在哪 2) 逐条修复命令 3) 装完后的验证"
  Write-Host "══════════════════════════════════════════════════" -ForegroundColor Cyan
}
function HasCmd($name) { [bool](Get-Command $name -ErrorAction SilentlyContinue) }
function JGet($url, $out) {
  # justget 多源下载兜底（路径/命令），失败回退 curl
  $jg = $env:JUSTGET_BIN
  if (!$jg -and (Test-Path "$env:USERPROFILE\workspace\justget\justget.mjs")) { $jg = "$env:USERPROFILE\workspace\justget\justget.mjs" }
  if ($jg -and (Test-Path $jg)) { node $jg $url -o $out -m "https://gh-proxy.com/$url" -m "https://ghfast.top/$url" 2>>$Log; return $LASTEXITCODE -eq 0 }
  if (HasCmd curl) { curl.exe -fSL $url -o $out 2>>$Log; return $LASTEXITCODE -eq 0 }
  return $false
}
function IsAdmin { ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) }

if (-not (IsAdmin)) { Warn "需要管理员权限（右击 PowerShell → 以管理员身份运行）" }

Log "OS: $([System.Environment]::OSVersion.VersionString) | 架构: $env:PROCESSOR_ARCHITECTURE"

# 0. winget（可选，装工具用）
if (-not (HasCmd winget)) { Warn "未找到 winget（可装 App Installer）。工具安装将走手动/justget" }

# 1. 虚拟显示驱动（无物理显示器时出画面；已有显示器/RDP 可跳过）
if (-not $NoDriver) {
  $installed = Get-PnpDevice -Class Display -ErrorAction SilentlyContinue | Where-Object { $_.FriendlyName -match "Idd|Virtual|间接|间接显示" }
  if ($installed) {
    Log "虚拟显示驱动已存在: $($installed.FriendlyName -join ', ')"
  } else {
    Log "安装虚拟显示驱动（IddSampleDriver 优先，usbmmidd 兜底）…"
    $drvDir = "$env:TEMP\aiti-idd"
    New-Item -ItemType Directory -Force -Path $drvDir | Out-Null
    $ok = $false
    # 路线 A：IddSampleDriver（微软官方样例，zip release）
    $IddUrl = "https://github.com/ge9/IddSampleDriver/releases/download/0.0.1.7/IddSampleDriver.zip"
    if ((JGet $IddUrl "$drvDir\idd.zip") -and (Test-Path "$drvDir\idd.zip")) {
      try {
        Expand-Archive "$drvDir\idd.zip" -DestinationPath "$drvDir\idd" -Force
        $inf = Get-ChildItem "$drvDir\idd" -Filter *.inf -Recurse | Select-Object -First 1
        if ($inf) {
          pnputil /add-driver $inf.FullName /install | Out-Null
          $ok = $LASTEXITCODE -eq 0
        }
      } catch { Warn "IddSampleDriver 安装失败: $_" }
    }
    # 路线 B：usbmmidd（注册表方式，免签名）
    if (-not $ok) {
      $uUrl = "https://github.com/ge9/UsbMMDisplay/archive/refs/heads/main.zip"
      if ((JGet $uUrl "$drvDir\usbmm.zip") -and (Test-Path "$drvDir\usbmm.zip")) {
        try {
          Expand-Archive "$drvDir\usbmm.zip" -DestinationPath "$drvDir\usbmm" -Force
          $adb = Get-ChildItem "$drvDir\usbmm" -Recurse -Filter "deviceinstaller64.exe" | Select-Object -First 1
          if (-not $adb) { $adb = Get-ChildItem "$drvDir\usbmm" -Recurse -Filter "deviceinstaller.exe" | Select-Object -First 1 }
          if ($adb) { & $adb.FullName enable 2>>$Log }
          $ok = $true
        } catch { Warn "usbmmidd 安装失败: $_" }
      }
    }
    if (-not $ok) {
      Warn "虚拟显示驱动安装失败"
      if ($AskAI) { AskAI "虚拟显示驱动安装失败" "尝试过的源: IddSampleDriver + usbmmidd；日志: $(Get-Content $Log -Tail 20 -ErrorAction SilentlyContinue)" }
    } else {
      Log "OK 虚拟显示驱动已装（若屏幕未出现，重启后生效）"
    }
  }
}

# 2. 自动登录（无头必须：开机自动进交互会话，GUI 才能渲染）
Log "配置自动登录（WinLogon AutoAdminLogon）…"
$winlogon = "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon"
if ($env:UI_ENV_WIN_USER) { Set-ItemProperty $winlogon "AutoAdminLogon" "1"; Set-ItemProperty $winlogon "DefaultUserName" $env:UI_ENV_WIN_USER }
else { Warn "未设 UI_ENV_WIN_USER（自动登录跳过；用 RDP 进一次会话可替代）" }

# 3. VNC server（TightVNC 优先，UltraVNC 兜底）
#    VNC 密码：先拿到用户设的密码（--VncPassword 或交互输入）→ 持久化到扩展 configDir/vnc-passwd；
#    便携 UltraVNC 存在时一并用正确算法写 ultravnc.ini（UltraVNC 自己认证，桥不代答）。
if (-not $VncPassword) {
  $sec = Read-Host -Prompt "请设置 VNC 密码（1~8 位，UltraVNC 上限 8 位；直接回车取消）"
  $VncPassword = $sec
}
if ($VncPassword) {
  $VncPassword = $VncPassword.Trim()
  if ($VncPassword.Length -gt 8) { Warn "VNC 密码超过 8 位，将截断为前 8 位（UltraVNC 限制）"; $VncPassword = $VncPassword.Substring(0, 8) }
  $cfgDir = "$env:USERPROFILE\.pi\web\data\aiti-ui-env\config"
  New-Item -ItemType Directory -Force -Path $cfgDir | Out-Null
  Set-Content -Path (Join-Path $cfgDir "vnc-passwd") -Value $VncPassword -NoNewline -Encoding ascii
  Remove-Item (Join-Path $cfgDir "vnc-rfb-passwd") -Force -ErrorAction SilentlyContinue # 旧随机密码文件退役
  Log "OK VNC 密码已保存（扩展 configDir/vnc-passwd）"
  # 便携 UltraVNC：用 UltraVNC 专有 DES 钥匙写 passwd（E8 4A D6 60 C4 72 1A E0，不是标准 VNC 的 17 52 ...），
  # 官方格式 = 8 字节密文 + 1 字节校验 hex。
  foreach ($vdir in @("$cfgDir\cache\ultravnc", "D:\apps\ultravnc", "$env:USERPROFILE\ultravnc")) {
    if (Test-Path (Join-Path $vdir "winvnc.exe")) {
      $ini = Join-Path $vdir "ultravnc.ini"
      Remove-Item $ini -Force -ErrorAction SilentlyContinue
      New-Item -ItemType File -Force (Join-Path $vdir "ultravnc.portable") | Out-Null
      Add-Type -Namespace Win32 -Name Prof -MemberDefinition @'
[DllImport("kernel32.dll", CharSet=CharSet.Ansi)] public static extern bool WritePrivateProfileString(string sect, string key, string val, string file);
'@
      $uvkey = [byte[]](232,74,214,96,196,114,26,224)
      $pb = [System.Text.Encoding]::ASCII.GetBytes($VncPassword)
      $data = New-Object byte[] 8
      for ($i = 0; $i -lt [Math]::Min(8, $pb.Length); $i++) { $data[$i] = $pb[$i] }
      $des = New-Object System.Security.Cryptography.DESCryptoServiceProvider
      $des.Mode = [System.Security.Cryptography.CipherMode]::ECB
      $des.Padding = [System.Security.Cryptography.PaddingMode]::None
      $des.Key = $uvkey; $des.IV = New-Object byte[] 8
      $h = $des.CreateEncryptor().TransformFinalBlock($data, 0, 8)
      $hex = (($h | ForEach-Object { $_.ToString('X2') }) -join '') + '00'
      foreach ($kv in @(@("AutoPortSelect","0"),@("PortNumber","$VncPort"),@("LoopbackOnly","1"),@("AllowLoopback","1"),@("HTTPConnect","0"),@("FileTransferEnabled","0"),@("IdleTimeout","0"),@("QueryAccept","0"),@("Secure","0"))) {
        [Win32.Prof]::WritePrivateProfileString("admin", $kv[0], $kv[1], $ini) | Out-Null
      }
      [Win32.Prof]::WritePrivateProfileString("UltraVNC", "passwd", $hex, $ini) | Out-Null
      Log "OK 便携 UltraVNC 密码已写入 $ini"
      break
    }
  }
} else { Warn "未设 VNC 密码：VNC 连接将无法建立（可重跑并设密码，或在 pi-web 面板里设）" }

if (-not (HasCmd "TightVNC Server") -and -not (Test-Path "C:\Program Files\TightVNC\tvnserver.exe")) {
  Log "安装 TightVNC server…"
  $vncUrl = "https://www.tightvnc.com/download/2.8.85/tightvnc-2.8.85-gpl-setup-64bit.msi"
  $msi = "$env:TEMP\tightvnc.msi"
  if ((JGet $vncUrl $msi) -and (Test-Path $msi)) {
    Start-Process msiexec -ArgumentList "/i `"$msi`" /quiet /norestart ALLUSERS=1" -Wait
    # 配置端口 + 密码（TightVNC 走标准 VNC 钥匙 17 52 6B 06 23 4E 58 07，存 REG_BINARY 8 字节）
    New-Item -ItemType Directory -Force -Path "HKLM:\SOFTWARE\TightVNC\Server" | Out-Null
    Set-ItemProperty "HKLM:\SOFTWARE\TightVNC\Server" "PortNumber" $VncPort
    Set-ItemProperty "HKLM:\SOFTWARE\TightVNC\Server" "LocalHostOnly" 1
    if ($VncPassword) {
      $fixed = [byte[]](23,82,107,6,35,78,88,7)
      $pb2 = [System.Text.Encoding]::ASCII.GetBytes($VncPassword)
      $d2 = New-Object byte[] 8
      for ($i = 0; $i -lt [Math]::Min(8, $pb2.Length); $i++) { $d2[$i] = $pb2[$i] }
      $des2 = New-Object System.Security.Cryptography.DESCryptoServiceProvider
      $des2.Mode = [System.Security.Cryptography.CipherMode]::ECB
      $des2.Padding = [System.Security.Cryptography.PaddingMode]::None
      $des2.Key = $fixed; $des2.IV = New-Object byte[] 8
      $bin = $des2.CreateEncryptor().TransformFinalBlock($d2, 0, 8)
      Set-ItemProperty "HKLM:\SOFTWARE\TightVNC\Server" "Password" $bin -Type Binary
      Log "OK TightVNC 已装（端口 $VncPort，仅本机；密码已写入注册表）"
    } else {
      Log "OK TightVNC 已装（端口 $VncPort，仅本机；未设密码，需在 TightVNC Server 界面设置一次）"
    }
  } else {
    Warn "TightVNC 下载失败（可手动装 UltraVNC/任何 VNC server 到 :$VncPort）"
    if ($AskAI) { AskAI "TightVNC 下载失败" "日志: $(Get-Content $Log -Tail 15 -ErrorAction SilentlyContinue)" }
  }
}

# 4. noVNC（网页查看）
$novncDir = "$env:ProgramData\aiti-ui-env\novnc"
if (-not (Test-Path "$novncDir\vnc.html")) {
  Log "下载 noVNC → $novncDir"
  New-Item -ItemType Directory -Force -Path $novncDir | Out-Null
  $nUrl = "https://github.com/novnc/noVNC/archive/refs/tags/v1.5.0.tar.gz"
  if ((JGet $nUrl "$env:TEMP\novnc.tar.gz") -and (Test-Path "$env:TEMP\novnc.tar.gz")) {
    tar -xzf "$env:TEMP\novnc.tar.gz" -C $novncDir --strip-components=1
    Log "OK noVNC 就绪"
  } else { Warn "noVNC 下载失败（浏览器访问可改用任何 VNC 客户端直连 :$VncPort）" }
}

# 5. VNC web 层 = 自写 node vnc-bridge（零依赖，无 python/pip 依赖）。
#    只需 node（pi-web 运行环境必有）+ 部署扩展（vnc-bridge.mjs 拷入 dataDir）。
$bridgePath = "$env:USERPROFILE\.pi\web\data\aiti-ui-env\vnc-bridge.mjs"
if (-not (HasCmd node)) { Warn "缺 node：vnc-bridge 是 node 脚本（pi-web 环境必有 node；独立部署需装）" }
elseif (-not (Test-Path $bridgePath)) { Warn "缺 vnc-bridge.mjs：先部署扩展（node tools/deploy.mjs），路径 $bridgePath" }
else { Log "OK VNC web 层：node vnc-bridge 就绪（无需 python）" }

if ($DryRun) { Log "DryRun 完成（未实际安装）" }

Log "完成。下一步："
Log "  1. 服务化/计划任务：.\install-service.ps1（NSSM 或 ScheduledTask 两种模式）"
Log "  2. 浏览器查看：http://127.0.0.1:$WebPort/vnc.html?autoconnect=true&resize=scale"
Log "  3. UIA/语义调试（对应 AT-SPI）：安装 WinAppDriver，用 appium-windows-driver 或 pywinauto 直读 UIA 树"
Log "  4. 公网暴露：service-tunnels 登记 vhost + TOTP，勿直开 5900/6080"