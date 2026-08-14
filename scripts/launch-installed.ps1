[CmdletBinding()]
param(
  [int]$Port = 8787
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$LogDir = Join-Path $ProjectRoot ".runtime\logs"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$LogPath = Join-Path $LogDir "launcher.log"
$StartScript = Join-Path $PSScriptRoot "start-workspace.ps1"

function Show-RoleFlowError {
  param([string]$Reason)
  Add-Type -AssemblyName System.Windows.Forms
  $Message = @"
RoleFlow 启动失败。

$Reason

请按提示检查 Microsoft Edge 和浏览器连接组件，然后重试。
诊断日志：$LogPath
"@
  [void][System.Windows.Forms.MessageBox]::Show(
    $Message,
    "RoleFlow",
    [System.Windows.Forms.MessageBoxButtons]::OK,
    [System.Windows.Forms.MessageBoxIcon]::Error
  )
}

try {
  $Output = & powershell.exe `
    -NoProfile `
    -NonInteractive `
    -WindowStyle Hidden `
    -ExecutionPolicy Bypass `
    -File $StartScript `
    -Port $Port 2>&1
  $ExitCode = $LASTEXITCODE
  $Text = ($Output | Out-String).Trim()
  Add-Content -LiteralPath $LogPath -Encoding utf8 -Value (
    "{0:o} exit={1}`r`n{2}" -f (Get-Date), $ExitCode, $Text
  )
  if ($ExitCode -ne 0) {
    $Reason = ($Output | Select-Object -Last 1 | Out-String).Trim()
    if (-not $Reason) {
      $Reason = "启动组件返回错误代码 $ExitCode。"
    }
    Show-RoleFlowError -Reason $Reason
    exit $ExitCode
  }
} catch {
  Add-Content -LiteralPath $LogPath -Encoding utf8 -Value (
    "{0:o} launcher_error={1}" -f (Get-Date), $_.Exception.Message
  )
  Show-RoleFlowError -Reason $_.Exception.Message
  exit 1
}
