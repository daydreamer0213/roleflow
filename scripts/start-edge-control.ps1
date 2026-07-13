[CmdletBinding()]
param(
  [ValidateSet("", "auto", "plugin", "bundled")]
  [string]$Source = "",
  [string]$EdgeControlRoot = "",
  [string]$PluginRoot = "",
  [string]$BundledRoot = "",
  [switch]$CheckOnly,
  [switch]$InstallConfig,
  [int]$TimeoutSeconds = 15
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot

function Resolve-Node {
  $Bundled = "D:\hermes\node\node.exe"
  if (Test-Path -LiteralPath $Bundled) {
    return $Bundled
  }
  $Cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($null -eq $Cmd) {
    throw "Node.js not found. Install Node 22+ or keep D:\hermes\node\node.exe available."
  }
  return $Cmd.Source
}

function Read-JsonFile {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) {
    return $null
  }
  return Get-Content -Raw -LiteralPath $Path | ConvertFrom-Json
}

function Read-EdgeControlConfig {
  $ConfigPath = Join-Path $env:APPDATA "CodexEdgeControl\config.json"
  return Read-JsonFile -Path $ConfigPath
}

function Get-BridgeStatus {
  param([Parameter(Mandatory = $true)]$Config)

  $Token = $Config.authToken
  if (-not $Token) {
    $Token = $Config.token
  }
  if (-not $Token) {
    throw "Edge Control config has no auth token."
  }

  $BaseUrl = "http://$($Config.host):$($Config.port)"
  $Headers = @{ "x-edge-control-token" = $Token }
  return Invoke-RestMethod -Method Get -Uri "$BaseUrl/api/status" -Headers $Headers -TimeoutSec 3
}

function Resolve-EdgeControlRoot {
  if ($EdgeControlRoot) {
    return [pscustomobject]@{ Source = "custom"; Root = $EdgeControlRoot }
  }

  $BrowserConfigPath = Join-Path $ProjectRoot "configs\browser.json"
  $BrowserConfig = Read-JsonFile -Path $BrowserConfigPath

  $ResolvedSource = $Source
  if (-not $ResolvedSource -and $env:ZHIPPING_EDGE_SOURCE) {
    $ResolvedSource = $env:ZHIPPING_EDGE_SOURCE
  }
  if (-not $ResolvedSource -and $BrowserConfig -and $BrowserConfig.edgeControlSource) {
    $ResolvedSource = $BrowserConfig.edgeControlSource
  }
  if (-not $ResolvedSource) {
    $ResolvedSource = "auto"
  }

  $ResolvedPluginRoot = $PluginRoot
  if (-not $ResolvedPluginRoot -and $BrowserConfig -and $BrowserConfig.pluginRoot) {
    $ResolvedPluginRoot = $BrowserConfig.pluginRoot
  }
  if (-not $ResolvedPluginRoot) {
    $ResolvedPluginRoot = "D:\codex-plugins\edge-control"
  }

  $ResolvedBundledRoot = $BundledRoot
  if (-not $ResolvedBundledRoot -and $BrowserConfig -and $BrowserConfig.bundledRoot) {
    $ResolvedBundledRoot = $BrowserConfig.bundledRoot
  }
  if (-not $ResolvedBundledRoot) {
    $ResolvedBundledRoot = "vendor\edge-control-bridge"
  }
  if (-not [System.IO.Path]::IsPathRooted($ResolvedBundledRoot)) {
    $ResolvedBundledRoot = Join-Path $ProjectRoot $ResolvedBundledRoot
  }

  if ($ResolvedSource -eq "plugin") {
    return [pscustomobject]@{ Source = "plugin"; Root = $ResolvedPluginRoot }
  }
  if ($ResolvedSource -eq "bundled") {
    return [pscustomobject]@{ Source = "bundled"; Root = $ResolvedBundledRoot }
  }
  if ($ResolvedSource -ne "auto") {
    throw "Unknown edgeControlSource: $ResolvedSource"
  }
  if (Test-Path -LiteralPath $ResolvedPluginRoot) {
    return [pscustomobject]@{ Source = "plugin"; Root = $ResolvedPluginRoot }
  }
  return [pscustomobject]@{ Source = "bundled"; Root = $ResolvedBundledRoot }
}

$Resolved = Resolve-EdgeControlRoot
$Root = Resolve-Path -LiteralPath $Resolved.Root -ErrorAction SilentlyContinue
if ($null -eq $Root) {
  throw "Edge Control root not found: $($Resolved.Root)"
}
$RootPath = $Root.Path
$ScriptsDir = Join-Path $RootPath "scripts"
$InstallScript = Join-Path $ScriptsDir "install.ps1"
$BridgeScript = Join-Path $ScriptsDir "bridge-server.mjs"
$NodeModules = Join-Path $ScriptsDir "node_modules"

if (-not (Test-Path -LiteralPath $BridgeScript)) {
  throw "Edge bridge script not found: $BridgeScript"
}
if (-not (Test-Path -LiteralPath $InstallScript)) {
  throw "Edge Control installer not found: $InstallScript"
}
if (-not (Test-Path -LiteralPath $NodeModules)) {
  if ($CheckOnly) {
    throw "Edge Control dependencies missing: $NodeModules. Run without -CheckOnly once."
  }
  & powershell -ExecutionPolicy Bypass -File $InstallScript -InstallDependencies
  if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
  }
}

$Config = Read-EdgeControlConfig
if ($InstallConfig -or $null -eq $Config) {
  & powershell -ExecutionPolicy Bypass -File $InstallScript -SkipDependencies
  if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
  }
  $Config = Read-EdgeControlConfig
}

if ($null -eq $Config) {
  throw "Edge Control config missing. Run without -CheckOnly once."
}

$Status = $null
try {
  $Status = Get-BridgeStatus -Config $Config
} catch {
  if ($CheckOnly) {
    throw "Edge Control bridge is not running: $($_.Exception.Message)"
  }
}

if ($null -eq $Status) {
  $Node = Resolve-Node
  $StateDir = Join-Path $env:APPDATA "CodexEdgeControl"
  $LogDir = Join-Path $StateDir "logs"
  New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
  $StdOutLogPath = Join-Path $LogDir "bridge.stdout.log"
  $StdErrLogPath = Join-Path $LogDir "bridge.stderr.log"
  $PidPath = Join-Path $StateDir "bridge.pid"

  $Process = Start-Process `
    -FilePath $Node `
    -ArgumentList "bridge-server.mjs" `
    -WorkingDirectory $ScriptsDir `
    -WindowStyle Hidden `
    -RedirectStandardOutput $StdOutLogPath `
    -RedirectStandardError $StdErrLogPath `
    -PassThru

  Set-Content -LiteralPath $PidPath -Value $Process.Id -Encoding ascii

  $Deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  do {
    Start-Sleep -Milliseconds 500
    try {
      $Status = Get-BridgeStatus -Config $Config
    } catch {
      $Status = $null
    }
  } while ($null -eq $Status -and (Get-Date) -lt $Deadline)

  if ($null -eq $Status) {
    throw "Started bridge PID=$($Process.Id), but it did not become ready. Check $StdErrLogPath"
  }
}

$ConnectionState = $Status.bridge.connectionState
$ExtensionReady = [bool]$Status.bridge.readyExtension
$ExtensionHealthy = [bool]$Status.bridge.healthyExtension

Write-Host "Edge Control source: $($Resolved.Source)"
Write-Host "Edge Control root: $RootPath"
Write-Host "Edge Control bridge: $ConnectionState"
Write-Host "Bridge URL: http://$($Config.host):$($Config.port)"
Write-Host "Extension ready: $ExtensionReady"
Write-Host "Extension healthy: $ExtensionHealthy"

if (-not $ExtensionHealthy) {
  $ExtensionDir = Join-Path $RootPath "extension"
  Write-Host "Load/refresh Edge unpacked extension from: $ExtensionDir"
  throw "Edge extension is not connected. Open Edge and ensure the Edge Control extension is loaded."
}

exit 0
