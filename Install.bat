@echo off
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File ".\scripts\install.ps1"
if errorlevel 1 goto :end
powershell -NoProfile -ExecutionPolicy Bypass -File ".\scripts\start-workspace.ps1"
:end
echo.
pause
