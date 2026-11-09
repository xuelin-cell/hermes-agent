import type { AppUpdater } from 'electron-updater'

/** electron-updater's own token type, taken from the method signature so this
 *  module never has to import builder-util-runtime (a transitive dependency
 *  nested under electron-updater, not one we declare). */
type CancellationToken = NonNullable<Parameters<AppUpdater['downloadUpdate']>[0]>

type Listener = () => void

/** builder-util-runtime's own cancellation error, re-created locally: the
 *  transfer path only ever checks `cancelled` on this token, and the strategy
 *  turns an aborted transfer into the user's decision instead of a failure. */
function cancelledError(): Error {
  const error: Error = new Error('cancelled')

  error.name = 'CancellationError'

  return error
}

/**
 * The whole cancellation contract electron-updater's download path consumes:
 * `cancelled`, `addListener`/`removeListener`/`onCancel`, and `createPromise`.
 * Implementing that surface here keeps the abort path local instead of reaching
 * into a nested package, while deriving the type from electron-updater means a
 * contract change fails the typecheck.
 *
 * `createPromise` is not optional: the HTTP executor wraps every buffer
 * download in it (the blockmap fetch, and the full-download fallback), so a
 * token without it fails those transfers outright — exactly the transfers a
 * client-side cancel has to be able to stop.
 */
export class DownloadCancellation {
  private cancelledFlag = false
  private listeners: Listener[] = []

  get cancelled(): boolean {
    return this.cancelledFlag
  }

  /** builder-util-runtime semantics: a listener added after cancellation runs
   *  immediately, so a request started late still aborts. */
  addListener(listener: Listener): void {
    if (this.cancelledFlag) {
      listener()

      return
    }

    this.listeners.push(listener)
  }

  removeListener(listener: Listener): void {
    this.listeners = this.listeners.filter(entry => entry !== listener)
  }

  onCancel(listener: Listener): void {
    this.addListener(listener)
  }

  /** Run one request under this token: cancelling aborts it and rejects, which
   *  is how an in-flight buffer download stops mid-transfer. */
  createPromise<T>(
    callback: (resolve: (value: T) => void, reject: (error: Error) => void, onCancel: (abort: Listener) => void) => void
  ): Promise<T> {
    if (this.cancelledFlag) {
      return Promise.reject(cancelledError())
    }

    return new Promise<T>((resolve: (value: T) => void, reject: (error: Error) => void): void => {
      let abortRequest: Listener | null = null
      let settled = false

      const settle = (): boolean => {
        if (settled) {
          return false
        }

        settled = true
        this.removeListener(onCancel)

        return true
      }

      const onCancel: Listener = (): void => {
        if (!settle()) {
          return
        }

        try {
          abortRequest?.()
        } catch {
          // Aborting a request that already went away must not mask the
          // cancellation itself.
        }

        abortRequest = null
        reject(cancelledError())
      }

      this.addListener(onCancel)
      callback(
        (value: T): void => {
          if (settle()) {
            resolve(value)
          }
        },
        (error: Error): void => {
          if (settle()) {
            reject(error)
          }
        },
        (abort: Listener): void => {
          abortRequest = abort
        }
      )
    })
  }

  dispose(): void {
    this.listeners = []
  }

  get token(): CancellationToken {
    return this as unknown as CancellationToken
  }

  /** Returns false when the transfer already settled — nothing left to abort. */
  cancel(): boolean {
    if (this.cancelledFlag) {
      return false
    }

    this.cancelledFlag = true

    for (const listener of this.listeners) {
      listener()
    }

    this.dispose()

    return true
  }
}
