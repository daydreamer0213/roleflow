function Resolve-RoleFlowNormalizedPath {
  param([Parameter(Mandatory = $true)][string]$Path)
  if ([string]::IsNullOrWhiteSpace($Path)) { throw "Path identity is missing." }
  return [System.IO.Path]::GetFullPath($Path).TrimEnd([char[]]@([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar))
}

function Resolve-RoleFlowBrowserProfilePath {
  param([Parameter(Mandatory = $true)][string]$ProjectRoot, [string]$ProfileDir = "", [string]$LocalAppDataPath = $env:LOCALAPPDATA)
  if ($ProfileDir) {
    $Candidate = if ([System.IO.Path]::IsPathRooted($ProfileDir)) { $ProfileDir } else { Join-Path $ProjectRoot $ProfileDir }
    return Resolve-RoleFlowNormalizedPath -Path $Candidate
  }
  if ([string]::IsNullOrWhiteSpace($LocalAppDataPath)) { throw "RoleFlow browser profile requires LOCALAPPDATA or an explicit -ProfileDir." }
  return Resolve-RoleFlowNormalizedPath -Path (Join-Path $LocalAppDataPath "RoleFlow\BrowserProfile")
}

function Test-RoleFlowPathOverlap {
  param(
    [Parameter(Mandatory = $true)][string]$FirstPath,
    [Parameter(Mandatory = $true)][string]$SecondPath
  )
  $First = Resolve-RoleFlowNormalizedPath -Path $FirstPath
  $Second = Resolve-RoleFlowNormalizedPath -Path $SecondPath
  return [string]::Equals($First, $Second, [System.StringComparison]::OrdinalIgnoreCase) -or
    $First.StartsWith($Second + "\", [System.StringComparison]::OrdinalIgnoreCase) -or
    $Second.StartsWith($First + "\", [System.StringComparison]::OrdinalIgnoreCase)
}

function Assert-RoleFlowPathHasNoReparsePoint {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [switch]$IncludeDescendants
  )
  $NormalizedPath = Resolve-RoleFlowNormalizedPath -Path $Path
  $Root = [System.IO.Path]::GetPathRoot($NormalizedPath)
  if ([string]::IsNullOrWhiteSpace($Root)) {
    throw "ROLEFLOW_REPARSE_POINT_CHECK_FAILED: $NormalizedPath"
  }

  try {
    $Current = Get-Item -LiteralPath $Root -Force -ErrorAction Stop
    if (($Current.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "ROLEFLOW_REPARSE_POINT_BLOCKED: $($Current.FullName)"
    }
    $RelativePath = $NormalizedPath.Substring($Root.Length)
    foreach ($Segment in @($RelativePath.Split([char[]]@('\', '/'), [System.StringSplitOptions]::RemoveEmptyEntries))) {
      if (-not $Current.PSIsContainer) { break }
      $Matches = @(
        Get-ChildItem -LiteralPath $Current.FullName -Force -ErrorAction Stop |
          Where-Object { [string]::Equals($_.Name, $Segment, [System.StringComparison]::OrdinalIgnoreCase) }
      )
      if ($Matches.Count -eq 0) { return $true }
      if ($Matches.Count -ne 1) { throw "ROLEFLOW_REPARSE_POINT_CHECK_FAILED: $NormalizedPath" }
      $Current = $Matches[0]
      if (($Current.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "ROLEFLOW_REPARSE_POINT_BLOCKED: $($Current.FullName)"
      }
    }

    if ($IncludeDescendants -and
        [string]::Equals(
          (Resolve-RoleFlowNormalizedPath -Path $Current.FullName),
          $NormalizedPath,
          [System.StringComparison]::OrdinalIgnoreCase
        ) -and
        $Current.PSIsContainer) {
      $Pending = [System.Collections.Stack]::new()
      $Pending.Push($Current)
      while ($Pending.Count -gt 0) {
        $Directory = $Pending.Pop()
        foreach ($Child in @(Get-ChildItem -LiteralPath $Directory.FullName -Force -ErrorAction Stop)) {
          if (($Child.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "ROLEFLOW_REPARSE_POINT_BLOCKED: $($Child.FullName)"
          }
          if ($Child.PSIsContainer) { $Pending.Push($Child) }
        }
      }
    }
  } catch {
    if ($_.Exception.Message -like "ROLEFLOW_REPARSE_POINT_*") { throw }
    throw "ROLEFLOW_REPARSE_POINT_CHECK_FAILED: $NormalizedPath"
  }
  return $true
}

function New-RoleFlowPortableEdgeArguments {
  param([int]$Port, [string]$ProfilePath, [string]$StartUrl)
  @("--remote-debugging-address=127.0.0.1", "--remote-debugging-port=$Port", "--remote-allow-origins=*", ('"--user-data-dir={0}"' -f (Resolve-RoleFlowNormalizedPath -Path $ProfilePath)), "--no-first-run", "--no-default-browser-check", $StartUrl)
}

function ConvertFrom-RoleFlowWindowsCommandLine {
  param([Parameter(Mandatory = $true)][string]$CommandLine)
  if (-not ("RoleFlow.CommandLineNative" -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
namespace RoleFlow {
  public static class CommandLineNative {
    [DllImport("shell32.dll", SetLastError = true)] public static extern IntPtr CommandLineToArgvW([MarshalAs(UnmanagedType.LPWStr)] string commandLine, out int argumentCount);
    [DllImport("kernel32.dll")] public static extern IntPtr LocalFree(IntPtr value);
  }
}
'@
  }
  $argumentCount = 0
  $argumentPointer = [RoleFlow.CommandLineNative]::CommandLineToArgvW($CommandLine, [ref]$argumentCount)
  if ($argumentPointer -eq [IntPtr]::Zero -or $argumentCount -lt 1) { throw "Process command line identity could not be parsed." }
  try {
    $arguments = @()
    for ($index = 0; $index -lt $argumentCount; $index += 1) {
      $valuePointer = [System.Runtime.InteropServices.Marshal]::ReadIntPtr($argumentPointer, $index * [IntPtr]::Size)
      $arguments += [System.Runtime.InteropServices.Marshal]::PtrToStringUni($valuePointer)
    }
    return $arguments
  } finally { [void][RoleFlow.CommandLineNative]::LocalFree($argumentPointer) }
}

function Get-RoleFlowCommandLineArguments {
  param([Parameter(Mandatory = $true)][string]$CommandLine)
  if ([string]::IsNullOrWhiteSpace($CommandLine)) { throw "Portable Edge process command line is unavailable." }
  return @(ConvertFrom-RoleFlowWindowsCommandLine -CommandLine $CommandLine)
}

function Assert-RoleFlowPortableEdgeProcessSnapshot {
  param([Parameter(Mandatory = $true)][string]$ProcessName, [Parameter(Mandatory = $true)][string]$ExecutablePath, [Parameter(Mandatory = $true)][string]$CommandLine, [Parameter(Mandatory = $true)][string]$EdgePath, [Parameter(Mandatory = $true)][int]$Port, [Parameter(Mandatory = $true)][string]$ProfilePath)
  if (-not [string]::Equals([System.IO.Path]::GetFileName($ProcessName), "msedge.exe", [System.StringComparison]::OrdinalIgnoreCase)) { throw "Portable Edge identity check failed on port ${Port}: listener process is not msedge." }
  if ([string]::IsNullOrWhiteSpace($ExecutablePath)) { throw "Portable Edge identity check failed on port ${Port}: listener executable path is unavailable." }
  if (-not [string]::Equals((Resolve-RoleFlowNormalizedPath -Path $ExecutablePath), (Resolve-RoleFlowNormalizedPath -Path $EdgePath), [System.StringComparison]::OrdinalIgnoreCase)) { throw "Portable Edge identity check failed on port ${Port}: listener uses a different executable." }
  $processArguments = Get-RoleFlowCommandLineArguments -CommandLine $CommandLine
  $addressArguments = @($processArguments | Where-Object { ([string]$_).StartsWith("--remote-debugging-address=", [System.StringComparison]::OrdinalIgnoreCase) })
  if ($addressArguments.Count -ne 1 -or -not [string]::Equals($addressArguments[0], "--remote-debugging-address=127.0.0.1", [System.StringComparison]::OrdinalIgnoreCase)) { throw "Portable Edge identity check failed on port ${Port}: listener must use one loopback address argument." }
  $portArgument = "--remote-debugging-port=$Port"
  $portArguments = @($processArguments | Where-Object { ([string]$_).StartsWith("--remote-debugging-port=", [System.StringComparison]::OrdinalIgnoreCase) })
  if ($portArguments.Count -ne 1 -or -not [string]::Equals($portArguments[0], $portArgument, [System.StringComparison]::OrdinalIgnoreCase)) { throw "Portable Edge identity check failed on port ${Port}: listener uses a different port." }
  $profileArguments = @($processArguments | Where-Object { ([string]$_).StartsWith("--user-data-dir=", [System.StringComparison]::OrdinalIgnoreCase) })
  if ($profileArguments.Count -ne 1) { throw "Portable Edge identity check failed on port ${Port}: listener profile authority is missing or ambiguous." }
  $actualProfile = Resolve-RoleFlowNormalizedPath -Path (([string]$profileArguments[0]).Substring("--user-data-dir=".Length))
  if (-not [string]::Equals($actualProfile, (Resolve-RoleFlowNormalizedPath -Path $ProfilePath), [System.StringComparison]::OrdinalIgnoreCase)) { throw "Portable Edge identity check failed on port ${Port}: listener uses a different profile." }
  return $true
}

function Get-RoleFlowTcpListenerSnapshot {
  param([Parameter(Mandatory = $true)][int]$Port)
  try {
    $listeners = @(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object { [int]$_.LocalPort -eq $Port } | ForEach-Object { [pscustomobject]@{ localAddress = [string]$_.LocalAddress; owningProcess = [int]$_.OwningProcess } })
    return [pscustomobject]@{ querySucceeded = $true; listeners = $listeners }
  } catch { return [pscustomobject]@{ querySucceeded = $false; listeners = @() } }
}

function Get-RoleFlowEdgeProcessSnapshot {
  try {
    try { $processes = @(Get-CimInstance -ClassName Win32_Process -Filter "Name = 'msedge.exe'" -ErrorAction Stop) } catch { $processes = @(Get-WmiObject -Class Win32_Process -Filter "Name = 'msedge.exe'" -ErrorAction Stop) }
    return [pscustomobject]@{ querySucceeded = $true; processes = @($processes | ForEach-Object { [pscustomobject]@{ ProcessId = [int]$_.ProcessId; ProcessName = [string]$_.Name; ExecutablePath = [string]$_.ExecutablePath; CommandLine = [string]$_.CommandLine } }) }
  } catch { return [pscustomobject]@{ querySucceeded = $false; processes = @() } }
}

function Assert-RoleFlowPortableEdgeListenerSnapshot {
  param([Parameter(Mandatory = $true)]$ListenerSnapshot, [Parameter(Mandatory = $true)]$ProcessQuerySnapshot, [Parameter(Mandatory = $true)][string]$EdgePath, [Parameter(Mandatory = $true)][int]$Port, [Parameter(Mandatory = $true)][string]$ProfilePath)
  if (-not $ListenerSnapshot.querySucceeded) { throw "Portable Edge identity check failed on port ${Port}: listener enumeration failed." }
  $listeners = @($ListenerSnapshot.listeners)
  if ($listeners.Count -ne 1 -or -not [string]::Equals([string]$listeners[0].localAddress, "127.0.0.1", [System.StringComparison]::OrdinalIgnoreCase)) { throw "Portable Edge identity check failed on port ${Port}: expected exactly one loopback listener." }
  $listenerProcessId = 0
  if (-not [int]::TryParse([string]$listeners[0].owningProcess, [ref]$listenerProcessId) -or $listenerProcessId -le 0) { throw "Portable Edge identity check failed on port ${Port}: listener PID could not be confirmed." }
  if (-not $ProcessQuerySnapshot.querySucceeded) { throw "Portable Edge identity check failed on port ${Port}: process enumeration failed." }
  $matches = @($ProcessQuerySnapshot.processes | Where-Object { [int]$_.ProcessId -eq $listenerProcessId })
  if ($matches.Count -ne 1) { throw "Portable Edge identity check failed on port ${Port}: listener process snapshot is missing or ambiguous." }
  [void](Assert-RoleFlowPortableEdgeProcessSnapshot -ProcessName ([string]$matches[0].ProcessName) -ExecutablePath ([string]$matches[0].ExecutablePath) -CommandLine ([string]$matches[0].CommandLine) -EdgePath $EdgePath -Port $Port -ProfilePath $ProfilePath)
  return $listenerProcessId
}

function Assert-RoleFlowPortableEdgeListenerIdentity {
  param([Parameter(Mandatory = $true)][int]$Port, [Parameter(Mandatory = $true)][string]$ProfilePath, [Parameter(Mandatory = $true)][string]$EdgePath)
  return Assert-RoleFlowPortableEdgeListenerSnapshot -ListenerSnapshot (Get-RoleFlowTcpListenerSnapshot -Port $Port) -ProcessQuerySnapshot (Get-RoleFlowEdgeProcessSnapshot) -EdgePath $EdgePath -Port $Port -ProfilePath $ProfilePath
}

function Assert-RoleFlowBrowserProfileNotInUse {
  param([Parameter(Mandatory = $true)][string]$ProfilePath, [Parameter(Mandatory = $true)]$ProcessQuerySnapshot)
  if (-not $ProcessQuerySnapshot.querySucceeded) { throw "RoleFlow browser profile check failed: Edge process enumeration failed." }
  $expectedProfile = Resolve-RoleFlowNormalizedPath -Path $ProfilePath
  foreach ($process in @($ProcessQuerySnapshot.processes)) {
    $SnapshotProcessName = [string]$process.ProcessName
    if ([string]::IsNullOrWhiteSpace($SnapshotProcessName)) { throw "RoleFlow browser profile check failed: an Edge process has incomplete identity." }
    if (-not [string]::Equals([System.IO.Path]::GetFileName($SnapshotProcessName), "msedge.exe", [System.StringComparison]::OrdinalIgnoreCase)) { continue }
    if ([string]::IsNullOrWhiteSpace([string]$process.ExecutablePath) -or [string]::IsNullOrWhiteSpace([string]$process.CommandLine)) { throw "RoleFlow browser profile check failed: an Edge process has incomplete identity." }
    $profileArguments = @(Get-RoleFlowCommandLineArguments -CommandLine ([string]$process.CommandLine) | Where-Object { ([string]$_).StartsWith("--user-data-dir=", [System.StringComparison]::OrdinalIgnoreCase) })
    if ($profileArguments.Count -gt 1) { throw "RoleFlow browser profile check failed: an Edge process has ambiguous profile authority." }
    if ($profileArguments.Count -eq 1) {
      $actualProfile = Resolve-RoleFlowNormalizedPath -Path (([string]$profileArguments[0]).Substring("--user-data-dir=".Length))
    } else {
      if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) { throw "RoleFlow browser profile check failed: the default Edge profile authority is unavailable." }
      $actualProfile = Resolve-RoleFlowNormalizedPath -Path (Join-Path $env:LOCALAPPDATA "Microsoft\Edge\User Data")
    }
    if (Test-RoleFlowPathOverlap -FirstPath $actualProfile -SecondPath $expectedProfile) { throw "RoleFlow browser profile is already in use by Edge." }
  }
  return $true
}

function Get-RoleFlowListenerPid {
  param([Parameter(Mandatory = $true)][int]$Port)
  $snapshot = Get-RoleFlowTcpListenerSnapshot -Port $Port
  if (-not $snapshot.querySucceeded -or @($snapshot.listeners).Count -ne 1) { return $null }
  $processId = 0
  if (-not [int]::TryParse([string]$snapshot.listeners[0].owningProcess, [ref]$processId) -or $processId -le 0) { return $null }
  return $processId
}
