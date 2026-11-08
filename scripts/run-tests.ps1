# scripts/run-tests.ps1
# One-shot offline verification (does not launch the app or hit the real Doubao site;
# the sidecar overlay test uses headless Chromium with local HTML fixtures only).
# Usage: powershell -File scripts/run-tests.ps1
# Exit code 0 = all checks pass.

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Invoke-Step {
    param([string]$Title, [scriptblock]$Body)
    Write-Output ""
    Write-Output "=== $Title ==="
    & $Body
    if ($LASTEXITCODE -ne 0) {
        Write-Output "FAILED: $Title (exit $LASTEXITCODE)"
        exit $LASTEXITCODE
    }
}

Invoke-Step 'prototype: extractor' { node prototype/src/validate-extractor.js }
Invoke-Step 'prototype: downloader' { node prototype/src/validate-downloader.js }
Invoke-Step 'sidecar: downloader' { node sidecar/src/downloader.js }
Invoke-Step 'sidecar: pool' { node sidecar/src/pool.js }
Invoke-Step 'sidecar: scanner' { node sidecar/src/scanner.test.js }
Invoke-Step 'sidecar: overlays (headless chromium)' { node sidecar/src/overlays.test.js }
Invoke-Step 'Rust unit tests' {
    Push-Location src-tauri
    try { cargo test } finally { Pop-Location }
}
Invoke-Step 'TypeScript type check' { npx tsc --noEmit }
Invoke-Step 'frontend build' { npm run build }

Write-Output ""
Write-Output "All offline checks passed."
