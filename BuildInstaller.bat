@echo off
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\scripts\build-installer.ps1" %*
if errorlevel 1 pause
