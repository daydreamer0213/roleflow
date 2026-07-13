[CmdletBinding()]
param(
  [string]$EdgePath = "",
  [int]$Port = 9222,
  [string]$ProfileDir = ".runtime\edge-profile",
  [string]$StartUrl = "https://www.zhipin.com/guangzhou/?seoRefer=index",
  [switch]$CheckOnly,
  [int]$TimeoutSeconds = 15
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot

function Resolve-ProjectPath {
  param([string]$Value)
  if ([System.IO.Path]::IsPathRooted($Value)) {
    return $Value
  }
  return Join-Path $ProjectRoot $Value
}

function Resolve-EdgePath {
  if ($EdgePath -and (Test-Path -LiteralPath $EdgePath)) {
    return (Resolve-Path -LiteralPath $EdgePath).Path
  }

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

  throw "Microsoft Edge not found. Install Edge or pass -EdgePath."
}

function Get-CdpVersion {
  try {
    return Invoke-RestMethod -Method Get -Uri "http://127.0.0.1:$Port/json/version" -TimeoutSec 2
  } catch {
    return $null
  }
}

$ProfilePath = Resolve-ProjectPath -Value $ProfileDir
$Version = Get-CdpVersion

if ($null -eq $Version -and $CheckOnly) {
  throw "Portable Edge CDP is not running on port $Port."
}

if ($null -eq $Version) {
  $ResolvedEdgePath = Resolve-EdgePath
  New-Item -ItemType Directory -Force -Path $ProfilePath | Out-Null

  $Args = @(
    "--remote-debugging-port=$Port",
    "--remote-allow-origins=*",
    "--user-data-dir=$ProfilePath",
    "--no-first-run",
    "--no-default-browser-check",
    $StartUrl
  )

  Start-Process -FilePath $ResolvedEdgePath -ArgumentList $Args | Out-Null

  $Deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  do {
    Start-Sleep -Milliseconds 500
    $Version = Get-CdpVersion
  } while ($null -eq $Version -and (Get-Date) -lt $Deadline)

  if ($null -eq $Version) {
    throw "Started Edge, but CDP did not become ready on port $Port."
  }
}

Write-Host "Portable Edge CDP: healthy"
Write-Host "CDP URL: http://127.0.0.1:$Port"
Write-Host "Profile dir: $ProfilePath"
Write-Host "Browser: $($Version.Browser)"
Write-Host "First use: log in to BOSS in this Edge window once."

exit 0
