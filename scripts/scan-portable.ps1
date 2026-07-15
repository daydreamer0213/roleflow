[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateRange(1, 2147483647)]
  [int]$PlanId,
  [int]$MaxCards = 60,
  [int]$DetailLimit = 5,
  [int]$MaxDetailTotal = 150,
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
  "--max-cards", [string]$MaxCards,
  "--detail-limit", [string]$DetailLimit,
  "--max-detail-total", [string]$MaxDetailTotal
)

$ScanArgs += @("--plan", [string]$PlanId)

& $RunScript @ScanArgs
exit $LASTEXITCODE
