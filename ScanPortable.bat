@echo off
cd /d "%~dp0"
set /p PLAN_ID=Search Plan ID:
if "%PLAN_ID%"=="" (
  echo Search Plan ID is required. Create and save a plan in the dashboard first.
  goto :end
)
powershell -NoProfile -ExecutionPolicy Bypass -File ".\scripts\scan-portable.ps1" -PlanId "%PLAN_ID%"
:end
echo.
pause
