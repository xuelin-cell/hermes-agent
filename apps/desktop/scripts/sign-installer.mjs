// Sign the NSIS installer with the resolved UKey/PFX certificate, then regenerate
// the blockmap and stable.yml (electron-builder's were computed before signing).
// Called from build-windows-installer.ps1 immediately after electron-builder
// finishes, when the UKey PIN cache is still fresh.
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'

import { buildBlockMap } from 'app-builder-lib/internal'
import { resolveSigner, buildSignArgs } from './resolve-windows-signer.mjs'

const installerIdx = process.argv.indexOf('-Installer')
const installer = installerIdx >= 0 ? process.argv[installerIdx + 1] : process.argv[2]

if (!installer) {
  console.error('Usage: sign-installer.mjs -Installer <path>')
  process.exit(1)
}

if (!fs.existsSync(installer)) {
  console.error('Installer not found:', installer)
  process.exit(1)
}

console.log('[sign-installer] Resolving signer...')
const signer = await resolveSigner({ signing: true })

if (signer.mode === 'none') {
  console.log('[sign-installer] Signing mode is none — skipping')
  process.exit(0)
}

console.log('[sign-installer] Signer:', { mode: signer.mode, thumbprint: signer.certificate?.thumbprint })

const args = buildSignArgs(
  { mode: signer.mode, certificate: signer.certificate },
  [installer],
  { timestampUrl: 'http://timestamp.digicert.com' }
)

console.log('[sign-installer] Signing installer...')
const result = spawnSync(signer.signtool, args, { stdio: 'inherit', timeout: 120000 })

if (result.status !== 0) {
  console.error('[sign-installer] Signing failed with exit code:', result.status)
  process.exit(result.status ?? 1)
}

console.log('[sign-installer] Successfully signed:', installer)

// Regenerate blockmap after signing (electron-builder's was computed pre-sign)
const blockmapPath = installer + '.blockmap'
console.log('[sign-installer] Regenerating blockmap...')
try {
  await buildBlockMap(installer, 'deflate', blockmapPath)
  console.log('[sign-installer] Blockmap regenerated:', blockmapPath)
} catch (err) {
  console.error('[sign-installer] Failed to regenerate blockmap:', err.message)
  process.exit(1)
}

// Regenerate stable.yml with the signed installer's checksum
const stableYmlPath = path.join(path.dirname(installer), 'stable.yml')
if (fs.existsSync(stableYmlPath)) {
  console.log('[sign-installer] Regenerating stable.yml...')
  try {
    const installerContent = fs.readFileSync(installer)
    const sha512 = createHash('sha512').update(installerContent).digest('base64')
    const size = installerContent.length
    const installerName = path.basename(installer)

    // Parse existing stable.yml to preserve version, releaseDate, and other fields
    const existingYml = fs.readFileSync(stableYmlPath, 'utf8')
    const versionMatch = existingYml.match(/^version:\s*(.+)$/m)
    const releaseDateMatch = existingYml.match(/^releaseDate:\s*'(.+)'$/m)

    const version = versionMatch ? versionMatch[1] : '0.0.0'
    const releaseDate = releaseDateMatch ? releaseDateMatch[1] : new Date().toISOString()

    const newYml = `version: ${version}
files:
  - url: ${installerName}
    sha512: ${sha512}
    size: ${size}
    isAdminRightsRequired: true
releaseDate: '${releaseDate}'
`
    fs.writeFileSync(stableYmlPath, newYml, 'utf8')
    console.log('[sign-installer] stable.yml regenerated:', stableYmlPath)
  } catch (err) {
    console.error('[sign-installer] Failed to regenerate stable.yml:', err.message)
    process.exit(1)
  }
}

process.exit(0)
