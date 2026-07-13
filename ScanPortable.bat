@echo off
cd /d "%~dp0"
set /p KEYWORDS=Keywords, comma separated, default AI:
if "%KEYWORDS%"=="" set KEYWORDS=AI
powershell -NoProfile -ExecutionPolicy Bypass -File ".\scripts\scan-portable.ps1" -Keywords "%KEYWORDS%" -MaxCards 60 -DetailLimit 5
echo.
pause
