[CmdletBinding()]
param(
  [int]$Port = 8787
)

$ErrorActionPreference = "Stop"
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $Utf8NoBom
$OutputEncoding = $Utf8NoBom
$ProjectRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot "lib\startup-identity.ps1")
if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
  throw "ROLEFLOW_LOCALAPPDATA_REQUIRED: 无法确定当前 Windows 用户的数据目录。"
}
if ($env:LOCALAPPDATA.StartsWith("\\", [System.StringComparison]::Ordinal)) {
  throw "ROLEFLOW_LOCALAPPDATA_UNC_REJECTED"
}
$LocalAppDataRoot = Resolve-RoleFlowNormalizedPath -Path $env:LOCALAPPDATA
[void](Assert-RoleFlowPathHasNoReparsePoint -Path $LocalAppDataRoot)
$DataRoot = Resolve-RoleFlowNormalizedPath -Path (Join-Path $LocalAppDataRoot "RoleFlow\Data")
$LogDir = Join-Path $DataRoot ".runtime\logs"
$LogPath = Join-Path $LogDir "launcher.log"
$StartScript = Join-Path $PSScriptRoot "start-workspace.ps1"

function Write-RoleFlowLauncherLog {
  param([Parameter(Mandatory = $true)][string]$Value)
  if (-not (Test-Path -LiteralPath $DataRoot -PathType Container)) { return }
  [void](Assert-RoleFlowPathHasNoReparsePoint -Path $DataRoot -IncludeDescendants)
  New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
  [void](Assert-RoleFlowPathHasNoReparsePoint -Path $LogDir -IncludeDescendants)
  Add-Content -LiteralPath $LogPath -Encoding utf8 -Value $Value
}

function Show-RoleFlowError {
  param([string]$Reason)
  Add-Type -AssemblyName System.Windows.Forms
  $DisplayReason = if ($Reason -match '^PORTABLE_EDGE_LISTENER_ENUMERATION_FAILED') {
    '无法检查 RoleFlow 专用 Edge 使用的本地端口。请重启电脑后重试；若仍失败，请提供下方诊断日志。'
  } else {
    $Reason
  }
  $Message = @"
RoleFlow 启动失败。

$DisplayReason

$(if ($Reason -match 'DASHBOARD_BROWSER_AUTHORITY_MISMATCH|PORTABLE_EDGE_(PORT_OCCUPIED_NOT_CDP|LISTENER_SNAPSHOT_MISMATCH)|Portable Edge identity check failed on port|RoleFlow browser profile is already in use') { '请关闭占用 RoleFlow 专用 Edge（推荐）配置目录或 9222 端口的窗口后重试。' } else { '请按提示处理后重试。' })
诊断日志：$LogPath
"@
  [void][System.Windows.Forms.MessageBox]::Show(
    $Message,
    "RoleFlow",
    [System.Windows.Forms.MessageBoxButtons]::OK,
    [System.Windows.Forms.MessageBoxIcon]::Error
  )
}

function Get-RoleFlowStartupMutexName {
  $Identity = "{0}|{1}" -f ([System.IO.Path]::GetFullPath($ProjectRoot).TrimEnd("\").ToLowerInvariant()), $Port
  $Hasher = [System.Security.Cryptography.SHA256]::Create()
  try {
    $Hash = $Hasher.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($Identity))
  } finally {
    $Hasher.Dispose()
  }
  $Suffix = (-join ($Hash | ForEach-Object { $_.ToString("x2") })).Substring(0, 24)
  return "Local\RoleFlow-Startup-$Suffix"
}

$StartupMutex = $null
$StartupMutexAcquired = $false
try {
  $StartupMutex = [System.Threading.Mutex]::new($false, (Get-RoleFlowStartupMutexName))
  try {
    $StartupMutexAcquired = $StartupMutex.WaitOne([TimeSpan]::FromSeconds(30))
  } catch [System.Threading.AbandonedMutexException] {
    $StartupMutexAcquired = $true
  }
  if (-not $StartupMutexAcquired) {
    throw "ROLEFLOW_STARTUP_ALREADY_IN_PROGRESS: 另一个 RoleFlow 启动过程仍在运行。"
  }
  $Output = & powershell.exe `
    -NoProfile `
    -NonInteractive `
    -WindowStyle Hidden `
    -ExecutionPolicy Bypass `
    -File $StartScript `
    -Port $Port 2>&1
  $ExitCode = $LASTEXITCODE
  $Text = ($Output | Out-String).Trim()
  Write-RoleFlowLauncherLog -Value (
    "{0:o} exit={1}`r`n{2}" -f (Get-Date), $ExitCode, $Text
  )
  if ($ExitCode -ne 0) {
    $Reason = ($Output | Select-Object -Last 1 | Out-String).Trim()
    if (-not $Reason) {
      $Reason = "启动组件返回错误代码 $ExitCode。"
    }
    Show-RoleFlowError -Reason $Reason
    exit $ExitCode
  }
} catch {
  try {
    Write-RoleFlowLauncherLog -Value (
      "{0:o} launcher_error={1}" -f (Get-Date), $_.Exception.Message
    )
  } catch {}
  Show-RoleFlowError -Reason $_.Exception.Message
  exit 1
} finally {
  if ($StartupMutexAcquired) {
    try { $StartupMutex.ReleaseMutex() } catch {}
  }
  if ($null -ne $StartupMutex) { $StartupMutex.Dispose() }
}
