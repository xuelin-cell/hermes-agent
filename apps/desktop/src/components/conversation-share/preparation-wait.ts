/** 让不支持取消的 IPC 和模块加载也能及时退出等待，迟到结果由调用者清理。 */
export async function waitForPreparation<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()

  return await new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    void operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}
