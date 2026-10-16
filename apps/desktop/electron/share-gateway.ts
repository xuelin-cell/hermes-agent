const GATEWAY = 'https://maas.ai-yuanjing.com/app/gateway/uniclaw-shares'

/** 向固定公司网关上传静态快照；凭据只由主进程提供，不接受页面指定地址。 */
export async function uploadShareHtml(
  request: typeof fetch,
  token: string,
  shareId: string,
  body: Buffer,
  signal?: AbortSignal
): Promise<string> {
  const response = await request(`${GATEWAY}/${shareId}.html`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/html' },
    body: new Uint8Array(body),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000)
  })

  if (!response.ok) {
    throw new Error(`分享服务返回 ${response.status}，请稍后重试。`)
  }

  const result: unknown = await response.json()

  if (
    !result ||
    typeof result !== 'object' ||
    !('shareId' in result) ||
    result.shareId !== shareId ||
    !('url' in result) ||
    typeof result.url !== 'string' ||
    !result.url.startsWith('https://')
  ) {
    throw new Error('分享服务返回无效链接。')
  }

  return result.url
}

/** 仅在服务器确认删除后返回，调用方才能撤销本地记录。 */
export async function deleteSharedPage(request: typeof fetch, token: string, shareId: string): Promise<void> {
  const response = await request(`${GATEWAY}/${shareId}.html`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(30_000)
  })

  if (response.status !== 204) {
    throw new Error(`取消分享失败：服务返回 ${response.status}。`)
  }
}
