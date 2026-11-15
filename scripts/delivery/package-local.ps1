# Rebuilds the offline package, replaces the local global install, and starts it.
#
#   package-local.ps1 [-Port 3000] [-SkipBuild]
#
# The build runs while the old server is still up; only the install step stops
# it, because a running server keeps the installed files locked on Windows.
# Double-click package-local.cmd at the repo root instead of running this.

param(
    [int]$Port = 3000,
    [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

function Stop-WithMessage([string]$Message) {
    Write-Host ''
    Write-Host $Message -ForegroundColor Red
    exit 1
}

Push-Location (Join-Path $PSScriptRoot '..\..')
try {
    if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
        Stop-WithMessage 'bun is not on PATH. Install Bun and reopen this window.'
    }

    Write-Host "OpenChamber local rebuild, port $Port" -ForegroundColor Cyan
    $arguments = @('scripts/offline-package.mjs')
    if ($SkipBuild) { $arguments += '--skip-build' }
    $arguments += @('--install', '--stop', '--start', '--port', "$Port")

    & bun @arguments
    if ($LASTEXITCODE -ne 0) {
        Stop-WithMessage 'The offline package script failed. See the output above.'
    }

    Write-Host "Waiting for http://127.0.0.1:$Port ..." -ForegroundColor Cyan
    $deadline = (Get-Date).AddSeconds(60)
    $ready = $false
    while (-not $ready -and (Get-Date) -lt $deadline) {
        try {
            $status = (Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 "http://127.0.0.1:$Port/api/version").StatusCode
            if ($status -eq 200) { $ready = $true }
        } catch {
            # The new server needs a moment to bind the port.
        }
        if (-not $ready) { Start-Sleep -Milliseconds 750 }
    }
    if (-not $ready) {
        Stop-WithMessage "The server did not answer on port $Port within 60s. See ~/.config/openchamber/logs/openchamber-$Port.log"
    }

    Start-Process "http://localhost:$Port"
    Write-Host ''
    Write-Host "Done. OpenChamber is running at http://localhost:$Port" -ForegroundColor Green
} finally {
    Pop-Location
}