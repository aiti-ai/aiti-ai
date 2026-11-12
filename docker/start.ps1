# =============================================================================
# start.ps1 — aiti Windows-native launcher (S5 runner, aiti-docker-image-plan §9.3)
#
# Shares the container entrypoint.sh / Linux systemd AITI_PHASES semantics (§9.3 acceptance:
# differences are allowed only in runner implementations, never in phases semantics):
#   piweb | bridge | gui | asr | term     — comma-separated, default "piweb,bridge"
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File start.ps1              # foreground start (Ctrl+C stops everything)
#   powershell -File start.ps1 -Install                             # register NSSM services (piweb/bridge daemons)
#   powershell -File start.ps1 -Remove                              # remove the NSSM services
#   powershell -File start.ps1 -Status                              # per-phase port status
#
# Environment (env-overridable, S2 path rules: env || default, no hardcoded drive letters):
#   AITI_PHASES           default "piweb,bridge"
#   AITI_APP_DIR          pi-web directory (must have run next build)  default ~\aiti\app
#   AITI_BRIDGE_DIR       aiti-bridge repo (bin/aiti-bridge.mjs)       default ~\aiti\bridge
#   AITI_EXTENSIONS_DIR   PI_WEB_EXTENSIONS_DIR              default ~\.pi\web\extensions
#   AITI_DATA_DIR         PI_WEB_DATA_DIR                    default ~\.pi\web\data
#   AITI_AGENT_DIR        PI_CODING_AGENT_DIR                default ~\.pi\agent
#   AITI_PIWEB_PORT       default 30142      AITI_BRIDGE_PORT   default 8777
#   AITI_CDP_PORT         default 9222 (Edge/Chrome CDP for the gui phase)
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

# ── port probing (PowerShell 7 prefers Get-NetTCPConnection; 5.1 falls back to netstat) ────────
function Get-PortPids([int]$P) {
  try {
    (Get-NetTCPConnection -LocalPort $P -State Listen -ErrorAction Stop).OwningProcess | Sort-Object -Unique
  } catch {
    netstat -ano | Select-String ":${P}\s.*LISTENING" | ForEach-Object { ($_ -split "\s+")[-1] } | Sort-Object -Unique
  }
}

function Test-PortUp([int]$P) { return @(Get-PortPids $P).Count -gt 0 }

# ── phase launchers (return a Process or $null) ─────────────────────────────────────────
function Start-Piweb {
  if (Test-PortUp $PiwebPort) { Write-Host "[piweb] ${PiwebPort} already running, skipping"; return $null }
  if (-not (Test-Path (Join-Path $AppDir ".next"))) { throw "[piweb] $AppDir has no .next build output — run next build in AITI_APP_DIR first" }
  $env:PI_WEB_EXTENSIONS_DIR = $ExtDir
  $env:PI_WEB_DATA_DIR = $DataDir
  $env:PI_CODING_AGENT_DIR = $AgentDir
  Write-Host "[piweb] next start :${PiwebPort}（ext=$ExtDir）"
  return Start-Process -FilePath "node" -ArgumentList "node_modules\next\dist\bin\next", "start", "-H", "0.0.0.0", "-p", $PiwebPort `
    -WorkingDirectory $AppDir -WindowStyle Hidden -PassThru
}

function Start-Bridge {
  if (Test-PortUp $BridgePort) { Write-Host "[bridge] ${BridgePort} already running, skipping"; return $null }
  $env:AITI_BRIDGE_DATA_DIR = Join-Path $DataDir "aiti-bridge"
  Write-Host "[bridge] aiti-bridge :${BridgePort}"
  return Start-Process -FilePath "node" -ArgumentList (Join-Path $BridgeDir "bin\aiti-bridge.mjs"), "--host", "0.0.0.0", "--port", $BridgePort `
    -WindowStyle Hidden -PassThru
}

function Start-Gui {
  # Windows-native = a real desktop (no Xvfb/VNC, §9.2); this phase only launches the CDP debug browser (Edge, falling back to Chrome)
  $browser = @()
  foreach ($c in @("${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
                   "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
                   "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
                   "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe")) {
    if (Test-Path $c) { $browser += $c; break }
  }
  if ($browser.Count -eq 0) { Write-Host "[gui] no Edge/Chrome found, skipping CDP"; return $null }
  Write-Host "[gui] CDP :${CdpPort}（$($browser[0])）"
  return Start-Process -FilePath $browser[0] -ArgumentList "--remote-debugging-port=$CdpPort", "--remote-allow-origins=*", "--no-first-run", "about:blank" -PassThru
}

function Start-Asr {
  # Extension-managed: aiti-ai-input ships start-stream.ps1 (idempotent) + port probing with auto-ensure — this only pre-launches it
  $asrDir = EnvOr "AITI_ASR_SERVER_DIR" ""
  if ([string]::IsNullOrWhiteSpace($asrDir)) {
    $asrDir = Join-Path $PSScriptRoot "..\pi-web-ext\aiti-ai-input\server"
  }
  $ctl = Join-Path $asrDir "start-stream.ps1"
  if (-not (Test-Path $ctl)) { Write-Host "[asr] $ctl not found — the extension auto-launches on first use, skipping"; return $null }
  Write-Host "[asr] start-stream.ps1 :8767"
  & powershell -NoProfile -ExecutionPolicy Bypass -File $ctl start
  return $null
}

function Start-Term {
  # Windows-native uses Windows Terminal / the pi CLI (§9.2: ttyd not required); a justget hint kept for installing ttyd
  Write-Host "[term] the native Windows terminal needs no ttyd; for a web terminal: just get ttyd, then run ttyd --port 7681 bash"
  return $null
}

# ── -Status / -Install / -Remove ──────────────────────────────────────────────
if ($Status) {
  foreach ($pair in @(@("piweb", $PiwebPort), @("bridge", $BridgePort), @("cdp", $CdpPort), @("asr", 8767))) {
    $up = Test-PortUp $pair[1]
    $pids = (Get-PortPids $pair[1]) -join " "
    Write-Host ("[{0}] :{1} {2}{3}" -f $pair[0], $pair[1], $(if ($up) { "running" } else { "not running" }), $(if ($up) { " (pid: $pids)" } else { "" }))
  }
  return
}

if ($Install -or $Remove) {
  $nssm = Get-Command nssm -ErrorAction SilentlyContinue
  if (-not $nssm) { throw "nssm not on PATH — install it first (choco install nssm / scoop install nssm)" }
  $self = (Resolve-Path $MyInvocation.MyCommand.Path).Path
  if ($Remove) {
    foreach ($svc in @("AitiWeb", "AitiBridge")) {
      if (Get-Service $svc -ErrorAction SilentlyContinue) { nssm stop $svc; nssm remove $svc confirm; Write-Host "[-] service $svc removed" }
      else { Write-Host "[.] service $svc does not exist" }
    }
    return
  }
  # Only piweb/bridge become services (background daemons); gui/asr/term are interactive — run in the foreground or at login
  if (-not (Test-Path (Join-Path $AppDir ".next"))) { throw "[piweb] $AppDir has no .next build output" }
  nssm install AitiWeb  powershell -NoProfile -ExecutionPolicy Bypass -File $self
  nssm set AitiWeb AppDirectory $AppDir
  nssm set AitiWeb AppEnvironmentExtra "AITI_PHASES=piweb"
  nssm install AitiBridge powershell -NoProfile -ExecutionPolicy Bypass -File $self
  nssm set AitiBridge AppEnvironmentExtra "AITI_PHASES=bridge"
  foreach ($svc in @("AitiWeb", "AitiBridge")) { nssm start $svc; Write-Host "[+] service $svc registered and started" }
  Write-Host "[i] gui/asr/term are interactive phases and are not registered as services — run start.ps1 in the foreground after login, or let the extensions auto-launch"
  return
}

# ── foreground start (equivalent of entrypoint.sh's wait: Ctrl+C stops everything) ─────────────────
$children = @()
try {
  if (Want "bridge") { $p = Start-Bridge;  if ($p) { $children += $p } }
  if (Want "piweb")  { $p = Start-Piweb;   if ($p) { $children += $p } }
  if (Want "gui")    { $p = Start-Gui;     if ($p) { $children += $p } }
  if (Want "asr")    { Start-Asr }
  if (Want "term")   { Start-Term }
  Write-Host "[start] phases=$($Phases -join ','); Ctrl+C stops everything"
  if ($children.Count -gt 0) { Wait-Process -Id ($children | ForEach-Object { $_.Id }) }
  else { Write-Host "[start] nothing new started (all ports already up)" }
} finally {
  foreach ($p in $children) {
    if ($p -and -not $p.HasExited) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue }
  }
}
