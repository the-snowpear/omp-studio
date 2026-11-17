@echo off
setlocal EnableExtensions
cd /d "%~dp0"

rem ---------------------------------------------------------------------------
rem  Say which launcher this window is before anything gets built, and keep the
rem  same label in the title bar so parallel windows stay distinguishable.
rem ---------------------------------------------------------------------------
set "OMP_LAUNCH_MODE=DEV PREVIEW + DEMO DATA"
set "OMP_LAUNCH_DATA=demo fixtures on lists, trees, telemetry, conversations;"
set "OMP_LAUNCH_DATA2=composer, terminal, approvals stay on the real Host"
set "OMP_LAUNCH_ENV=OMP_PREVIEW_DATA=1  (renderer enters preview mode, marks off)"
set "OMP_LAUNCH_UI=http://127.0.0.1:5173, Vite dev server with hot reload"

set "OMP_GIT_BRANCH="
set "OMP_GIT_COMMIT="
set "OMP_GIT_STATE="
for /f "delims=" %%b in ('git -C "%~dp0." rev-parse --abbrev-ref HEAD 2^>nul') do set "OMP_GIT_BRANCH=%%b"
for /f "delims=" %%c in ('git -C "%~dp0." rev-parse --short HEAD 2^>nul') do set "OMP_GIT_COMMIT=%%c"
for /f "delims=" %%d in ('git -C "%~dp0." status --porcelain --untracked-files=no 2^>nul') do set "OMP_GIT_STATE=+ local changes"
if not defined OMP_GIT_BRANCH set "OMP_GIT_BRANCH=(not a git checkout)"
if defined OMP_GIT_COMMIT if not defined OMP_GIT_STATE set "OMP_GIT_STATE=clean"
if defined OMP_GIT_STATE set "OMP_GIT_BRANCH=%OMP_GIT_BRANCH%, %OMP_GIT_STATE%"

title OMP Studio - %OMP_LAUNCH_MODE% [%OMP_GIT_BRANCH%]

echo.
echo  ====================================================================
echo    OMP Studio  -  %OMP_LAUNCH_MODE%
echo  ====================================================================
echo    script : %~nx0
echo    data   : %OMP_LAUNCH_DATA%
echo             %OMP_LAUNCH_DATA2%
echo    env    : %OMP_LAUNCH_ENV%
echo    ui     : %OMP_LAUNCH_UI%
echo    branch : %OMP_GIT_BRANCH%  %OMP_GIT_COMMIT%
echo  ====================================================================
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

echo [start] %OMP_LAUNCH_MODE% - building and opening OMP Studio. Please wait...
set "OMP_PREVIEW_DATA=1"
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
