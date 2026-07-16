[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateRange(1, 2147483647)]
  [int]$PlanId,
  [ValidateSet("daily", "broad")]
  [string]$ScanMode = "daily",
  [int]$MaxCards = 0,
  [int]$MaxDetailTotal = 0,
  [ValidateSet("auto", "plugin", "bundled")]
  [string]$BridgeSource = "auto",
  [string]$EdgeControlRoot = ""
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot

$StartArgs = @{
  Source = $BridgeSource
}
if ($EdgeControlRoot) {
  $StartArgs.EdgeControlRoot = $EdgeControlRoot
}

& (Join-Path $PSScriptRoot "start-edge-control.ps1") @StartArgs
if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}

$RunScript = Join-Path $ProjectRoot "run.ps1"
$ScanArgs = @(
  "scan",
  "--site", "boss",
  "--browser", "edge",
  "--plan", [string]$PlanId,
  "--scan-mode", $ScanMode
)
if ($MaxCards -gt 0) { $ScanArgs += @("--max-cards", [string]$MaxCards) }
if ($MaxDetailTotal -gt 0) { $ScanArgs += @("--max-detail-total", [string]$MaxDetailTotal) }

& $RunScript @ScanArgs
exit $LASTEXITCODE
