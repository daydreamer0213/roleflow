[CmdletBinding()]
param(
  [string]$ProjectRoot = "",
  [string]$NodePath = "",
  [switch]$SkipEdgeCheck,
  [ValidateRange(1, 65535)][int]$DashboardProbePort = 8787,
  [ValidateRange(1, 65535)][int]$CdpProbePort = 9222
)

$ErrorActionPreference = "Stop"
if (-not $ProjectRoot) {
  $ProjectRoot = Split-Path -Parent $PSScriptRoot
}
$ProjectRoot = [System.IO.Path]::GetFullPath($ProjectRoot).TrimEnd("\")
. (Join-Path $PSScriptRoot "lib\startup-identity.ps1")
$RuntimeDir = Join-Path $ProjectRoot ".runtime"
$LogDir = Join-Path $RuntimeDir "logs"
$SelfCheckDir = Join-Path $RuntimeDir "self-check"
New-Item -ItemType Directory -Force -Path $LogDir, $SelfCheckDir | Out-Null
$LogPath = Join-Path $LogDir "install-self-check.log"

function Write-CheckLog {
  param([string]$Message)
  $Line = "{0:o} {1}" -f (Get-Date), $Message
  Add-Content -LiteralPath $LogPath -Value $Line -Encoding utf8
}

function Resolve-InstalledNode {
  if ($NodePath) {
    return [System.IO.Path]::GetFullPath($NodePath)
  }
  $Candidate = Join-Path $ProjectRoot "runtime\node\node.exe"
  if (Test-Path -LiteralPath $Candidate) {
    return $Candidate
  }
  throw "Bundled Node.js is missing: $Candidate"
}

function Resolve-EdgePath {
  foreach ($Candidate in @(
    (Join-Path ${env:ProgramFiles(x86)} "Microsoft\Edge\Application\msedge.exe"),
    (Join-Path $env:ProgramFiles "Microsoft\Edge\Application\msedge.exe")
  )) {
    if ($Candidate -and (Test-Path -LiteralPath $Candidate -PathType Leaf)) {
      return $Candidate
    }
  }
  return $null
}

function Test-LoopbackPortOpen {
  param([Parameter(Mandatory = $true)][int]$Port)
  $Client = [System.Net.Sockets.TcpClient]::new()
  try {
    $Connect = $Client.ConnectAsync("127.0.0.1", $Port)
    if (-not $Connect.Wait(500)) {
      return $false
    }
    return $Client.Connected
  } catch {
    return $false
  } finally {
    $Client.Dispose()
  }
}

function Assert-DashboardProbeConflict {
  param(
    [Parameter(Mandatory = $true)][int]$Port,
    [Parameter(Mandatory = $true)][string]$StableProfile
  )
  if (-not (Test-LoopbackPortOpen -Port $Port)) {
    return
  }
  try {
    $Health = Invoke-RestMethod -Method Get -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 2
  } catch {
    throw "Dashboard probe port $Port has an ambiguous listener."
  }
  $ActualAuthority = $Health.browserAuthority
  if ($Health.ok -ne $true -or
      [string]::IsNullOrWhiteSpace([string]$Health.projectRoot) -or
      $null -eq $ActualAuthority -or
      -not [string]::Equals(
        (Resolve-RoleFlowNormalizedPath -Path ([string]$Health.projectRoot)),
        $ProjectRoot,
        [System.StringComparison]::OrdinalIgnoreCase
      ) -or
      -not [string]::Equals(
        [string]$ActualAuthority.browserMode,
        "portable",
        [System.StringComparison]::OrdinalIgnoreCase
      ) -or
      [int]$ActualAuthority.cdpPort -ne 9222 -or
      [string]::IsNullOrWhiteSpace([string]$ActualAuthority.profilePath) -or
      -not [string]::Equals(
        (Resolve-RoleFlowNormalizedPath -Path ([string]$ActualAuthority.profilePath)),
        $StableProfile,
        [System.StringComparison]::OrdinalIgnoreCase
      )) {
    throw "Dashboard probe port $Port is occupied by a different authority."
  }
}

function Assert-CdpProbeConflict {
  param(
    [Parameter(Mandatory = $true)][int]$Port,
    [Parameter(Mandatory = $true)][string]$StableProfile,
    [string]$EdgePath
  )
  if (-not (Test-LoopbackPortOpen -Port $Port)) {
    return
  }
  if (-not $EdgePath) {
    throw "CDP probe port $Port is occupied, but installed Microsoft Edge could not be resolved."
  }
  [void](Assert-RoleFlowPortableEdgeListenerIdentity `
    -Port $Port `
    -ProfilePath $StableProfile `
    -EdgePath $EdgePath)
}

function Get-FreeLoopbackPort {
  $Listener = [System.Net.Sockets.TcpListener]::new(
    [System.Net.IPAddress]::Loopback,
    0
  )
  $Listener.Start()
  try {
    return ([System.Net.IPEndPoint]$Listener.LocalEndpoint).Port
  } finally {
    $Listener.Stop()
  }
}

$DashboardProcess = $null
$DatabasePath = Join-Path $SelfCheckDir ("dashboard-{0}.sqlite" -f $PID)
$StdOutPath = Join-Path $SelfCheckDir ("dashboard-{0}.stdout.log" -f $PID)
$StdErrPath = Join-Path $SelfCheckDir ("dashboard-{0}.stderr.log" -f $PID)

try {
  foreach ($RelativePath in @(
    "package.json",
    "LICENSE",
    "NOTICE",
    "src\cli.js",
    "scripts\start-workspace.ps1",
    "node_modules\pdfjs-dist\legacy\build\pdf.mjs"
  )) {
    $RequiredPath = Join-Path $ProjectRoot $RelativePath
    if (-not (Test-Path -LiteralPath $RequiredPath)) {
      throw "Required installed file is missing: $RelativePath"
    }
  }

  $Node = Resolve-InstalledNode
  if (-not (Test-Path -LiteralPath $Node)) {
    throw "Node.js is missing: $Node"
  }
  $VersionText = & $Node -v
  if ($LASTEXITCODE -ne 0 -or $VersionText -notmatch "^v(\d+)\." -or [int]$Matches[1] -lt 22) {
    throw "RoleFlow requires Node.js 22 or newer."
  }

  $StableProfile = Resolve-RoleFlowBrowserProfilePath -ProjectRoot $ProjectRoot
  $StableProfileParent = Resolve-RoleFlowNormalizedPath -Path (Split-Path -Parent $StableProfile)
  New-Item -ItemType Directory -Force -Path $StableProfileParent | Out-Null
  $WriteProbe = Join-Path $StableProfileParent (".self-check-write-{0}.tmp" -f ([guid]::NewGuid().ToString("N")))
  try {
    [System.IO.File]::WriteAllText($WriteProbe, "RoleFlow self-check")
  } finally {
    if (Test-Path -LiteralPath $WriteProbe) {
      Remove-Item -LiteralPath $WriteProbe -Force
    }
  }

  $Edge = Resolve-EdgePath
  if (-not $SkipEdgeCheck) {
    if (-not $Edge) {
      throw "Microsoft Edge is not installed."
    }
    Write-CheckLog "Microsoft Edge detected."
  }

  Assert-DashboardProbeConflict -Port $DashboardProbePort -StableProfile $StableProfile
  Assert-CdpProbeConflict -Port $CdpProbePort -StableProfile $StableProfile -EdgePath $Edge

  & $Node -e "require.resolve('pdfjs-dist/legacy/build/pdf.mjs', { paths: [process.argv[1]] })" $ProjectRoot
  if ($LASTEXITCODE -ne 0) {
    throw "Production dependencies could not be loaded."
  }

  $Port = Get-FreeLoopbackPort
  $Arguments = @(
    "--disable-warning=ExperimentalWarning",
    ('"{0}"' -f (Join-Path $ProjectRoot "src\cli.js")),
    "dashboard",
    "--port", [string]$Port,
    "--db", ('"{0}"' -f $DatabasePath),
    "--browser", "portable",
    "--cdp-port", "9222",
    "--browser-profile", ('"{0}"' -f $StableProfile)
  )
  $DashboardProcess = Start-Process `
    -FilePath $Node `
    -ArgumentList $Arguments `
    -WorkingDirectory $ProjectRoot `
    -WindowStyle Hidden `
    -RedirectStandardOutput $StdOutPath `
    -RedirectStandardError $StdErrPath `
    -PassThru

  $Deadline = (Get-Date).AddSeconds(15)
  $Health = $null
  do {
    Start-Sleep -Milliseconds 250
    if ($DashboardProcess.HasExited) {
      throw "Dashboard self-check process exited before becoming ready."
    }
    try {
      $Health = Invoke-RestMethod -Method Get -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 2
    } catch {
      $Health = $null
    }
  } while ($null -eq $Health -and (Get-Date) -lt $Deadline)

  if ($null -eq $Health -or
      $Health.ok -ne $true -or
      [int]$Health.pid -ne [int]$DashboardProcess.Id -or
      -not [string]::Equals(
        [System.IO.Path]::GetFullPath([string]$Health.projectRoot).TrimEnd("\"),
        $ProjectRoot,
        [System.StringComparison]::OrdinalIgnoreCase
      ) -or
      $null -eq $Health.browserAuthority -or
      -not [string]::Equals(
        [string]$Health.browserAuthority.browserMode,
        "portable",
        [System.StringComparison]::OrdinalIgnoreCase
      ) -or
      [int]$Health.browserAuthority.cdpPort -ne 9222 -or
      -not [string]::Equals(
        (Resolve-RoleFlowNormalizedPath -Path ([string]$Health.browserAuthority.profilePath)),
        $StableProfile,
        [System.StringComparison]::OrdinalIgnoreCase
      )) {
    throw "Dashboard did not pass the isolated startup identity check."
  }

  Write-CheckLog "SELF_CHECK_OK Node=$VersionText Port=$Port"
  Write-Output "SELF_CHECK_OK"
} catch {
  Write-CheckLog ("SELF_CHECK_FAILED {0}" -f $_.Exception.Message)
  throw
} finally {
  if ($null -ne $DashboardProcess -and -not $DashboardProcess.HasExited) {
    Stop-Process -Id $DashboardProcess.Id -Force -ErrorAction SilentlyContinue
    Wait-Process -Id $DashboardProcess.Id -Timeout 5 -ErrorAction SilentlyContinue
  }
  foreach ($Path in @(
    $DatabasePath,
    "$DatabasePath-wal",
    "$DatabasePath-shm",
    $StdOutPath,
    $StdErrPath
  )) {
    if (Test-Path -LiteralPath $Path) {
      Remove-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
    }
  }
}
