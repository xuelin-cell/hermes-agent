import { Codecs, persistentAtom } from '@/lib/persisted'

/** File cards are reconstructed from transcripts; retain their session indicator across reloads. */
export const $sessionsWithFiles = persistentAtom<string[]>(
  'hermes.desktop.sessionsWithFiles.v1', [], Codecs.stringArray
)

export function noteSessionFile(sessionId: string | null): void {
  if (!sessionId || $sessionsWithFiles.get().includes(sessionId)) {
    return
  }

  $sessionsWithFiles.set([...$sessionsWithFiles.get(), sessionId])
}
