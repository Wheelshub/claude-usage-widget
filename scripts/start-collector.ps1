<#
  Starts the Claude usage collector in the foreground.
  Leave this window open while using the widget, or use install-startup.ps1
  to run it automatically (hidden) at login.
#>
$ErrorActionPreference = 'Stop'
$collector = Join-Path (Split-Path -Parent $PSScriptRoot) 'collector'
Set-Location $collector
Write-Host "Starting collector in $collector ..." -ForegroundColor Cyan
node server.js
