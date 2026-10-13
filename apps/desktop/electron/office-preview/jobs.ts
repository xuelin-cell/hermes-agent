/** 同一个队列一次只执行一个转换；按账号缓存目录和文件版本合并重复请求。 */
export class OfficePreviewJobs<T> {
  private tail: Promise<void> = Promise.resolve()
  private pending = new Map<string, Promise<T>>()

  /** 调用方离开不取消任务；成功或失败都释放队列，允许之后显式重试。 */
  run(scope: string, key: string, work: () => Promise<T>): Promise<T> {
    const identity = JSON.stringify([scope, key])
    const existing = this.pending.get(identity)

    if (existing) {
      return existing
    }

    const result = this.tail.then(work)
    this.pending.set(identity, result)

    // 两条结束路径都消费结果，避免 finally 产生无人处理的拒绝 Promise。
    const settle = () => {
      this.pending.delete(identity)
    }

    this.tail = result.then(settle, settle)

    return result
  }
}
