@echo off
setlocal
chcp 936 >nul 2>&1
title Zombie RTS Outpost FOB-07
cd /d "%~dp0"

set "GAME=%~dp0game\index.html"

if not exist "%GAME%" goto missing

start "" "%GAME%"
exit /b 0

:missing
echo.
echo   [ERROR] game file not found:
echo   %GAME%
echo.
echo   Please keep the game folder next to this script.
echo.
pause
exit /b 1
