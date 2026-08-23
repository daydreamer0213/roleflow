[CmdletBinding()]
param(
  [int]$Port = 8787,
  [int]$CdpPort = 9222,
  [ValidateSet("edge", "portable")]
  [string]$BrowserMode = "portable",
  [string]$ProfileDir = "",
  [switch]$NoBrowser,
  [switch]$NoOpen
)

$ErrorActionPreference = "Stop"
if ($BrowserMode -eq "edge" -and ($PSBoundParameters.ContainsKey('CdpPort') -or $PSBoundParameters.ContainsKey('ProfileDir'))) {
  throw "WORKSPACE_EDGE_BROWSER_AUTHORITY_INVALID: Edge 高级模式不能携带专用 Edge 端口或配置目录。"
}
if ($BrowserMode -eq "portable" -and $CdpPort -ne 9222) {
  throw "WORKSPACE_PORTABLE_BROWSER_REQUIRED: portable 模式只支持 9222 端口。"
}
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$RunScript = Join-Path $ProjectRoot "run.ps1"
. (Join-Path $PSScriptRoot "lib\startup-identity.ps1")
$ProfilePath = if ($BrowserMode -eq "portable") {
  Resolve-RoleFlowBrowserProfilePath -ProjectRoot $ProjectRoot -ProfileDir $ProfileDir
} else {
  ""
}
$AuthorityCdpPort = $null
if ($BrowserMode -eq "portable") { $AuthorityCdpPort = $CdpPort }
$BrowserAuthority = @{
  browserMode = $BrowserMode
  cdpPort = $AuthorityCdpPort
  profilePath = $ProfilePath
}

function Test-Dashboard {
  param([int]$DashboardPort, [hashtable]$ExpectedBrowserAuthority)
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
  $actualAuthority = $health.browserAuthority
  $expectedProfilePath = if ([string]::IsNullOrWhiteSpace([string]$ExpectedBrowserAuthority.profilePath)) { "" } else { Resolve-RoleFlowNormalizedPath -Path ([string]$ExpectedBrowserAuthority.profilePath) }
  $actualProfilePath = if ([string]::IsNullOrWhiteSpace([string]$actualAuthority.profilePath)) { "" } else { Resolve-RoleFlowNormalizedPath -Path ([string]$actualAuthority.profilePath) }
  if ($null -eq $actualAuthority -or
      -not [string]::Equals([string]$actualAuthority.browserMode, [string]$ExpectedBrowserAuthority.browserMode, [System.StringComparison]::OrdinalIgnoreCase) -or
      [string]$actualAuthority.cdpPort -ne [string]$ExpectedBrowserAuthority.cdpPort -or
      -not [string]::Equals($expectedProfilePath, $actualProfilePath, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "DASHBOARD_BROWSER_AUTHORITY_MISMATCH: Dashboard 浏览器身份与本次工作区启动请求不一致。"
  }
  return $true
}

& (Join-Path $PSScriptRoot "install.ps1") -CheckOnly
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

if (-not $NoBrowser) {
  if ($BrowserMode -eq "edge") {
    & (Join-Path $PSScriptRoot "start-edge-control.ps1") -Source auto
  } else {
    & (Join-Path $PSScriptRoot "start-portable-edge.ps1") -Port $CdpPort -ProfileDir $ProfilePath
  }
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

if (-not (Test-Dashboard -DashboardPort $Port -ExpectedBrowserAuthority $BrowserAuthority)) {
  $arguments = @(
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", ('"{0}"' -f $RunScript),
    "dashboard",
    "--port", [string]$Port,
    "--browser", $BrowserMode
  )
  if ($BrowserMode -eq "portable") {
    $arguments += @("--cdp-port", [string]$CdpPort, "--browser-profile", ('"{0}"' -f $ProfilePath))
  }
  Start-Process -FilePath "powershell.exe" -ArgumentList $arguments -WorkingDirectory $ProjectRoot -WindowStyle Hidden | Out-Null
  $deadline = (Get-Date).AddSeconds(15)
  do {
    Start-Sleep -Milliseconds 300
  } while (-not (Test-Dashboard -DashboardPort $Port -ExpectedBrowserAuthority $BrowserAuthority) -and (Get-Date) -lt $deadline)
}

if (-not (Test-Dashboard -DashboardPort $Port -ExpectedBrowserAuthority $BrowserAuthority)) {
  throw "Dashboard failed to start on http://127.0.0.1:$Port. Check whether the port is occupied."
}

$url = "http://127.0.0.1:$Port/"
Write-Host "RoleFlow is ready: $url"
if ($BrowserMode -eq "edge") {
  Write-Host "浏览器：当前 Edge 高级模式，复用已登录的固定 BOSS 标签页"
} else {
  Write-Host "浏览器：项目专用 Edge（首次需要独立登录）"
}
Write-Host "未登录时请先在 BOSS 标签页登录；设置好搜索条件后切回工作台。"

if (-not $NoOpen) {
  $workspaceArgs = @(
    "workspace-tabs",
    "--dashboard-url", $url,
    "--browser", $BrowserMode
  )
  if ($BrowserMode -eq "portable") {
    $workspaceArgs += @("--cdp-port", [string]$CdpPort, "--browser-profile", $ProfilePath)
  }
  & $RunScript @workspaceArgs
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
