@echo off
setlocal
cd /d "%~dp0"
if errorlevel 1 exit /b 1
where node.exe >nul 2>nul
if errorlevel 1 (
  echo Install Node.js 24 or newer: https://nodejs.org/
  pause
  exit /b 1
)
if not exist "node_modules\@steipete\oracle\dist\bin\oracle-cli.js" (
  echo Installing Oracle. Please wait...
  call npm.cmd ci --omit=dev --ignore-scripts --no-audit --no-fund --cache .npm-cache
  if errorlevel 1 (
    echo Oracle installation failed. Check your internet connection.
    pause
    exit /b 1
  )
)
node.exe launch.mjs
if errorlevel 1 (
  pause
  exit /b 1
)
exit /b 0
