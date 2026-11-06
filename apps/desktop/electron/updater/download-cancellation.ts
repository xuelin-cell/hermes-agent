import type { AppUpdater } from 'electron-updater'

/** electron-updater's own token type, taken from the method signature so this
 *  module never has to import builder-util-runtime (a transitive dependency
 *  nested under electron-updater, not one we declare). */
type CancellationToken = NonNullable<Parameters<AppUpdater['downloadUpdate']>[0]>

type Listener = () => void

/**
 * The whole cancellation contract electron-updater's download path consumes:
 * `cancelled`, plus listeners the HTTP executor registers to abort the request
 * (`addListener`/`removeListener`, and `onCancel` in older runtimes). Implementing
 * that surface here keeps the abort path local instead of reaching into a
 * nested package, while deriving the type from electron-updater means a
 * contract change fails the typecheck.
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
