[CmdletBinding()]
param(
    [string]$ProxyUrl = '',
    # fast keeps electron-builder's normal preset and lowers only the inner 7z
    # level, trading installer size for build time. Default stays normal.
    [ValidateSet('store', 'fast', 'normal', 'maximum')]
    [string]$Compression = 'normal',
    [switch]$NoAutoUpdate,
    # The web installer publishes a small bootstrapper plus a .7z payload whose
    # embedded blockmap lets electron-updater download updates differentially.
    # The default full NSIS package stays offline-installable and is differential
    # too, through the .exe.blockmap published next to it (the previous blockmap
    # has to be cached locally, otherwise it falls back to a full download).
    [switch]$WebInstaller,
    # Release mode: requires signing configuration (Azure, UKey, or PFX).
    # Without -Release, the build produces an unsigned installer (development only).
    # Signing configuration is read from environment variables:
    #   - Azure: AZURE_SIGN_ENDPOINT, AZURE_SIGN_ACCOUNT, AZURE_SIGN_PROFILE, AZURE_CLIENT_ID
    #   - UKey: HERMES_UKEY_THUMBPRINT
    #   - PFX: WIN_CSC_LINK or CSC_LINK (with optional WIN_CSC_KEY_PASSWORD)
    [switch]$Release
)

function Select-PyPiIndex {
    # uv.lock cannot cover the editable project's build-system.requires
    # (setuptools/wheel), so that resolution always needs a reachable index.
    # Probing here turns an unreachable mirror from a ten-minute build failure
    # into a fast, explicit one.
    param([string[]]$Candidates, [string]$Proxy = '')
    foreach ($candidate in $Candidates) {
        $probe = $candidate.TrimEnd('/') + '/pip/'
        # Windows PowerShell 5.1 never reads HTTP_PROXY/HTTPS_PROXY here, so a
        # proxy-routed build must pass its endpoint explicitly.
        $request = @{ Uri = $probe; TimeoutSec = 8; UseBasicParsing = $true }
        if (-not [string]::IsNullOrWhiteSpace($Proxy)) {
            $request.Proxy = $Proxy
            $request.ProxyUseDefaultCredentials = $true
        }
        try {
            $response = Invoke-WebRequest @request
            if ($response.StatusCode -lt 400) {
                Write-Host "PyPI index: $candidate" -ForegroundColor DarkGray
                return $candidate
            }
        } catch {
            Write-Host "PyPI index unreachable: $candidate" -ForegroundColor DarkGray
        }
    }
    return $null
}

$ErrorActionPreference = 'Stop'
$wallClock = [System.Diagnostics.Stopwatch]::StartNew()
$builderCompression = if ($Compression -eq 'fast') { 'normal' } else { $Compression }
$innerCompressionLevel = @{ store = '0'; fast = '1'; normal = '5'; maximum = '9' }[$Compression]
$previousConsoleEncoding = [Console]::OutputEncoding
$previousEnvironment = @{}

# Set signing mode based on -Release switch
$env:HERMES_SIGNING_MODE = if ($Release) { 'release' } else { 'unsigned' }
if ($Release) {
    Write-Host "Release mode: signing required" -ForegroundColor Cyan
    # Determine signing method: Azure (if configured) or UKey (hardcoded)
    $hasAzure = $env:AZURE_SIGN_ENDPOINT -and $env:AZURE_CLIENT_ID
    $signingType = if ($hasAzure) { 'Azure' } else { 'UKey' }
    Write-Host "Signing method: $signingType" -ForegroundColor DarkGray
}
foreach ($name in @('TEMP', 'TMP', 'ELECTRON_BUILDER_CACHE', 'UV_CONCURRENT_INSTALLS',
                    'ELECTRON_BUILDER_COMPRESSION_LEVEL', 'HTTP_PROXY', 'HTTPS_PROXY',
                    'NO_PROXY', 'NODE_USE_ENV_PROXY', 'ELECTRON_GET_USE_PROXY',
                    'HERMES_WINDOWS_UPDATE', 'HERMES_WINDOWS_FORMAT',
                    'UV_INDEX_URL', 'ELECTRON_MIRROR', 'PYTHONIOENCODING', 'PYTHONUTF8',
                    'HERMES_SIGNING_MODE')) {
    $previousEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}
$sourceRoot = $PSScriptRoot
$cacheRoot = Join-Path $sourceRoot '.cache\desktop-inputs'
$workRoot = Join-Path $sourceRoot '.build\desktop-job-windows'
$tempRoot = Join-Path $sourceRoot '.build\temp-windows'
$buildTemp = Join-Path $tempRoot ([guid]::NewGuid().ToString('N'))

try {
    $OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    $env:PYTHONIOENCODING = 'utf-8'
    $env:PYTHONUTF8 = '1'

    # Fail before any dependency work: a web installer must keep its update feed.
    if ($WebInstaller -and $NoAutoUpdate) {
        throw 'A web installer needs the update feed; drop -NoAutoUpdate or -WebInstaller.'
    }

    $admissionClock = [System.Diagnostics.Stopwatch]::StartNew()
    $python = Join-Path $sourceRoot '.venv\Scripts\python.exe'
    if (-not (Test-Path -LiteralPath $python -PathType Leaf)) {
        throw "Build Python not found: $python. Run '. .\activate.ps1' once, then rerun this script."
    }
    $npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if ($null -eq $npm) {
        throw 'npm was not found. Install Node.js, then rerun this script (Open Connector needs npm ci).'
    }

    Push-Location $sourceRoot
    try {
        # The staging entry must import before the long dependency work starts.
        & $python -B -c 'import scripts.bundles.desktop'
        if ($LASTEXITCODE -ne 0) {
            throw "Build Python cannot import scripts.bundles.desktop (exit $LASTEXITCODE)."
        }

        $commit = (& git rev-parse HEAD).Trim()
        if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($commit)) {
            throw 'Cannot resolve the current Git commit.'
        }
        # Same admission as desktop_prepare.require_source: ignored files may stay.
        $changes = @(& git status --porcelain --untracked-files=all)
        if ($LASTEXITCODE -ne 0) {
            throw 'Cannot inspect the Git working tree.'
        }
        if ($changes.Count -gt 0) {
            throw 'The source tree has uncommitted or untracked changes. Commit them before packaging.'
        }
    } finally {
        Pop-Location
        # Printed on failure too: a rejected tree should show what the checks cost.
        Write-Host ("[build-timing] admission: {0:F1}s" -f $admissionClock.Elapsed.TotalSeconds)
    }

    $env:TEMP = $buildTemp
    $env:TMP = $env:TEMP
    $env:ELECTRON_BUILDER_CACHE = Join-Path $cacheRoot 'electron-builder'
    $env:UV_CONCURRENT_INSTALLS = '1'
    # NSIS 的内层 7z 不跟随 normal 配置，必须显式设置受支持的压缩级别。
    $env:ELECTRON_BUILDER_COMPRESSION_LEVEL = $innerCompressionLevel

    New-Item -ItemType Directory -Force -Path $buildTemp, $cacheRoot | Out-Null
    if (-not [string]::IsNullOrWhiteSpace($ProxyUrl)) {
        $env:HTTP_PROXY = $ProxyUrl
        $env:HTTPS_PROXY = $ProxyUrl
        $env:NO_PROXY = 'localhost,127.0.0.1,::1,registry.npmjs.org,files.pythonhosted.org'
        $env:NODE_USE_ENV_PROXY = '1'
        $env:ELECTRON_GET_USE_PROXY = '1'
    }

    if ($Release) {
        $node = Get-Command node -ErrorAction Stop
        & $node.Source (Join-Path $sourceRoot 'apps\desktop\scripts\check-windows-signer.mjs')
        if ($LASTEXITCODE -ne 0) {
            throw "Signing preflight failed with exit code $LASTEXITCODE."
        }
    }

    # 国内镜像加速：Python 依赖走第一个可达的镜像，Electron 走 npmmirror。
    # 用户手动设置的环境变量优先（不会覆盖）。
    if (-not $env:UV_INDEX_URL) {
        $indexClock = [System.Diagnostics.Stopwatch]::StartNew()
        try {
            # -ProxyUrl already exported HTTPS_PROXY above; honour either source.
            $indexProxy = if ([string]::IsNullOrWhiteSpace($ProxyUrl)) { $env:HTTPS_PROXY } else { $ProxyUrl }
            $env:UV_INDEX_URL = Select-PyPiIndex -Proxy $indexProxy -Candidates @(
                'https://pypi.tuna.tsinghua.edu.cn/simple/',
                'https://mirrors.aliyun.com/pypi/simple/',
                'https://pypi.org/simple/')
            if (-not $env:UV_INDEX_URL) {
                $via = if ([string]::IsNullOrWhiteSpace($indexProxy)) { '' } else { " (proxy $indexProxy)" }
                throw "No reachable PyPI index$via. Check the network or set UV_INDEX_URL to your mirror."
            }
        } finally {
            Write-Host ("[build-timing] index-probe: {0:F1}s" -f $indexClock.Elapsed.TotalSeconds)
        }
    }
    if (-not $env:ELECTRON_MIRROR) {
        $env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
    }

    # NSIS 包由 electron-updater 自管更新：安装后从 OSS 拉 stable.yml + blockmap
    # 做差量下载，静默安装后重启。打一次性交付包时加 -NoAutoUpdate 关闭。
    if (-not $NoAutoUpdate) {
        $env:HERMES_WINDOWS_UPDATE = 'electron-updater'
    }
    if ($WebInstaller) {
        $env:HERMES_WINDOWS_FORMAT = 'nsis-web'
    }

    # Open Connector ships its own node_modules (electron-builder extraResources) and the packaging hook
    # refuses to run without them, so install them from its lock file before the long build starts.
    $connectorClock = [System.Diagnostics.Stopwatch]::StartNew()
    Write-Host 'Installing Open Connector dependencies' -ForegroundColor DarkGray
    Push-Location (Join-Path $sourceRoot 'apps\desktop')
    try {
        & $npm.Source run connectors:install
        if ($LASTEXITCODE -ne 0) {
            throw "npm run connectors:install failed with exit code $LASTEXITCODE."
        }
    } finally {
        Pop-Location
        Write-Host ("[build-timing] connectors: {0:F1}s" -f $connectorClock.Elapsed.TotalSeconds)
    }

    Write-Host "Building Windows installer from $commit" -ForegroundColor Cyan
    Write-Host "Persistent cache: $cacheRoot" -ForegroundColor DarkGray
    Write-Host "Installer compression: $Compression (electron-builder $builderCompression, 7z level $innerCompressionLevel)" -ForegroundColor DarkGray
    $buildStarted = Get-Date

    # Package into a fresh, per-commit output directory instead of the shared
    # apps/desktop/release. Reusing the previous run's win-unpacked\resources\app.asar
    # is what trips "EBUSY: resource busy or locked" on Windows when a scanner
    # (天擎 / Windows Defender / Search indexer / the editor) still holds a handle
    # on the leftover file. Keying the directory on the commit means a new commit
    # never touches the old artifact at all. release-local-* is already gitignored,
    # so the dirty-tree admission above stays clean.
    # NOT named $release: PowerShell variable names are case-insensitive, so
    # $release would be the [switch]$Release parameter and assigning a string
    # to it throws (see a370eab4).
    $outputDir = Join-Path $sourceRoot "apps\desktop\release-local-$($commit.Substring(0, 12))"
    if (Test-Path -LiteralPath $outputDir) {
        try {
            Remove-Item -LiteralPath $outputDir -Recurse -Force
        } catch {
            throw "Cannot clear the previous output dir $outputDir (a file is still locked). Close any running app instance and let the scanner finish, then rerun."
        }
    }
    New-Item -ItemType Directory -Force -Path $outputDir | Out-Null

    $buildClock = [System.Diagnostics.Stopwatch]::StartNew()
    Push-Location $sourceRoot
    try {
        & $python scripts\bundles\desktop.py `
            --commit $commit `
            --variant bundled `
            --work $workRoot `
            --cache $cacheRoot `
            -- "-c.compression=$builderCompression" `
            "-c.directories.output=$outputDir"
        if ($LASTEXITCODE -ne 0) {
            throw "Windows installer build failed with exit code $LASTEXITCODE."
        }
    } finally {
        Pop-Location
        Write-Host ("[build-timing] desktop-build: {0:F1}s" -f $buildClock.Elapsed.TotalSeconds)
    }

    # $outputDir is the fresh per-commit output dir computed before the build;
    # electron-builder wrote win-unpacked and the installer inside it.
    # nsis-web keeps its bootstrapper and .7z payload in <output>\nsis-web;
    # the full nsis target writes straight into <output>.
    $artifactDir = if ($WebInstaller) { Join-Path $outputDir 'nsis-web' } else { $outputDir }
    $installer = Get-ChildItem -LiteralPath $artifactDir -Filter '*.exe' -File |
        Where-Object { $_.Name -notmatch 'uninstall' -and $_.LastWriteTime -ge $buildStarted } |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1
    if ($null -eq $installer) {
        throw "Build completed but no EXE installer was found under $artifactDir."
    }

    # Sign the NSIS installer immediately after build (UKey PIN cache is fresh).
    # electron-builder's own sign attempt may have failed silently when the PIN
    # cache expired during the long payload signing phase.
    $signingMode = $env:HERMES_SIGNING_MODE
    if ($signingMode -eq 'release') {
        $signClock = [System.Diagnostics.Stopwatch]::StartNew()
        try {
            $node = Get-Command node -ErrorAction SilentlyContinue
            if ($null -eq $node) {
                throw 'node not found; cannot sign installer'
            }
            & $node.Source (Join-Path $sourceRoot 'apps\desktop\scripts\sign-installer.mjs') `
                -Installer $installer.FullName
            if ($LASTEXITCODE -ne 0) {
                throw "Installer signing failed with exit code $LASTEXITCODE."
            }
        } finally {
            Write-Host ("[build-timing] installer-sign: {0:F1}s" -f $signClock.Elapsed.TotalSeconds)
        }
    }

    # Check identity, bundled kits, the bundled Python and path lengths before anyone hands the installer out.
    $checkClock = [System.Diagnostics.Stopwatch]::StartNew()
    try {
        & (Join-Path $sourceRoot 'scripts\bundles\check-windows-installer.ps1') `
            -Installer $installer.FullName -Commit $commit -Scratch $buildTemp `
            -Unpacked (Join-Path $outputDir 'win-unpacked')
    } finally {
        Write-Host ("[build-timing] installer-check: {0:F1}s" -f $checkClock.Elapsed.TotalSeconds)
    }

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
    $cleanupClock = [System.Diagnostics.Stopwatch]::StartNew()
    try {
        # Early admission failures never create the directory; do not report a fake cleanup.
        if (Test-Path -LiteralPath $buildTemp) {
            Remove-Item -LiteralPath $buildTemp -Recurse -Force -ErrorAction SilentlyContinue
            Write-Host ("[build-timing] temporary.cleanup: {0:F1}s" -f $cleanupClock.Elapsed.TotalSeconds)
        }
    } finally {
        foreach ($name in $previousEnvironment.Keys) {
            [Environment]::SetEnvironmentVariable($name, $previousEnvironment[$name], 'Process')
        }
        [Console]::OutputEncoding = $previousConsoleEncoding
        Write-Host ("Wall time (including preparation and cleanup): " + $wallClock.Elapsed.ToString('hh\:mm\:ss'))
    }
}
