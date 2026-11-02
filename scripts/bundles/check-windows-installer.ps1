<#
Checks a built Windows installer before it is handed out; build-windows-installer.ps1 runs it last.
It throws when the installer must not ship, otherwise it prints what the installer carries.
Run it on its own against an earlier build too:
  .\scripts\bundles\check-windows-installer.ps1 -Installer <exe> -Commit <40-char sha>
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Installer,
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[0-9a-f]{40}$')]
    [string]$Commit,
    # The unpacked app the installer was made from (default: win-unpacked next to the installer).
    [string]$Unpacked = '',
    # Scratch directory for the Python check (default: a temporary one, removed afterwards).
    [string]$Scratch = ''
)

$ErrorActionPreference = 'Stop'
$installerFile = Get-Item -LiteralPath $Installer
if ([string]::IsNullOrWhiteSpace($Unpacked)) {
    $Unpacked = Join-Path $installerFile.DirectoryName 'win-unpacked'
}
$Unpacked = (Resolve-Path -LiteralPath $Unpacked).Path.TrimEnd('\')
$ownScratch = [string]::IsNullOrWhiteSpace($Scratch)
if ($ownScratch) {
    $Scratch = Join-Path ([System.IO.Path]::GetTempPath()) ('installer-check-' + [guid]::NewGuid().ToString('N'))
}
New-Item -ItemType Directory -Force -Path $Scratch | Out-Null

$problems = New-Object System.Collections.Generic.List[string]
$warnings = New-Object System.Collections.Generic.List[string]
$facts = New-Object System.Collections.Generic.List[string]
$payload = Join-Path $Unpacked 'resources\agent-payload'

try {
    # NSIS keeps the whole app in one data block, which must stay below 2 GiB.
    if ($installerFile.Length -ge [int]::MaxValue) {
        $problems.Add('The installer is 2 GiB or larger; NSIS cannot install it.')
    }

    # One fixed identity: a newer installer replaces the installed app instead of adding another one.
    $product = $installerFile.VersionInfo.ProductName
    if ([string]::IsNullOrWhiteSpace($product)) {
        $problems.Add('The installer has no product name.')
    } elseif ($product.Contains($Commit.Substring(0, 7)) -and $env:UNIWORK_FIXED_IDENTITY -ne '0') {
        $problems.Add("The product name '$product' carries the commit, so every build would install as another app.")
    }
    # apps/desktop/nsis/installer.nsh names the install folder (APP_FILENAME). It must not be UniWork:
    # the earlier UniWork app installs to %ProgramFiles%\UniWork, and sharing it mixes and uninstalls both apps.
    $nsisInclude = Join-Path $PSScriptRoot '..\..\apps\desktop\nsis\installer.nsh'
    $installName = ''
    if (Test-Path -LiteralPath $nsisInclude -PathType Leaf) {
        $define = Select-String -LiteralPath $nsisInclude -Pattern '^\s*!define APP_FILENAME "([^"]+)"' | Select-Object -First 1
        if ($null -ne $define) { $installName = $define.Matches[0].Groups[1].Value }
    }
    if ([string]::IsNullOrWhiteSpace($installName)) {
        $problems.Add("Cannot read the install folder name (!define APP_FILENAME) from $nsisInclude.")
        $installName = $product
    } elseif ($installName -eq 'UniWork') {
        $problems.Add('The install folder is UniWork, which the earlier UniWork app also uses.')
    }
    $facts.Add("Product: $product (administrator installation to %ProgramFiles%\$installName)")

    $stampPath = Join-Path $Unpacked 'resources\install-stamp.json'
    if (-not (Test-Path -LiteralPath $stampPath -PathType Leaf)) {
        throw "Installer check failed: $stampPath is missing."
    }
    $stamp = Get-Content -LiteralPath $stampPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($stamp.commit -ne $Commit) {
        $problems.Add("The build stamp names commit $($stamp.commit), not $Commit.")
    }
    if ($null -eq $stamp.runtime) {
        throw 'Installer check failed: the build stamp carries no bundled runtime.'
    }
    $facts.Add("Commit: $($stamp.commit)")
    $repoDir = Join-Path $payload $stamp.runtime.repoDir

    # The incremental installer (apps/desktop/nsis/incremental-update.nsh) decides which runtime
    # components to keep by reading payload-stamp.txt. A missing or malformed stamp silently
    # disables incremental upgrades — every build must ship one that covers the whole payload.
    $payloadStamp = Join-Path $payload 'payload-stamp.txt'
    if (-not (Test-Path -LiteralPath $payloadStamp -PathType Leaf)) {
        $problems.Add('The payload carries no payload-stamp.txt; incremental upgrades cannot run.')
    } else {
        $lines = [System.IO.File]::ReadAllLines($payloadStamp)
        $schemaOk = $false; $targetOk = $false
        $stampComponents = [System.Collections.Generic.HashSet[string]]::new()
        $stampTools = [System.Collections.Generic.HashSet[string]]::new()
        foreach ($line in $lines) {
            if ($line -ceq 'schema 1') { $schemaOk = $true; continue }
            if ($line -cmatch '^target ([a-z0-9-]+)$') { $targetOk = $true; continue }
            if ($line -cmatch '^(venv|pm-runtime|uv-cache\.zip) [0-9a-f]{64}$') { $stampComponents.Add($Matches[1]) | Out-Null; continue }
            if ($line -cmatch '^tool (\S+) (\S+) (\S+) [0-9a-f]{64}$') { $stampTools.Add($Matches[1]) | Out-Null; continue }
            $problems.Add("payload-stamp.txt has an unexpected line: $line")
        }
        if (-not $schemaOk) { $problems.Add('payload-stamp.txt is missing "schema 1".') }
        if (-not $targetOk) { $problems.Add('payload-stamp.txt is missing a "target" line.') }
        foreach ($required in @('venv', 'pm-runtime', 'uv-cache.zip')) {
            if (-not $stampComponents.Contains($required)) {
                $problems.Add("payload-stamp.txt has no $required line; the incremental installer would skip it.")
            }
        }
        $toolsFacts = Join-Path $payload 'tools\facts.json'
        if (Test-Path -LiteralPath $toolsFacts -PathType Leaf) {
            $factsJson = Get-Content -LiteralPath $toolsFacts -Raw -Encoding UTF8 | ConvertFrom-Json
            foreach ($name in $factsJson.PSObject.Properties.Name) {
                if ($factsJson.$name.entry -and -not $stampTools.Contains($name)) {
                    $problems.Add("payload-stamp.txt is missing tool $name even though tools/facts.json records it.")
                }
            }
        }
        $facts.Add("Payload stamp: $($stampComponents.Count) components, $($stampTools.Count) tool(s)")
    }

    # Built-in kits and experts, where the backend looks for them: the installed app discovers plugins in
    # resources\python-plugins (older installers read the payload snapshot), and autoseed looks next to uniwork-kits.
    $pluginRoot = Join-Path $Unpacked 'resources\python-plugins'
    if (-not (Test-Path -LiteralPath $pluginRoot -PathType Container)) {
        $pluginRoot = Join-Path $repoDir 'plugins'
    }
    $kits = Join-Path $pluginRoot 'uniwork-kits\bundled\uniwork-bundled'
    $kitCount = @(Get-ChildItem -LiteralPath (Join-Path $kits 'plugins') -Filter '*.zip' -File -ErrorAction SilentlyContinue).Count
    $kitsOptional = ($env:UNIWORK_BUNDLED_PLUGINS -eq 'off') -or ($env:UNIWORK_BUNDLED_PLUGINS_REQUIRED -eq '0')
    if ($kitCount -eq 0 -and -not $kitsOptional) {
        $problems.Add('The installer carries no bundled kits or experts.')
    }
    $kitFact = "Kits: $kitCount package(s) in $($pluginRoot.Substring($Unpacked.Length + 1))"
    $record = Join-Path $kits 'source.json'
    if (Test-Path -LiteralPath $record -PathType Leaf) {
        $source = Get-Content -LiteralPath $record -Raw -Encoding UTF8 | ConvertFrom-Json
        $kitFact += " from $($source.source)"
        if ($source.commit) {
            $kitFact += " at $($source.commit.Substring(0, [math]::Min(12, $source.commit.Length)))"
        }
    }
    $facts.Add($kitFact)

    # Open Connector runs from resources with its own node_modules.
    $connector = Join-Path $Unpacked 'resources\open-connector'
    if (Test-Path -LiteralPath $connector -PathType Container) {
        if (-not (Test-Path -LiteralPath (Join-Path $connector 'node_modules\hono\package.json') -PathType Leaf)) {
            $problems.Add('Open Connector ships without its node_modules (npm run connectors:install was not run).')
        }
    }

    # The bundled interpreter must load the agent the way the app starts its backend.
    $saved = @{}
    foreach ($name in @('PYTHONPATH', 'PYTHONHOME', 'PYTHONNOUSERSITE', 'PYTHONDONTWRITEBYTECODE', 'PYTHONUTF8', 'HERMES_HOME')) {
        $saved[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
    }
    $preference = $ErrorActionPreference
    try {
        # Native stderr must not turn into a terminating error under Windows PowerShell.
        $ErrorActionPreference = 'Continue'
        $sitePackages = Join-Path $payload $stamp.runtime.sitePackages
        [Environment]::SetEnvironmentVariable('PYTHONPATH', "$repoDir;$sitePackages", 'Process')
        [Environment]::SetEnvironmentVariable('PYTHONHOME', $null, 'Process')
        [Environment]::SetEnvironmentVariable('PYTHONNOUSERSITE', '1', 'Process')
        [Environment]::SetEnvironmentVariable('PYTHONDONTWRITEBYTECODE', '1', 'Process')
        [Environment]::SetEnvironmentVariable('PYTHONUTF8', '1', 'Process')
        [Environment]::SetEnvironmentVariable('HERMES_HOME', (Join-Path $Scratch 'hermes-home'), 'Process')
        $python = Join-Path $payload $stamp.runtime.storePython
        $output = @(& $python -c 'import sys, hermes_cli.main; print(sys.version.split()[0])' 2>&1)
        if ($LASTEXITCODE -eq 0) {
            $facts.Add("Python: $($output[-1]) loads hermes_cli.main")
        } else {
            $tail = ($output | Select-Object -Last 8 | ForEach-Object { "$_" }) -join "`n   "
            $problems.Add("The bundled Python cannot load hermes_cli.main (exit $LASTEXITCODE):`n   $tail")
        }
    } finally {
        $ErrorActionPreference = $preference
        foreach ($name in $saved.Keys) {
            [Environment]::SetEnvironmentVariable($name, $saved[$name], 'Process')
        }
    }

    # NSIS works within MAX_PATH (259 usable characters). It extracts straight into the install folder
    # (apps/desktop/nsis/direct-extract.nsh), so only the install folder path limits the file paths.
    $longest = 0
    $longestPath = ''
    foreach ($file in [System.IO.Directory]::EnumerateFiles($Unpacked, '*', [System.IO.SearchOption]::AllDirectories)) {
        $length = $file.Length - $Unpacked.Length - 1
        if ($length -gt $longest) {
            $longest = $length
            $longestPath = $file.Substring($Unpacked.Length + 1)
        }
    }
    $installPrefix = Join-Path $env:ProgramFiles $installName
    if (($installPrefix.Length + 1 + $longest) -gt 259) {
        $problems.Add("The longest path ($longestPath) exceeds MAX_PATH under $installPrefix.")
    }
    # Users may pick another folder; report the longest one that still fits.
    $folderBudget = 259 - 1 - $longest
    if ($folderBudget -lt 40) {
        $warnings.Add("Only install folders up to $folderBudget characters fit; shorten: $longestPath")
    }
    $facts.Add("Paths: longest $longest characters; install folders up to $folderBudget characters fit (default $installPrefix)")
} finally {
    if ($ownScratch) {
        Remove-Item -LiteralPath $Scratch -Recurse -Force -ErrorAction SilentlyContinue
    }
}

Write-Host ''
Write-Host 'Installer check:' -ForegroundColor Cyan
foreach ($fact in $facts) {
    Write-Host "  $fact"
}
foreach ($warning in $warnings) {
    Write-Host "  WARNING: $warning" -ForegroundColor Yellow
}
foreach ($problem in $problems) {
    Write-Host "  PROBLEM: $problem" -ForegroundColor Red
}
if ($problems.Count -gt 0) {
    throw "Installer check failed; do not hand out $($installerFile.FullName)"
}
