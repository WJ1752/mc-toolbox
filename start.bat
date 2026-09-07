@echo off
chcp 65001 >nul
title Minecraft Toolbox
cd /d "%~dp0"

REM 单文件可执行（构建产物）：直接双击即可
if exist "dist\mc-toolbox.exe" (
  echo Starting Minecraft Toolbox (single executable)...
  "dist\mc-toolbox.exe" %*
  goto :eof
)

REM 否则回退到开发模式（需要本机 Node 18+）
set "NODE_EXE="
where node >nul 2>nul
if %errorlevel%==0 set "NODE_EXE=node"

if not defined NODE_EXE (
  for /d %%D in ("%USERPROFILE%\.workbuddy\binaries\node\versions\*") do (
    if exist "%%D\node.exe" set "NODE_EXE=%%D\node.exe"
  )
)

if not defined NODE_EXE (
  echo.
  echo  [!] Node.js not found.
  echo      Please install Node.js 18+ from https://nodejs.org
  echo      OR run build.mjs to generate dist\mc-toolbox.exe
  echo.
  pause
  exit /b 1
)

echo Starting Minecraft Toolbox with: %NODE_EXE%
"%NODE_EXE%" server.js
echo.
echo Server stopped.
pause
