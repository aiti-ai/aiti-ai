# =============================================================================
# test-bootstrap.ps1 - Windows test harness for bootstrap.ps1
#
# Run on a real Windows host (expected: no system Python <= 3.12, no uv = the
# zero-step environment bootstrap.ps1 is designed to rescue):
#   powershell -NoProfile -ExecutionPolicy Bypass -File test-bootstrap.ps1 [-Phase all|fast|flow|reentry]
#
# Phases:
#   fast    T1 syntax parse, T2 unknown provider -> exit 2 + prepare.json failed
#   flow    T3 full stub flow on a fresh home (uv self-bootstrap -> CPython 3.12 ->
#           fingerprinted deps -> stub model resolution -> ready.json), plus dependency
#           import checks inside the created venv
#   reentry T4 idempotent rerun (deps not reinstalled), T5 -ForceDeps reinstalls,
#           T6 AITI_TTS_TN=0 skips the WeTextProcessing attempt
# =============================================================================
param(
  [string]$SvcDir = "D:\workspace\pi-web\extensions\aiti-ai-speek\server\tts-service",
  [string]$TestRoot = "D:\workspace\tts-bootstrap-test",
  [string]$Phase = "all"
)

$fail = 0
function Assert([bool]$cond, [string]$name) {
  if ($cond) { Write-Host "PASS  $name" }
  else { Write-Host "FAIL  $name"; $script:fail++ }
}
function Run-Bootstrap([string[]]$extra, [string]$svcHome) {
  # NB: do not name this "$home" - that collides with the read-only $HOME automatic variable.
  $env:AITI_TTS_HOME = $svcHome
  $out = @(powershell -NoProfile -ExecutionPolicy Bypass -File $Script:BootScript @extra)
  return ,@($out)
}
function Fresh-Home([string]$name) {
  $h = Join-Path $TestRoot $name
  Remove-Item -Recurse -Force $h -ErrorAction SilentlyContinue
  return $h
}
function Read-PrepareJson([string]$svcHome) {
  return (Get-Content (Join-Path $svcHome "prepare.json") -Raw | ConvertFrom-Json)
}

$script:BootScript = Join-Path $SvcDir "bootstrap.ps1"
New-Item -ItemType Directory -Force -Path $TestRoot | Out-Null
Remove-Item Env:\AITI_TTS_TN -ErrorAction SilentlyContinue

if ($Phase -in @("all", "fast")) {
  # T1: the script must parse cleanly under the host PowerShell (5.1).
  $errs = $null
  [System.Management.Automation.Language.Parser]::ParseFile($script:BootScript, [ref]$null, [ref]$errs) | Out-Null
  Assert (@($errs).Count -eq 0) "T1 syntax parse (errors: $(@($errs).Count))"

  # T2: unknown provider -> exit 2 + prepare.json failed phase.
  $h2 = Fresh-Home "home-t2"
  $null = Run-Bootstrap @("-Provider", "nope") $h2
  Assert ($LASTEXITCODE -eq 2) "T2 unknown provider exit code (got $LASTEXITCODE)"
  # Provider validation happens before any directory is created, so no prepare.json yet
  # (same as bootstrap.sh; the failed/100 phase is only for venv/deps failures).
  Assert (-not (Test-Path (Join-Path $h2 "prepare.json"))) "T2 no prepare.json on provider validation failure"

  # T2b: unknown argument -> exit 2.
  $h2b = Fresh-Home "home-t2b"
  $null = Run-Bootstrap @("--bogus") $h2b
  Assert ($LASTEXITCODE -eq 2) "T2b unknown arg exit code (got $LASTEXITCODE)"
}

if ($Phase -in @("all", "flow")) {
  # T3: full stub flow on a fresh home, zero-step host (no python/uv preinstalled).
  $h3 = Fresh-Home "home-t3"
  $t3 = Run-Bootstrap @("-Provider", "stub") $h3
  Assert ($LASTEXITCODE -eq 0) "T3 stub bootstrap exit 0 (got $LASTEXITCODE)"
  $t3txt = ($t3 | Out-String)
  $py = Join-Path $h3 "venv-hojo\Scripts\python.exe"
  Assert (Test-Path $py) "T3 venv python exists (Scripts\python.exe)"
  Assert (Test-Path (Join-Path $h3 "venv-hojo\.deps-sha256")) "T3 deps fingerprint stamp written"
  Assert (Test-Path (Join-Path $h3 "uv-python")) "T3 uv-managed CPython stored under the service home"
  Assert ($t3txt -match "bootstrap complete: provider=stub") "T3 completion log line"
  $ready = Get-Content (Join-Path $h3 "ready.json") -Raw | ConvertFrom-Json
  Assert ($ready.provider -eq "stub" -and $ready.family -eq "hojo") "T3 ready.json provider/family"
  Assert ($ready.modelDir -eq "") "T3 ready.json modelDir empty (stub downloads nothing)"
  Assert ($ready.depsHash.Length -eq 64) "T3 ready.json depsHash is sha256"
  Assert ($ready.tn -eq (-not (Test-Path (Join-Path $h3 "tn-disabled")))) "T3 ready.json tn flag consistent with tn-disabled"
  $pj = Read-PrepareJson $h3
  Assert ($pj.phase -eq "download" -and $pj.percent -eq 88) "T3 prepare.json final download/88 (got $($pj.phase)/$($pj.percent))"

  # T3b: the created venv must actually hold the hojo dependency set.
  $probe = "import fastapi, uvicorn, pydantic, numpy, soundfile, tokenizers, onnx, onnxruntime, huggingface_hub; import sys; print('deps-ok', sys.version.split()[0], 'numpy', numpy.__version__, 'ort', onnxruntime.__version__)"
  & $py -c $probe | Tee-Object -Variable depout
  Assert ($LASTEXITCODE -eq 0) "T3b hojo deps importable in venv"
  Assert (($depout | Out-String) -match "numpy 1\.") "T3b numpy stays on 1.x (<2 pin)"

  $script:h3 = $h3
}

if ($Phase -in @("all", "reentry")) {
  $h3 = $script:h3
  if (-not $h3) { $h3 = Join-Path $TestRoot "home-t3" }
  $stamp = Join-Path $h3 "venv-hojo\.deps-sha256"
  $before = (Get-Item $stamp).LastWriteTimeUtc

  # T4: second run on the same home -> deps fingerprint hit, nothing reinstalled.
  $t4 = Run-Bootstrap @("-Provider", "stub") $h3
  Assert ($LASTEXITCODE -eq 0) "T4 idempotent rerun exit 0"
  Assert ((($t4 | Out-String)) -match "deps unchanged") "T4 'deps unchanged' reported"
  Assert ((Get-Item $stamp).LastWriteTimeUtc -eq $before) "T4 stamp untouched (deps skipped)"

  # T5: -ForceDeps must reinstall and refresh the stamp.
  $t5 = Run-Bootstrap @("-Provider", "stub", "-ForceDeps") $h3
  Assert ($LASTEXITCODE -eq 0) "T5 force-deps exit 0"
  Assert ((($t5 | Out-String)) -match "deps installed") "T5 'deps installed' reported"

  # T6: AITI_TTS_TN=0 must skip the WeTextProcessing attempt entirely.
  Remove-Item (Join-Path $h3 "tn-disabled") -ErrorAction SilentlyContinue
  $env:AITI_TTS_TN = "0"
  $t6 = Run-Bootstrap @("-Provider", "stub") $h3
  Remove-Item Env:\AITI_TTS_TN -ErrorAction SilentlyContinue
  Assert ($LASTEXITCODE -eq 0) "T6 TN=0 rerun exit 0"
  Assert (-not (Test-Path (Join-Path $h3 "tn-disabled"))) "T6 AITI_TTS_TN=0 skips TN install (no tn-disabled)"
  Assert (-not ((($t6 | Out-String)) -match "text normalization")) "T6 no TN phase messages"
}

Write-Host ""
if ($fail -eq 0) { Write-Host "ALL PASS" } else { Write-Host "$fail FAILURES"; exit 1 }
