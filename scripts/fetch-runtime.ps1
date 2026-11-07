# scripts/fetch-runtime.ps1
# Downloads the bundled runtime for a self-contained Windows installer:
#   1. Node.js (pinned LTS, Windows x64 portable zip) -> runtime/node/win-x64/
#   2. Playwright Chromium (same version as sidecar)    -> runtime/ms-playwright/
#
# Usage: powershell -File scripts/fetch-runtime.ps1 [-Force]
# The script is idempotent: existing files are kept unless -Force is passed.
# Requires: Expand-Archive, internet access.

[CmdletBinding()]
param([switch]$Force)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

$NodeVersion    = 'v22.20.0'  # bump together with sidecar engines
$nodeZipName    = "node-$NodeVersion-win-x64.zip"
$nodeDir        = Join-Path $root 'runtime\node\win-x64'
$nodeExe        = Join-Path $nodeDir 'node.exe'
$playwrightDir  = Join-Path $root 'runtime\ms-playwright'

# ---------- Node.js ----------
Write-Output "== Node.js $NodeVersion =="
if ($Force -and (Test-Path $nodeDir)) { Remove-Item -Recurse -Force $nodeDir }
if (-not (Test-Path $nodeExe)) {
    $tmp = Join-Path $env:TEMP $nodeZipName
    $url = "https://nodejs.org/dist/$NodeVersion/$nodeZipName"
    Write-Output "Downloading $url"
    Invoke-WebRequest -Uri $url -OutFile $tmp -UseBasicParsing
    New-Item -ItemType Directory -Path $nodeDir -Force | Out-Null
    $tmpExtract = Join-Path $env:TEMP 'node-extract'
    if (Test-Path $tmpExtract) { Remove-Item -Recurse -Force $tmpExtract }
    Expand-Archive -Path $tmp -DestinationPath $tmpExtract -Force
    # zip contains node-<ver>-win-x64\*; move contents up one level
    $inner = Join-Path $tmpExtract "node-$NodeVersion-win-x64"
    Get-ChildItem -Path $inner -Force | Move-Item -Destination $nodeDir -Force
    Remove-Item -Recurse -Force $tmpExtract
    Remove-Item -Force $tmp
    Write-Output "Node.js unpacked: $nodeExe"
} else {
    Write-Output 'Node.js already present, skipping download.'
}

# ---------- Playwright Chromium ----------
Write-Output '== Playwright Chromium =='
$env:PLAYWRIGHT_BROWSERS_PATH = $playwrightDir
if ($Force -and (Test-Path $playwrightDir)) { Remove-Item -Recurse -Force $playwrightDir }
$sidecarDir = Join-Path $root 'sidecar'
$playwrightCli = Join-Path $sidecarDir 'node_modules\playwright-core\cli.js'
if (-not (Test-Path $playwrightCli)) {
    Write-Output 'sidecar node_modules missing; installing sidecar dependencies first...'
    Push-Location $sidecarDir
    try { npm ci } finally { Pop-Location }
}
node $playwrightCli install chromium
Write-Output "Runtime ready."
Write-Output "  node: $nodeExe"
Write-Output "  browsers: $playwrightDir"
