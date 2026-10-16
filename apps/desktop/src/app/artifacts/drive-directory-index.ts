import type { DriveAsset, DrivePage } from '@/api/drive'

export interface DriveIndexSnapshot {
  items: DriveAsset[]
  scanning: boolean
  complete: boolean
  error: boolean
  loadedDirectories: string[]
}

export interface DriveFolderLocation {
  id: string
  name: string
}

/** 只缓存展示所需元信息，服务返回的凭据、签名链接及额外字段不进入索引。 */
function metadata(asset: DriveAsset, parent: string): DriveAsset {
  if (
    !asset ||
    typeof asset.asset_id !== 'string' ||
    !asset.asset_id ||
    typeof asset.name !== 'string' ||
    !['file', 'directory'].includes(asset.kind)
  ) {
    throw new Error('Invalid cloud file metadata')
  }

  return {
    asset_id: asset.asset_id,
    name: asset.name,
    kind: asset.kind,
    parent_asset_id: parent,
    fid: typeof asset.fid === 'string' ? asset.fid : undefined,
    size_bytes: typeof asset.size_bytes === 'number' ? asset.size_bytes : null,
    modified_at: typeof asset.modified_at === 'string' ? asset.modified_at : null,
    created_at: typeof asset.created_at === 'string' ? asset.created_at : null,
    permissions: {
      read: asset.permissions?.read !== false,
      write: asset.permissions?.write !== false,
      delete: asset.permissions?.delete !== false
    }
  }
}

/** 页面独占扫描器：可以用本账号窗口的元信息快照启动，销毁后拒绝迟到响应。 */
export class DriveDirectoryIndex {
  private directories = new Map<string, DriveAsset[]>()
  private listeners = new Set<(snapshot: DriveIndexSnapshot) => void>()
  private generation = 0
  private disposed = false
  private loadedDirectories = new Set<string>()
  private snapshot: DriveIndexSnapshot = {
    items: [],
    scanning: false,
    complete: false,
    error: false,
    loadedDirectories: []
  }

  /** 根目录来自服务返回值，不能假定所有云盘都使用固定目录 ID。 */
  constructor(
    readonly root: string,
    private readonly fetchPage: (parent: string, page: number) => Promise<DrivePage>,
    cached?: DriveIndexSnapshot
  ) {
    if (cached) {
      for (const item of cached.items) {
        const parent = item.parent_asset_id || root
        const rows = this.directories.get(parent) ?? []
        rows.push(metadata(item, parent))
        this.directories.set(parent, rows)
      }

      this.loadedDirectories = new Set(cached.loadedDirectories)
      this.publish({ scanning: false, complete: cached.complete, error: false })
    }
  }

  /** 订阅增量扫描结果，返回对应的解除订阅方法。 */
  subscribe(listener: (snapshot: DriveIndexSnapshot) => void): () => void {
    this.listeners.add(listener)

    return () => {
      this.listeners.delete(listener)
    }
  }

  /** 返回当前快照，搜索使用内存数据而不触发网络请求。 */
  getSnapshot(): DriveIndexSnapshot {
    return this.snapshot
  }

  /** 发布去重后的元信息和扫描状态。 */
  private publish(state: Omit<DriveIndexSnapshot, 'items' | 'loadedDirectories'>): void {
    const items = new Map<string, DriveAsset>()

    for (const rows of this.directories.values()) {
      for (const asset of rows) {
        items.set(asset.asset_id, asset)
      }
    }

    this.snapshot = { ...state, items: [...items.values()], loadedDirectories: [...this.loadedDirectories] }
    this.listeners.forEach(listener => listener(this.snapshot))
  }

  /** 失效在途扫描并释放本页对象；窗口缓存只保存已发布的独立快照。 */
  dispose(): void {
    this.disposed = true
    this.generation++
    this.directories.clear()
    this.loadedDirectories.clear()
    this.listeners.clear()
    this.snapshot = { items: [], scanning: false, complete: false, error: false, loadedDirectories: [] }
  }

  /** 扫描全部可达目录；刷新失败时保留已知结果，完整成功后清除失效目录。 */
  async sync(force = false): Promise<void> {
    if (this.disposed || (!force && (this.snapshot.scanning || this.snapshot.complete))) {
      return
    }

    const generation = ++this.generation
    // 每次等待返回后校验归属，避免旧扫描写入新页面或刷新结果。
    const current = () => !this.disposed && generation === this.generation
    const next = new Map<string, DriveAsset[]>()
    const queue = [this.root]
    const visited = new Set<string>()
    this.publish({ scanning: true, complete: false, error: false })

    try {
      while (queue.length && current()) {
        const parent = queue.shift()!

        if (visited.has(parent)) {
          continue
        }

        visited.add(parent)
        const rows = new Map<string, DriveAsset>()

        for (let page = 1; current(); page++) {
          const batch = await this.fetchPage(parent, page)

          if (!current()) {
            return
          }

          if (!Array.isArray(batch?.items)) {
            throw new Error('Invalid cloud directory response')
          }

          if (!batch.items.length) {
            this.directories.set(parent, [...rows.values()])
            this.loadedDirectories.add(parent)
            this.publish({ scanning: true, complete: false, error: false })

            break
          }

          let added = 0

          for (const value of batch.items) {
            const asset = metadata(value, parent)

            if (!rows.has(asset.asset_id)) {
              added++
            }

            rows.set(asset.asset_id, asset)
          }

          if (!added) {
            throw new Error('Cloud directory pagination repeated')
          }

          const known = new Map((this.directories.get(parent) ?? []).map(asset => [asset.asset_id, asset]))

          rows.forEach((asset, id) => known.set(id, asset))
          this.directories.set(parent, [...known.values()])
          this.publish({ scanning: true, complete: false, error: false })
        }

        next.set(parent, [...rows.values()])

        for (const asset of rows.values()) {
          if (asset.kind === 'directory' && asset.permissions?.read !== false && !visited.has(asset.asset_id)) {
            queue.push(asset.asset_id)
          }
        }
      }

      if (current()) {
        this.directories = next
        this.loadedDirectories = new Set(next.keys())
        this.publish({ scanning: false, complete: true, error: false })
      }
    } catch {
      if (current()) {
        this.publish({ scanning: false, complete: false, error: true })
      }
    }
  }
}

/** 从父目录关系构建完整路径，循环或失效路径不允许导航。 */
export function driveFolderPath(items: DriveAsset[], root: string, parent: string): DriveFolderLocation[] | null {
  const byId = new Map(items.map(item => [item.asset_id, item]))
  const path: DriveFolderLocation[] = []
  const visited = new Set<string>()
  let id = parent

  while (id !== root) {
    const asset = byId.get(id)

    if (visited.has(id) || !asset || asset.kind !== 'directory' || !asset.parent_asset_id) {
      return null
    }

    visited.add(id)
    path.unshift({ id, name: asset.name })
    id = asset.parent_asset_id
  }

  return path
}

/** 普通列表只显示当前目录；关键词搜索覆盖该目录的全部已索引子目录。 */
export function filterDriveFiles(items: DriveAsset[], root: string, parent: string, query: string): DriveAsset[] {
  const needle = query.trim().toLocaleLowerCase()
  const parents = new Map(items.map(item => [item.asset_id, item.parent_asset_id]))

  return items
    .filter(asset => {
      if (!needle) {
        return asset.parent_asset_id === parent
      }

      if (!asset.name.toLocaleLowerCase().includes(needle)) {
        return false
      }

      const visited = new Set<string>()
      let id = asset.parent_asset_id

      while (id && !visited.has(id)) {
        if (id === parent) {
          return true
        }

        if (id === root) {
          return false
        }

        visited.add(id)
        id = parents.get(id)
      }

      return false
    })
    .sort(
      (left, right) =>
        Number(right.kind === 'directory') - Number(left.kind === 'directory') ||
        left.name.localeCompare(right.name) ||
        left.asset_id.localeCompare(right.asset_id)
    )
}
