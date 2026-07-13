$ErrorActionPreference = "Stop"
$ProjectRoot = $PSScriptRoot

function Resolve-Node {
  $Candidates = @()
  if ($env:ZHIPPING_NODE) {
    $Candidates += $env:ZHIPPING_NODE
  }
  $Candidates += (Join-Path $ProjectRoot ".runtime\node\node.exe")
  $Candidates += "D:\hermes\node\node.exe"

  foreach ($Candidate in $Candidates) {
    if ($Candidate -and (Test-Path -LiteralPath $Candidate)) {
      return $Candidate
    }
  }

  $Cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($null -ne $Cmd) {
    return $Cmd.Source
  }

  throw "Node.js 22+ not found. Run scripts\install.ps1 first."
}

$Node = Resolve-Node
$CliArgs = $args

if ($CliArgs.Count -gt 0 -and $CliArgs[0] -eq "check") {
  & $Node --disable-warning=ExperimentalWarning tests/self_check.js
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  & $Node --disable-warning=ExperimentalWarning tests/observability_smoke.js
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  & $Node --disable-warning=ExperimentalWarning tests/model_adapter_smoke.js
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  & $Node --disable-warning=ExperimentalWarning tests/model_settings_smoke.js
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  & $Node --disable-warning=ExperimentalWarning tests/model_settings_ui_smoke.js
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  & $Node --disable-warning=ExperimentalWarning tests/profile_quality_smoke.js
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  & $Node --disable-warning=ExperimentalWarning tests/screening_quality_smoke.js
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  & $Node --disable-warning=ExperimentalWarning tests/onboarding_smoke.js
  exit $LASTEXITCODE
}

if ($CliArgs.Count -gt 0 -and $CliArgs[0] -eq "flow-smoke") {
  & $Node --disable-warning=ExperimentalWarning tests/flow_smoke.js
  exit $LASTEXITCODE
}

if ($CliArgs.Count -gt 0 -and $CliArgs[0] -eq "ui-smoke") {
  & $Node --disable-warning=ExperimentalWarning tests/onboarding_smoke.js
  exit $LASTEXITCODE
}

& $Node --disable-warning=ExperimentalWarning src/cli.js @CliArgs
exit $LASTEXITCODE
