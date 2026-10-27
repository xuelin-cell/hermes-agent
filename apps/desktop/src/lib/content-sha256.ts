import { sha256 } from '@noble/hashes/sha2.js'

/** Intranet HTTP has no SubtleCrypto. Keep the same UTF-8 SHA-256 fingerprint in both contexts. */
export async function contentSha256(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text)
  const hash = globalThis.crypto?.subtle
    ? new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes))
    : sha256(bytes)

  return Array.from(hash, byte => byte.toString(16).padStart(2, '0')).join('')
}
