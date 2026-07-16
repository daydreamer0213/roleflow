[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateRange(1, 2147483647)]
  [int]$PlanId,
  [ValidateSet("daily", "broad")]
  [string]$ScanMode = "daily",
  [int]$MaxCards = 0,
  [int]$MaxDetailTotal = 0,
  [int]$Port = 9222,
  [string]$ProfileDir = ".runtime\edge-profile",
  [string]$EdgePath = ""
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot

$StartArgs = @{
  Port = $Port
  ProfileDir = $ProfileDir
}
if ($EdgePath) {
  $StartArgs.EdgePath = $EdgePath
}

& (Join-Path $PSScriptRoot "start-portable-edge.ps1") @StartArgs
if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}

$RunScript = Join-Path $ProjectRoot "run.ps1"
$ScanArgs = @(
  "scan",
  "--site", "boss",
  "--browser", "portable",
  "--cdp-port", [string]$Port,
  "--scan-mode", $ScanMode
)

$ScanArgs += @("--plan", [string]$PlanId)
if ($MaxCards -gt 0) { $ScanArgs += @("--max-cards", [string]$MaxCards) }
if ($MaxDetailTotal -gt 0) { $ScanArgs += @("--max-detail-total", [string]$MaxDetailTotal) }

& $RunScript @ScanArgs
exit $LASTEXITCODE
