[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$InstallRoot,
  [string]$DataRoot = ""
)

$ErrorActionPreference = "Stop"
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $Utf8NoBom
$OutputEncoding = $Utf8NoBom
. (Join-Path $PSScriptRoot "lib\startup-identity.ps1")

function Resolve-RoleFlowLocalAbsolutePath {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$MissingCode,
    [Parameter(Mandatory = $true)][string]$AbsoluteCode
  )
  if ([string]::IsNullOrWhiteSpace($Path)) { throw $MissingCode }
  if ($Path.StartsWith("\\", [System.StringComparison]::Ordinal)) {
    throw "ROLEFLOW_RUNTIME_UNC_PATH_REJECTED"
  }
  if (-not [System.IO.Path]::IsPathRooted($Path)) { throw $AbsoluteCode }
  return Resolve-RoleFlowNormalizedPath -Path $Path
}

function Write-RoleFlowUserDataStatus {
  param([string]$Status, [string]$ResolvedDataRoot)
  [pscustomobject]@{
    status = $Status
    dataRoot = $ResolvedDataRoot
  } | ConvertTo-Json -Compress
}

function Get-RoleFlowFileSha256 {
  param([Parameter(Mandatory = $true)][string]$Path)
  $Stream = [System.IO.File]::OpenRead($Path)
  $Hasher = [System.Security.Cryptography.SHA256]::Create()
  try {
    return [System.BitConverter]::ToString($Hasher.ComputeHash($Stream)).Replace("-", "")
  } finally {
    $Hasher.Dispose()
    $Stream.Dispose()
  }
}

function Get-RoleFlowDirectoryManifest {
  param([Parameter(Mandatory = $true)][string]$Source)
  [void](Assert-RoleFlowPathHasNoReparsePoint -Path $Source -IncludeDescendants)
  $Manifest = @(
    foreach ($SourceFile in @(Get-ChildItem -LiteralPath $Source -File -Recurse -Force -ErrorAction Stop)) {
      [pscustomobject]@{
        relativePath = $SourceFile.FullName.Substring($Source.Length).TrimStart([char[]]@('\', '/'))
        length = [long]$SourceFile.Length
        sha256 = Get-RoleFlowFileSha256 -Path $SourceFile.FullName
      }
    }
  )
  [void](Assert-RoleFlowPathHasNoReparsePoint -Path $Source -IncludeDescendants)
  return $Manifest
}

function Assert-RoleFlowCopiedDirectory {
  param([array]$Manifest, [string]$Destination)
  [void](Assert-RoleFlowPathHasNoReparsePoint -Path $Destination -IncludeDescendants)
  $DestinationFiles = @(Get-ChildItem -LiteralPath $Destination -File -Recurse -Force -ErrorAction Stop)
  if ($DestinationFiles.Count -ne $Manifest.Count) {
    throw "ROLEFLOW_USER_DATA_MIGRATION_VERIFY_FAILED: file count"
  }
  $Expected = @{}
  foreach ($Entry in $Manifest) { $Expected[[string]$Entry.relativePath] = $Entry }
  foreach ($DestinationFile in $DestinationFiles) {
    $RelativePath = $DestinationFile.FullName.Substring($Destination.Length).TrimStart([char[]]@('\', '/'))
    if (-not $Expected.ContainsKey($RelativePath)) {
      throw "ROLEFLOW_USER_DATA_MIGRATION_VERIFY_FAILED: $RelativePath"
    }
    $Entry = $Expected[$RelativePath]
    if ([long]$Entry.length -ne [long]$DestinationFile.Length) {
      throw "ROLEFLOW_USER_DATA_MIGRATION_VERIFY_FAILED: $RelativePath"
    }
    $DestinationHash = Get-RoleFlowFileSha256 -Path $DestinationFile.FullName
    if (-not [string]::Equals([string]$Entry.sha256, $DestinationHash, [System.StringComparison]::OrdinalIgnoreCase)) {
      throw "ROLEFLOW_USER_DATA_MIGRATION_VERIFY_FAILED: $RelativePath"
    }
  }
  [void](Assert-RoleFlowPathHasNoReparsePoint -Path $Destination -IncludeDescendants)
}

function Remove-RoleFlowSafeStagingDirectory {
  param(
    [Parameter(Mandatory = $true)][string]$StagingRoot,
    [Parameter(Mandatory = $true)][string]$DataParent
  )
  if (-not $StagingRoot.StartsWith($DataParent + "\", [System.StringComparison]::OrdinalIgnoreCase) -or
      -not ([System.IO.Path]::GetFileName($StagingRoot)).StartsWith("Data.staging-", [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "ROLEFLOW_USER_DATA_STAGING_PATH_UNSAFE"
  }
  if (-not (Test-Path -LiteralPath $StagingRoot)) { return }
  $RootItem = Get-Item -LiteralPath $StagingRoot -Force -ErrorAction Stop
  if (($RootItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "ROLEFLOW_REPARSE_POINT_BLOCKED: $($RootItem.FullName)"
  }
  $Pending = [System.Collections.Stack]::new()
  $Pending.Push($RootItem)
  $ReparseEntries = [System.Collections.ArrayList]::new()
  while ($Pending.Count -gt 0) {
    $Directory = $Pending.Pop()
    foreach ($Child in @(Get-ChildItem -LiteralPath $Directory.FullName -Force -ErrorAction Stop)) {
      if (($Child.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        [void]$ReparseEntries.Add([pscustomobject]@{ path = $Child.FullName; directory = [bool]$Child.PSIsContainer })
      } elseif ($Child.PSIsContainer) {
        $Pending.Push($Child)
      }
    }
  }
  foreach ($ReparseEntry in $ReparseEntries) {
    if ($ReparseEntry.directory) {
      [System.IO.Directory]::Delete([string]$ReparseEntry.path)
    } else {
      [System.IO.File]::Delete([string]$ReparseEntry.path)
    }
  }
  [void](Assert-RoleFlowPathHasNoReparsePoint -Path $StagingRoot -IncludeDescendants)
  Microsoft.PowerShell.Management\Remove-Item -LiteralPath $StagingRoot -Recurse -Force -ErrorAction Stop
}

$ResolvedInstallRoot = Resolve-RoleFlowLocalAbsolutePath `
  -Path $InstallRoot `
  -MissingCode "ROLEFLOW_INSTALL_ROOT_REQUIRED" `
  -AbsoluteCode "ROLEFLOW_INSTALL_ROOT_ABSOLUTE_REQUIRED"
if (-not (Test-Path -LiteralPath $ResolvedInstallRoot -PathType Container)) {
  throw "ROLEFLOW_INSTALL_ROOT_NOT_FOUND"
}

if ([string]::IsNullOrWhiteSpace($DataRoot)) {
  if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
    throw "ROLEFLOW_LOCALAPPDATA_REQUIRED"
  }
  $DataRoot = Join-Path $env:LOCALAPPDATA "RoleFlow\Data"
}
$ResolvedDataRoot = Resolve-RoleFlowLocalAbsolutePath `
  -Path $DataRoot `
  -MissingCode "ROLEFLOW_DATA_ROOT_REQUIRED" `
  -AbsoluteCode "ROLEFLOW_DATA_ROOT_ABSOLUTE_REQUIRED"

if (Test-RoleFlowPathOverlap -FirstPath $ResolvedInstallRoot -SecondPath $ResolvedDataRoot) {
  throw "ROLEFLOW_APP_DATA_ROOT_OVERLAP"
}
[void](Assert-RoleFlowPathHasNoReparsePoint -Path $ResolvedInstallRoot)
[void](Assert-RoleFlowPathHasNoReparsePoint -Path $ResolvedDataRoot)

$Mappings = @(
  [pscustomobject]@{ Source = "data"; Destination = "data" },
  [pscustomobject]@{ Source = ".runtime\settings"; Destination = ".runtime\settings" },
  [pscustomobject]@{ Source = ".runtime\resumes"; Destination = ".runtime\resumes" },
  [pscustomobject]@{ Source = ".runtime\logs"; Destination = ".runtime\logs" },
  [pscustomobject]@{ Source = "reports"; Destination = "reports" },
  [pscustomobject]@{ Source = "profiles"; Destination = "profiles" }
)
$LegacySources = @()
foreach ($Mapping in $Mappings) {
  $Source = Resolve-RoleFlowNormalizedPath -Path (Join-Path $ResolvedInstallRoot $Mapping.Source)
  if (-not $Source.StartsWith($ResolvedInstallRoot + "\", [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "ROLEFLOW_USER_DATA_SOURCE_PATH_UNSAFE"
  }
  if (Test-Path -LiteralPath $Source) {
    if (-not (Test-Path -LiteralPath $Source -PathType Container)) {
      throw "ROLEFLOW_USER_DATA_SOURCE_INVALID: $($Mapping.Source)"
    }
    [void](Assert-RoleFlowPathHasNoReparsePoint -Path $Source -IncludeDescendants)
    $LegacySources += [pscustomobject]@{
      Source = $Source
      Destination = $Mapping.Destination
      Manifest = @(Get-RoleFlowDirectoryManifest -Source $Source)
    }
  }
}

if (Test-Path -LiteralPath $ResolvedDataRoot) {
  if (-not (Test-Path -LiteralPath $ResolvedDataRoot -PathType Container)) {
    throw "ROLEFLOW_DATA_ROOT_INVALID"
  }
  [void](Assert-RoleFlowPathHasNoReparsePoint -Path $ResolvedDataRoot -IncludeDescendants)
  Write-RoleFlowUserDataStatus -Status "existing" -ResolvedDataRoot $ResolvedDataRoot
  return
}

$DataParent = Split-Path -Parent $ResolvedDataRoot
if ([string]::IsNullOrWhiteSpace($DataParent)) { throw "ROLEFLOW_DATA_ROOT_PARENT_INVALID" }
[void](Assert-RoleFlowPathHasNoReparsePoint -Path $DataParent)
New-Item -ItemType Directory -Force -Path $DataParent | Out-Null
[void](Assert-RoleFlowPathHasNoReparsePoint -Path $DataParent)

$StagingRoot = "$ResolvedDataRoot.staging-$([guid]::NewGuid().ToString('N'))"
if (-not $StagingRoot.StartsWith($DataParent + "\", [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "ROLEFLOW_USER_DATA_STAGING_PATH_UNSAFE"
}

try {
  New-Item -ItemType Directory -Path $StagingRoot -ErrorAction Stop | Out-Null
  foreach ($LegacySource in $LegacySources) {
    $Destination = Join-Path $StagingRoot $LegacySource.Destination
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Destination) | Out-Null
    [void](Assert-RoleFlowPathHasNoReparsePoint -Path $StagingRoot -IncludeDescendants)
    [void](Assert-RoleFlowPathHasNoReparsePoint -Path $Destination -IncludeDescendants)
    [void](Assert-RoleFlowPathHasNoReparsePoint -Path $LegacySource.Source -IncludeDescendants)
    Copy-Item -LiteralPath $LegacySource.Source -Destination $Destination -Recurse -Force
    [void](Assert-RoleFlowPathHasNoReparsePoint -Path $LegacySource.Source -IncludeDescendants)
    [void](Assert-RoleFlowPathHasNoReparsePoint -Path $Destination -IncludeDescendants)
    Assert-RoleFlowCopiedDirectory -Manifest $LegacySource.Manifest -Destination $Destination
    [void](Assert-RoleFlowPathHasNoReparsePoint -Path $LegacySource.Source -IncludeDescendants)
  }
  foreach ($RelativePath in @("data", ".runtime\settings", ".runtime\resumes", ".runtime\logs", "reports", "profiles")) {
    New-Item -ItemType Directory -Force -Path (Join-Path $StagingRoot $RelativePath) | Out-Null
  }
  [void](Assert-RoleFlowPathHasNoReparsePoint -Path $StagingRoot -IncludeDescendants)
  if (Test-Path -LiteralPath $ResolvedDataRoot) {
    throw "ROLEFLOW_USER_DATA_TARGET_RACE"
  }
  [System.IO.Directory]::Move($StagingRoot, $ResolvedDataRoot)
} catch {
  if (Test-Path -LiteralPath $StagingRoot) {
    Remove-RoleFlowSafeStagingDirectory -StagingRoot $StagingRoot -DataParent $DataParent
  }
  throw
}

$Status = if ($LegacySources.Count -gt 0) { "migrated" } else { "created" }
Write-RoleFlowUserDataStatus -Status $Status -ResolvedDataRoot $ResolvedDataRoot
