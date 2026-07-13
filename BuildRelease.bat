@echo off
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File ".\scripts\package-release.ps1" -IncludePortableNode
if errorlevel 1 pause
