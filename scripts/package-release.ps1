[CmdletBinding()]
param(
  [switch]$IncludePortableNode,
  [string]$OutputName = "RoleFlow-portable.zip"
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$RuntimeDir = Join-Path $ProjectRoot ".runtime"
$StageDir = Join-Path $RuntimeDir "release-stage"
$DistDir = Join-Path $ProjectRoot "dist"

function Remove-ProjectPath {
  param([string]$Path)
  $resolved = Resolve-Path -LiteralPath $Path -ErrorAction SilentlyContinue
  if ($null -eq $resolved) { return }
  $root = (Resolve-Path -LiteralPath $ProjectRoot).Path.TrimEnd("\")
  if (-not $resolved.Path.StartsWith($root + "\")) { throw "Refusing to remove outside project: $($resolved.Path)" }
  Remove-Item -LiteralPath $resolved.Path -Recurse -Force
}

$Node = Join-Path $ProjectRoot ".runtime\node\node.exe"
if (-not (Test-Path -LiteralPath $Node)) {
  $Node = (Get-Command node -ErrorAction Stop).Source
}
foreach ($test in @("tests\self_check.js", "tests\observability_smoke.js", "tests\model_adapter_smoke.js", "tests\model_settings_smoke.js", "tests\model_settings_ui_smoke.js", "tests\profile_quality_smoke.js", "tests\onboarding_smoke.js")) {
  & $Node --disable-warning=ExperimentalWarning (Join-Path $ProjectRoot $test)
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

Remove-ProjectPath -Path $StageDir
New-Item -ItemType Directory -Force -Path $StageDir, $DistDir | Out-Null
foreach ($name in @("scripts", "src", "tests", "node_modules")) {
  Copy-Item -LiteralPath (Join-Path $ProjectRoot $name) -Destination (Join-Path $StageDir $name) -Recurse -Force
}
New-Item -ItemType Directory -Force -Path (Join-Path $StageDir "configs"), (Join-Path $StageDir "profiles") | Out-Null
foreach ($name in @("keywords.yaml", "scoring.yaml", "model.json", "profile.example.json")) {
  Copy-Item -LiteralPath (Join-Path $ProjectRoot "configs\\$name") -Destination (Join-Path $StageDir "configs\\$name") -Force
}
foreach ($name in @("example_profile.json", "example_resume_versions.json", "README.md")) {
  Copy-Item -LiteralPath (Join-Path $ProjectRoot "profiles\\$name") -Destination (Join-Path $StageDir "profiles\\$name") -Force
}
New-Item -ItemType Directory -Force -Path (Join-Path $StageDir "data"), (Join-Path $StageDir "reports") | Out-Null
foreach ($name in @("sample_jobs.json", "sample_resume.txt")) {
  Copy-Item -LiteralPath (Join-Path $ProjectRoot "data\$name") -Destination (Join-Path $StageDir "data\$name") -Force
}
foreach ($name in @("README.md", "package.json", "package-lock.json", "run.ps1", "Install.bat", "Start.bat", "BuildRelease.bat", "ScanPortable.bat", "StartPortableEdge.bat", ".gitignore")) {
  Copy-Item -LiteralPath (Join-Path $ProjectRoot $name) -Destination (Join-Path $StageDir $name) -Force
}
Copy-Item -LiteralPath (Join-Path $ProjectRoot "docs") -Destination (Join-Path $StageDir "docs") -Recurse -Force

if ($IncludePortableNode) {
  $portableNode = Join-Path $RuntimeDir "node"
  if (-not (Test-Path -LiteralPath (Join-Path $portableNode "node.exe"))) {
    throw "Portable Node is missing. Run scripts\install.ps1 -InstallPortableNode first."
  }
  New-Item -ItemType Directory -Force -Path (Join-Path $StageDir ".runtime") | Out-Null
  Copy-Item -LiteralPath $portableNode -Destination (Join-Path $StageDir ".runtime\node") -Recurse -Force
}

$zipPath = Join-Path $DistDir $OutputName
if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force }
Compress-Archive -Path (Join-Path $StageDir "*") -DestinationPath $zipPath -CompressionLevel Optimal
Remove-ProjectPath -Path $StageDir
Write-Host "Release package: $zipPath"
Write-Host "Excluded: data\jobs.sqlite, reports, .runtime\edge-profile, vendor\edge-control-bridge."
