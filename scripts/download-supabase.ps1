# TeamMarks — Download Supabase Browser Bundle
#
# This script downloads the Supabase JS client v2 UMD bundle
# and saves it as lib/supabase-browser.js for use by the extension.
#
# Run this script from the project root:
#   pwsh -File scripts/download-supabase.ps1
#
# The service worker loads lib/supabase-browser.js via importScripts()
# BEFORE lib/supabase.js, which expects the global `supabase` object
# to be present.

$ErrorActionPreference = 'Stop'

$bundleUrl = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js'
$outputPath = Join-Path $PSScriptRoot '..' 'lib' 'supabase-browser.js'
$outputPath = [System.IO.Path]::GetFullPath($outputPath)

Write-Host "Downloading Supabase JS client from CDN..." -ForegroundColor Cyan
Write-Host "  URL: $bundleUrl"
Write-Host "  Output: $outputPath"

try {
    # Use TLS 1.2 for security
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

    Invoke-WebRequest -Uri $bundleUrl -OutFile $outputPath -UseBasicParsing
    $fileSize = (Get-Item $outputPath).Length
    Write-Host ""
    Write-Host "Download complete! ($fileSize bytes)" -ForegroundColor Green
    Write-Host "The bundle is now at lib/supabase-browser.js"
}
catch {
    Write-Host ""
    Write-Host "ERROR: Failed to download the Supabase bundle." -ForegroundColor Red
    Write-Host "  $_" -ForegroundColor Red
    Write-Host ""
    Write-Host "You can download it manually:" -ForegroundColor Yellow
    Write-Host "  1. Open $bundleUrl in your browser"
    Write-Host "  2. Save the file as lib/supabase-browser.js in the project root"
    exit 1
}