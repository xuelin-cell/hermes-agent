<#
Decides which installed runtime components the new payload keeps, and tells the
NSIS installer (incremental-update.nsh) what to delete before extracting and
which archive paths to skip. It never changes the installation itself: the
installer falls back to a full extraction when this exits non-zero, and when
nothing can be kept the plan simply deletes every installed file.

Digests come from payload-stamp.txt, written by scripts/bundles/payload.py at
build time. The installed copy is re-hashed with the payload's own interpreter
(payload-digest.py) so a damaged or modified component is replaced rather than
carried over.

Exit codes: 0 plan written, 1 no plan (installer extracts everything over the
existing files), 2 the directory is not an installed payload.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Install,
    [Parameter(Mandatory = $true)][string]$NewStamp,
    [string]$OldStamp = '',
    [Parameter(Mandatory = $true)][string]$DeleteFile,
    [Parameter(Mandatory = $true)][string]$ExcludeFile,
    [string]$Log = ''
)

$ErrorActionPreference = 'Stop'
$notes = [System.Collections.Generic.List[string]]::new()
$utf8 = [System.Text.UTF8Encoding]::new($false)

function Add-Note([string]$message) {
    $notes.Add($message)
}

# NSIS reads the plan files as ANSI text, so only ASCII paths may enter them.
function Test-Ascii([string]$value) {
    foreach ($character in $value.ToCharArray()) {
        if ([int]$character -gt 127) {
            return $false
        }
    }
    return $true
}

function Read-PayloadStamp([string]$path) {
    if ([string]::IsNullOrWhiteSpace($path) -or -not [System.IO.File]::Exists($path)) {
        return $null
    }
    $stamp = @{ Schema = 0; Target = ''; Components = @{}; Tools = @{} }
    foreach ($line in [System.IO.File]::ReadAllLines($path)) {
        if ($line -ceq 'schema 1') {
            $stamp.Schema = 1
            continue
        }
        if ($line -cmatch '^target ([a-z0-9-]+)$') {
            $stamp.Target = $Matches[1]
            continue
        }
        if ($line -cmatch '^(venv|pm-runtime|uv-cache\.zip) ([0-9a-f]{64})$') {
            $stamp.Components[$Matches[1]] = $Matches[2]
            continue
        }
        if ($line -cmatch '^tool (\S+) (\S+) (\S+) ([0-9a-f]{64})$') {
            $stamp.Tools[$Matches[1]] = @{ Entry = $Matches[2]; Version = $Matches[3]; Digest = $Matches[4] }
            continue
        }
        # An unknown line means a stamp shape this installer does not understand.
        return $null
    }
    if ($stamp.Schema -ne 1 -or $stamp.Target -eq '') {
        return $null
    }
    return $stamp
}

function Get-ChildNames([string]$directory) {
    $names = [System.Collections.Generic.List[string]]::new()
    foreach ($entry in [System.IO.Directory]::EnumerateFileSystemEntries($directory)) {
        $names.Add([System.IO.Path]::GetFileName($entry))
    }
    return $names
}

$exitCode = 1
try {
    $installRoot = [System.IO.Path]::GetFullPath($Install).TrimEnd('\')
    $payload = Join-Path $installRoot 'resources\agent-payload'
    $manifestPath = Join-Path $payload 'manifest.json'
    Add-Note "plan for $installRoot"
    if (-not [System.IO.Directory]::Exists($installRoot) -or -not [System.IO.File]::Exists($manifestPath)) {
        Add-Note 'not an installed payload'
        $exitCode = 2
    } else {
        $new = Read-PayloadStamp $NewStamp
        if ($null -eq $new) {
            throw "the installer stamp is missing or unreadable: $NewStamp"
        }
        foreach ($name in @('venv', 'pm-runtime', 'uv-cache.zip')) {
            if (-not $new.Components.ContainsKey($name)) {
                throw "the installer stamp has no $name line"
            }
        }
        if ([string]::IsNullOrWhiteSpace($OldStamp)) {
            $OldStamp = Join-Path $payload 'payload-stamp.txt'
        }
        $old = Read-PayloadStamp $OldStamp

        $keep = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
        $keepTools = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
        if ($null -eq $old -or $old.Target -cne $new.Target) {
            Add-Note 'no comparable previous stamp: every installed file is replaced'
        } else {
            # Only a component the new build ships byte-identically is a candidate;
            # the installed bytes then get the final say below.
            $candidates = [System.Collections.Generic.List[object]]::new()
            foreach ($name in $new.Components.Keys) {
                if ($old.Components.ContainsKey($name) -and $old.Components[$name] -ceq $new.Components[$name]) {
                    $candidates.Add([pscustomobject]@{
                        Kind = 'component'; Name = $name; Entry = ''; Ok = $false
                        Path = (Join-Path $payload $name); Digest = $new.Components[$name]
                    })
                } else {
                    Add-Note "replace $name (new build)"
                }
            }
            foreach ($name in $new.Tools.Keys) {
                $tool = $new.Tools[$name]
                $previous = $old.Tools[$name]
                if ($null -ne $previous -and $previous.Entry -ceq $tool.Entry -and
                    $previous.Version -ceq $tool.Version -and $previous.Digest -ceq $tool.Digest) {
                    $candidates.Add([pscustomobject]@{
                        Kind = 'tool'; Name = $name; Entry = $tool.Entry; Ok = $false
                        Path = (Join-Path $payload "tools\$($tool.Entry)"); Digest = $tool.Digest
                    })
                } else {
                    Add-Note "replace tool $name (new build)"
                }
            }

            if ($candidates.Count -gt 0) {
                $manifest = [System.IO.File]::ReadAllText($manifestPath) | ConvertFrom-Json
                $python = Join-Path $payload $manifest.runtime.storePython
                $code = Join-Path $payload $manifest.runtime.repoDir
                if (-not [System.IO.File]::Exists($python) -or -not [System.IO.Directory]::Exists($code)) {
                    throw 'the installed payload cannot verify itself'
                }
                Add-Note "verifying $($candidates.Count) component(s) with the installed interpreter"
                $paths = @($candidates | ForEach-Object { $_.Path })
                $output = & $python -I -B (Join-Path $PSScriptRoot 'payload-digest.py') $code @paths
                if ($LASTEXITCODE -ne 0) {
                    throw "the installed interpreter could not verify components (exit $LASTEXITCODE)"
                }
                $verified = @{}
                # payload-digest.py answers "<path>`t<digest>" per line: PS 5.1
                # hands a top-level JSON array back as one object, not rows.
                foreach ($line in @($output)) {
                    $line = [string]$line
                    if ([string]::IsNullOrEmpty($line)) { continue }
                    $split = $line.IndexOf("`t")
                    if ($split -lt 1) {
                        throw "the installed interpreter returned an unexpected digest line: $line"
                    }
                    $verified[$line.Substring(0, $split)] = $line.Substring($split + 1)
                }
                $entries = @{}
                foreach ($candidate in $candidates) {
                    $actual = $verified[$candidate.Path]
                    $candidate.Ok = $actual -ceq $candidate.Digest
                    $why = if ($candidate.Ok) { 'keep' } else { 'replace' }
                    if ($candidate.Kind -eq 'component') {
                        if ($candidate.Ok) {
                            $keep.Add($candidate.Name) | Out-Null
                        }
                        Add-Note "$why $($candidate.Name)"
                    } elseif (-not $entries.ContainsKey($candidate.Entry)) {
                        $entries[$candidate.Entry] = $candidate.Ok
                    } else {
                        $entries[$candidate.Entry] = $entries[$candidate.Entry] -and $candidate.Ok
                    }
                }
                foreach ($entry in $entries.Keys) {
                    if ($entries[$entry]) {
                        $keepTools.Add($entry) | Out-Null
                        Add-Note "keep tool entry $entry"
                    } else {
                        Add-Note "replace tool entry $entry (installed bytes differ)"
                    }
                }
            }
        }

        $delete = [System.Collections.Generic.List[string]]::new()
        function Add-Delete([string]$relative) {
            $full = Join-Path $installRoot $relative
            if (-not [System.IO.File]::Exists($full) -and -not [System.IO.Directory]::Exists($full)) {
                return
            }
            if (-not (Test-Ascii $relative)) {
                Add-Note "keep $relative (name is not ASCII)"
                return
            }
            $delete.Add($relative)
        }
        if ($keep.Count -eq 0 -and $keepTools.Count -eq 0) {
            foreach ($name in Get-ChildNames $installRoot) { Add-Delete $name }
        } else {
            foreach ($name in Get-ChildNames $installRoot) {
                if ($name -ine 'resources') { Add-Delete $name }
            }
            $resources = Join-Path $installRoot 'resources'
            if ([System.IO.Directory]::Exists($resources)) {
                foreach ($name in Get-ChildNames $resources) {
                    if ($name -ine 'agent-payload') { Add-Delete "resources\$name" }
                }
            }
            foreach ($name in Get-ChildNames $payload) {
                if ($name -ieq 'tools') {
                    if ($keepTools.Count -eq 0) { Add-Delete 'resources\agent-payload\tools' }
                    continue
                }
                if (-not $keep.Contains($name)) { Add-Delete "resources\agent-payload\$name" }
            }
            if ($keepTools.Count -gt 0) {
                $toolsDir = Join-Path $payload 'tools'
                if ([System.IO.Directory]::Exists($toolsDir)) {
                    foreach ($name in Get-ChildNames $toolsDir) {
                        if (-not $keepTools.Contains($name)) { Add-Delete "resources\agent-payload\tools\$name" }
                    }
                }
            }
        }

        $exclusions = [System.Collections.Generic.List[string]]::new()
        foreach ($name in $keep) {
            if ($name -ieq 'uv-cache.zip') {
                $exclusions.Add("-x!resources\agent-payload\$name")
            } else {
                $exclusions.Add("-x!resources\agent-payload\$name\*")
            }
        }
        foreach ($entry in $keepTools) {
            $exclusions.Add("-x!resources\agent-payload\tools\$entry\*")
        }

        [System.IO.File]::WriteAllLines($DeleteFile, $delete, $utf8)
        if ($exclusions.Count -gt 0) {
            # One switch per line: NSIS builds the 7-Zip command in a 1024-character
            # variable and batches the lines itself.
            [System.IO.File]::WriteAllLines($ExcludeFile, $exclusions, $utf8)
        } elseif ([System.IO.File]::Exists($ExcludeFile)) {
            [System.IO.File]::Delete($ExcludeFile)
        }
        Add-Note "delete $($delete.Count) path(s), skip $($exclusions.Count) archive path(s)"
        $exitCode = 0
    }
} catch {
    Add-Note "failed: $($_.Exception.Message)"
    $exitCode = 1
} finally {
    if (-not [string]::IsNullOrWhiteSpace($Log)) {
        try {
            [System.IO.File]::WriteAllLines($Log, $notes, $utf8)
        } catch {
            # A missing log must not change the plan.
        }
    }
}
exit $exitCode
