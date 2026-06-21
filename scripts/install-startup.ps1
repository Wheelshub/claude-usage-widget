<#
  Makes the collector start automatically (hidden) at login, so the widget
  always has fresh data after a reboot.

  Uses the per-user Startup folder — no admin rights required.

  Install:   powershell -ExecutionPolicy Bypass -File install-startup.ps1
  Uninstall: powershell -ExecutionPolicy Bypass -File install-startup.ps1 -Remove
#>
param([switch]$Remove)

$ErrorActionPreference = 'Stop'
$collector = Join-Path (Split-Path -Parent $PSScriptRoot) 'collector'
$server    = Join-Path $collector 'server.js'
$startup   = [Environment]::GetFolderPath('Startup')
$launcher  = Join-Path $startup 'ClaudeUsageCollector.vbs'

if ($Remove) {
  if (Test-Path $launcher) { Remove-Item $launcher -Force; Write-Host "Removed startup launcher." -ForegroundColor Green }
  else { Write-Host "No startup launcher found." -ForegroundColor Yellow }
  # also stop any running instance
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -like '*server.js*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
  return
}

$node = (Get-Command node -ErrorAction Stop).Source

# A .vbs in the Startup folder launches the collector with no visible window.
@"
' Auto-starts the Claude usage collector, hidden, at login.
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = "$collector"
sh.Run """$node"" ""$server""", 0, False
"@ | Set-Content -Path $launcher -Encoding ASCII

Write-Host "Installed startup launcher:" -ForegroundColor Green
Write-Host "  $launcher"
Write-Host "  -> runs: $node $server  (hidden, at login)"

# Start it now if it isn't already running.
$running = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*server.js*' }
if (-not $running) {
  Start-Process 'wscript.exe' -ArgumentList "`"$launcher`""
  Write-Host "Started collector now." -ForegroundColor Cyan
} else {
  Write-Host "Collector already running (PID $($running.ProcessId))." -ForegroundColor Cyan
}
