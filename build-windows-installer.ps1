[CmdletBinding()]
param(
    [string]$ProxyUrl = '',
    [ValidateSet('store', 'normal', 'maximum')]
    [string]$Compression = 'normal',
    [switch]$NoAutoUpdate,
    # The web installer publishes a small bootstrapper plus a .7z payload whose
    # embedded blockmap lets electron-updater download updates differentially.
    # The default full NSIS package stays offline-installable but always updates
    # in full.
    [switch]$WebInstaller
)

$ErrorActionPreference = 'Stop'
$previousEnvironment = @{}
foreach ($name in @('TEMP', 'TMP', 'ELECTRON_BUILDER_CACHE', 'UV_CONCURRENT_INSTALLS',
                    'ELECTRON_BUILDER_COMPRESSION_LEVEL', 'HTTP_PROXY', 'HTTPS_PROXY',
                    'NO_PROXY', 'NODE_USE_ENV_PROXY', 'ELECTRON_GET_USE_PROXY',
                    'HERMES_WINDOWS_UPDATE', 'HERMES_WINDOWS_FORMAT')) {
    $previousEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}
$sourceRoot = $PSScriptRoot
$cacheRoot = Join-Path $sourceRoot '.cache\desktop-inputs'
$workRoot = Join-Path $sourceRoot '.build\desktop-job-windows'
$tempRoot = Join-Path $sourceRoot '.build\temp-windows'
$buildTemp = Join-Path $tempRoot ([guid]::NewGuid().ToString('N'))
$env:TEMP = $buildTemp
$env:TMP = $env:TEMP
$env:ELECTRON_BUILDER_CACHE = Join-Path $cacheRoot 'electron-builder'
$env:UV_CONCURRENT_INSTALLS = '1'
# NSIS 的内层 7z 不跟随 normal 配置，必须显式设置受支持的压缩级别。
$env:ELECTRON_BUILDER_COMPRESSION_LEVEL = @{ store = '0'; normal = '5'; maximum = '9' }[$Compression]

New-Item -ItemType Directory -Force -Path $buildTemp, $cacheRoot | Out-Null
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

# NSIS 包由 electron-updater 自管更新：安装后从 OSS 拉 stable.yml + blockmap
# 做差量下载，静默安装后重启。打一次性交付包时加 -NoAutoUpdate 关闭。
if (-not $NoAutoUpdate) {
    $env:HERMES_WINDOWS_UPDATE = 'electron-updater'
}
if ($WebInstaller -and $NoAutoUpdate) {
    throw 'A web installer needs the update feed; drop -NoAutoUpdate or -WebInstaller.'
}
if ($WebInstaller) {
    $env:HERMES_WINDOWS_FORMAT = 'nsis-web'
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

    # Open Connector ships its own node_modules (electron-builder extraResources) and the packaging hook
    # refuses to run without them, so install them from its lock file before the long build starts.
    $npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if ($null -eq $npm) {
        throw 'npm was not found. Install Node.js, then rerun this script (Open Connector needs npm ci).'
    }
    Write-Host 'Installing Open Connector dependencies' -ForegroundColor DarkGray
    Push-Location (Join-Path $sourceRoot 'apps\desktop')
    try {
        & $npm.Source run connectors:install
        if ($LASTEXITCODE -ne 0) {
            throw "npm run connectors:install failed with exit code $LASTEXITCODE."
        }
    } finally {
        Pop-Location
    }

    Write-Host "Building Windows installer from $commit" -ForegroundColor Cyan
    Write-Host "Persistent cache: $cacheRoot" -ForegroundColor DarkGray
    Write-Host "Installer compression: $Compression" -ForegroundColor DarkGray
    $buildStarted = Get-Date

    & $python scripts\bundles\desktop.py `
        --commit $commit `
        --variant bundled `
        --work $workRoot `
        --cache $cacheRoot `
        -- "-c.compression=$Compression"
    if ($LASTEXITCODE -ne 0) {
        throw "Windows installer build failed with exit code $LASTEXITCODE."
    }

    $release = Join-Path $sourceRoot 'apps\desktop\release'
    # nsis-web keeps its bootstrapper and .7z payload in release\nsis-web;
    # the full nsis target writes straight into release.
    $artifactDir = if ($WebInstaller) { Join-Path $release 'nsis-web' } else { $release }
    $installer = Get-ChildItem -LiteralPath $artifactDir -Filter '*.exe' -File |
        Where-Object { $_.Name -notmatch 'uninstall' -and $_.LastWriteTime -ge $buildStarted } |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1
    if ($null -eq $installer) {
        throw "Build completed but no EXE installer was found under $artifactDir."
    }

    # Check identity, bundled kits, the bundled Python and path lengths before anyone hands the installer out.
    & (Join-Path $sourceRoot 'scripts\bundles\check-windows-installer.ps1') `
        -Installer $installer.FullName -Commit $commit -Scratch $buildTemp `
        -Unpacked (Join-Path $release 'win-unpacked')

    $sizeMiB = [math]::Round($installer.Length / 1MB, 1)
    Write-Host ''
    Write-Host 'Windows installer completed.' -ForegroundColor Green
    Write-Host "Path: $($installer.FullName)"
    Write-Host "Size: $sizeMiB MiB"
    if ($WebInstaller) {
        $payload = Get-ChildItem -LiteralPath $artifactDir -Filter '*.7z' -File -ErrorAction SilentlyContinue |
            Where-Object { $_.LastWriteTime -ge $buildStarted } |
            Sort-Object LastWriteTime -Descending |
            Select-Object -First 1
        if ($null -eq $payload) {
            throw 'Web installer build produced no .7z payload.'
        }
        Write-Host "Payload: $($payload.FullName)" -ForegroundColor Cyan
        Write-Host 'Publish the .exe, the .7z and stable.yml together; the client downloads the .7z differentially.'
    }
    Write-Host ("Total time: " + ((Get-Date) - $buildStarted).ToString('hh\:mm\:ss'))
} finally {
    Pop-Location
    Remove-Item -LiteralPath $buildTemp -Recurse -Force -ErrorAction SilentlyContinue
    foreach ($name in $previousEnvironment.Keys) {
        [Environment]::SetEnvironmentVariable($name, $previousEnvironment[$name], 'Process')
    }
}
