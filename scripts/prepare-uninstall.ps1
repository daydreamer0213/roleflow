[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$InstallRoot,
  [switch]$PromptDeleteUserData,
  [switch]$DeleteUserData,
  [switch]$ConfirmDelete,
  [switch]$SkipDeletePrompt,
  [switch]$SkipDashboardStop
)

$ErrorActionPreference = "Stop"
$InstallRoot = [System.IO.Path]::GetFullPath($InstallRoot).TrimEnd("\")
if ([string]::IsNullOrWhiteSpace($InstallRoot) -or
    $InstallRoot -eq [System.IO.Path]::GetPathRoot($InstallRoot)) {
  throw "Refusing an unsafe install root."
}

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

function Remove-ApprovedUserData {
  $ApprovedChildren = @("data", ".runtime", "reports", "logs", "profiles")
  foreach ($Child in $ApprovedChildren) {
    $Target = [System.IO.Path]::GetFullPath((Join-Path $InstallRoot $Child)).TrimEnd("\")
    if (-not $Target.StartsWith(
      $InstallRoot + "\",
      [System.StringComparison]::OrdinalIgnoreCase
    )) {
      throw "Refusing to delete outside the RoleFlow install root: $Target"
    }
    if (Test-Path -LiteralPath $Target) {
      Remove-Item -LiteralPath $Target -Recurse -Force
    }
  }
}

if (-not $SkipDashboardStop) {
  Stop-InstalledDashboard
}

if ($PromptDeleteUserData -and -not $SkipDeletePrompt) {
  Add-Type -AssemblyName System.Windows.Forms
  $Choice = [System.Windows.Forms.MessageBox]::Show(
    "是否同时删除本机 RoleFlow 数据？`r`n`r`n将删除：岗位数据库、简历、模型设置、日志、报告和本地候选人资料。`r`n默认选择否会保留这些内容在：`r`n$InstallRoot",
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

if ($DeleteUserData -and $ConfirmDelete) {
  Remove-ApprovedUserData
  Write-Output "RoleFlow local user data deleted."
} elseif (-not $SkipDeletePrompt) {
  Write-Output "RoleFlow local user data preserved at: $InstallRoot"
}
