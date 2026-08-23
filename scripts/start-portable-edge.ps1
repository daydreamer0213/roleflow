[CmdletBinding()]
param(
  [string]$EdgePath = "",
  [int]$Port = 9222,
  [string]$ProfileDir = "",
  [string]$StartUrl = "https://www.zhipin.com/web/geek/jobs",
  [switch]$CheckOnly,
  [int]$TimeoutSeconds = 15
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot "lib\startup-identity.ps1")
# New-RoleFlowPortableEdgeArguments supplies --remote-debugging-address=127.0.0.1.

function Resolve-EdgePath {
  if ($EdgePath -and (Test-Path -LiteralPath $EdgePath)) {
    return Resolve-RoleFlowNormalizedPath -Path (Resolve-Path -LiteralPath $EdgePath).Path
  }
  if ($EdgePath) { throw "Caller-trusted -EdgePath does not exist: $EdgePath" }

  $Candidates = @()
  if (${env:ProgramFiles(x86)}) { $Candidates += (Join-Path ${env:ProgramFiles(x86)} "Microsoft\Edge\Application\msedge.exe") }
  if ($env:ProgramFiles) { $Candidates += (Join-Path $env:ProgramFiles "Microsoft\Edge\Application\msedge.exe") }
  foreach ($Candidate in $Candidates) {
    if (Test-Path -LiteralPath $Candidate) {
      return Resolve-RoleFlowNormalizedPath -Path $Candidate
    }
  }
  throw "Microsoft Edge not found in standard installation paths. Install Edge or pass caller-trusted -EdgePath."
}

function Get-CdpVersion {
  try {
    return Invoke-RestMethod -Method Get -Uri "http://127.0.0.1:$Port/json/version" -TimeoutSec 2
  } catch {
    return $null
  }
}

$ProfilePath = Resolve-RoleFlowBrowserProfilePath -ProjectRoot $ProjectRoot -ProfileDir $ProfileDir
$ResolvedEdgePath = Resolve-EdgePath
$ListenerSnapshot = Get-RoleFlowTcpListenerSnapshot -Port $Port
if (-not $ListenerSnapshot.querySucceeded) {
  throw "PORTABLE_EDGE_LISTENER_ENUMERATION_FAILED: could not inspect port $Port."
}
$ProcessQuerySnapshot = Get-RoleFlowEdgeProcessSnapshot
$HasPortOwner = @($ListenerSnapshot.listeners).Count -gt 0
$Version = Get-CdpVersion

if ($HasPortOwner -and $null -eq $Version) {
  throw "PORTABLE_EDGE_PORT_OCCUPIED_NOT_CDP: port $Port is already owned but /json/version is not a valid CDP responder."
}
if (-not $HasPortOwner -and $null -ne $Version) {
  throw "PORTABLE_EDGE_LISTENER_SNAPSHOT_MISMATCH: CDP responded without a listener snapshot on port $Port."
}
if ($null -eq $Version -and $CheckOnly) {
  throw "Portable Edge CDP is not running on port $Port."
}

if ($null -ne $Version) {
  [void](Assert-RoleFlowPortableEdgeListenerSnapshot -ListenerSnapshot $ListenerSnapshot -ProcessQuerySnapshot $ProcessQuerySnapshot -EdgePath $ResolvedEdgePath -Port $Port -ProfilePath $ProfilePath)
}

if ($null -eq $Version) {
  [void](Assert-RoleFlowBrowserProfileNotInUse -ProfilePath $ProfilePath -ProcessQuerySnapshot $ProcessQuerySnapshot)
  New-Item -ItemType Directory -Force -Path $ProfilePath | Out-Null

  $Args = New-RoleFlowPortableEdgeArguments -Port $Port -ProfilePath $ProfilePath -StartUrl $StartUrl

  Start-Process -FilePath $ResolvedEdgePath -ArgumentList $Args -WorkingDirectory $ProjectRoot | Out-Null

  $Deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  do {
    Start-Sleep -Milliseconds 500
    $Version = Get-CdpVersion
  } while ($null -eq $Version -and (Get-Date) -lt $Deadline)

  if ($null -eq $Version) {
    throw "Started Edge, but CDP did not become ready on port $Port."
  }
  [void](Assert-RoleFlowPortableEdgeListenerIdentity -Port $Port -ProfilePath $ProfilePath -EdgePath $ResolvedEdgePath)
}

Write-Host "Portable Edge CDP: healthy"
Write-Host "CDP URL: http://127.0.0.1:$Port"
Write-Host "Profile dir: $ProfilePath"
Write-Host "Browser: $($Version.Browser)"
Write-Host "RoleFlow 专用 Edge（推荐）已就绪。首次使用请登录 BOSS，并保留一个 BOSS 搜索结果页。"

exit 0
