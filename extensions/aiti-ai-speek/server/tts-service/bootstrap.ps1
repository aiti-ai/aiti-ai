# =============================================================================
# aiti-ai-speek · local TTS service bootstrap (idempotent, zero manual steps) - Windows
#
# Windows counterpart of bootstrap.sh: same phases, same prepare.json protocol, same
# exit codes. Pure ASCII so Windows PowerShell 5.1 parses it correctly without a BOM.
# Called by start-tts.ps1 before the service starts; can also be run alone for
# troubleshooting:
#   powershell -NoProfile -ExecutionPolicy Bypass -File bootstrap.ps1 -Provider hojo-40m
#
# Phases written to $AITI_TTS_HOME/prepare.json for the settings panel:
#   venv (0-15) -> deps (15-40) -> download (40-88) -> load (handled by tts_server.py)
#
# Environment:
#   AITI_TTS_HOME          data root (default ~\.pi\web\data\aiti-ai-speek\cache\tts-service)
#   AITI_TTS_PROVIDER      default provider (hojo-40m)
#   AITI_TTS_PIP_INDEX     optional pip index-url (mirror)
#   AITI_TTS_TN=0          skip WeTextProcessing text normalization install
#   HF_ENDPOINT / HTTPS_PROXY / HTTP_PROXY  honoured for model download (bootstrap_models.py)
# =============================================================================
$ErrorActionPreference = "Continue"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Provider = "hojo-40m"
if ($env:AITI_TTS_PROVIDER) { $Provider = $env:AITI_TTS_PROVIDER }
$HfEndpointArg = ""
$Source = "hf"
$ForceDeps = $false
# Default = attempt the optional WeTextProcessing install; AITI_TTS_TN=0 (or -NoTn) skips it.
$SkipTn = ($env:AITI_TTS_TN -eq "0")

# --- argument parsing (manual: unknown args must exit 2, mirroring bootstrap.sh) ------------
$i = 0
while ($i -lt $args.Count) {
  $a = "$($args[$i])"
  if ($a -eq "--provider" -or $a -eq "-Provider")            { $Provider = "$($args[$i+1])"; $i += 2 }
  elseif ($a -eq "--hf-endpoint" -or $a -eq "-HfEndpoint")   { $HfEndpointArg = "$($args[$i+1])"; $i += 2 }
  elseif ($a -eq "--source" -or $a -eq "-Source")            { $Source = "$($args[$i+1])"; $i += 2 }
  elseif ($a -eq "--force-deps" -or $a -eq "-ForceDeps")     { $ForceDeps = $true; $i += 1 }
  elseif ($a -eq "--no-tn" -or $a -eq "-NoTn")               { $SkipTn = $true; $i += 1 }
  else { Write-Host "[bootstrap] unknown arg: $a"; exit 2 }
}

function Write-Log([string]$msg) { Write-Host "[bootstrap] $msg" }

# --- provider family (venv selector) --------------------------------------------------------
$Family = ""
if ($Provider -in @("hojo-40m", "hojo-80m", "stub")) { $Family = "hojo" }
elseif ($Provider -in @("qwen3-0.6b", "qwen3-1.7b")) { $Family = "qwen3" }
else {
  Write-Log "unknown provider '$Provider' (hojo-40m|hojo-80m|qwen3-0.6b|qwen3-1.7b|stub)"
  exit 2
}

$Req = Join-Path $ScriptDir "requirements-$Family.txt"
if ($Provider -eq "hojo-80m") { $Req = Join-Path $ScriptDir "requirements-hojo80.txt" }

# --- paths / progress protocol ---------------------------------------------------------------
$HomeDir = if ($env:AITI_TTS_HOME) { $env:AITI_TTS_HOME } else { Join-Path $HOME ".pi\web\data\aiti-ai-speek\cache\tts-service" }
$Prepare = Join-Path $HomeDir "prepare.json"
$LogDir = Join-Path $HomeDir "logs"
New-Item -ItemType Directory -Force -Path $HomeDir, $LogDir | Out-Null

function Write-Utf8NoBom([string]$Path, [string]$Text) {
  # PS 5.1 Set-Content -Encoding utf8 writes a BOM that breaks JSON.parse consumers.
  [IO.File]::WriteAllText($Path, $Text, (New-Object Text.UTF8Encoding $false))
}

# Atomic prepare.json writer (tmp + move), tolerated to fail (progress must never break the run).
function Write-Prepare([string]$phase, $percent, [string]$message) {
  try {
    $obj = [ordered]@{
      phase = $phase; percent = $percent; message = $message
      at = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
    }
    Write-Utf8NoBom "$Prepare.tmp" ($obj | ConvertTo-Json -Compress)
    Move-Item -Force "$Prepare.tmp" $Prepare
  } catch {}
}

# --- uv (self-contained toolchain bootstrap) --------------------------------------------------
# uv-managed interpreters live under the service home so the environment is self-contained.
if (-not $env:UV_PYTHON_INSTALL_DIR) { $env:UV_PYTHON_INSTALL_DIR = Join-Path $HomeDir "uv-python" }
$script:UvExe = ""

function Install-Uv {
  # Resolves $script:UvExe: existing PATH uv, a previously installed <home>/bin/uv.exe,
  # or the official installer (astral.sh, ~15MB). Best effort; returns $true when resolved.
  $homeUv = Join-Path $HomeDir "bin\uv.exe"
  if (Test-Path $homeUv) { $script:UvExe = $homeUv; return $true }
  $cmd = Get-Command uv -ErrorAction SilentlyContinue
  if ($cmd) { $script:UvExe = $cmd.Source; return $true }
  # Ensure TLS 1.2 is available to Windows PowerShell 5.1 (older defaults lack it).
  try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor 3072 } catch {}
  Write-Prepare "venv" 7 "installing uv (Python toolchain bootstrap)"
  New-Item -ItemType Directory -Force -Path (Join-Path $HomeDir "bin") | Out-Null
  try {
    $env:UV_INSTALL_DIR = Join-Path $HomeDir "bin"
    $installer = Invoke-RestMethod -Uri "https://astral.sh/uv/install.ps1" -UseBasicParsing -TimeoutSec 60
    Invoke-Expression $installer
  } catch { Write-Log "uv installer download failed: $($_.Exception.Message.Split("`n")[0])" }
  if (Test-Path $homeUv) { $script:UvExe = $homeUv; return $true }
  # Some installer versions ignore UV_INSTALL_DIR; sweep the known fallback spots and
  # copy into <home>/bin to keep the environment self-contained.
  foreach ($cand in @((Join-Path $env:USERPROFILE ".local\bin\uv.exe"), (Join-Path $env:USERPROFILE ".cargo\bin\uv.exe"))) {
    if (Test-Path $cand) { Copy-Item $cand $homeUv -Force; $script:UvExe = $homeUv; return $true }
  }
  Write-Log "uv installer failed (network?)"
  return $false
}

# --- venv (Python 3.10-3.12; Hojo rejects 3.13) ----------------------------------------------
$Venv = Join-Path $HomeDir "venv-$Family"
$Py = Join-Path $Venv "Scripts\python.exe"
$script:Py = $Py

function Invoke-Quiet([scriptblock]$sb) {
  # Run a native command with stderr silenced (PS 5.1 wraps redirected stderr into
  # ErrorRecords when ErrorActionPreference is Stop; switch it off around probes).
  $prev = $ErrorActionPreference; $ErrorActionPreference = "SilentlyContinue"
  try { & $sb 2>$null | Out-Null; return $LASTEXITCODE } finally { $ErrorActionPreference = $prev }
}

function Test-SystemPython([string]$spec) {
  # $spec is like "py -3.12" or an interpreter path; the venv module must actually work.
  $parts = $spec.Split(" ")
  $exe = Get-Command $parts[0] -ErrorAction SilentlyContinue
  if (-not $exe) { return $false }
  $probe = $parts[1..($parts.Length - 1)] + @("-c", "import venv, ensurepip")
  return ((Invoke-Quiet { & $exe @probe }) -eq 0)
}

if (!(Test-Path $Py)) {
  Write-Prepare "venv" 5 "creating Python 3.12 environment"
  Install-Uv | Out-Null
  $created = $false
  if ($script:UvExe) {
    if ((Invoke-Quiet { & $script:UvExe python find 3.12 }) -eq 0) { $created = $true }
    else {
      Write-Log "installing CPython 3.12 via uv (one time, ~30MB)..."
      Invoke-Quiet { & $script:UvExe python install 3.12 } | Out-Null
      if ((Invoke-Quiet { & $script:UvExe python find 3.12 }) -eq 0) { $created = $true }
    }
    if ($created) {
      Invoke-Quiet { & $script:UvExe venv --seed --python 3.12 $Venv } | Out-Null
      if (!(Test-Path $Py)) { $created = $false }
    }
  }
  if (-not $created) {
    # System interpreters are only acceptable when the venv module actually works.
    $specs = @()
    if (Get-Command py -ErrorAction SilentlyContinue) { $specs += @("py -3.12", "py -3.11", "py -3.10") }
    $specs += @("python3.12", "python")
    foreach ($spec in $specs) {
      if (Test-SystemPython $spec) {
        $parts = $spec.Split(" ")
        $exe = (Get-Command $parts[0]).Source
        $probe = $parts[1..($parts.Length - 1)] + @("-m", "venv", $Venv)
        Invoke-Quiet { & $exe @probe } | Out-Null
        if (Test-Path $Py) { $created = $true; break }
      }
    }
  }
  if (-not $created) {
    Write-Log "no usable Python 3.10-3.12 and uv could not be installed automatically."
    Write-Log "  Options: install uv (https://docs.astral.sh/uv/) or Python 3.12, then retry."
    Write-Prepare "failed" 100 "python 3.12 not available (no uv, no python3.10-3.12 with venv)"
    exit 3
  }
  Write-Log "venv ready: $Venv"
}
Write-Prepare "venv" 15 "python env ready"

# --- dependencies (fingerprinted, skipped when unchanged) -------------------------------------
if (!(Test-Path $Req)) { Write-Log "missing requirements: $Req"; exit 3 }
$PipIndex = "$env:AITI_TTS_PIP_INDEX"
$sha = [System.Security.Cryptography.SHA256]::Create()
try {
  # Same fingerprint recipe as bootstrap.sh: requirements text + family line + pip index line.
  $hashSrc = ([IO.File]::ReadAllText($Req)) + "family=$Family`n" + "pip=$PipIndex`n"
  $DepsHash = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($hashSrc))).Replace("-", "").ToLower()
} finally { $sha.Dispose() }
$Stamp = Join-Path $Venv ".deps-sha256"
$stampHash = ""
if (Test-Path $Stamp) { $stampHash = ([IO.File]::ReadAllText($Stamp)).Trim() }

function Invoke-PipInstall([string[]]$pipArgs) {
  # Prefer the venv pip; fall back to `uv pip install --python` for seed-less uv venvs.
  if ((Invoke-Quiet { & $script:Py -m pip --version }) -eq 0) {
    & $script:Py -m pip @pipArgs
    return $LASTEXITCODE
  }
  if ($script:UvExe) {
    & $script:UvExe pip install --python $script:Py @pipArgs
    return $LASTEXITCODE
  }
  return 1
}

if ($ForceDeps -or !(Test-Path $Stamp) -or $stampHash -ne $DepsHash) {
  Write-Prepare "deps" 18 "installing python deps (first run may take a few minutes)"
  Invoke-Quiet { & $script:Py -m pip install --upgrade pip -q } | Out-Null
  $pipExtra = @()
  if ($PipIndex) { $pipExtra += @("--index-url", $PipIndex) }
  $ok = $false
  for ($attempt = 1; $attempt -le 3; $attempt++) {
    if ((Invoke-PipInstall (@("install", "-q", "-r", $Req) + $pipExtra)) -eq 0) { $ok = $true; break }
    Write-Log "pip install failed (attempt $attempt), retrying..."
    Start-Sleep -Seconds ($attempt * 3)
  }
  if (-not $ok) { Write-Prepare "failed" 100 "pip install failed (see logs)"; exit 4 }
  Write-Utf8NoBom $Stamp $DepsHash
  Write-Log "deps installed (hash $($DepsHash.Substring(0, 12)))"
} else {
  Write-Log "deps unchanged (hash $($DepsHash.Substring(0, 12)))"
}
Write-Prepare "deps" 40 "python deps ready"

# --- optional text normalization (Hojo only; failure degrades to --no-tn) ----------------------
# Windows note: pynini/WeTextProcessing usually has no prebuilt wheel, so this is expected to
# degrade to tn-disabled there; the service then runs without text normalization.
if ($Family -eq "hojo" -and -not $SkipTn) {
  if ((Invoke-Quiet { & $script:Py -c "import tn" }) -ne 0) {
    Write-Prepare "deps" 44 "installing text normalization (optional)"
    $pipExtra = @()
    if ($PipIndex) { $pipExtra += @("--index-url", $PipIndex) }
    if ((Invoke-PipInstall (@("install", "-q", "WeTextProcessing>=1.0.4.1") + $pipExtra)) -eq 0) {
      Write-Log "WeTextProcessing installed"
    } else {
      Write-Log "WeTextProcessing install failed -> synthesis runs without text normalization"
      Write-Utf8NoBom (Join-Path $HomeDir "tn-disabled") "no-tn"
    }
  }
}

# --- model download (source auto-resolved, resumable, verified) --------------------------------
Write-Prepare "download" 40 "preparing model files"
$ModelsPy = Join-Path $ScriptDir "bootstrap_models.py"
$modelArgs = @($ModelsPy, "--provider", $Provider, "--home", $HomeDir, "--prepare-json", $Prepare, "--source", $Source, "--print-dir")
if ($HfEndpointArg) { $modelArgs += @("--hf-endpoint", $HfEndpointArg) }  # PS 5.1 drops empty native args
$out = @(& $script:Py @modelArgs)
$ModelDir = [string]$out[$out.Count - 1]

# --- record the resolved environment for the extension -----------------------------------------
$TnEnabled = -not (Test-Path (Join-Path $HomeDir "tn-disabled"))
$ready = [ordered]@{
  provider = $Provider; family = $Family; venv = $Venv; modelDir = $ModelDir
  depsHash = $DepsHash; tn = $TnEnabled; at = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
}
Write-Utf8NoBom (Join-Path $HomeDir "ready.json") ($ready | ConvertTo-Json -Compress)
Write-Prepare "download" 88 "model ready"
Write-Log "bootstrap complete: provider=$Provider family=$Family model=$ModelDir"
