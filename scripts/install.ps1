[CmdletBinding()]
param(
  [switch]$CheckOnly,
  [switch]$SkipNodeInstall,
  [switch]$InstallPortableNode,
  [switch]$ForceDependencies,
  [switch]$StartBrowser,
  [int]$Port = 9222
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$RuntimeDir = Join-Path $ProjectRoot ".runtime"

function Test-Node {
  param([string]$NodePath)
  if (-not $NodePath) {
    return $null
  }
  try {
    $VersionText = & $NodePath -v 2>$null
  } catch {
    return $null
  }
  if ($VersionText -match "^v(\d+)\.") {
    $Major = [int]$Matches[1]
    if ($Major -ge 22) {
      return [pscustomobject]@{ Path = $NodePath; Version = $VersionText }
    }
  }
  return $null
}

function Resolve-Node {
  $Candidates = @()
  if ($env:ZHIPPING_NODE) {
    $Candidates += $env:ZHIPPING_NODE
  }
  $Candidates += (Join-Path $ProjectRoot ".runtime\node\node.exe")
  $Candidates += "D:\hermes\node\node.exe"

  $Cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($null -ne $Cmd) {
    $Candidates += $Cmd.Source
  }

  foreach ($Candidate in $Candidates) {
    if ($Candidate -and (Test-Path -LiteralPath $Candidate)) {
      $Node = Test-Node -NodePath $Candidate
      if ($null -ne $Node) {
        return $Node
      }
    }
  }
  return $null
}

function Remove-ProjectPath {
  param([string]$Path)
  $Resolved = Resolve-Path -LiteralPath $Path -ErrorAction SilentlyContinue
  if ($null -eq $Resolved) {
    return
  }
  $Root = (Resolve-Path -LiteralPath $ProjectRoot).Path.TrimEnd("\")
  $Target = $Resolved.Path
  if (-not $Target.StartsWith($Root + "\")) {
    throw "Refusing to remove outside project: $Target"
  }
  Remove-Item -LiteralPath $Target -Recurse -Force
}

function Install-PortableNode {
  New-Item -ItemType Directory -Force -Path $RuntimeDir | Out-Null
  $DownloadDir = Join-Path $RuntimeDir "downloads"
  New-Item -ItemType Directory -Force -Path $DownloadDir | Out-Null

  Write-Host "Downloading Node.js release index..."
  $Index = Invoke-RestMethod -Uri "https://nodejs.org/dist/index.json" -TimeoutSec 30
  $Release = $Index | Where-Object {
    $_.version -like "v22.*" -and $_.files -contains "win-x64-zip"
  } | Select-Object -First 1

  if ($null -eq $Release) {
    throw "Could not find a Node.js v22 win-x64 zip release."
  }

  $ZipName = "node-$($Release.version)-win-x64.zip"
  $ZipUrl = "https://nodejs.org/dist/$($Release.version)/$ZipName"
  $ZipPath = Join-Path $DownloadDir $ZipName
  $ExtractDir = Join-Path $RuntimeDir "node-extract"
  $NodeDir = Join-Path $RuntimeDir "node"

  if (-not (Test-Path -LiteralPath $ZipPath)) {
    Write-Host "Downloading $ZipName to $ZipPath"
    Invoke-WebRequest -UseBasicParsing -Uri $ZipUrl -OutFile $ZipPath
  }

  Remove-ProjectPath -Path $ExtractDir
  New-Item -ItemType Directory -Force -Path $ExtractDir | Out-Null
  Expand-Archive -LiteralPath $ZipPath -DestinationPath $ExtractDir -Force

  $ExtractedRoot = Get-ChildItem -LiteralPath $ExtractDir -Directory | Select-Object -First 1
  if ($null -eq $ExtractedRoot) {
    throw "Node zip did not contain an extracted directory."
  }

  Remove-ProjectPath -Path $NodeDir
  Move-Item -LiteralPath $ExtractedRoot.FullName -Destination $NodeDir
  Remove-ProjectPath -Path $ExtractDir

  $NodeExe = Join-Path $NodeDir "node.exe"
  $Node = Test-Node -NodePath $NodeExe
  if ($null -eq $Node) {
    throw "Portable Node install failed: $NodeExe"
  }
  return $Node
}

function Resolve-EdgePath {
  $Candidates = @(
    "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    "C:\Program Files\Microsoft\Edge\Application\msedge.exe"
  )
  foreach ($Candidate in $Candidates) {
    if (Test-Path -LiteralPath $Candidate) {
      return $Candidate
    }
  }

  $Cmd = Get-Command msedge -ErrorAction SilentlyContinue
  if ($null -ne $Cmd) {
    return $Cmd.Source
  }
  return $null
}

function Test-ProjectDependencies {
  param([string]$NodePath)
  $PreviousPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    & $NodePath -e "try { require.resolve('pdf-parse') } catch { process.exit(1) }" 2>$null
    return $LASTEXITCODE -eq 0
  } finally {
    $ErrorActionPreference = $PreviousPreference
  }
}

function Install-ProjectDependencies {
  param([string]$NodePath, [bool]$ForceInstall = $false)
  $DependenciesHealthy = Test-ProjectDependencies -NodePath $NodePath
  if ($DependenciesHealthy -and -not $ForceInstall) {
    Write-Host "Project dependencies already present. Use -ForceDependencies to reinstall."
    return
  }
  $NpmPath = Join-Path (Split-Path -Parent $NodePath) "npm.cmd"
  if (-not (Test-Path -LiteralPath $NpmPath)) {
    throw "npm.cmd not found next to Node: $NpmPath"
  }
  $env:npm_config_cache = Join-Path $RuntimeDir "npm-cache"
  $env:npm_config_audit = "false"
  $env:npm_config_fund = "false"
  Write-Host "Installing project dependencies to $ProjectRoot\node_modules"
  for ($Attempt = 1; $Attempt -le 3; $Attempt += 1) {
    & $NpmPath ci --no-audit --no-fund
    if ($LASTEXITCODE -eq 0) {
      if (Test-ProjectDependencies -NodePath $NodePath) { return }
    }
    if ($Attempt -lt 3) {
      Write-Host "Dependency install attempt $Attempt failed. Retrying shortly..."
      Start-Sleep -Seconds $Attempt
    }
  }
  throw "Project dependencies could not be installed after 3 attempts."
}

Write-Host "RoleFlow installer"
Write-Host "Project: $ProjectRoot"

$Node = $null
if ($InstallPortableNode) {
  if ($CheckOnly) {
    throw "-InstallPortableNode cannot be used with -CheckOnly."
  }
  $Node = Install-PortableNode
} else {
  $Node = Resolve-Node
}

if ($null -eq $Node) {
  if ($CheckOnly -or $SkipNodeInstall) {
    throw "Node.js 22+ not found."
  }
  $Node = Install-PortableNode
}
Write-Host "Node: $($Node.Path) $($Node.Version)"

$PdfParser = Join-Path $ProjectRoot "node_modules\pdf-parse"
if ($CheckOnly) {
  if (-not (Test-Path -LiteralPath $PdfParser)) {
    throw "Project dependencies not installed. Run scripts\install.ps1 without -CheckOnly."
  }
} else {
  Install-ProjectDependencies -NodePath $Node.Path -ForceInstall $ForceDependencies
}

$EdgePath = Resolve-EdgePath
if (-not $EdgePath) {
  throw "Microsoft Edge not found. Install Microsoft Edge first."
}
Write-Host "Edge: $EdgePath"

$env:ZHIPPING_NODE = $Node.Path
& $Node.Path --disable-warning=ExperimentalWarning (Join-Path $ProjectRoot "tests\self_check.js")
if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}
& $Node.Path --disable-warning=ExperimentalWarning (Join-Path $ProjectRoot "tests\observability_smoke.js")
if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}
& $Node.Path --disable-warning=ExperimentalWarning (Join-Path $ProjectRoot "tests\model_adapter_smoke.js")
if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}
& $Node.Path --disable-warning=ExperimentalWarning (Join-Path $ProjectRoot "tests\onboarding_smoke.js")
if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}

if ($StartBrowser) {
  & powershell -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "start-portable-edge.ps1") -Port $Port
  if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
  }
}

Write-Host "Install check passed."
Write-Host "Next: scripts\scan-portable.ps1 -Keywords ""AI application"""
exit 0
