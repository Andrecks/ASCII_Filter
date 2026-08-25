@echo off
rem ASCII Shader desktop launcher. Self-bootstraps on a fresh clone:
rem installs node_modules and, if npm's postinstall skipped the Electron binary
rem download (happens on some setups), runs Electron's own installer directly.
cd /d "%~dp0"
set ELECTRON=node_modules\electron\dist\electron.exe

if exist "%ELECTRON%" goto run

echo [ASCII Shader] First run: installing dependencies (needs Node.js + network)...
where npm >nul 2>nul
if errorlevel 1 (
  echo [ASCII Shader] npm not found. Install Node.js from https://nodejs.org and rerun.
  pause
  exit /b 1
)
call npm install --no-audit --no-fund

if not exist "%ELECTRON%" (
  echo [ASCII Shader] Electron binary still missing - running its installer directly...
  node node_modules\electron\install.js
)

if not exist "%ELECTRON%" (
  echo [ASCII Shader] Could not install Electron. See errors above.
  pause
  exit /b 1
)

:run
start "" "%ELECTRON%" .
