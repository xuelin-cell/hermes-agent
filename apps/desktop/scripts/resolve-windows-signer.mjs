// Windows signing certificate resolver.
// Locates signtool.exe and resolves certificate configuration (PFX or UKey thumbprint).
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'

// 注意：不直接导入 windows-bundle-tools.mjs，避免循环依赖
// ensureWindowsBundleTools 在 locateSignTool() 中动态导入

// Hardcoded UKey certificate thumbprint (same as hexagent/UniWork)
const UKEY_THUMBPRINT = '2E148B83366A90B70BB0AEBDB81C8CB982C39311'

/**
 * @typedef {'azure' | 'ukey' | 'pfx' | 'none'} SigningMode
 * @typedef {{ kind: 'pfx' | 'thumbprint', value: string, password?: string, subject?: string, thumbprint?: string }} CertificateConfig
 * @typedef {{ signtool: string, mode: SigningMode, certificate: CertificateConfig | null }} SignerConfig
 */

/**
 * Determine the signing mode from environment.
 * @param {NodeJS.ProcessEnv} [env=process.env]
 * @returns {SigningMode}
 */
export function resolveSigningMode(env = process.env) {
  const mode = env.HERMES_SIGNING_MODE
  // Only sign when explicitly in release mode
  if (mode !== 'release') return 'none'
  // Release mode: determine signing backend by priority (Azure > UKey > PFX)
  if (env.AZURE_SIGN_ENDPOINT && env.AZURE_CLIENT_ID) return 'azure'
  // UKey: use hardcoded thumbprint (no env var needed)
  return 'ukey'
}

/**
 * Get the hardcoded UKey thumbprint.
 * @returns {string}
 */
export function getUkeyThumbprint() {
  return UKEY_THUMBPRINT
}

/**
 * Locate signtool.exe using the bundle tools or fallback paths.
 * @param {object} [options]
 * @param {boolean} [options.signing=false]
 * @returns {Promise<string>}
 */
export async function locateSignTool({ signing = false } = {}) {
  // Prefer the bundle tools resolver (dynamic import to avoid circular dependency)
  try {
    const { ensureWindowsBundleTools } = await import('./windows-bundle-tools.mjs')
    const tools = await ensureWindowsBundleTools({ signing })
    if (tools.signtool && fs.existsSync(tools.signtool)) {
      return tools.signtool
    }
  } catch {
    // Fall through to fallback paths
  }

  // Fallback: winCodeSign cache (app-builder-lib downloads signtool here)
  const localAppData = process.env.LOCALAPPDATA || process.env.APPDATA
  if (localAppData) {
    const cacheRoot = path.join(localAppData, 'electron-builder', 'Cache', 'winCodeSign')
    if (fs.existsSync(cacheRoot)) {
      const versions = fs.readdirSync(cacheRoot).filter(d => d.startsWith('winCodeSign-'))
      for (const version of versions.sort().reverse()) {
        const candidate = path.join(cacheRoot, version, 'windows-10', 'x64', 'signtool.exe')
        if (fs.existsSync(candidate)) return candidate
      }
    }
  }

  // Last resort: PATH lookup
  const where = spawnSync('where', ['signtool.exe'], { encoding: 'utf8' })
  if (where.status === 0 && where.stdout.trim()) {
    return where.stdout.trim().split(/\r?\n/)[0]
  }

  throw new Error('signtool.exe not found: install Windows SDK or set HERMES_PREPARED_PACKAGING')
}

/**
 * Resolve certificate configuration from environment.
 * @param {SigningMode} mode
 * @param {NodeJS.ProcessEnv} [env=process.env]
 * @returns {CertificateConfig | null}
 */
export function resolveCertificate(mode, env = process.env) {
  if (mode === 'azure' || mode === 'none') return null

  if (mode === 'ukey') {
    // Use hardcoded thumbprint (same as hexagent/UniWork)
    const thumbprint = UKEY_THUMBPRINT
    return {
      kind: 'thumbprint',
      value: thumbprint.toUpperCase().replace(/\s+/g, ''),
      thumbprint: thumbprint.toUpperCase().replace(/\s+/g, ''),
    }
  }

  if (mode === 'pfx') {
    const pfxPath = env.WIN_CSC_LINK || env.CSC_LINK
    if (!pfxPath) throw new Error('WIN_CSC_LINK or CSC_LINK is required for PFX signing')
    if (!fs.existsSync(pfxPath)) throw new Error(`PFX file not found: ${pfxPath}`)
    return {
      kind: 'pfx',
      value: pfxPath,
      password: env.WIN_CSC_KEY_PASSWORD || env.CSC_KEY_PASSWORD || '',
    }
  }

  throw new Error(`Unknown signing mode: ${mode}`)
}

/**
 * Validate that the certificate is usable (has private key).
 * @param {CertificateConfig} cert
 * @param {string} signtool
 * @returns {Promise<{ valid: boolean, subject?: string, error?: string }>}
 */
export async function validateCertificate(cert, signtool) {
  if (cert.kind === 'pfx') {
    // For PFX, try to list certificates and check for private key
    const args = ['sign', '/f', cert.value]
    if (cert.password) args.push('/p', cert.password)
    args.push('/debug', '/?') // Just probe, don't actually sign

    const result = spawnSync(signtool, args, { encoding: 'utf8', timeout: 10000 })
    // signtool returns non-zero for /? but we can check stderr for password errors
    if (result.stderr && /invalid password|incorrect password/i.test(result.stderr)) {
      return { valid: false, error: 'PFX password is incorrect' }
    }
    return { valid: true }
  }

  if (cert.kind === 'thumbprint') {
    // For UKey/thumbprint, verify the certificate exists in the store with a private key
    const ps = `
      $tp = '${cert.thumbprint}'
      $cert = Get-ChildItem -Path Cert:\\CurrentUser\\My\\$tp -ErrorAction SilentlyContinue
      if (-not $cert) {
        $cert = Get-ChildItem -Path Cert:\\LocalMachine\\My\\$tp -ErrorAction SilentlyContinue
      }
      if (-not $cert) {
        Write-Output "NOT_FOUND"
        exit 1
      }
      if (-not $cert.HasPrivateKey) {
        Write-Output "NO_PRIVATE_KEY"
        exit 1
      }
      Write-Output "VALID"
      Write-Output $cert.Subject
    `

    // Use full path to avoid ENOENT in Git Bash / non-interactive shells
    const powershellPath = process.env.SYSTEMROOT
      ? path.join(process.env.SYSTEMROOT, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      : 'powershell.exe'

    const result = spawnSync(powershellPath, ['-NoProfile', '-Command', ps], {
      encoding: 'utf8',
      timeout: 15000,
    })

    if (result.error) {
      return { valid: false, error: `PowerShell spawn failed: ${result.error.message}` }
    }
    if (!result.stdout) {
      return { valid: false, error: `PowerShell returned no output (timeout or spawn failure)` }
    }

    const output = result.stdout.trim()
    if (output.includes('NOT_FOUND')) {
      return { valid: false, error: `Certificate with thumbprint ${cert.thumbprint} not found in store` }
    }
    if (output.includes('NO_PRIVATE_KEY')) {
      return { valid: false, error: `Certificate ${cert.thumbprint} has no private key (UKey may not be inserted)` }
    }
    if (output.includes('VALID')) {
      const lines = output.split(/\r?\n/)
      const subject = lines[lines.length - 1]
      return { valid: true, subject }
    }

    return { valid: false, error: `Failed to validate certificate: ${result.stderr}` }
  }

  return { valid: false, error: `Unknown certificate kind: ${cert.kind}` }
}

/**
 * Resolve the complete signer configuration.
 * @param {object} [options]
 * @param {boolean} [options.signing=false]
 * @param {NodeJS.ProcessEnv} [options.env=process.env]
 * @returns {Promise<SignerConfig>}
 */
export async function resolveSigner({ signing = false, env = process.env } = {}) {
  const mode = resolveSigningMode(env)
  const signtool = await locateSignTool({ signing: signing && mode !== 'none' })
  const certificate = resolveCertificate(mode, env)

  if (certificate && mode !== 'none') {
    const validation = await validateCertificate(certificate, signtool)
    if (!validation.valid) {
      throw new Error(`Certificate validation failed: ${validation.error}`)
    }
    if (validation.subject) {
      certificate.subject = validation.subject
    }
  }

  return { signtool, mode, certificate }
}

/**
 * Build signtool arguments for signing files.
 * @param {SignerConfig} signer
 * @param {string[]} files
 * @param {object} [options]
 * @param {string} [options.digestAlgorithm='sha256']
 * @param {string} [options.timestampUrl='http://timestamp.digicert.com']
 * @param {string} [options.description]
 * @param {string} [options.descriptionUrl]
 * @returns {string[]}
 */
export function buildSignArgs(signer, files, {
  digestAlgorithm = 'sha256',
  timestampUrl = 'http://timestamp.digicert.com',
  description,
  descriptionUrl,
} = {}) {
  const args = ['sign', `/fd`, digestAlgorithm]

  if (signer.mode === 'azure') {
    // Azure uses dlib/metadata - handled separately by caller
    throw new Error('Azure signing args should be built by batch-sign-binaries.mjs')
  }

  if (signer.mode === 'ukey' && signer.certificate) {
    args.push('/sha1', signer.certificate.thumbprint)
    args.push('/s', 'My')
  }

  if (signer.mode === 'pfx' && signer.certificate) {
    args.push('/f', signer.certificate.value)
    if (signer.certificate.password) {
      args.push('/p', signer.certificate.password)
    }
  }

  // Timestamp (RFC 3161)
  if (timestampUrl) {
    args.push('/tr', timestampUrl)
    args.push('/td', digestAlgorithm)
  }

  // Description
  if (description) {
    args.push('/d', description)
  }
  if (descriptionUrl) {
    args.push('/du', descriptionUrl)
  }

  // Debug mode for verbose output
  args.push('/debug')

  // Files to sign
  args.push(...files)

  return args
}

/**
 * Compute a fingerprint for the signing configuration (for cache invalidation).
 * @param {SignerConfig} signer
 * @returns {string}
 */
export function signingConfigFingerprint(signer) {
  const hash = createHash('sha256')
  hash.update(signer.mode)
  hash.update(signer.signtool)
  if (signer.certificate) {
    hash.update(signer.certificate.kind)
    hash.update(signer.certificate.value)
  }
  return hash.digest('hex')
}
