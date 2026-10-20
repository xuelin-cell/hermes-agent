import type { ArtifactShareService } from './service'

/** One startup pass plus five-minute retries; a slow pass never overlaps itself. */
export function startArtifactShareCleanup(
  service: ArtifactShareService,
  onError: (error: unknown) => void
): () => void {
  let running = false
  let stopped = false

  const run = async () => {
    if (running || stopped) {
      return
    }

    running = true

    try {
      const result = await service.cleanupExpired()

      if (result.failed) {
        onError(new Error(`${result.failed} expired artifact shares await cleanup retry`))
      }
    } catch (error) {
      onError(error)
    } finally {
      running = false
    }
  }

  void run()
  const timer = setInterval(() => void run(), 5 * 60 * 1000)
  timer.unref()

  return () => {
    stopped = true
    clearInterval(timer)
  }
}
