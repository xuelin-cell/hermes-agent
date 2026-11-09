import fs from 'node:fs'
import path from 'node:path'

/**
 * Resolve PowerShell interpreter path.
 *
 * Spawning bare 'powershell.exe' trusts PATH to contain
 * %SystemRoot%\System32\WindowsPowerShell\v1.0. On machines whose PATH was
 * trimmed or stored as non-expanding REG_SZ, that lookup fails with ENOENT.
 * Resolve by absolute path first, then fall back to PATH search.
 */
export function resolvePowerShell(): string {
  for (const v of ['SystemRoot', 'windir'] as const) {
    const root = process.env[v]

    if (root) {
      const candidate = path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')

      try {
        if (fs.statSync(candidate).isFile()) {
          return candidate
        }
      } catch {
        void 0
      }
    }
  }

  const pathDirs = (process.env.PATH || process.env.Path || '').split(path.delimiter).filter(Boolean)

  for (const exe of ['powershell.exe', 'pwsh.exe']) {
    for (const dir of pathDirs) {
      const candidate = path.join(dir, exe)

      try {
        if (fs.statSync(candidate).isFile()) {
          return candidate
        }
      } catch {
        void 0
      }
    }
  }

  return 'powershell.exe'
}
