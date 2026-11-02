/**
 * payload-rehash-policy.mjs — decide whether afterPack must recompute the
 * payload digests.
 *
 * Assembly already wrote payload-stamp.txt from the bytes it staged, and
 * electron-builder copies those bytes verbatim into the unpacked app. Only a
 * step that rewrites shipped bytes invalidates that stamp:
 *   - Authenticode signing (batch-sign) rewrites every signed PE;
 *   - sanitize-pe-signatures clears a dangling certificate table in place.
 * An unsigned build that repaired nothing therefore ships exactly the bytes
 * the stamp describes, and re-hashing ~1.5 GiB of tools buys nothing.
 */

/**
 * @param {{ signSkipped: boolean, repairedCount: number, stampExists: boolean }} input
 *   signSkipped: batch-sign reported no signing identity was configured
 *   repairedCount: PEs sanitize-pe-signatures edited in place
 *   stampExists: payload-stamp.txt is present from assembly
 * @returns {boolean} true when the payload digests must be recomputed
 */
export function shouldRehashPayload({ signSkipped, repairedCount, stampExists }) {
  // Nothing to trust: assembly skipped the stamp or it was removed.
  if (!stampExists) return true
  // Signing ran, so the bytes the stamp describes are gone.
  if (!signSkipped) return true
  // In-place PE repairs changed bytes the stamp already covered.
  return repairedCount > 0
}
