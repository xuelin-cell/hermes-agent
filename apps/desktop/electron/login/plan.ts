export interface MaasModel {
  id: string
  name: string
  baseUrl: string
}

export interface MaasPlan {
  apiKey: string
  models: MaasModel[]
  mainModelIndex: number
}

export type FetchedPlan = { status: 'available'; plan: MaasPlan } | { status: 'empty' | 'failed' }

/** 只接受 JSON 字段对象，不从数组或空值读取套餐信息。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** 无损解析可选模型 ID，拒绝超出安全范围的数值。 */
function identifier(value: unknown): string | null {
  if (value === undefined || value === null) {
    return ''
  }

  if (typeof value === 'string') {
    return value.trim()
  }

  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? String(value) : null
}

/** 解析完整套餐；只把显式空字段当作无套餐，不静默丢弃坏模型。 */
function parsePlan(body: unknown): FetchedPlan {
  if (!isRecord(body) || (body.code !== undefined && body.code !== 0 && body.code !== '0')) {
    throw new Error('套餐响应无效。')
  }

  const payload = body.data === undefined ? body : body.data

  if (!isRecord(payload)) {
    throw new Error('套餐字段无效。')
  }

  if (payload.apiKey === null && payload.models === null) {
    return { status: 'empty' }
  }

  if (typeof payload.apiKey !== 'string' || !payload.apiKey.trim()) {
    throw new Error('缺少模型凭据。')
  }

  const catalog: unknown = typeof payload.models === 'string' ? JSON.parse(payload.models) : payload.models

  if (!isRecord(catalog) || !Array.isArray(catalog.models) || !catalog.models.length) {
    throw new Error('缺少模型目录。')
  }

  const mainId = identifier(catalog.main_model_id)

  if (mainId === null) {
    throw new Error('主模型标识无效。')
  }

  const models = catalog.models.map((row: unknown): MaasModel => {
    if (!isRecord(row)) {
      throw new Error('模型字段无效。')
    }

    const id = identifier(row.id)
    const name = typeof row.model === 'string' && row.model.trim() ? row.model.trim() : id

    if (id === null || !name || typeof row.base_url !== 'string') {
      throw new Error('模型字段不完整。')
    }

    const base = row.base_url.trim().replace(/\/+$/, '')
    const url = new URL(base)

    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error('模型地址无效。')
    }

    return { id, name, baseUrl: base.endsWith('/v1') ? base : `${base}/v1` }
  })

  const mainModelIndex = mainId ? models.findIndex(model => model.id === mainId) : -1

  return {
    status: 'available',
    plan: { apiKey: payload.apiKey.trim(), models, mainModelIndex: Math.max(0, mainModelIndex) }
  }
}

/** 用主进程保管的登录 token 查询固定地址，失败只返回套餐状态，不判定身份。 */
export async function fetchPlan(request: typeof fetch, token: string, cancellation: AbortSignal): Promise<FetchedPlan> {
  try {
    const response = await request('https://maas.ai-yuanjing.com/app/gateway/uniwork/my-plan', {
      method: 'GET',
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
      signal: AbortSignal.any([AbortSignal.timeout(15_000), cancellation]),
      redirect: 'error',
      credentials: 'omit',
      cache: 'no-store'
    })

    return response.ok ? parsePlan(await response.json()) : { status: 'failed' }
  } catch {
    return { status: 'failed' }
  }
}
