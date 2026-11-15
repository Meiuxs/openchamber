@echo off
chcp 65001 >nul
rem One click: build the offline package, replace the local install, start it.
rem Optional: package-local.cmd -Port 3001   |   package-local.cmd -SkipBuild
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\delivery\package-local.ps1" %*
echo.
pause