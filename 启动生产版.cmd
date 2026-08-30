@echo off
setlocal EnableExtensions
title OMP Studio Production Preview
cd /d "%~dp0"

echo.
echo  OMP Studio - Production Preview
echo  ==============================
echo.

where node.exe >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js was not found.
  echo Install Node.js 22 or newer, then double-click this file again.
  echo.
  pause
  exit /b 1
)

where npm.cmd >nul 2>nul
if errorlevel 1 (
  echo [ERROR] npm was not found.
  echo Reinstall Node.js with npm enabled, then try again.
  echo.
  pause
  exit /b 1
)

if not exist "node_modules\electron\package.json" (
  echo [setup] Installing dependencies. This is needed only on the first run...
  call npm.cmd install
  if errorlevel 1 goto :failed
)

echo [start] Building and opening OMP Studio (production bundle). Please wait...
set "OMP_PREVIEW_MODE=production"
set "OMP_NPM_CLI=%ProgramFiles%\nodejs\node_modules\npm\bin\npm-cli.js"
if not exist "%OMP_NPM_CLI%" set "OMP_NPM_CLI=%ProgramFiles(x86)%\nodejs\node_modules\npm\bin\npm-cli.js"
if not exist "%OMP_NPM_CLI%" (
  echo [ERROR] npm CLI was not found under the Node.js installation.
  echo Expected: "%ProgramFiles%\nodejs\node_modules\npm\bin\npm-cli.js"
  echo.
  pause
  exit /b 1
)
node.exe scripts\preview.mjs
set "PREVIEW_EXIT=%ERRORLEVEL%"

if not "%PREVIEW_EXIT%"=="0" goto :failed_code
exit /b 0

:failed
set "PREVIEW_EXIT=%ERRORLEVEL%"

:failed_code
echo.
echo [ERROR] Preview failed with exit code %PREVIEW_EXIT%.
echo Review the messages above, then press any key to close this window.
echo.
pause >nul
exit /b %PREVIEW_EXIT%
