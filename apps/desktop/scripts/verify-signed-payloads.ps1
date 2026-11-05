param(
    [Parameter(Mandatory = $true)][string]$Manifest,
    [string]$SignTool = '',
    # Optional: match by thumbprint instead of Subject (more reliable for UKey certs)
    [string]$Thumbprint = ''
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$items = Get-Content -Raw -LiteralPath $Manifest | ConvertFrom-Json
$results = @(
    foreach ($item in $items) {
        $signature = Get-AuthenticodeSignature -LiteralPath $item.path
        # Match by thumbprint if provided, otherwise by Subject
        $certMatch = if ($Thumbprint) {
            $signature.SignerCertificate.Thumbprint -eq $Thumbprint
        } else {
            $signature.SignerCertificate.Subject -eq $item.publisher
        }
        $valid = $signature.Status -eq 'Valid' -and
            $signature.SignatureType -eq 'Authenticode' -and
            $null -ne $signature.TimeStamperCertificate -and
            $certMatch
        if ($signature.SignatureType -eq 'Catalog' -and $SignTool) {
            # Catalog lookup hides a replacement embedded signature. Verify index 0,
            # without /a, so catalog trust cannot approve corrupt or unsigned bytes.
            $exitCode = & {
                # PowerShell 5 turns redirected native stderr into a terminating error.
                $ErrorActionPreference = 'Continue'
                $global:LASTEXITCODE = $null
                & $SignTool verify /pa /tw /ds 0 $item.path *> $null
                $global:LASTEXITCODE
            }
            $valid = $false
            if ($exitCode -eq 0) {
                $certificate = [Security.Cryptography.X509Certificates.X509Certificate]::CreateFromSignedFile($item.path)
                try {
                    $certMatch = if ($Thumbprint) {
                        $certificate.Thumbprint -eq $Thumbprint
                    } else {
                        $certificate.Subject -eq $item.publisher
                    }
                    $valid = $certMatch
                }
                finally { $certificate.Dispose() }
            }
        }
        [PSCustomObject]@{ path = $item.path; valid = [bool]$valid }
    }
)
ConvertTo-Json -InputObject $results -Compress
