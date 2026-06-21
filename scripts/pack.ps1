<#
  Packages widget/ into Claude-Usage.icuewidget for import into iCUE (5.44+).

  Preferred path: Corsair's official WidgetBuilder CLI (`icuewidget`), which
  validates the manifest and produces a properly-formed package.

  Fallback: zip the folder and rename to .icuewidget. The .icuewidget format is
  a zip archive, so this usually imports, but if iCUE rejects it, install the
  official WidgetBuilder Kit and re-run this script.
#>

$ErrorActionPreference = 'Stop'
$root      = Split-Path -Parent $PSScriptRoot
$widgetDir = Join-Path $root 'widget'
$outFile   = Join-Path $root 'Claude-Usage.icuewidget'

if (-not (Test-Path (Join-Path $widgetDir 'manifest.json'))) {
  throw "manifest.json not found in $widgetDir"
}

function Get-Cli {
  foreach ($name in @('icuewidget', 'icuewidget.cmd', 'icuewidget.exe')) {
    $c = Get-Command $name -ErrorAction SilentlyContinue
    if ($c) { return $c.Source }
  }
  return $null
}

$cli = Get-Cli

if ($cli) {
  Write-Host "Using official WidgetBuilder CLI: $cli" -ForegroundColor Green
  Push-Location $widgetDir
  try {
    & $cli validate
    if ($LASTEXITCODE -ne 0) { throw "icuewidget validate failed ($LASTEXITCODE)" }
    & $cli package
    if ($LASTEXITCODE -ne 0) { throw "icuewidget package failed ($LASTEXITCODE)" }
    Write-Host "Packaged via CLI. Look for the .icuewidget file in $widgetDir" -ForegroundColor Green
  } finally {
    Pop-Location
  }
}
else {
  Write-Host "WidgetBuilder CLI not found - using zip fallback." -ForegroundColor Yellow
  Write-Host "(Install the WidgetBuilder Kit from Corsair for the validated package.)" -ForegroundColor Yellow
  $tmpZip = Join-Path $env:TEMP 'claude-usage-widget.zip'
  if (Test-Path $tmpZip)  { Remove-Item $tmpZip -Force }
  if (Test-Path $outFile) { Remove-Item $outFile -Force }
  Compress-Archive -Path (Join-Path $widgetDir '*') -DestinationPath $tmpZip -Force
  Move-Item $tmpZip $outFile
  Write-Host "Created: $outFile" -ForegroundColor Green
  Write-Host "Import it in iCUE: Widgets panel -> '+' -> browse to this file." -ForegroundColor Cyan
}
