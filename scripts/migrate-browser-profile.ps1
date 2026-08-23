[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$SourceProfileDir,
  [switch]$ConfirmMigration
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot "lib\startup-identity.ps1")

function Test-PathWithin {
  param(
    [Parameter(Mandatory = $true)][string]$Candidate,
    [Parameter(Mandatory = $true)][string]$Parent
  )
  return [string]::Equals($Candidate, $Parent, [System.StringComparison]::OrdinalIgnoreCase) -or
    $Candidate.StartsWith($Parent + "\", [System.StringComparison]::OrdinalIgnoreCase)
}

function Assert-NonRootPath {
  param([Parameter(Mandatory = $true)][string]$Path)
  $Root = [System.IO.Path]::GetPathRoot($Path)
  if ([string]::IsNullOrWhiteSpace($Path) -or
      [string]::IsNullOrWhiteSpace($Root) -or
      [string]::Equals(
        $Path.TrimEnd("\"),
        $Root.TrimEnd("\"),
        [System.StringComparison]::OrdinalIgnoreCase
      )) {
    throw "ROLEFLOW_PROFILE_PATH_UNSAFE"
  }
}

function Get-RelativeFileInventory {
  param([Parameter(Mandatory = $true)][string]$Root)
  return @(
    Get-ChildItem -LiteralPath $Root -Recurse -Force -File |
      ForEach-Object { $_.FullName.Substring($Root.Length + 1) } |
      Sort-Object
  )
}

if (-not $ConfirmMigration) {
  throw "ROLEFLOW_PROFILE_MIGRATION_CONFIRMATION_REQUIRED"
}

$SourcePath = Resolve-RoleFlowNormalizedPath -Path $SourceProfileDir
$TargetPath = Resolve-RoleFlowBrowserProfilePath -ProjectRoot $ProjectRoot
$ExpectedTarget = Resolve-RoleFlowNormalizedPath -Path (
  Join-Path $env:LOCALAPPDATA "RoleFlow\BrowserProfile"
)
$TargetParent = Resolve-RoleFlowNormalizedPath -Path (Split-Path -Parent $TargetPath)
$ExpectedParent = Resolve-RoleFlowNormalizedPath -Path (Join-Path $env:LOCALAPPDATA "RoleFlow")

Assert-NonRootPath -Path $SourcePath
Assert-NonRootPath -Path $TargetPath
[void](Assert-RoleFlowPathHasNoReparsePoint -Path $SourcePath -IncludeDescendants)
[void](Assert-RoleFlowPathHasNoReparsePoint -Path $TargetPath -IncludeDescendants)
if (-not [string]::Equals($TargetPath, $ExpectedTarget, [System.StringComparison]::OrdinalIgnoreCase) -or
    -not [string]::Equals($TargetParent, $ExpectedParent, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "ROLEFLOW_PROFILE_TARGET_IDENTITY_INVALID"
}
if ((Test-PathWithin -Candidate $SourcePath -Parent $TargetPath) -or
    (Test-PathWithin -Candidate $TargetPath -Parent $SourcePath)) {
  throw "ROLEFLOW_PROFILE_PATH_RELATION_INVALID"
}
if (-not (Test-Path -LiteralPath $SourcePath -PathType Container)) {
  throw "ROLEFLOW_PROFILE_SOURCE_MISSING"
}
if (-not (Test-Path -LiteralPath (Join-Path $SourcePath "Local State") -PathType Leaf)) {
  throw "ROLEFLOW_PROFILE_LOCAL_STATE_REQUIRED"
}
if (Test-Path -LiteralPath $TargetPath) {
  throw "ROLEFLOW_PROFILE_TARGET_EXISTS"
}

$ProcessSnapshot = Get-RoleFlowEdgeProcessSnapshot
[void](Assert-RoleFlowBrowserProfileNotInUse -ProfilePath $SourcePath -ProcessQuerySnapshot $ProcessSnapshot)
[void](Assert-RoleFlowBrowserProfileNotInUse -ProfilePath $TargetPath -ProcessQuerySnapshot $ProcessSnapshot)

[void](Assert-RoleFlowPathHasNoReparsePoint -Path $TargetPath -IncludeDescendants)
New-Item -ItemType Directory -Force -Path $TargetParent | Out-Null
[void](Assert-RoleFlowPathHasNoReparsePoint -Path $TargetParent)
$StagingName = ".BrowserProfile-migration-$([guid]::NewGuid().ToString('N'))"
$StagingPath = Resolve-RoleFlowNormalizedPath -Path (Join-Path $TargetParent $StagingName)
if (-not [string]::Equals(
      (Resolve-RoleFlowNormalizedPath -Path (Split-Path -Parent $StagingPath)),
      $TargetParent,
      [System.StringComparison]::OrdinalIgnoreCase
    ) -or
    -not [string]::Equals(
      [System.IO.Path]::GetFileName($StagingPath),
      $StagingName,
      [System.StringComparison]::Ordinal
    ) -or
    (Test-Path -LiteralPath $StagingPath)) {
  throw "ROLEFLOW_PROFILE_STAGING_IDENTITY_INVALID"
}
[void](Assert-RoleFlowPathHasNoReparsePoint -Path $StagingPath -IncludeDescendants)

$StagingCreated = $false
try {
  [System.IO.Directory]::CreateDirectory($StagingPath) | Out-Null
  $StagingCreated = $true
  [void](Assert-RoleFlowPathHasNoReparsePoint -Path $SourcePath -IncludeDescendants)
  [void](Assert-RoleFlowPathHasNoReparsePoint -Path $StagingPath -IncludeDescendants)
  foreach ($Child in @(Get-ChildItem -LiteralPath $SourcePath -Force)) {
    Copy-Item `
      -LiteralPath $Child.FullName `
      -Destination (Join-Path $StagingPath $Child.Name) `
      -Recurse `
      -Force
  }

  [void](Assert-RoleFlowPathHasNoReparsePoint -Path $SourcePath -IncludeDescendants)
  [void](Assert-RoleFlowPathHasNoReparsePoint -Path $StagingPath -IncludeDescendants)
  if (-not (Test-Path -LiteralPath (Join-Path $StagingPath "Local State") -PathType Leaf)) {
    throw "ROLEFLOW_PROFILE_STAGING_LOCAL_STATE_MISSING"
  }
  $SourceInventory = Get-RelativeFileInventory -Root $SourcePath
  $StagingInventory = Get-RelativeFileInventory -Root $StagingPath
  if (@(Compare-Object -ReferenceObject $SourceInventory -DifferenceObject $StagingInventory).Count -ne 0) {
    throw "ROLEFLOW_PROFILE_STAGING_INVENTORY_MISMATCH"
  }

  [void](Assert-RoleFlowPathHasNoReparsePoint -Path $StagingPath -IncludeDescendants)
  [void](Assert-RoleFlowPathHasNoReparsePoint -Path $TargetPath -IncludeDescendants)
  [System.IO.Directory]::Move($StagingPath, $TargetPath)
  $StagingCreated = $false
  Write-Output "PROFILE_MIGRATION_OK"
} finally {
  if ($StagingCreated -and (Test-Path -LiteralPath $StagingPath)) {
    $CleanupPath = Resolve-RoleFlowNormalizedPath -Path $StagingPath
    $CleanupParent = Resolve-RoleFlowNormalizedPath -Path (Split-Path -Parent $CleanupPath)
    if (-not [string]::Equals($CleanupPath, $StagingPath, [System.StringComparison]::OrdinalIgnoreCase) -or
        -not [string]::Equals($CleanupParent, $TargetParent, [System.StringComparison]::OrdinalIgnoreCase) -or
        -not [string]::Equals(
          [System.IO.Path]::GetFileName($CleanupPath),
          $StagingName,
          [System.StringComparison]::Ordinal
        )) {
      throw "ROLEFLOW_PROFILE_STAGING_CLEANUP_REFUSED"
    }
    [void](Assert-RoleFlowPathHasNoReparsePoint -Path $CleanupPath -IncludeDescendants)
    Remove-Item -LiteralPath $CleanupPath -Recurse -Force
  }
}
