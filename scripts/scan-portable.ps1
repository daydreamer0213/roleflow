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
  [int]$Port = 9222,
  [string]$ProfileDir = ".runtime\edge-profile",
  [string]$EdgePath = ""
)

$ErrorActionPreference = "Stop"
if ($ScanMode -eq "daily" -and ($PSBoundParameters.ContainsKey("MaxCards") -or $PSBoundParameters.ContainsKey("MaxDetailTotal"))) {
  throw "Scan budget overrides are only supported in broad mode."
}

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
if ($PSBoundParameters.ContainsKey("MaxCards")) { $ScanArgs += @("--max-cards", [string]$MaxCards) }
if ($PSBoundParameters.ContainsKey("MaxDetailTotal")) { $ScanArgs += @("--max-detail-total", [string]$MaxDetailTotal) }

& $RunScript @ScanArgs
exit $LASTEXITCODE
