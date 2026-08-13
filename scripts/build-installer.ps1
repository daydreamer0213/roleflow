[CmdletBinding()]
param(
  [string]$OutputDir = "",
  [string]$BuildRoot = "D:\DevData\RoleFlow-installer",
  [string]$PortableNodeRoot = "",
  [string]$InnoCompiler = "",
  [switch]$SkipTests,
  [switch]$StageOnly
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$Package = Get-Content -Raw -Encoding utf8 -LiteralPath (Join-Path $ProjectRoot "package.json") | ConvertFrom-Json
$Version = [string]$Package.version
$RequiredNodeVersion = (
  Get-Content -Raw -LiteralPath (Join-Path $ProjectRoot "installer\node-version.txt")
).Trim()
if (-not $OutputDir) {
  $OutputDir = Join-Path $ProjectRoot "dist"
}
$OutputDir = [System.IO.Path]::GetFullPath($OutputDir)
$BuildRoot = [System.IO.Path]::GetFullPath($BuildRoot).TrimEnd("\")
$StageDir = Join-Path $BuildRoot ("stage\{0}" -f $Version)

function Remove-SafeBuildPath {
  param([Parameter(Mandatory = $true)][string]$Path)
  $FullPath = [System.IO.Path]::GetFullPath($Path).TrimEnd("\")
  $DriveRoot = [System.IO.Path]::GetPathRoot($FullPath).TrimEnd("\")
  if ($FullPath -eq $DriveRoot -or
      -not $FullPath.StartsWith($BuildRoot + "\", [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to remove an unsafe build path: $FullPath"
  }
  if (Test-Path -LiteralPath $FullPath) {
    Remove-Item -LiteralPath $FullPath -Recurse -Force
  }
}

function Resolve-InnoCompiler {
  foreach ($Candidate in @(
    $InnoCompiler,
    $env:ROLEFLOW_ISCC,
    "D:\DevData\InnoSetup\ISCC.exe",
    "C:\Program Files (x86)\Inno Setup 6\ISCC.exe",
    "C:\Program Files\Inno Setup 6\ISCC.exe"
  )) {
    if ($Candidate -and (Test-Path -LiteralPath $Candidate)) {
      return [System.IO.Path]::GetFullPath($Candidate)
    }
  }
  throw "Inno Setup compiler not found. Install the pinned compiler under D:\DevData\InnoSetup or set ROLEFLOW_ISCC."
}

function Resolve-PortableNodeRoot {
  foreach ($Candidate in @(
    $PortableNodeRoot,
    (Join-Path $ProjectRoot ".runtime\node"),
    "D:\hermes\node"
  )) {
    if (-not $Candidate) {
      continue
    }
    $NodeExe = Join-Path $Candidate "node.exe"
    if (-not (Test-Path -LiteralPath $NodeExe)) {
      continue
    }
    $ActualVersion = (& $NodeExe -v).Trim()
    if ($LASTEXITCODE -eq 0 -and $ActualVersion -eq $RequiredNodeVersion) {
      return [System.IO.Path]::GetFullPath($Candidate)
    }
  }
  throw "Pinned portable Node $RequiredNodeVersion is missing. Expected .runtime\node or D:\hermes\node."
}

function Copy-ProjectItem {
  param(
    [Parameter(Mandatory = $true)][string]$RelativePath,
    [string]$DestinationRelativePath = ""
  )
  $Source = Join-Path $ProjectRoot $RelativePath
  if (-not (Test-Path -LiteralPath $Source)) {
    throw "Required release item is missing: $RelativePath"
  }
  if (-not $DestinationRelativePath) {
    $DestinationRelativePath = $RelativePath
  }
  $Destination = Join-Path $StageDir $DestinationRelativePath
  $DestinationParent = Split-Path -Parent $Destination
  if ($DestinationParent) {
    New-Item -ItemType Directory -Force -Path $DestinationParent | Out-Null
  }
  Copy-Item -LiteralPath $Source -Destination $Destination -Recurse -Force
}

$NodeRoot = Resolve-PortableNodeRoot

if (-not $SkipTests) {
  $TestNode = Join-Path $NodeRoot "node.exe"
  & $TestNode --disable-warning=ExperimentalWarning (Join-Path $ProjectRoot "tests\run_all.js")
  if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
  }
}

Remove-SafeBuildPath -Path $StageDir
New-Item -ItemType Directory -Force -Path $StageDir, $OutputDir | Out-Null

foreach ($RelativePath in @(
  "src",
  "node_modules",
  "LICENSE",
  "NOTICE",
  "README.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "CODE_OF_CONDUCT.md",
  "package.json",
  "package-lock.json",
  "run.ps1",
  "Install.bat",
  "Start.bat",
  "ScanPortable.bat",
  "StartPortableEdge.bat"
)) {
  Copy-ProjectItem -RelativePath $RelativePath
}

foreach ($RelativePath in @(
  "scripts\install.ps1",
  "scripts\start-workspace.ps1",
  "scripts\start-edge-control.ps1",
  "scripts\start-portable-edge.ps1",
  "scripts\scan-boss.ps1",
  "scripts\scan-portable.ps1",
  "scripts\launch-installed.ps1",
  "scripts\installed-self-check.ps1",
  "scripts\prepare-uninstall.ps1",
  "scripts\lib\startup-identity.ps1"
)) {
  Copy-ProjectItem -RelativePath $RelativePath
}

foreach ($RelativePath in @(
  "configs\keywords.yaml",
  "configs\scoring.yaml",
  "configs\model.json",
  "configs\profile.example.json",
  "profiles\example_profile.json",
  "profiles\example_resume_versions.json",
  "profiles\README.md",
  "data\sample_jobs.json",
  "data\sample_resume.txt",
  "docs\README.md",
  "docs\daily_workflow.md",
  "docs\onboarding_workflow.md",
  "docs\operations.md",
  "docs\product_spec.md",
  "docs\release_boundary.md"
)) {
  Copy-ProjectItem -RelativePath $RelativePath
}

New-Item -ItemType Directory -Force -Path (Join-Path $StageDir "runtime") | Out-Null
Copy-Item -LiteralPath $NodeRoot -Destination (Join-Path $StageDir "runtime\node") -Recurse -Force

$ForbiddenFiles = @(
  Get-ChildItem -LiteralPath $StageDir -Recurse -File |
    Where-Object {
      $RelativePath = $_.FullName.Substring($StageDir.Length + 1)
      $_.Name -match "jobs\.sqlite|\.sqlite-(wal|shm)$|\.key$" -or
      $RelativePath -match "^(tests|vendor\\edge-control-bridge|\.runtime|reports|logs)(\\|$)"
    }
)
if ($ForbiddenFiles.Count -gt 0) {
  throw "Installer stage contains forbidden runtime or development files: $($ForbiddenFiles[0].FullName)"
}

if ($StageOnly) {
  Write-Host "Installer stage: $StageDir"
  exit 0
}

$Compiler = Resolve-InnoCompiler
$Arguments = @(
  "/DStageDir=$StageDir",
  "/DAppVersion=$Version",
  "/DOutputDir=$OutputDir",
  (Join-Path $ProjectRoot "installer\RoleFlow.iss")
)
& $Compiler @Arguments
if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}

$InstallerPath = Join-Path $OutputDir ("RoleFlow-Setup-{0}.exe" -f $Version)
if (-not (Test-Path -LiteralPath $InstallerPath)) {
  throw "Inno Setup completed without the expected installer: $InstallerPath"
}
$Hash = Get-FileHash -Algorithm SHA256 -LiteralPath $InstallerPath
$HashPath = "$InstallerPath.sha256"
"$($Hash.Hash.ToLowerInvariant())  $([System.IO.Path]::GetFileName($InstallerPath))" |
  Set-Content -LiteralPath $HashPath -Encoding ascii

Write-Host "Installer: $InstallerPath"
Write-Host "SHA-256: $($Hash.Hash.ToLowerInvariant())"
Write-Host "Build cache: $BuildRoot"
