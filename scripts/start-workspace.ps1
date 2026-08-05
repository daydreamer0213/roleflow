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

function Test-Dashboard {
  param([int]$DashboardPort)
  try {
    $health = Invoke-RestMethod -Method Get -Uri "http://127.0.0.1:$DashboardPort/health" -TimeoutSec 2
    return $health.ok -eq $true
  } catch {
    return $false
  }
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
    "-File", $RunScript,
    "dashboard",
    "--port", [string]$Port
  )
  Start-Process -FilePath "powershell.exe" -ArgumentList $arguments -WindowStyle Hidden | Out-Null
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
Write-Host "浏览器：项目专用 Edge（不需要 Edge Control 扩展）"
Write-Host "下一步：在项目专用 Edge 登录 BOSS、打开岗位搜索结果页并设置筛选，然后在工作台点击“执行一轮”。"
if (-not $NoOpen) { Start-Process $url }
