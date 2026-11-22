@echo off
chcp 65001 >nul
rem One click: start the HMR dev server (no build, no package, no install) and open it.
rem Optional: dev-local.cmd -Port 5181 -ApiPort 3903   |   dev-local.cmd -NoBrowser
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\delivery\dev-local.ps1" %*
echo.
pause
