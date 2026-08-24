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
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $Utf8NoBom
$OutputEncoding = $Utf8NoBom
if ($BrowserMode -eq "edge" -and ($PSBoundParameters.ContainsKey('CdpPort') -or $PSBoundParameters.ContainsKey('ProfileDir'))) {
  throw "WORKSPACE_EDGE_BROWSER_AUTHORITY_INVALID: 使用当前 Edge（高级，需要浏览器连接组件）不能携带 RoleFlow 专用 Edge（推荐）的端口或配置目录。"
}
if ($BrowserMode -eq "portable" -and $CdpPort -ne 9222) {
  throw "WORKSPACE_PORTABLE_BROWSER_REQUIRED: portable 模式只支持 9222 端口。"
}
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$RunScript = Join-Path $ProjectRoot "run.ps1"
. (Join-Path $PSScriptRoot "lib\startup-identity.ps1")
if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
  throw "ROLEFLOW_LOCALAPPDATA_REQUIRED: 无法确定当前 Windows 用户的数据目录。"
}
$DataRoot = Resolve-RoleFlowNormalizedPath -Path (Join-Path $env:LOCALAPPDATA "RoleFlow\Data")
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

function Get-DashboardRuntimeStatus {
  param([int]$DashboardPort)
  try {
    return Invoke-RestMethod `
      -Method Get `
      -Uri "http://127.0.0.1:$DashboardPort/api/runtime-status" `
      -TimeoutSec 3
  } catch {
    throw "DASHBOARD_RUNTIME_STATUS_UNAVAILABLE: 无法读取 RoleFlow 的浏览器启动状态。$($_.Exception.Message)"
  }
}

function Confirm-DashboardBrowserRuntime {
  param(
    [int]$DashboardPort,
    [switch]$AllowRecovery
  )
  if ($BrowserMode -ne "portable" -or $NoBrowser) { return }

  $Runtime = Get-DashboardRuntimeStatus -DashboardPort $DashboardPort
  $Deadline = (Get-Date).AddSeconds(20)
  while ($Runtime.browser.status -in @("unknown", "starting") -and (Get-Date) -lt $Deadline) {
    Start-Sleep -Milliseconds 300
    $Runtime = Get-DashboardRuntimeStatus -DashboardPort $DashboardPort
  }
  if ($Runtime.browser.ready -eq $true) { return }

  if (-not $AllowRecovery) {
    throw "DASHBOARD_BROWSER_START_FAILED: $([string]$Runtime.browser.message)"
  }
  if ([string]$Runtime.browser.status -eq "conflict") {
    throw "DASHBOARD_BROWSER_CONFLICT: $([string]$Runtime.browser.message)"
  }

  $RecoveryError = $null
  try {
    $Recovered = Invoke-RestMethod `
      -Method Post `
      -Uri "http://127.0.0.1:$DashboardPort/api/runtime/browser/recover" `
      -ContentType "application/json" `
      -Body "{}" `
      -TimeoutSec 45
    if ($Recovered.browser.ready -eq $true) { return }
  } catch {
    $RecoveryError = $_.Exception.Message
  }

  # Workspace preparation may fail after Edge has already recovered. In that case
  # startup still succeeds and the Dashboard can explain the remaining action.
  $Runtime = Get-DashboardRuntimeStatus -DashboardPort $DashboardPort
  if ($Runtime.browser.ready -eq $true) { return }
  $Detail = if ($RecoveryError) { $RecoveryError } else { [string]$Runtime.browser.message }
  throw "DASHBOARD_BROWSER_RECOVERY_FAILED: $Detail"
}

& (Join-Path $PSScriptRoot "install.ps1") -CheckOnly
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$DashboardWasRunning = Test-Dashboard -DashboardPort $Port -ExpectedBrowserAuthority $BrowserAuthority
if (-not $DashboardWasRunning) {
  $DataPreparation = & (Join-Path $PSScriptRoot "prepare-user-data.ps1") `
    -InstallRoot $ProjectRoot `
    -DataRoot $DataRoot
  Write-Verbose "RoleFlow user data: $DataPreparation"
  $arguments = @(
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", ('"{0}"' -f $RunScript),
    "dashboard",
    "--port", [string]$Port,
    "--browser", $BrowserMode,
    "--data-root", ('"{0}"' -f $DataRoot)
  )
  if ($BrowserMode -eq "portable") {
    $arguments += @("--cdp-port", [string]$CdpPort, "--browser-profile", ('"{0}"' -f $ProfilePath))
  }
  if ($NoBrowser) { $arguments += "--no-browser" }
  if ($NoOpen) { $arguments += "--no-startup-guidance" }
  Start-Process -FilePath "powershell.exe" -ArgumentList $arguments -WorkingDirectory $ProjectRoot -WindowStyle Hidden | Out-Null
  $deadline = (Get-Date).AddSeconds(15)
  do {
    Start-Sleep -Milliseconds 300
  } while (-not (Test-Dashboard -DashboardPort $Port -ExpectedBrowserAuthority $BrowserAuthority) -and (Get-Date) -lt $deadline)
}

if (-not (Test-Dashboard -DashboardPort $Port -ExpectedBrowserAuthority $BrowserAuthority)) {
  throw "Dashboard failed to start on http://127.0.0.1:$Port. Check whether the port is occupied."
}

Confirm-DashboardBrowserRuntime `
  -DashboardPort $Port `
  -AllowRecovery:$DashboardWasRunning

$url = "http://127.0.0.1:$Port/"
Write-Host "RoleFlow is ready: $url"
if ($BrowserMode -eq "edge") {
  Write-Host "浏览器：使用当前 Edge（高级，需要浏览器连接组件）"
} else {
  Write-Host "浏览器：RoleFlow 专用 Edge（推荐）"
}
Write-Host "未登录时请先在 BOSS 标签页登录；设置好搜索条件后切回工作台。"
