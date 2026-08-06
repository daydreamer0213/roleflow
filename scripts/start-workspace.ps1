[CmdletBinding()]
param(
  [int]$Port = 8787,
  [int]$CdpPort = 9222,
  [switch]$NoBrowser,
  [switch]$NoOpen
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$RunScript = Join-Path $ProjectRoot "run.ps1"
. (Join-Path $PSScriptRoot "lib\startup-identity.ps1")

function Test-Dashboard {
  param([int]$DashboardPort)
  try {
    $health = Invoke-RestMethod -Method Get -Uri "http://127.0.0.1:$DashboardPort/health" -TimeoutSec 2
  } catch {
    return $false
  }
  $listenerPid = Get-RoleFlowListenerPid -Port $DashboardPort
  if ($health.ok -ne $true -or
      $null -eq $listenerPid -or
      $null -eq $health.pid -or
      [int]$health.pid -ne [int]$listenerPid -or
      [string]::IsNullOrWhiteSpace([string]$health.projectRoot)) {
    throw "Dashboard identity check failed on port ${DashboardPort}: health identity or listener PID is missing or mismatched."
  }
  $expectedRoot = Resolve-RoleFlowNormalizedPath -Path $ProjectRoot
  $actualRoot = Resolve-RoleFlowNormalizedPath -Path ([string]$health.projectRoot)
  if (-not [string]::Equals($expectedRoot, $actualRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Dashboard identity check failed on port ${DashboardPort}: listener belongs to another project, not the current project."
  }
  return $true
}

& (Join-Path $PSScriptRoot "install.ps1") -CheckOnly
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

if (-not $NoBrowser) {
  & (Join-Path $PSScriptRoot "start-portable-edge.ps1") -Port $CdpPort
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

if (-not (Test-Dashboard -DashboardPort $Port)) {
  $arguments = @(
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", ('"{0}"' -f $RunScript),
    "dashboard",
    "--port", [string]$Port
  )
  Start-Process -FilePath "powershell.exe" -ArgumentList $arguments -WorkingDirectory $ProjectRoot -WindowStyle Hidden | Out-Null
  $deadline = (Get-Date).AddSeconds(15)
  do {
    Start-Sleep -Milliseconds 300
  } while (-not (Test-Dashboard -DashboardPort $Port) -and (Get-Date) -lt $deadline)
}

if (-not (Test-Dashboard -DashboardPort $Port)) {
  throw "Dashboard failed to start on http://127.0.0.1:$Port. Check whether the port is occupied."
}

$url = "http://127.0.0.1:$Port/"
Write-Host "RoleFlow is ready: $url"
Write-Host "浏览器：工作台与 BOSS 位于同一个项目专用 Edge 窗口（不需要 Edge Control 扩展）"
Write-Host "未登录时请先在 BOSS 标签页登录；设置好搜索条件后切回工作台。"

if (-not $NoOpen) {
  $workspaceArgs = @(
    "workspace-tabs",
    "--dashboard-url", $url,
    "--browser", "portable",
    "--cdp-port", [string]$CdpPort
  )
  & $RunScript @workspaceArgs
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
