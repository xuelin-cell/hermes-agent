interface QueuedJob<T> {
  promise: Promise<T>
  waiters: number
}

/** 同一个队列一次只执行一个转换；按账号缓存目录和文件版本合并重复请求。 */
export class OfficePreviewJobs<T> {
  private tail: Promise<void> = Promise.resolve()
  private pending = new Map<string, QueuedJob<T>>()

  /**
   * 成功或失败都释放队列，允许之后显式重试。已经开始的转换不中途取消；
   * 还在排队时所有等待方都已离开（signal 取消），轮到它时直接跳过，不让没人看的转换挡住当前文件。
   */
  run(scope: string, key: string, work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const identity = JSON.stringify([scope, key])
    let job = this.pending.get(identity)

    if (!job) {
      const queued: QueuedJob<T> = { promise: Promise.resolve() as Promise<T>, waiters: 0 }

      queued.promise = this.tail.then(() => {
        if (queued.waiters > 0) {
          return work()
        }

        throw Object.assign(new Error('Office preview request was abandoned'), { code: 'unavailable' })
      })

      this.pending.set(identity, queued)

      // 两条结束路径都消费结果，避免 finally 产生无人处理的拒绝 Promise。
      const settle = () => {
        this.pending.delete(identity)
      }

      this.tail = queued.promise.then(settle, settle)
      job = queued
    }

    if (!signal?.aborted) {
      const joined = job
      joined.waiters++
      signal?.addEventListener('abort', () => joined.waiters--, { once: true })
    }

    return job.promise
  }
}
