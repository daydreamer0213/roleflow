[CmdletBinding()]
param(
  [string]$ProjectRoot = "",
  [string]$NodePath = "",
  [switch]$SkipEdgeCheck
)

$ErrorActionPreference = "Stop"
if (-not $ProjectRoot) {
  $ProjectRoot = Split-Path -Parent $PSScriptRoot
}
$ProjectRoot = [System.IO.Path]::GetFullPath($ProjectRoot).TrimEnd("\")
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
    "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    "C:\Program Files\Microsoft\Edge\Application\msedge.exe"
  )) {
    if (Test-Path -LiteralPath $Candidate) {
      return $Candidate
    }
  }
  $Command = Get-Command msedge -ErrorAction SilentlyContinue
  if ($null -ne $Command) {
    return $Command.Source
  }
  return $null
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

  if (-not $SkipEdgeCheck) {
    $Edge = Resolve-EdgePath
    if (-not $Edge) {
      throw "Microsoft Edge is not installed."
    }
    Write-CheckLog "Microsoft Edge detected."
  }

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
    "--db", ('"{0}"' -f $DatabasePath)
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
