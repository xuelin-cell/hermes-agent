import { setTimeout as delay } from 'node:timers/promises'

import type { CloudDriveRequest } from './contract'

export interface VerificationAsset {
  asset_id: string
  fid?: string | null
  name: string
  kind: 'file' | 'directory'
  parent_asset_id: string
  size_bytes?: number | null
}

export type DriveRead = (input: CloudDriveRequest, signal: AbortSignal) => Promise<unknown>
export type VerificationVerdict = 'confirmed' | 'absent' | 'inconclusive'

/** 联通可能限制实际页长；只有空页证明结束，短页和 has_more=false 均不能证明完整。 */
async function* readDriveFolderPages(
  read: DriveRead,
  parent: string,
  signal: AbortSignal
): AsyncGenerator<VerificationAsset[]> {
  const found = new Set<string>()

  for (let page = 1; page <= 100; page++) {
    signal.throwIfAborted()

    const params = new URLSearchParams({
      space_id: 'personal',
      parent_asset_id: parent,
      page_no: String(page),
      page_size: '100',
      sort: 'name_asc'
    })

    const value = (await read({ route: `/assets?${params}` }, signal)) as {
      items?: VerificationAsset[]
      page?: { has_more?: boolean }
    }

    signal.throwIfAborted()

    if (!Array.isArray(value?.items)) {
      throw new Error('Incomplete directory')
    }

    if (!value.items.length) {
      if (value.page?.has_more === true) {
        throw new Error('Inconsistent directory page')
      }

      return
    }

    const previous = found.size

    for (const item of value.items) {
      if (
        !item ||
        typeof item.asset_id !== 'string' ||
        !item.asset_id ||
        typeof item.name !== 'string' ||
        !['file', 'directory'].includes(item.kind) ||
        item.parent_asset_id !== parent
      ) {
        throw new Error('Invalid directory item')
      }

      found.add(item.asset_id)
    }

    if (previous === found.size) {
      throw new Error('Repeated directory page')
    }

    yield value.items
  }

  throw new Error('Incomplete directory')
}

/** 基线、唯一候选和“不存在”判断必须完整读完，异常时不能返回部分列表。 */
export async function readDriveFolder(
  read: DriveRead,
  parent: string,
  signal: AbortSignal
): Promise<VerificationAsset[]> {
  const found = new Map<string, VerificationAsset>()

  for await (const rows of readDriveFolderPages(read, parent, signal)) {
    rows.forEach(row => found.set(row.asset_id, row))
  }

  return [...found.values()]
}

/** 回收站也逐页读完；deleteNo 是操作号，不能冒充原文件 ID。 */
async function readRecycle(read: DriveRead, signal: AbortSignal): Promise<Record<string, unknown>[]> {
  const found = new Map<string, Record<string, unknown>>()

  for (let page = 1; page <= 100; page++) {
    signal.throwIfAborted()

    const rows = await read(
      { route: '/unicom/QueryRecycleData', method: 'POST', body: { pageNo: page, pageSize: 50, sortRule: '0' } },
      signal
    )

    signal.throwIfAborted()

    if (!Array.isArray(rows)) {
      throw new Error('Invalid recycle response')
    }

    const previous = found.size

    for (const row of rows) {
      if (!row || typeof row.deleteNo !== 'string' || !row.deleteNo) {
        throw new Error('Invalid recycle item')
      }

      found.set(row.deleteNo, row)
    }

    if (!rows.length) {
      return [...found.values()]
    }

    if (previous === found.size) {
      throw new Error('Repeated recycle page')
    }
  }

  throw new Error('Incomplete recycle bin')
}

/** fid 是文件关联标识，文件夹的占位值 0 和 openFileId 均不能当作目录列表 ID。 */
function fileFid(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() && value !== '0' ? value : undefined
}

/** 目录缺少 fid 时沿用现有 FileDetails 读取，不从回收站字段猜测原始 ID。 */
async function assetFid(read: DriveRead, asset: VerificationAsset, signal: AbortSignal): Promise<string> {
  const known = fileFid(asset.fid)

  if (known) {
    return known
  }

  const details = (await read(
    { route: '/unicom/FileDetails', method: 'POST', body: { fileId: asset.asset_id } },
    signal
  )) as { fid?: unknown }

  const fid = fileFid(details?.fid)

  if (!fid) {
    throw new Error('Missing file fid')
  }

  return fid
}

/** 完整遍历按实际目录 ID 路由；缺页、读失败或达到上限都不意味着目标不存在。 */
async function* walkAssets(read: DriveRead, signal: AbortSignal): AsyncGenerator<VerificationAsset[]> {
  const pending = ['0']
  const visited = new Set<string>()

  while (pending.length) {
    const parent = pending.shift()!

    if (visited.has(parent)) {
      continue
    }

    if (visited.size >= 1000) {
      throw new Error('Incomplete directory tree')
    }

    visited.add(parent)

    for await (const rows of readDriveFolderPages(read, parent, signal)) {
      yield rows
      pending.push(...rows.filter(row => row.kind === 'directory').map(row => row.asset_id))
    }
  }
}

/** 查找目标 ID，证明缺失必须遍历完整棵树，避免把移动当作删除。 */
async function findAssets(read: DriveRead, ids: Set<string>, signal: AbortSignal): Promise<VerificationAsset[]> {
  const matches = new Map<string, VerificationAsset>()

  for await (const rows of walkAssets(read, signal)) {
    rows.filter(row => ids.has(row.asset_id)).forEach(row => matches.set(row.asset_id, row))

    if (matches.size === ids.size) {
      return [...matches.values()]
    }
  }

  return [...matches.values()]
}

/** 三次有效查询无新上传才可判失败；查询失败或多个候选始终保留为无法自动确认。 */
export async function confirmDriveState(
  query: () => Promise<VerificationVerdict>,
  signal: AbortSignal,
  check: () => void
): Promise<VerificationVerdict> {
  let absent = 0

  for (const wait of [0, 5000, 10000]) {
    await delay(wait, undefined, { signal })
    check()

    try {
      const verdict = await query()
      check()

      if (verdict === 'confirmed') {
        return verdict
      }

      absent += Number(verdict === 'absent')
    } catch {
      check()
      signal.throwIfAborted()
    }
  }

  return absent === 3 ? 'absent' : 'inconclusive'
}

export interface UploadSnapshot {
  parent: string
  name: string
  size: number
  ids: Set<string>
}

/** 每次上传重新获取基线，包括同名同大小的后续文件。 */
export async function snapshotUpload(
  read: DriveRead,
  parent: string,
  name: string,
  size: number,
  signal: AbortSignal
): Promise<UploadSnapshot> {
  const rows = await readDriveFolder(read, parent, signal)

  return { parent, name, size, ids: new Set(rows.map(row => row.asset_id)) }
}

/** 上传只接受唯一同名、同大小且不在上传前快照中的文件。 */
export async function verifyUpload(
  read: DriveRead,
  before: UploadSnapshot,
  signal: AbortSignal
): Promise<VerificationVerdict> {
  const rows = await readDriveFolder(read, before.parent, signal)

  const candidates = rows.filter(
    row => row.kind === 'file' && row.name === before.name && !before.ids.has(row.asset_id)
  )

  if (candidates.some(row => !Number.isSafeInteger(row.size_bytes) || Number(row.size_bytes) < 0)) {
    return 'inconclusive'
  }

  const matches = candidates.filter(row => row.size_bytes === before.size)

  return matches.length === 1 ? 'confirmed' : matches.length === 0 ? 'absent' : 'inconclusive'
}

interface MutationQuery {
  (signal: AbortSignal): Promise<VerificationVerdict>
  result?: { asset_id: string }
}

interface MutationContext {
  read: DriveRead
  input: CloudDriveRequest
  signal: AbortSignal
}

function hasAsset(rows: VerificationAsset[], id: string, kind: string): boolean {
  return rows.some(row => row.asset_id === id && row.kind === kind)
}

function mutationVerdict(confirmed: boolean): VerificationVerdict {
  return confirmed ? 'confirmed' : 'inconclusive'
}

/** 新建必须比写入前多出唯一的新 ID，同名旧目录不能认领。 */
async function prepareFolder({ read, input, signal }: MutationContext): Promise<MutationQuery> {
  const body = input.body ?? {}
  const parent = String(body.parent_asset_id ?? '0')
  const before = new Set((await readDriveFolder(read, parent, signal)).map(row => row.asset_id))

  const query: MutationQuery = async scope => {
    const matches = (await readDriveFolder(read, parent, scope)).filter(
      row => row.kind === 'directory' && row.name === body.name && !before.has(row.asset_id)
    )

    if (matches.length === 1) {
      query.result = { asset_id: matches[0].asset_id }
    }

    return mutationVerdict(matches.length === 1)
  }

  return query
}

/** 重命名以同一文件 ID 的名称变化为准，不能认领另一个同名文件。 */
async function prepareRename({ read, input, signal }: MutationContext): Promise<MutationQuery> {
  const body = input.body ?? {}
  const id = decodeURIComponent(input.route.split('?')[0].slice('/assets/'.length))
  const before = await findAssets(read, new Set([id]), signal)
  const source = before.find(row => row.asset_id === id && row.kind === body.kind)

  if (!source || source.name === body.new_name) {
    throw new Error('Missing rename baseline')
  }

  return async scope => {
    for await (const rows of readDriveFolderPages(read, source.parent_asset_id, scope)) {
      if (rows.some(row => row.asset_id === id && row.kind === source.kind && row.name === body.new_name)) {
        return 'confirmed'
      }
    }

    return 'inconclusive'
  }
}

/** 移动和移入回收站共用写入前身份快照，不接受缺失的目标。 */
async function mutationTargets({ read, input, signal }: MutationContext) {
  const body = input.body ?? {}

  const targets = [
    ...(Array.isArray(body.file_ids) ? body.file_ids.map(id => ({ id: String(id), kind: 'file' })) : []),
    ...(Array.isArray(body.directory_ids) ? body.directory_ids.map(id => ({ id: String(id), kind: 'directory' })) : [])
  ]

  const before = await findAssets(read, new Set(targets.map(item => item.id)), signal)

  if (!targets.length || !targets.every(item => hasAsset(before, item.id, item.kind))) {
    throw new Error('Missing mutation baseline')
  }

  return { targets, before }
}

async function prepareMove(context: MutationContext): Promise<MutationQuery> {
  const { read, input } = context
  const { targets, before } = await mutationTargets(context)
  const destination = String(input.body?.target_parent_asset_id)

  if (before.some(row => row.parent_asset_id === destination)) {
    throw new Error('Already in destination')
  }

  return async scope => {
    const matched = new Set<string>()

    for await (const rows of readDriveFolderPages(read, destination, scope)) {
      targets.filter(item => hasAsset(rows, item.id, item.kind)).forEach(item => matched.add(item.id))

      if (targets.every(item => matched.has(item.id))) {
        return 'confirmed'
      }
    }

    return 'inconclusive'
  }
}

/** 文件删除关联新 deleteNo 与快照中的 fid，已有回收站记录不能证明本次写入成功。 */
async function prepareTrash(context: MutationContext): Promise<MutationQuery> {
  const { read, input, signal } = context

  // 文件夹没有可关联原目录 ID 的回收站字段，其不确定结果策略需另行确定。
  if (Array.isArray(input.body?.directory_ids) && input.body.directory_ids.length) {
    throw new Error('Directory recycle identity unavailable')
  }

  const { before } = await mutationTargets(context)

  const files = await Promise.all(
    before.map(async source => ({ id: source.asset_id, fid: await assetFid(read, source, signal) }))
  )

  if (new Set(files.map(file => file.fid)).size !== files.length) {
    throw new Error('Ambiguous file identity')
  }

  const previous = new Set((await readRecycle(read, signal)).map(row => String(row.deleteNo)))

  return async scope => {
    const recycled = (await readRecycle(read, scope)).filter(
      row => !previous.has(String(row.deleteNo)) && String(row.type) === '1'
    )

    if (!files.every(file => recycled.filter(row => fileFid(row.fid) === file.fid).length === 1)) {
      return 'inconclusive'
    }

    const remaining = await findAssets(read, new Set(files.map(file => file.id)), scope)

    return mutationVerdict(remaining.length === 0)
  }
}

/** 恢复文件必须是写入后新出现的原 fid，旧文件或并发重复候选都不能认领。 */
async function prepareFileRestore(
  read: DriveRead,
  originals: Record<string, unknown>[],
  signal: AbortSignal
): Promise<MutationQuery> {
  const fids = originals.map(row => (String(row.type) === '1' ? fileFid(row.fid) : undefined))

  if (fids.some(fid => !fid) || new Set(fids).size !== fids.length) {
    throw new Error('Missing or ambiguous file identity')
  }

  const wanted = new Set(fids)
  const previous = new Set<string>()

  for await (const rows of walkAssets(read, signal)) {
    for (const row of rows) {
      previous.add(row.asset_id)
    }
  }

  const deleteNos = new Set(originals.map(row => String(row.deleteNo)))

  return async scope => {
    if ((await readRecycle(read, scope)).some(row => deleteNos.has(String(row.deleteNo)))) {
      return 'inconclusive'
    }

    const matches: string[] = []

    for await (const rows of walkAssets(read, scope)) {
      for (const row of rows) {
        if (row.kind !== 'file' || previous.has(row.asset_id)) {
          continue
        }

        const fid = await assetFid(read, row, scope)

        if (wanted.has(fid)) {
          matches.push(fid)
        }
      }
    }

    return mutationVerdict(fids.every(fid => matches.filter(value => value === fid).length === 1))
  }
}

/** 回收站写入按真实 deleteNo 操作；只有恢复文件需要进一步关联 fid。 */
async function prepareRecycle({ read, input, signal }: MutationContext): Promise<MutationQuery> {
  const route = input.route.split('?')[0]
  const body = input.body ?? {}
  const targets = new Set(Array.isArray(body.deleteNos) ? body.deleteNos.map(String) : [])
  const before = await readRecycle(read, signal)

  if (route === '/unicom/EmptyRecycleData') {
    return async scope => mutationVerdict((await readRecycle(read, scope)).length === 0)
  }

  const originals = before.filter(row => targets.has(String(row.deleteNo)))

  if (!targets.size || originals.length !== targets.size) {
    throw new Error('Missing recycle baseline')
  }

  if (route === '/unicom/DeleteRecycleData') {
    return async scope =>
      mutationVerdict(!(await readRecycle(read, scope)).some(row => targets.has(String(row.deleteNo))))
  }

  return prepareFileRestore(read, originals, signal)
}

const MUTATION_VERIFIERS: Record<string, (context: MutationContext) => Promise<MutationQuery>> = {
  'POST:/folders': prepareFolder,
  'PATCH:/assets/:id': prepareRename,
  'POST:/assets/move': prepareMove,
  'POST:/assets/trash': prepareTrash,
  'POST:/unicom/ReductionRecycleData': prepareRecycle,
  'POST:/unicom/DeleteRecycleData': prepareRecycle,
  'POST:/unicom/EmptyRecycleData': prepareRecycle
}

/** 固定动作表构造只读核验，核验函数不能获得或重放写请求。 */
export async function prepareMutationVerification(
  read: DriveRead,
  input: CloudDriveRequest,
  signal: AbortSignal
): Promise<MutationQuery> {
  const route = input.method === 'PATCH' ? '/assets/:id' : input.route.split('?')[0]
  const prepare = MUTATION_VERIFIERS[`${input.method}:${route}`]

  if (!prepare) {
    throw new Error('Unsupported mutation')
  }

  return prepare({ read, input, signal })
}
