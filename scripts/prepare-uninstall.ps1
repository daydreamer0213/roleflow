[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$InstallRoot,
  [int]$Port = 8787,
  [switch]$PromptDeleteUserData,
  [switch]$DeleteUserData,
  [switch]$ConfirmDelete,
  [switch]$PromptDeleteBrowserProfile,
  [switch]$DeleteBrowserProfile,
  [switch]$ConfirmDeleteBrowserProfile,
  [switch]$SkipDeletePrompt,
  [switch]$SkipDashboardStop
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "lib\startup-identity.ps1")
$InstallRoot = [System.IO.Path]::GetFullPath($InstallRoot).TrimEnd("\")
if ([string]::IsNullOrWhiteSpace($InstallRoot) -or
    $InstallRoot -eq [System.IO.Path]::GetPathRoot($InstallRoot)) {
  throw "Refusing an unsafe install root."
}
[void](Wait-RoleFlowStartupMutex -ProjectRoot $InstallRoot -Port $Port)

function Stop-InstalledDashboard {
  try {
    $Health = Invoke-RestMethod -Method Get -Uri "http://127.0.0.1:8787/health" -TimeoutSec 2
  } catch {
    return
  }
  if ($Health.ok -ne $true -or
      $null -eq $Health.pid -or
      [string]::IsNullOrWhiteSpace([string]$Health.projectRoot)) {
    return
  }
  $ActualRoot = [System.IO.Path]::GetFullPath([string]$Health.projectRoot).TrimEnd("\")
  if (-not [string]::Equals(
    $ActualRoot,
    $InstallRoot,
    [System.StringComparison]::OrdinalIgnoreCase
  )) {
    return
  }

  $Listener = @(
    Get-NetTCPConnection -State Listen -LocalPort 8787 -ErrorAction Stop |
      Where-Object { $_.LocalAddress -eq "127.0.0.1" } |
      Select-Object -ExpandProperty OwningProcess -Unique
  )
  if ($Listener.Count -ne 1 -or [int]$Listener[0] -ne [int]$Health.pid) {
    throw "Dashboard listener identity is ambiguous; it was not stopped."
  }

  Stop-Process -Id ([int]$Health.pid) -Force
  try {
    Wait-Process -Id ([int]$Health.pid) -Timeout 10 -ErrorAction Stop
  } catch {
    if (Get-Process -Id ([int]$Health.pid) -ErrorAction SilentlyContinue) {
      throw "RoleFlow dashboard did not stop in time."
    }
  }
}

function Get-RoleFlowLocalAppDataRoot {
  if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
    throw "ROLEFLOW_LOCALAPPDATA_REQUIRED"
  }
  if ($env:LOCALAPPDATA.StartsWith("\\", [System.StringComparison]::Ordinal)) {
    throw "ROLEFLOW_LOCALAPPDATA_UNC_REJECTED"
  }
  if (-not [System.IO.Path]::IsPathRooted($env:LOCALAPPDATA)) {
    throw "ROLEFLOW_LOCALAPPDATA_ABSOLUTE_REQUIRED"
  }
  $LocalAppDataRoot = Resolve-RoleFlowNormalizedPath -Path $env:LOCALAPPDATA
  $VolumeRoot = [System.IO.Path]::GetPathRoot($LocalAppDataRoot).TrimEnd("\")
  if ([string]::Equals($LocalAppDataRoot.TrimEnd("\"), $VolumeRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "ROLEFLOW_LOCALAPPDATA_VOLUME_ROOT_REJECTED"
  }
  [void](Assert-RoleFlowPathHasNoReparsePoint -Path $LocalAppDataRoot)
  return $LocalAppDataRoot
}

function Get-RoleFlowUserDataParent {
  $LocalAppDataRoot = Get-RoleFlowLocalAppDataRoot
  $Parent = Resolve-RoleFlowNormalizedPath -Path (Join-Path $LocalAppDataRoot "RoleFlow")
  if (-not $Parent.StartsWith($LocalAppDataRoot + "\", [System.StringComparison]::OrdinalIgnoreCase) -or
      [string]::Equals($Parent, $LocalAppDataRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "ROLEFLOW_USER_DATA_PARENT_UNSAFE"
  }
  [void](Assert-RoleFlowPathHasNoReparsePoint -Path $Parent)
  return $Parent
}

function Get-ApprovedUserDataTargets {
  $Parent = Get-RoleFlowUserDataParent
  $Target = Resolve-RoleFlowNormalizedPath -Path (Join-Path $Parent "Data")
  if (-not $Target.StartsWith($Parent + "\", [System.StringComparison]::OrdinalIgnoreCase) -or
      [string]::Equals($Target, $Parent, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "ROLEFLOW_USER_DATA_DELETE_PATH_UNSAFE"
  }
  [void](Assert-RoleFlowPathHasNoReparsePoint -Path $Target -IncludeDescendants)
  return @($Target)
}

function Get-BrowserProfileDeletionTarget {
  $LocalAppDataRoot = Get-RoleFlowLocalAppDataRoot
  $Target = Resolve-RoleFlowBrowserProfilePath -ProjectRoot $InstallRoot
  [void](Assert-RoleFlowPathHasNoReparsePoint -Path $Target -IncludeDescendants)
  $Expected = Resolve-RoleFlowNormalizedPath -Path (
    Join-Path $env:LOCALAPPDATA "RoleFlow\BrowserProfile"
  )
  if (-not [string]::Equals($Target, $Expected, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "ROLEFLOW_BROWSER_PROFILE_DELETE_IDENTITY_INVALID"
  }
  if (-not $Target.StartsWith($LocalAppDataRoot + "\", [System.StringComparison]::OrdinalIgnoreCase) -or
      [string]::Equals($Target, $LocalAppDataRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "ROLEFLOW_BROWSER_PROFILE_DELETE_PATH_UNSAFE"
  }
  return $Target
}

if (-not $SkipDashboardStop) {
  Stop-InstalledDashboard
}

if ($PromptDeleteUserData -and -not $SkipDeletePrompt) {
  $PromptUserDataPath = Join-Path (Get-RoleFlowUserDataParent) "Data"
  Add-Type -AssemblyName System.Windows.Forms
  $Choice = [System.Windows.Forms.MessageBox]::Show(
    "是否同时删除本机 RoleFlow 数据？`r`n`r`n将删除：岗位数据库、简历、模型设置、日志、报告和本地候选人资料。`r`n默认选择否会保留这些内容在：`r`n$PromptUserDataPath",
    "卸载 RoleFlow",
    [System.Windows.Forms.MessageBoxButtons]::YesNo,
    [System.Windows.Forms.MessageBoxIcon]::Warning,
    [System.Windows.Forms.MessageBoxDefaultButton]::Button2
  )
  if ($Choice -eq [System.Windows.Forms.DialogResult]::Yes) {
    $DeleteUserData = $true
    $ConfirmDelete = $true
  }
}

if ($PromptDeleteBrowserProfile -and -not $SkipDeletePrompt) {
  $PromptBrowserProfilePath = Resolve-RoleFlowBrowserProfilePath -ProjectRoot $InstallRoot
  Add-Type -AssemblyName System.Windows.Forms
  $Choice = [System.Windows.Forms.MessageBox]::Show(
    "是否同时删除 RoleFlow 专用浏览器登录资料？`r`n`r`n路径：$PromptBrowserProfilePath`r`n`r`n删除后需要重新登录 BOSS。",
    "卸载 RoleFlow",
    [System.Windows.Forms.MessageBoxButtons]::YesNo,
    [System.Windows.Forms.MessageBoxIcon]::Warning,
    [System.Windows.Forms.MessageBoxDefaultButton]::Button2
  )
  if ($Choice -eq [System.Windows.Forms.DialogResult]::Yes) {
    $DeleteBrowserProfile = $true
    $ConfirmDeleteBrowserProfile = $true
  }
}

if ($DeleteBrowserProfile -xor $ConfirmDeleteBrowserProfile) {
  throw "ROLEFLOW_BROWSER_PROFILE_DELETE_CONFIRMATION_REQUIRED"
}

$DeleteApprovedUserData = $DeleteUserData -and $ConfirmDelete
$DeleteApprovedBrowserProfile = $DeleteBrowserProfile -and $ConfirmDeleteBrowserProfile
$UserDataTargets = @()
$BrowserProfileTarget = $null

if ($DeleteApprovedUserData) {
  $UserDataTargets = @(Get-ApprovedUserDataTargets)
}
if ($DeleteApprovedBrowserProfile) {
  $BrowserProfileTarget = Get-BrowserProfileDeletionTarget
  $ProcessSnapshot = Get-RoleFlowEdgeProcessSnapshot
  [void](Assert-RoleFlowBrowserProfileNotInUse `
    -ProfilePath $BrowserProfileTarget `
    -ProcessQuerySnapshot $ProcessSnapshot)
}

if ($DeleteApprovedBrowserProfile) {
  [void](Assert-RoleFlowPathHasNoReparsePoint -Path $BrowserProfileTarget -IncludeDescendants)
}
if ($DeleteApprovedUserData) {
  foreach ($Target in $UserDataTargets) {
    [void](Assert-RoleFlowPathHasNoReparsePoint -Path $Target -IncludeDescendants)
  }
}

if ($DeleteApprovedBrowserProfile) {
  [void](Assert-RoleFlowPathHasNoReparsePoint -Path $BrowserProfileTarget -IncludeDescendants)
  if (Test-Path -LiteralPath $BrowserProfileTarget) {
    Remove-Item -LiteralPath $BrowserProfileTarget -Recurse -Force
  }
  Write-Output "RoleFlow browser login data deleted."
} elseif (-not $SkipDeletePrompt) {
  Write-Output "RoleFlow browser login data preserved."
}

if ($DeleteApprovedUserData) {
  foreach ($Target in $UserDataTargets) {
    [void](Assert-RoleFlowPathHasNoReparsePoint -Path $Target -IncludeDescendants)
    if (Test-Path -LiteralPath $Target) {
      Remove-Item -LiteralPath $Target -Recurse -Force
    }
  }
  Write-Output "RoleFlow local user data deleted."
} elseif (-not $SkipDeletePrompt) {
  $PreservedDataPath = Join-Path (Get-RoleFlowUserDataParent) "Data"
  Write-Output "RoleFlow local user data preserved at: $PreservedDataPath"
}
