[CmdletBinding()]
param(
    [string]$ProxyUrl = ''
)

$ErrorActionPreference = 'Stop'
$sourceRoot = $PSScriptRoot
$cacheRoot = Join-Path $sourceRoot '.cache\desktop-inputs'
$workRoot = Join-Path $sourceRoot '.build\desktop-job-windows'
$env:TEMP = Join-Path $sourceRoot '.build\temp-windows'
$env:TMP = $env:TEMP
$env:ELECTRON_BUILDER_CACHE = Join-Path $cacheRoot 'electron-builder'
$env:UV_CONCURRENT_INSTALLS = '1'

New-Item -ItemType Directory -Force -Path $env:TEMP, $cacheRoot | Out-Null
if (-not [string]::IsNullOrWhiteSpace($ProxyUrl)) {
    $env:HTTP_PROXY = $ProxyUrl
    $env:HTTPS_PROXY = $ProxyUrl
    $env:NO_PROXY = 'localhost,127.0.0.1,::1,registry.npmjs.org,files.pythonhosted.org'
    $env:NODE_USE_ENV_PROXY = '1'
    $env:ELECTRON_GET_USE_PROXY = '1'
}

$python = Join-Path $sourceRoot '.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $python -PathType Leaf)) {
    throw "Build Python not found: $python. Run '. .\activate.ps1' once, then rerun this script."
}

Push-Location $sourceRoot
try {
    $commit = (& git rev-parse HEAD).Trim()
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($commit)) {
        throw 'Cannot resolve the current Git commit.'
    }
    $changes = @(& git status --porcelain --untracked-files=no)
    if ($LASTEXITCODE -ne 0) {
        throw 'Cannot inspect the Git working tree.'
    }
    if ($changes.Count -gt 0) {
        throw 'The source tree has uncommitted tracked changes. Commit them before packaging.'
    }

    Write-Host "Building Windows installer from $commit" -ForegroundColor Cyan
    Write-Host "Persistent cache: $cacheRoot" -ForegroundColor DarkGray

    & $python scripts\bundles\desktop.py `
        --commit $commit `
        --variant bundled `
        --work $workRoot `
        --cache $cacheRoot
    if ($LASTEXITCODE -ne 0) {
        throw "Windows installer build failed with exit code $LASTEXITCODE."
    }

    $release = Join-Path $sourceRoot 'apps\desktop\release'
    $installer = Get-ChildItem -LiteralPath $release -Filter '*.exe' -File |
        Where-Object { $_.Name -notmatch 'uninstall' } |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1
    if ($null -eq $installer) {
        throw "Build completed but no EXE installer was found under $release."
    }

    $sizeMiB = [math]::Round($installer.Length / 1MB, 1)
    Write-Host ''
    Write-Host 'Windows installer completed.' -ForegroundColor Green
    Write-Host "Path: $($installer.FullName)"
    Write-Host "Size: $sizeMiB MiB"
} finally {
    Pop-Location
}
