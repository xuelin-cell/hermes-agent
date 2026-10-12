# Copyright 2026 Alibaba Group
# Licensed under the Apache License, Version 2.0
#
# DWS Local Installer for Windows - Install from bundled zip archives.
# No network access required, all binaries are included locally.
#
# Usage:
#   .\install.ps1              # Auto-detect architecture and install
#   .\install.ps1 -Arch amd64  # Force specific architecture
#   .\install.ps1 -Help        # Show help
#
# Environment variables:
#   $env:DWS_INSTALL_DIR  - where to put the binary (default: $HOME\.local\bin)

param(
    [string]$Arch = "",
    [switch]$Help,
    [switch]$Force
)

# --- Configuration ---

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$BinName = "dws.exe"
$InstallDir = if ($env:DWS_INSTALL_DIR) { $env:DWS_INSTALL_DIR } else { Join-Path $env:USERPROFILE ".local\bin" }

# --- Helpers ---

function Say($msg) {
    Write-Host "  $msg"
}

function Err($msg) {
    Write-Host "  [X] $msg" -ForegroundColor Red
    exit 1
}

function Warn($msg) {
    Write-Host "  [!] $msg" -ForegroundColor Yellow
}

function Print-Banner {
    Write-Host ""
    Say "+--------------------------------------+"
    Say "|     DWS Local Installer (Windows)    |"
    Say "|     DingTalk Workspace CLI           |"
    Say "+--------------------------------------+"
    Write-Host ""
}

# --- Architecture Detection ---

function Get-Architecture {
    if ($Arch -ne "") {
        return $Arch.ToLower()
    }

    $cpu = $env:PROCESSOR_ARCHITECTURE
    if ($cpu -eq "AMD64") {
        return "amd64"
    } elseif ($cpu -eq "ARM64") {
        return "arm64"
    } else {
        # Fallback: check .NET runtime
        $ptrSize = [System.IntPtr]::Size
        if ($ptrSize -eq 8) {
            # 64-bit, need to check if ARM
            if ($env:PROCESSOR_IDENTIFIER -match "ARM") {
                return "arm64"
            }
            return "amd64"
        }
        return "amd64"
    }
}

# --- Installation ---

function Install-Binary {
    $arch = Get-Architecture
    $archiveName = "dws-windows-$arch.zip"
    $archivePath = Join-Path $ScriptDir $archiveName

    Say "OS:      windows"
    Say "Arch:    $arch"
    Say "Archive: $archiveName"
    Say ""

    # Check if archive exists
    if (-not (Test-Path $archivePath)) {
        $available = Get-ChildItem -Path $ScriptDir -Filter "dws-windows-*.zip" -ErrorAction SilentlyContinue
        $availableList = if ($available) { $available.Name -join "`n   " } else { "(none)" }
        Err "Archive not found: $archivePath`n   Available archives in $ScriptDir`:`n   $availableList"
    }

    Say "[>] Extracting from local archive..."

    # Create temp directory
    $tmpdir = Join-Path $env:TEMP "dws-install-$(Get-Random)"
    New-Item -ItemType Directory -Path $tmpdir -Force | Out-Null

    try {
        # Extract archive
        Expand-Archive -Path $archivePath -DestinationPath $tmpdir -Force

        # Find the binary
        $foundBin = $null
        $exeInRoot = Join-Path $tmpdir $BinName
        $exeInSubdir = Join-Path $tmpdir "dws-windows-$arch\$BinName"

        if (Test-Path $exeInRoot) {
            $foundBin = $exeInRoot
        } elseif (Test-Path $exeInSubdir) {
            $foundBin = $exeInSubdir
        } else {
            $foundBin = Get-ChildItem -Path $tmpdir -Recurse -Filter $BinName -File -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty FullName
        }

        if (-not $foundBin -or -not (Test-Path $foundBin)) {
            Err "Could not find $BinName binary in the archive"
        }

        # Create install directory
        if (-not (Test-Path $InstallDir)) {
            New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
        }

        # Copy binary
        $destPath = Join-Path $InstallDir $BinName
        Copy-Item $foundBin $destPath -Force

        Say "[OK] Binary installed: $destPath"
    }
    finally {
        # Cleanup temp directory
        if (Test-Path $tmpdir) {
            Remove-Item $tmpdir -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}

function Test-InPath {
    $pathDirs = $env:PATH -split [System.IO.Path]::PathSeparator
    return $InstallDir -in $pathDirs
}

function Print-NextSteps {
    Say ""
    Say "[*] Installation complete!"
    Say ""

    if (-not (Test-InPath)) {
        Say "[!] $InstallDir is not in your PATH."
        Say ""
        Say "Add it to your PATH temporarily (current session):"
        Say '  $env:PATH = "{0}" + [System.IO.Path]::PathSeparator + $env:PATH' -f $InstallDir
        Say ""
        Say "Or add to your PowerShell profile for persistence:"
        Say "  1. Open your profile: notepad `$PROFILE"
        Say "  2. Add this line:"
        Say '     `$env:PATH = "{0}" + [System.IO.Path]::PathSeparator + `$env:PATH' -f $InstallDir
        Say ""
    }

    Say "Next steps:"
    Say "  dws version              # verify installation"
    Say "  dws auth login           # authenticate with DingTalk"
    Say "  dws --help               # explore commands"
    Say ""
    Say "For authentication, use:"
    Say "  . $ScriptDir\auth.ps1"
}

# --- Main ---

function Show-Help {
    Say "DWS Local Installer for Windows - Install from bundled zip archives"
    Say ""
    Say "Usage:"
    Say "  .\install.ps1              # Auto-detect architecture and install"
    Say "  .\install.ps1 -Arch ARCH   # Force specific architecture (amd64/arm64)"
    Say "  .\install.ps1 -Help        # Show this help"
    Say ""
    Say "Parameters:"
    Say "  -Arch      Architecture to install (amd64 or arm64)"
    Say "  -Force     Force reinstall even if already installed"
    Say "  -Help      Show this help message"
    Say ""
    Say "Environment variables:"
    Say "  `$env:DWS_INSTALL_DIR  - Installation directory (default: `$HOME\.local\bin)"
    Say ""
    Say "Supported architectures:"
    Say "  amd64  - x86_64 / x64"
    Say "  arm64  - aarch64 / ARM64"
    Say ""
    Say "Available local archives:"
    $archives = Get-ChildItem -Path $ScriptDir -Filter "dws-windows-*.zip" -ErrorAction SilentlyContinue
    if ($archives) {
        foreach ($f in $archives) {
            Say "  $($f.Name)"
        }
    } else {
        Say "  (none)"
    }
}

function Main {
    if ($Help) {
        Print-Banner
        Show-Help
        exit 0
    }

    # Validate architecture if specified
    if ($Arch -ne "") {
        $Arch = $Arch.ToLower()
        if ($Arch -notin @("amd64", "arm64")) {
            Err "Invalid architecture: $Arch. Supported: amd64, arm64"
        }
    }

    Print-Banner

    # Check if already installed
    $existingDws = Get-Command dws -ErrorAction SilentlyContinue
    if ($existingDws -and -not $Force) {
        $currentVersion = & dws version 2>$null
        Say "[!] dws is already installed: $($existingDws.Source)"
        Say "   Current version: $currentVersion"
        Say ""
        Say "Reinstalling to: $InstallDir"
        Say "Use -Force to skip this check in the future."
        Say ""
    }

    Install-Binary
    Print-NextSteps
}

Main
