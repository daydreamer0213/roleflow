#ifndef StageDir
  #error StageDir must be provided by scripts\build-installer.ps1
#endif
#ifndef AppVersion
  #error AppVersion must be provided by scripts\build-installer.ps1
#endif
#ifndef OutputDir
  #define OutputDir "..\dist"
#endif

#define PowerShellExe "{sys}\WindowsPowerShell\v1.0\powershell.exe"

[Setup]
AppId={{D44A88E4-76A8-46C1-A83D-C25BF218412C}
AppName=RoleFlow
AppVersion={#AppVersion}
AppPublisher=RoleFlow contributors
AppPublisherURL=https://github.com/daydreamer0213/roleflow
AppSupportURL=https://github.com/daydreamer0213/roleflow/issues
AppUpdatesURL=https://github.com/daydreamer0213/roleflow/releases
DefaultDirName={localappdata}\Programs\RoleFlow
DisableDirPage=no
UsePreviousAppDir=yes
DefaultGroupName=RoleFlow
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
LicenseFile={#StageDir}\LICENSE
SetupIconFile={#StageDir}\assets\RoleFlow.ico
OutputDir={#OutputDir}
OutputBaseFilename=RoleFlow-Setup-{#AppVersion}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
SetupLogging=yes
UninstallDisplayName=RoleFlow
UninstallDisplayIcon={app}\assets\RoleFlow.ico
CloseApplications=no
RestartApplications=no

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式"; GroupDescription: "快捷方式："; Flags: checkedonce

[InstallDelete]
Type: files; Name: "{app}\src\adapters\browser\index.js"
Type: files; Name: "{app}\src\core\llm.js"

[Files]
Source: "{#StageDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\RoleFlow"; Filename: "{#PowerShellExe}"; Parameters: "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File ""{app}\scripts\launch-installed.ps1"""; WorkingDir: "{app}"; IconFilename: "{app}\assets\RoleFlow.ico"
Name: "{group}\RoleFlow 使用说明"; Filename: "{app}\README.md"; WorkingDir: "{app}"
Name: "{group}\卸载 RoleFlow"; Filename: "{uninstallexe}"
Name: "{autodesktop}\RoleFlow"; Filename: "{#PowerShellExe}"; Parameters: "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File ""{app}\scripts\launch-installed.ps1"""; WorkingDir: "{app}"; IconFilename: "{app}\assets\RoleFlow.ico"; Tasks: desktopicon

[Run]
Filename: "{#PowerShellExe}"; Parameters: "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File ""{app}\scripts\launch-installed.ps1"""; Description: "启动 RoleFlow"; WorkingDir: "{app}"; Flags: nowait postinstall skipifsilent runhidden
Filename: "{app}\README.md"; Description: "查看 RoleFlow 使用说明"; Flags: postinstall shellexec skipifsilent unchecked

[Code]
function RunPowerShellScript(const ScriptName, Arguments: String; var ResultCode: Integer): Boolean;
var
  CommandLine: String;
begin
  CommandLine :=
    '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' +
    ExpandConstant('{app}\scripts\' + ScriptName) + '" ' + Arguments;
  Result := Exec(
    ExpandConstant('{#PowerShellExe}'),
    CommandLine,
    ExpandConstant('{app}'),
    SW_HIDE,
    ewWaitUntilTerminated,
    ResultCode
  );
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ResultCode: Integer;
begin
  Result := '';
  if FileExists(ExpandConstant('{app}\scripts\prepare-uninstall.ps1')) then
  begin
    if (not RunPowerShellScript(
      'prepare-uninstall.ps1',
      '-InstallRoot "' + ExpandConstant('{app}') + '" -SkipDeletePrompt',
      ResultCode
    )) or (ResultCode <> 0) then
      Result := 'RoleFlow 正在运行，且无法安全停止。请关闭 RoleFlow 后重试安装。';
  end;
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  ResultCode: Integer;
begin
  if CurStep = ssPostInstall then
  begin
    WizardForm.StatusLabel.Caption := '正在准备 RoleFlow 用户数据…';
    if (not RunPowerShellScript(
      'prepare-user-data.ps1',
      '-InstallRoot "' + ExpandConstant('{app}') + '"',
      ResultCode
    )) or (ResultCode <> 0) then
      RaiseException(
        'RoleFlow 无法安全准备用户数据。安装文件没有被当作用户数据使用，请查看安装日志。'
      );
    WizardForm.StatusLabel.Caption := '正在检查 RoleFlow 本地运行环境…';
    if (not RunPowerShellScript(
      'installed-self-check.ps1',
      '-ProjectRoot "' + ExpandConstant('{app}') + '"',
      ResultCode
    )) or (ResultCode <> 0) then
      RaiseException(
        'RoleFlow 环境自检未通过。请确认已安装 Microsoft Edge；详细信息位于当前用户的 RoleFlow 数据目录：.runtime\logs\install-self-check.log。'
      );
  end;
end;

function InitializeUninstall(): Boolean;
var
  ResultCode: Integer;
  Arguments: String;
begin
  Arguments := '-InstallRoot "' + ExpandConstant('{app}') + '"';
  if UninstallSilent then
    Arguments := Arguments + ' -SkipDeletePrompt'
  else
    Arguments := Arguments + ' -PromptDeleteUserData -PromptDeleteBrowserProfile';
  Result := RunPowerShellScript(
    'prepare-uninstall.ps1',
    Arguments,
    ResultCode
  ) and (ResultCode = 0);
  if not Result then
    MsgBox(
      'RoleFlow 无法确认运行进程已经安全停止，因此没有开始卸载。',
      mbError,
      MB_OK
    );
end;
