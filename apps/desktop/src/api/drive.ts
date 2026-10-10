import { $uniWorkAuth, logoutUniWork } from '@/store/uniwork-auth'

import { hermesApi } from './client'

export interface DriveAsset {
  asset_id: string
  fid?: null | string
  parent_asset_id: null | string
  name: string
  kind: 'directory' | 'file'
  size_bytes: null | number
  modified_at: null | string
  mime_type?: string
}

export interface DriveFolder {
  asset_id: string
  name: string
}

export interface DrivePage {
  items: DriveAsset[]
  ancestors?: DriveFolder[]
  page: { has_more: boolean; page_no: number; page_size: number; total: null | number }
}

interface DriveEnvelope<T> {
  data: T
  ok: boolean
  status: string
}

async function driveRequest<T>(route: string, method: 'GET' | 'PATCH' | 'POST' = 'GET', body?: unknown) {
  const user = $uniWorkAuth.get().user

  if (!user?.token || !user.phone) {throw new Error('请先登录 UniWork 账户')}

  try {
    const result = await hermesApi<DriveEnvelope<T>>({
      method: 'POST',
      path: '/api/uniwork/drive/request',
      body: { login: user.token, phone: user.phone, route, method, body }
    })

    return result.data
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)

    if (/^401\b|\b401:|登录已失效|重新登录|认证失败/.test(message)) {
      logoutUniWork()
      throw new Error('UniWork 登录已失效，请重新登录')
    }

    throw error
  }
}

export const driveApi = {
  spaces: () => driveRequest<{ items: Array<{ kind: string; name: string; root_asset_id: string; space_id: string }> }>('/asset-spaces'),
  list: (spaceId: string, parentId: string, query = '') => {
    const params = new URLSearchParams({ space_id: spaceId, parent_asset_id: parentId, page_no: '1', page_size: '100', sort: 'name_asc' })

    if (query) {params.set('query', query)}

    return driveRequest<DrivePage>(`/assets?${params}`)
  },
  createFolder: (parentId: string, name: string) => driveRequest('/folders', 'POST', { parent_asset_id: parentId, name }),
  rename: (asset: DriveAsset, name: string) => driveRequest(`/assets/${encodeURIComponent(asset.asset_id)}`, 'PATCH', { new_name: name, kind: asset.kind }),
  trash: (assets: DriveAsset[]) => driveRequest('/assets/trash', 'POST', {
    file_ids: assets.filter(asset => asset.kind === 'file').map(asset => asset.asset_id),
    directory_ids: assets.filter(asset => asset.kind === 'directory').map(asset => asset.asset_id)
  }),
  download: async (asset: DriveAsset) => {
    const fid = asset.fid || (await driveRequest<{ fid: string }>('/unicom/FileDetails', 'POST', { fileId: asset.asset_id })).fid

    return driveRequest<{ download_url?: string }>('/assets/download', 'POST', { fid })
  },
  preview: async (asset: DriveAsset) => {
    const user = $uniWorkAuth.get().user

    if (!user?.token || !user.phone) {throw new Error('请先登录 UniWork 账户')}

    return hermesApi<{ name: string; ok: boolean; path: string; size_bytes: number }>({
      method: 'POST',
      path: '/api/uniwork/drive/preview',
      body: {
        asset_id: asset.asset_id,
        fid: asset.fid,
        login: user.token,
        name: asset.name,
        phone: user.phone,
        size_bytes: asset.size_bytes
      }
    })
  }
}
