[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateRange(1, 2147483647)]
  [int]$PlanId,
  [ValidateSet("daily", "broad")]
  [string]$ScanMode = "daily",
  [ValidateRange(10, 200)]
  [int]$MaxCards,
  [ValidateRange(1, 1000)]
  [int]$MaxDetailTotal,
  [ValidateSet("auto", "plugin", "bundled")]
  [string]$BridgeSource = "auto",
  [string]$EdgeControlRoot = ""
)

$ErrorActionPreference = "Stop"
if ($ScanMode -eq "daily" -and ($PSBoundParameters.ContainsKey("MaxCards") -or $PSBoundParameters.ContainsKey("MaxDetailTotal"))) {
  throw "Scan budget overrides are only supported in broad mode."
}

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
if ($PSBoundParameters.ContainsKey("MaxCards")) { $ScanArgs += @("--max-cards", [string]$MaxCards) }
if ($PSBoundParameters.ContainsKey("MaxDetailTotal")) { $ScanArgs += @("--max-detail-total", [string]$MaxDetailTotal) }

& $RunScript @ScanArgs
exit $LASTEXITCODE
