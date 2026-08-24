[CmdletBinding()]
param(
  [string]$ProjectRoot = "",
  [string]$DataRoot = "",
  [string]$NodePath = "",
  [switch]$SkipEdgeCheck
)

$ErrorActionPreference = "Stop"
if (-not $ProjectRoot) {
  $ProjectRoot = Split-Path -Parent $PSScriptRoot
}
$ProjectRoot = [System.IO.Path]::GetFullPath($ProjectRoot).TrimEnd("\")
. (Join-Path $PSScriptRoot "lib\startup-identity.ps1")

if (-not $DataRoot) {
  if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
    throw "ROLEFLOW_LOCALAPPDATA_REQUIRED: 无法确定当前 Windows 用户的数据目录。"
  }
  if ($env:LOCALAPPDATA.StartsWith("\\", [System.StringComparison]::Ordinal)) {
    throw "ROLEFLOW_LOCALAPPDATA_UNC_REJECTED"
  }
  $DataRoot = Join-Path $env:LOCALAPPDATA "RoleFlow\Data"
}
if (-not [System.IO.Path]::IsPathRooted($DataRoot) -or $DataRoot.StartsWith("\\", [System.StringComparison]::Ordinal)) {
  throw "ROLEFLOW_DATA_ROOT_LOCAL_ABSOLUTE_REQUIRED"
}
$DataRoot = Resolve-RoleFlowNormalizedPath -Path $DataRoot
[void](Assert-RoleFlowPathHasNoReparsePoint -Path $ProjectRoot)
[void](Assert-RoleFlowPathHasNoReparsePoint -Path $DataRoot)

$RuntimeDir = Join-Path $DataRoot ".runtime"
$LogDir = Join-Path $RuntimeDir "logs"
$SelfCheckParent = Join-Path $RuntimeDir "self-check"
$SelfCheckDir = Join-Path $SelfCheckParent ("{0}-{1}" -f $PID, ([guid]::NewGuid().ToString("N")))
New-Item -ItemType Directory -Force -Path $LogDir, $SelfCheckDir | Out-Null
[void](Assert-RoleFlowPathHasNoReparsePoint -Path $LogDir -IncludeDescendants)
[void](Assert-RoleFlowPathHasNoReparsePoint -Path $SelfCheckDir -IncludeDescendants)
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
  if (Test-Path -LiteralPath $Candidate -PathType Leaf) {
    return $Candidate
  }
  throw "Bundled Node.js is missing: $Candidate"
}

function Resolve-EdgePath {
  $Candidates = @()
  foreach ($ProgramRoot in @(${env:ProgramFiles(x86)}, $env:ProgramFiles)) {
    if (-not [string]::IsNullOrWhiteSpace($ProgramRoot)) {
      $Candidates += (Join-Path $ProgramRoot "Microsoft\Edge\Application\msedge.exe")
    }
  }
  if (-not [string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
    $Candidates += (Join-Path $env:LOCALAPPDATA "Microsoft\Edge\Application\msedge.exe")
  }
  foreach ($Candidate in $Candidates) {
    if (Test-Path -LiteralPath $Candidate -PathType Leaf) {
      return [System.IO.Path]::GetFullPath($Candidate)
    }
  }
  return $null
}

function Assert-DirectoryCreatable {
  param([Parameter(Mandatory = $true)][string]$Directory)
  New-Item -ItemType Directory -Force -Path $Directory | Out-Null
  [void](Assert-RoleFlowPathHasNoReparsePoint -Path $Directory -IncludeDescendants)
  $Probe = Join-Path $Directory (".roleflow-write-{0}.tmp" -f ([guid]::NewGuid().ToString("N")))
  try {
    [System.IO.File]::WriteAllText($Probe, "RoleFlow self-check")
  } finally {
    if (Test-Path -LiteralPath $Probe -PathType Leaf) {
      Remove-Item -LiteralPath $Probe -Force
    }
  }
}

function Get-FreeLoopbackPort {
  for ($Attempt = 0; $Attempt -lt 128; $Attempt += 1) {
    $Candidate = Get-Random -Minimum 49152 -Maximum 65535
    $Listener = [System.Net.Sockets.TcpListener]::new(
      [System.Net.IPAddress]::Loopback,
      $Candidate
    )
    try {
      $Listener.Start()
      return $Candidate
    } catch [System.Net.Sockets.SocketException] {
      continue
    } finally {
      $Listener.Stop()
    }
  }
  throw "RoleFlow could not reserve a temporary local Dashboard port."
}

function Remove-SelfCheckDirectory {
  param(
    [Parameter(Mandatory = $true)][string]$Directory,
    [Parameter(Mandatory = $true)][string]$Parent
  )
  $ResolvedDirectory = Resolve-RoleFlowNormalizedPath -Path $Directory
  $ResolvedParent = Resolve-RoleFlowNormalizedPath -Path $Parent
  $Leaf = [System.IO.Path]::GetFileName($ResolvedDirectory)
  if (-not $ResolvedDirectory.StartsWith($ResolvedParent + "\", [System.StringComparison]::OrdinalIgnoreCase) -or
      $Leaf -notmatch '^\d+-[0-9a-f]{32}$') {
    throw "ROLEFLOW_SELF_CHECK_CLEANUP_PATH_UNSAFE"
  }
  if (-not (Test-Path -LiteralPath $ResolvedDirectory -PathType Container)) { return }
  [void](Assert-RoleFlowPathHasNoReparsePoint -Path $ResolvedDirectory -IncludeDescendants)
  Microsoft.PowerShell.Management\Remove-Item -LiteralPath $ResolvedDirectory -Recurse -Force -ErrorAction Stop
}

$DashboardProcess = $null
$DatabasePath = Join-Path $SelfCheckDir "dashboard.sqlite"
$StdOutPath = Join-Path $SelfCheckDir "dashboard.stdout.log"
$StdErrPath = Join-Path $SelfCheckDir "dashboard.stderr.log"

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
  if (-not (Test-Path -LiteralPath $Node -PathType Leaf)) {
    throw "Node.js is missing: $Node"
  }
  $VersionText = (& $Node -v | Out-String).Trim()
  if ($LASTEXITCODE -ne 0 -or $VersionText -notmatch "^v(\d+)\." -or [int]$Matches[1] -lt 22) {
    throw "RoleFlow requires Node.js 22 or newer."
  }

  Assert-DirectoryCreatable -Directory $DataRoot
  $StableProfile = Resolve-RoleFlowBrowserProfilePath -ProjectRoot $ProjectRoot
  Assert-DirectoryCreatable -Directory (Split-Path -Parent $StableProfile)

  if (-not $SkipEdgeCheck) {
    $Edge = Resolve-EdgePath
    if (-not $Edge) {
      throw "Microsoft Edge is not installed. Please install Microsoft Edge and run RoleFlow again."
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
    "--db", ('"{0}"' -f $DatabasePath),
    "--data-root", ('"{0}"' -f $DataRoot),
    "--browser", "edge",
    "--no-browser",
    "--no-startup-guidance",
    "--force-mock"
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
      $DashboardProcess.WaitForExit()
      throw "Dashboard self-check process exited before becoming ready (exit $($DashboardProcess.ExitCode))."
    }
    try {
      $Health = Invoke-RestMethod -Method Get -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 2
    } catch {
      $Health = $null
    }
  } while ($null -eq $Health -and (Get-Date) -lt $Deadline)

  if ($null -eq $Health) { throw "Dashboard self-check health endpoint did not respond." }
  if ($Health.ok -ne $true) { throw "Dashboard self-check health response was not ready." }
  if ([string]$Health.applicationStatus -ne "ready") { throw "Dashboard self-check application state was not ready." }
  if ([int]$Health.pid -ne [int]$DashboardProcess.Id) { throw "Dashboard self-check process identity did not match." }
  if (-not [string]::Equals(
      [System.IO.Path]::GetFullPath([string]$Health.projectRoot).TrimEnd("\"),
      $ProjectRoot,
      [System.StringComparison]::OrdinalIgnoreCase
    )) {
    throw "Dashboard self-check installation identity did not match."
  }

  Write-CheckLog "SELF_CHECK_OK Node=$VersionText Port=$Port"
  Write-Output "SELF_CHECK_OK"
} catch {
  $ChildOutput = @()
  foreach ($OutputPath in @($StdOutPath, $StdErrPath)) {
    if (Test-Path -LiteralPath $OutputPath -PathType Leaf) {
      $ChildOutput += (Get-Content -Raw -LiteralPath $OutputPath -ErrorAction SilentlyContinue)
    }
  }
  Write-CheckLog ("SELF_CHECK_FAILED {0} {1}" -f $_.Exception.Message, (($ChildOutput -join " ").Trim()))
  throw
} finally {
  if ($null -ne $DashboardProcess -and -not $DashboardProcess.HasExited) {
    Stop-Process -Id $DashboardProcess.Id -Force -ErrorAction SilentlyContinue
    Wait-Process -Id $DashboardProcess.Id -Timeout 5 -ErrorAction SilentlyContinue
  }
  Remove-SelfCheckDirectory -Directory $SelfCheckDir -Parent $SelfCheckParent
  if ((Test-Path -LiteralPath $SelfCheckParent -PathType Container) -and
      @(Get-ChildItem -LiteralPath $SelfCheckParent -Force).Count -eq 0) {
    Remove-Item -LiteralPath $SelfCheckParent -Force -ErrorAction SilentlyContinue
  }
}
