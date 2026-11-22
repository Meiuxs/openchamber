# Rebuild-free local verification: start the HMR dev server in a new window and
# open it in the browser. Source changes under packages/ui and packages/web are
# picked up by Vite HMR and the server's file watcher; nothing is packed,
# installed globally, or zipped.
#
#   dev-local.ps1 [-Port 5180] [-ApiPort 3902] [-NoBrowser]
#
# Double-click dev-local.cmd at the repo root instead of running this directly.

param(
    [int]$Port = 5180,
    [int]$ApiPort = 3902,
    [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

function Stop-WithMessage([string]$Message) {
    Write-Host ''
    Write-Host $Message -ForegroundColor Red
    exit 1
}

function Test-PortInUse([int]$Number) {
    return [bool](Get-NetTCPConnection -LocalPort $Number -State Listen -ErrorAction SilentlyContinue)
}

Push-Location (Join-Path $PSScriptRoot '..\..')
try {
    if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
        Stop-WithMessage 'bun is not on PATH. Install Bun and reopen this window.'
    }
    if ($Port -lt 1 -or $Port -gt 65535 -or $ApiPort -lt 1 -or $ApiPort -gt 65535) {
        Stop-WithMessage "Ports must be between 1 and 65535 (got UI $Port, API $ApiPort)."
    }
    if ($Port -eq $ApiPort) {
        Stop-WithMessage "UI and API ports must differ (both are $Port)."
    }

    foreach ($number in @($Port, $ApiPort)) {
        if (Test-PortInUse $number) {
            Stop-WithMessage "Port $number is already listening. Stop the running OpenChamber dev instance or choose another -Port / -ApiPort."
        }
    }

    Write-Host "OpenChamber dev (HMR): UI $Port, API $ApiPort" -ForegroundColor Cyan
    Write-Host 'The dev server runs in its own window; close that window to stop it.' -ForegroundColor Cyan

    $env:OPENCHAMBER_HMR_UI_PORT = "$Port"
    $env:OPENCHAMBER_HMR_API_PORT = "$ApiPort"
    $arguments = @('/k', 'bun', 'run', 'dev')
    Start-Process -FilePath 'cmd.exe' -ArgumentList $arguments -WorkingDirectory (Get-Location).Path

    Write-Host "Waiting for http://127.0.0.1:$Port ..." -ForegroundColor Cyan
    Write-Host 'Vite clears its cache on each dev start, so the first load after a start can take several minutes.' -ForegroundColor DarkGray
    $deadline = (Get-Date).AddSeconds(600)
    $nextNotice = (Get-Date).AddSeconds(15)
    $ready = $false
    while (-not $ready -and (Get-Date) -lt $deadline) {
        try {
            $status = (Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 "http://127.0.0.1:$Port/").StatusCode
            if ($status -eq 200) { $ready = $true }
        } catch {
            # Vite is still starting or the API it proxies to is not ready yet.
        }
        if (-not $ready) {
            if ((Get-Date) -ge $nextNotice) {
                Write-Host '  still starting ...' -ForegroundColor DarkGray
                $nextNotice = (Get-Date).AddSeconds(15)
            }
            Start-Sleep -Milliseconds 750
        }
    }
    if (-not $ready) {
        Stop-WithMessage "The dev UI did not answer on port $Port within 10 min. Check the dev server window for errors."
    }

    if (-not $NoBrowser) {
        Start-Process "http://localhost:$Port"
    }
    Write-Host ''
    Write-Host "Done. OpenChamber dev is running at http://localhost:$Port" -ForegroundColor Green
} finally {
    Pop-Location
}
