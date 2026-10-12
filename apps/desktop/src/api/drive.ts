export interface DriveAsset {
  asset_id: string
  fid?: string
  name: string
  kind: 'directory' | 'file'
  size_bytes?: number
}

/** 云盘凭据由主进程添加，不读取旧 Web 登录缓存。 */
export async function driveRequest<T>(
  route: string,
  method: 'GET' | 'POST' | 'PATCH' = 'GET',
  body?: Record<string, unknown>
): Promise<T> {
  if (!window.hermesDesktop?.cloudDriveRequest) {
    throw new Error('请使用新版桌面端打开个人云盘')
  }

  return (await window.hermesDesktop.cloudDriveRequest({ route, method, body })) as T
}

/** 查询文件详情后取得签名下载地址。 */
export async function driveDownload(asset: DriveAsset): Promise<string> {
  const fid =
    asset.fid || (await driveRequest<{ fid: string }>('/unicom/FileDetails', 'POST', { fileId: asset.asset_id })).fid

  const result = await driveRequest<{ download_url: string }>('/assets/download', 'POST', { fid })
  const url = new URL(result.download_url)

  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error('云盘下载地址无效')
  }

  return result.download_url
}
