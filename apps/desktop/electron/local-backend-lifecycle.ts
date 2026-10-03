import { createBackendShutdownCoordinator } from './backend-ownership'
import { markExpectedTransition } from './crash-forensics'

/** Observe every branch, but never leave quit parked on a lost exit/SSH callback. */
export async function waitForTeardown(tasks: readonly Promise<unknown>[], timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined

  try {
    await Promise.race([
      Promise.allSettled(tasks),
      new Promise<void>((resolve: () => void): void => {
        timer = setTimeout(resolve, timeoutMs)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

interface LocalBackendLifecycleDeps<Child> {
  stopChild: (child: Child) => void
  waitForExit: (child: Child) => Promise<void>
  cancelSetup: () => void
  timeoutMs?: number
}

/**
 * Physical ownership outlives routing entries: track starts before their first
 * await and children before their asynchronous identity claim. The permanent
 * shutdown signal and synchronous spawn fence make bounded waiting safe: a late
 * resolver can finish, but can never create another owned backend.
 */
export interface LocalBackendLifecycle<Child> {
  signal: AbortSignal
  assertCanStart: () => void
  hasPending: () => boolean
  start: <T>(run: () => Promise<T>) => Promise<T>
  spawn: (create: () => Child) => Child
  release: (child: Child) => boolean
  stop: (child: Child | null | undefined) => Promise<void>
  shutdown: () => Promise<void>
  seal: () => void
  ownedChildren: () => Child[]
  settleStarts: () => Promise<void>
}

export function createLocalBackendLifecycle<Child>(
  deps: LocalBackendLifecycleDeps<Child>
): LocalBackendLifecycle<Child> {
  const controller = new AbortController()
  const starts = new Set<Promise<unknown>>()
  const children = new Set<Child>()
  const stops = new Map<Child, Promise<void>>()

  function stop(child: Child | null | undefined): Promise<void> {
    if (child == null) {
      return Promise.resolve()
    }

    const existing = stops.get(child)

    if (existing) {
      return existing
    }

    const stopping = (async (): Promise<void> => {
      deps.stopChild(child)
      await deps.waitForExit(child)
    })()

    stops.set(child, stopping)
    void stopping.then(
      (): boolean => stops.delete(child),
      (): boolean => stops.delete(child)
    )

    return stopping
  }

  /** 先封闭启动入口；退出账号需要在停止前记录完整进程子树。 */
  function seal(): void {
    controller.abort(markExpectedTransition(new Error('Hermes Desktop is quitting.')))
    deps.cancelSetup()
  }

  const shutdown = createBackendShutdownCoordinator((): Promise<void> => {
    seal()

    return waitForTeardown([...starts, ...[...children].map(stop), ...stops.values()], deps.timeoutMs ?? 7_000)
  })

  return {
    seal,
    ownedChildren: (): Child[] => [...children],
    /** 等待已封闭的启动任务完成归属写入；超时不能作为退出成功。 */
    async settleStarts(): Promise<void> {
      // 启动被取消的拒绝是预期结果；这里只确认不再存在迟到的归属写入。
      let timer: ReturnType<typeof setTimeout> | undefined

      try {
        await Promise.race([
          Promise.allSettled([...starts]),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error('后端启动尚未结束。')), deps.timeoutMs ?? 15_000)
          })
        ])
      } finally {
        clearTimeout(timer)
      }
    },
    signal: controller.signal,
    assertCanStart: (): void => controller.signal.throwIfAborted(),
    hasPending: (): boolean => starts.size > 0 || children.size > 0 || stops.size > 0 || shutdown.isPending(),
    start<T>(run: () => Promise<T>): Promise<T> {
      if (controller.signal.aborted) {
        return Promise.reject(controller.signal.reason)
      }

      // Defer invocation one microtask so the inventory precedes all work.
      const promise = Promise.resolve().then((): Promise<T> => {
        controller.signal.throwIfAborted()

        return run()
      })

      starts.add(promise)
      void promise.then(
        (): boolean => starts.delete(promise),
        (): boolean => starts.delete(promise)
      )

      return promise
    },
    spawn(create: () => Child): Child {
      controller.signal.throwIfAborted()
      const child = create()
      children.add(child)

      return child
    },
    release: (child: Child): boolean => children.delete(child),
    stop,
    shutdown: shutdown.run
  }
}
