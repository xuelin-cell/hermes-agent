# Copyright 2026 Alibaba Group
# Licensed under the Apache License, Version 2.0
#
# DWS Authentication Script for Windows (Headless Environment)
# Handles device flow authentication with proper logging and status checking.
#
# Usage:
#   .\auth.ps1              # Start authentication flow
#   .\auth.ps1 -Check       # Only check auth status (no login)
#   .\auth.ps1 -Status      # Same as -Check
#
# Environment variables:
#   $env:DWS_AUTH_LOG_DIR  - Directory for auth logs (default: $env:USERPROFILE\.dws\sessions)
#   $env:DWS_AUTH_TIMEOUT  - Max seconds to wait for auth link (default: 30)

param(
    [switch]$Check,
    [switch]$Status,
    [switch]$Help
)

# --- Configuration ---

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$AuthLogDir = if ($env:DWS_AUTH_LOG_DIR) { $env:DWS_AUTH_LOG_DIR } else { Join-Path $env:USERPROFILE ".dws\sessions" }
$AuthLogFile = Join-Path $AuthLogDir "dws_auth.log"
$AuthTimeout = if ($env:DWS_AUTH_TIMEOUT) { [int]$env:DWS_AUTH_TIMEOUT } else { 30 }

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

# Check if dws command is available
function Test-DwsInstalled {
    $dws = Get-Command dws -ErrorAction SilentlyContinue
    return $null -ne $dws
}

# Ensure log directory exists
function Ensure-LogDir {
    if (-not (Test-Path $AuthLogDir)) {
        try {
            New-Item -ItemType Directory -Path $AuthLogDir -Force | Out-Null
        }
        catch {
            Warn "Cannot create log directory: $AuthLogDir"
            $script:AuthLogDir = $env:TEMP
            $script:AuthLogFile = Join-Path $env:TEMP "dws_auth_$env:USERNAME.log"
        }
    }
}

# Get current auth status in JSON format
function Get-AuthStatus {
    $result = dws auth status --format json 2>&1
    if ($LASTEXITCODE -eq 0 -and $result) {
        return $result
    }
    return '{"authenticated":false}'
}

# Check if currently authenticated
function Test-Authenticated {
    $status = Get-AuthStatus

    # Check for "authenticated": true
    if ($status -match '"authenticated"\s*:\s*true') {
        return $true
    }

    # Check for "status": "authenticated"
    if ($status -match '"status"\s*:\s*"authenticated"') {
        return $true
    }

    return $false
}

# --- Main Authentication Flow ---

function Start-Auth {
    # Step 1: Check dws installation
    if (-not (Test-DwsInstalled)) {
        Err "dws is not installed or not in PATH. Please run install.ps1 first.`n   Install script: $ScriptDir\install.ps1"
    }

    $dwsPath = (Get-Command dws).Source
    Say "[OK] dws is installed: $dwsPath"

    # Step 2: Check current auth status
    Say ""
    Say "Checking authentication status..."

    $authStatus = Get-AuthStatus
    Say $authStatus

    if (Test-Authenticated) {
        Say ""
        Say "[OK] Already authenticated!"
        exit 0
    }

    Say ""
    Say "[!] Not authenticated. Starting device flow login..."

    # Step 3: Ensure log directory and clean up old log
    Ensure-LogDir

    if (Test-Path $AuthLogFile) {
        Remove-Item $AuthLogFile -Force
    }

    # Step 4: Start device flow login in background
    Say ""
    Say "Starting device flow authentication..."
    Say "Log file: $AuthLogFile"
    Say ""

    # Run dws auth login --device in background
    $AuthLogFileErr = Join-Path $AuthLogDir "dws_auth_err.log"
    $process = Start-Process -FilePath "dws" -ArgumentList "auth", "login", "--device" -RedirectStandardOutput $AuthLogFile -RedirectStandardError $AuthLogFileErr -NoNewWindow -PassThru

    Say "Authentication process started (PID: $($process.Id))"
    Say "Waiting for authorization link..."
    Say ""

    # Step 5: Wait for auth link to appear in log
    $waited = 0

    while ($waited -lt $AuthTimeout) {
        Start-Sleep -Seconds 1
        $waited++

        if (Test-Path $AuthLogFile) {
            $logContent = Get-Content $AuthLogFile -Raw -ErrorAction SilentlyContinue

            if ($logContent) {
                # Check for authorization link or code
                if ($logContent -match "https://" -or $logContent -match "dingtalk" -or $logContent -match "code") {
                    break
                }
            }
        }
    }

    # Step 6: Display auth information
    Say "================================================================"
    Say "[*] AUTHORIZATION REQUIRED"
    Say "================================================================"
    Say ""

    if (Test-Path $AuthLogFile) {
        Get-Content $AuthLogFile
        Say ""
    }

    Say "================================================================"
    Say ""
    Say "[^] Please open the authorization link above in your browser and complete"
    Say "   the DingTalk scan/authorization."
    Say ""
    Say "[*] The authentication process is running in the background (PID: $($process.Id))."
    Say ""
    Say "After authorization, run one of the following to verify:"
    Say "  . $ScriptDir\auth.ps1 -Check"
    Say "  dws auth status --format json"
    Say ""
    Say "Log file: $AuthLogFile"
}

# --- Check Only Mode ---

function Test-AuthStatus {
    if (-not (Test-DwsInstalled)) {
        Err "dws is not installed or not in PATH."
    }

    Say "Current authentication status:"
    Say ""

    $authStatus = Get-AuthStatus
    Say $authStatus
    Say ""

    if (Test-Authenticated) {
        Say "[OK] Status: AUTHENTICATED"
        exit 0
    }
    else {
        Say "[X] Status: NOT AUTHENTICATED"
        Say ""
        Say "Run the following to authenticate:"
        Say "  . $ScriptDir\auth.ps1"
        exit 1
    }
}

# --- Main Entry ---

function Show-Help {
    Say "Usage: .\auth.ps1 [OPTIONS]"
    Say ""
    Say "Options:"
    Say "  -Check, -Status  Check auth status only (no login)"
    Say "  -Help            Show help message"
    Say ""
    Say "Environment variables:"
    Say "  `$env:DWS_AUTH_LOG_DIR   Directory for auth logs (default: `$env:USERPROFILE\.dws\sessions)"
    Say "  `$env:DWS_AUTH_TIMEOUT   Max seconds to wait for auth link (default: 30)"
}

function Main {
    if ($Help) {
        Show-Help
        exit 0
    }

    if ($Check -or $Status) {
        Test-AuthStatus
    }
    else {
        Start-Auth
    }
}

Main
