interface QueuedJob<T> {
  identity: string
  promise: Promise<T>
  waiters: number
  background: boolean
  work: () => Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
  cleanup: (() => void)[]
}

/** 同一个队列一次只执行一个转换；按账号缓存目录和文件版本合并重复请求。 */
export class OfficePreviewJobs<T> {
  private queue: QueuedJob<T>[] = []
  private running = false
  private pending = new Map<string, QueuedJob<T>>()

  /**
   * 成功或失败都释放队列，允许之后显式重试。已经开始的转换不中途取消；
   * 还在排队时所有等待方都已离开（signal 取消），轮到它时直接跳过，不让没人看的转换挡住当前文件。
   */
  run(scope: string, key: string, work: () => Promise<T>, signal?: AbortSignal, background = false): Promise<T> {
    const identity = JSON.stringify([scope, key])
    let job = this.pending.get(identity)

    if (!job) {
      let resolve!: (value: T) => void
      let reject!: (error: unknown) => void

      const promise = new Promise<T>((done, fail) => {
        resolve = done
        reject = fail
      })

      // 队列自己消费拒绝；等待方稍后才接收取消结果时也不产生未处理拒绝。
      void promise.catch(() => undefined)
      job = { identity, promise, waiters: 0, background, work, resolve, reject, cleanup: [] }
      this.pending.set(identity, job)
      this.queue.push(job)
    }

    if (!signal?.aborted) {
      const joined = job
      joined.waiters++

      if (!background) {
        joined.background = false
      }

      // 每个调用方只撤销自己的等待，不能取消其它卡片或已经开始的转换。
      const leave = () => joined.waiters--
      signal?.addEventListener('abort', leave, { once: true })
      joined.cleanup.push(() => signal?.removeEventListener('abort', leave))
    }

    queueMicrotask(() => this.next())

    return job.promise
  }

  /** 只对尚未开始的任务排优先级；正在转换的 Office 实例按原流程安全完成。 */
  private next(): void {
    if (this.running || !this.queue.length) {
      return
    }

    const foreground = this.queue.findIndex(job => !job.background && job.waiters > 0)
    const job = this.queue.splice(foreground < 0 ? 0 : foreground, 1)[0]
    this.running = true

    const result = (async () => {
      if (!job.waiters) {
        throw Object.assign(new Error('Office preview request was abandoned'), { code: 'unavailable' })
      }

      return job.work()
    })()

    void result.then(
      value => {
        this.finish(job)
        job.resolve(value)
      },
      error => {
        this.finish(job)
        job.reject(error)
      }
    )
  }

  /** 先解除合并记录和取消监听，再结算请求，显式重试不会复用已经结束的任务。 */
  private finish(job: QueuedJob<T>): void {
    this.pending.delete(job.identity)
    job.cleanup.forEach(cleanup => cleanup())
    this.running = false
    queueMicrotask(() => this.next())
  }
}
