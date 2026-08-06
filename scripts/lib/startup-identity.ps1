function Resolve-RoleFlowNormalizedPath {
  param([Parameter(Mandatory = $true)][string]$Path)
  if ([string]::IsNullOrWhiteSpace($Path)) {
    throw "Path identity is missing."
  }
  return [System.IO.Path]::GetFullPath($Path).TrimEnd(
    [char[]]@(
      [System.IO.Path]::DirectorySeparatorChar,
      [System.IO.Path]::AltDirectorySeparatorChar
    )
  )
}

function Get-RoleFlowListenerPid {
  param([Parameter(Mandatory = $true)][int]$Port)
  try {
    $connections = @(
      Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction Stop |
        Where-Object { $_.LocalAddress -eq "127.0.0.1" } |
        Select-Object -ExpandProperty OwningProcess -Unique
    )
  } catch {
    return $null
  }
  if ($connections.Count -ne 1) {
    return $null
  }
  $processId = 0
  if (-not [int]::TryParse([string]$connections[0], [ref]$processId) -or $processId -le 0) {
    return $null
  }
  return $processId
}

function Get-RoleFlowProcessIdentity {
  param([Parameter(Mandatory = $true)][int]$ProcessId)
  try {
    $process = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction Stop
  } catch {
    try {
      $process = Get-WmiObject -Class Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction Stop
    } catch {
      return $null
    }
  }
  return $process
}

function ConvertFrom-RoleFlowWindowsCommandLine {
  param([Parameter(Mandatory = $true)][string]$CommandLine)
  if (-not ("RoleFlow.CommandLineNative" -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

namespace RoleFlow {
  public static class CommandLineNative {
    [DllImport("shell32.dll", SetLastError = true)]
    public static extern IntPtr CommandLineToArgvW(
      [MarshalAs(UnmanagedType.LPWStr)] string commandLine,
      out int argumentCount
    );

    [DllImport("kernel32.dll")]
    public static extern IntPtr LocalFree(IntPtr value);
  }
}
'@
  }

  $argumentCount = 0
  $argumentPointer = [RoleFlow.CommandLineNative]::CommandLineToArgvW($CommandLine, [ref]$argumentCount)
  if ($argumentPointer -eq [IntPtr]::Zero -or $argumentCount -lt 1) {
    throw "Process command line identity could not be parsed."
  }
  try {
    $arguments = @()
    for ($index = 0; $index -lt $argumentCount; $index += 1) {
      $valuePointer = [System.Runtime.InteropServices.Marshal]::ReadIntPtr(
        $argumentPointer,
        $index * [IntPtr]::Size
      )
      $arguments += [System.Runtime.InteropServices.Marshal]::PtrToStringUni($valuePointer)
    }
    return $arguments
  } finally {
    [void][RoleFlow.CommandLineNative]::LocalFree($argumentPointer)
  }
}

function Assert-RoleFlowPortableEdgeListenerIdentity {
  param(
    [Parameter(Mandatory = $true)][int]$Port,
    [Parameter(Mandatory = $true)][string]$ProfilePath
  )
  $listenerProcessId = Get-RoleFlowListenerPid -Port $Port
  if ($null -eq $listenerProcessId) {
    throw "Portable Edge identity check failed on port ${Port}: listener PID could not be confirmed."
  }
  $process = Get-RoleFlowProcessIdentity -ProcessId $listenerProcessId
  if ($null -eq $process -or [string]::IsNullOrWhiteSpace([string]$process.CommandLine)) {
    throw "Portable Edge identity check failed on port ${Port}: listener process command line is unavailable."
  }
  $processName = [System.IO.Path]::GetFileNameWithoutExtension([string]$process.Name)
  if (-not [string]::Equals($processName, "msedge", [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Portable Edge identity check failed on port ${Port}: listener process is not msedge."
  }

  $processArguments = @(ConvertFrom-RoleFlowWindowsCommandLine -CommandLine ([string]$process.CommandLine))
  $addressArguments = @($processArguments | Where-Object {
    [string]::Equals($_, "--remote-debugging-address=127.0.0.1", [System.StringComparison]::OrdinalIgnoreCase)
  })
  $portArgument = "--remote-debugging-port=$Port"
  $portArguments = @($processArguments | Where-Object {
    [string]::Equals($_, $portArgument, [System.StringComparison]::OrdinalIgnoreCase)
  })
  $profileArguments = @($processArguments | Where-Object {
    ([string]$_).StartsWith("--user-data-dir=", [System.StringComparison]::OrdinalIgnoreCase)
  })
  if ($addressArguments.Count -ne 1 -or $portArguments.Count -ne 1 -or $profileArguments.Count -ne 1) {
    throw "Portable Edge identity check failed on port ${Port}: debugging address, port, or profile authority is missing or ambiguous."
  }

  $actualProfile = Resolve-RoleFlowNormalizedPath -Path (
    ([string]$profileArguments[0]).Substring("--user-data-dir=".Length)
  )
  $expectedProfile = Resolve-RoleFlowNormalizedPath -Path $ProfilePath
  if (-not [string]::Equals($actualProfile, $expectedProfile, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Portable Edge identity check failed on port ${Port}: listener uses a different profile."
  }
  return $listenerProcessId
}
