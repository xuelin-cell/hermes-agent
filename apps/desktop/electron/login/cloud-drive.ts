import { CloudDriveCredentials, type DriveCredentialOptions } from './cloud-drive-credentials'
import { type CloudDriveFailure, type CloudDriveRequest, isCloudDriveReadOperation } from './contract'
import type { LoginIdentity } from './session'

const BASE = 'https://maas.ai-yuanjing.com/app/uniwork/general_uniclaw/clouddrive/v1'
const AUTH = 'https://www.yjworker.10010.com/app/gateway/uniwork-yunpan/access-token'

/** 跨 IPC 只传递操作状态和错误码，不传服务原文、身份或下载凭据。 */
export class CloudDriveOperationError extends Error {
  readonly result: CloudDriveFailure

  /** 将部分成功或未知结果保留为可由页面区分的安全数据。 */
  constructor(status: CloudDriveFailure['status'], code: string) {
    super('云盘操作未完成')
    this.result = { protocol: 'uniwork.drive-result.v1', ok: false, status, code }
  }
}

/** 主进程持有云盘凭据，固定上游与操作范围；不将 token 返回页面。 */
export class CloudDriveClient {
  private readonly credentials: CloudDriveCredentials

  /** 身份由登录模块提供，测试可替换网络但不能让页面选择上游。 */
  constructor(
    private readonly identity: () => LoginIdentity | null,
    private readonly request: typeof fetch = fetch,
    options: DriveCredentialOptions = {}
  ) {
    this.credentials = new CloudDriveCredentials(identity, value => this.acquireToken(value), options)
  }

  /** 定期和唤醒检查共享同一份主进程令牌，MCP 调用无需单独同步凭据。 */
  renewCredentials(): Promise<void> {
    return this.credentials.renewActive()
  }

  /** 仅在退出账号成功后调用，失效在途认证并删除本账号云盘密文。 */
  clearCredentials(): void {
    this.credentials.clear()
  }

  /** 传输绑定发起时的账号和登录，切换或到期后立即停止落盘和发送。 */
  guardIdentity(): () => void {
    const original = this.identity()

    return () => {
      const current = this.identity()

      if (
        !original ||
        !current ||
        current.uid !== original.uid ||
        current.token !== original.token ||
        current.expiresAt <= Date.now()
      ) {
        throw new CloudDriveOperationError('failed', 'AUTH_CHANGED')
      }
    }
  }

  /** 只向固定账号服务提交手机号和应用版本，不转发 MaaS 或云盘认证头。 */
  private async acquireToken(identity: LoginIdentity): Promise<string> {
    const response = await this.request(AUTH, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: identity.phone, appVersion: '0.17.0' })
    })

    const payload = await response.json()
    const token = payload?.result?.accessToken

    if (
      !response.ok ||
      !payload?.meta ||
      !['', '0', '200'].includes(String(payload.meta.code ?? '')) ||
      typeof token !== 'string' ||
      !token.trim()
    ) {
      throw new Error('个人云盘认证失败，请稍后重试')
    }

    if (this.identity()?.token !== identity.token || this.identity()?.uid !== identity.uid) {
      throw new Error('登录状态已变化，请重新打开资料库')
    }

    return token
  }

  /** 只转发云盘业务操作，并在服务明确报告云盘令牌过期时刷新一次。 */
  async execute(input: CloudDriveRequest, signal?: AbortSignal): Promise<unknown> {
    const identity = this.identity()

    if (!identity || identity.expiresAt <= Date.now()) {
      throw new Error('请重新登录 UniWork')
    }

    if (!identity.phone || !/^1\d{10}$/.test(identity.phone)) {
      throw new Error('请退出账号并重新登录一次，以启用个人云盘')
    }

    if (!input || typeof input.route !== 'string') {
      throw new Error('云盘请求无效')
    }

    const method = input.method ?? 'GET'
    const route = input.route.split('?')[0]

    const allowed = {
      GET: [/^\/asset-spaces$/, /^\/asset-spaces\/[^/]+\/usage$/, /^\/assets$/, /^\/drive\/capabilities$/],
      POST: [
        /^\/folders$/,
        /^\/assets\/(move|trash|download)$/,
        /^\/unicom\/FileDetails$/,
        /^\/unicom\/(QueryRecycleData|ReductionRecycleData|DeleteRecycleData|EmptyRecycleData)$/
      ],
      PATCH: [/^\/assets\/[^/]+$/]
    }

    if (
      !allowed[method]?.some(pattern => pattern.test(route)) ||
      /[\\\r\n#]/.test(input.route) ||
      /%(?:2e|2f|5c)/i.test(route) ||
      route.includes('..')
    ) {
      throw new Error('云盘操作不受支持')
    }

    // 个人回收站接口不接收空间参数；禁止借原生桥切到项目或其他空间。
    if (
      /^\/unicom\/(QueryRecycleData|ReductionRecycleData|DeleteRecycleData|EmptyRecycleData)$/.test(route) &&
      (Object.hasOwn(input.body ?? {}, 'spaceType') ||
        Object.hasOwn(input.body ?? {}, 'space_id') ||
        input.route !== route)
    ) {
      throw new Error('云盘操作不受支持')
    }

    if (
      route === '/unicom/EmptyRecycleData' &&
      (!input.body || typeof input.body !== 'object' || Array.isArray(input.body) || Object.keys(input.body).length > 0)
    ) {
      throw new Error('云盘操作不受支持')
    }

    if (
      route === '/unicom/DeleteRecycleData' &&
      (!Array.isArray(input.body?.deleteNos) ||
        input.body.deleteNos.length !== 1 ||
        typeof input.body.deleteNos[0] !== 'string' ||
        !input.body.deleteNos[0] ||
        Object.keys(input.body).some(key => key !== 'deleteNos'))
    ) {
      throw new Error('云盘操作不受支持')
    }

    const readOnly = isCloudDriveReadOperation(input)

    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.credentials.get()

      if (this.identity()?.token !== identity.token || this.identity()?.uid !== identity.uid) {
        throw new Error('登录状态已变化，请重新打开资料库')
      }

      let response: Response
      let payload

      try {
        response = await this.request(BASE + input.route, {
          method,
          redirect: 'error',
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000),
          headers: {
            Authorization: `Bearer ${identity.token}`,
            'X-Drive-Access-Token': token,
            'Content-Type': 'application/json'
          },
          ...(input.body ? { body: JSON.stringify(input.body) } : {})
        })
        payload = await response.json()
      } catch {
        throw new CloudDriveOperationError(readOnly ? 'failed' : 'outcome_unknown', 'TRANSPORT_ERROR')
      }

      if (this.identity()?.token !== identity.token || this.identity()?.uid !== identity.uid) {
        throw new CloudDriveOperationError(readOnly ? 'failed' : 'outcome_unknown', 'AUTH_CHANGED')
      }

      const expired =
        payload?.error?.code === 'DRIVE_AUTH_EXPIRED' || String(payload?.error?.provider_code ?? '') === '9999'

      if (expired) {
        if (attempt === 0) {
          try {
            await this.credentials.recover(token)
          } catch {
            throw new CloudDriveOperationError('failed', 'DRIVE_AUTH_EXPIRED')
          }

          if (readOnly) {
            continue
          }
        }

        // 更新凭据但不自动重放写操作，仍需用户明确重试。
        throw new CloudDriveOperationError('failed', 'DRIVE_AUTH_EXPIRED')
      }

      if (
        !response.ok ||
        payload?.ok !== true ||
        !Object.hasOwn(payload, 'data') ||
        (payload.status !== undefined && payload.status !== 'succeeded')
      ) {
        const status =
          payload?.status === 'partial_success' || payload?.status === 'outcome_unknown'
            ? payload.status
            : payload?.status === 'failed' || payload?.ok === false || readOnly
              ? 'failed'
              : 'outcome_unknown'

        const code =
          typeof payload?.error?.code === 'string' && /^[A-Z_]{1,64}$/.test(payload.error.code)
            ? payload.error.code
            : response.status === 401
              ? 'AUTH_REQUIRED'
              : 'SERVICE_ERROR'

        throw new CloudDriveOperationError(status, code)
      }

      return payload.data
    }

    throw new Error('个人云盘认证失败，请重试')
  }

  /** 分片只发送一次；凭据与固定上传地址始终留在主进程。 */
  async uploadPart(metadata: Record<string, string | number>, bytes: Uint8Array, signal: AbortSignal): Promise<void> {
    const check = this.guardIdentity()
    const identity = this.identity()
    check()
    const token = await this.credentials.get()
    check()
    signal.throwIfAborted()
    let response: Response
    let payload

    try {
      response = await this.request(BASE + '/drive/upload-part', {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.any([signal, AbortSignal.timeout(150_000)]),
        headers: {
          Authorization: `Bearer ${identity!.token}`,
          'X-Drive-Access-Token': token,
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(bytes.length),
          'X-Drive-Upload-Metadata': Buffer.from(JSON.stringify({ ...metadata, partSize: bytes.length })).toString(
            'base64'
          )
        },
        body: bytes as BodyInit
      })
      payload = await response.json()
      check()
    } catch {
      throw new CloudDriveOperationError('outcome_unknown', 'UPLOAD_INTERRUPTED')
    }

    if (payload?.error?.code === 'DRIVE_AUTH_EXPIRED' || String(payload?.error?.provider_code ?? '') === '9999') {
      try {
        await this.credentials.recover(token)
      } catch {
        // 续期失败也只报告原分片过期，不能重放该分片。
      }

      throw new CloudDriveOperationError('failed', 'DRIVE_AUTH_EXPIRED')
    }

    const final = metadata.partIndex === metadata.totalPart

    if (
      !response.ok ||
      payload?.ok !== true ||
      !['succeeded', ...(final ? [] : ['accepted'])].includes(payload.status)
    ) {
      throw new CloudDriveOperationError(
        payload?.status === 'partial_success'
          ? 'partial_success'
          : payload?.status === 'failed' || payload?.ok === false
            ? 'failed'
            : 'outcome_unknown',
        typeof payload?.error?.code === 'string' && /^[A-Z_]{1,64}$/.test(payload.error.code)
          ? payload.error.code
          : 'UPLOAD_UNCONFIRMED'
      )
    }
  }

  /** 只下载服务授权的同源中转路径，不接收页面 URL，也不把认证头送到 CDN。 */
  async downloadContent(assetId: string, signal: AbortSignal): Promise<Response> {
    const check = this.guardIdentity()

    const details = (await this.execute(
      { route: '/unicom/FileDetails', method: 'POST', body: { fileId: assetId } },
      signal
    )) as { fid?: unknown }

    if (typeof details?.fid !== 'string' || !details.fid) {
      throw new CloudDriveOperationError('failed', 'INVALID_RESPONSE')
    }

    const plan = (await this.execute(
      { route: '/assets/download', method: 'POST', body: { fid: details.fid } },
      signal
    )) as { download_path?: unknown }

    const relative = plan?.download_path

    if (typeof relative !== 'string' || !relative.startsWith('/drive/content?')) {
      throw new CloudDriveOperationError('failed', 'SERVER_UPGRADE_REQUIRED')
    }

    const url = new URL(BASE + relative)

    if (
      url.origin !== new URL(BASE).origin ||
      url.pathname !== new URL(BASE).pathname + '/drive/content' ||
      url.hash ||
      [...url.searchParams.keys()].some(key => key !== 'fid') ||
      url.searchParams.getAll('fid').length !== 1 ||
      url.searchParams.get('fid') !== details.fid
    ) {
      throw new CloudDriveOperationError('failed', 'INVALID_RESPONSE')
    }

    check()
    const identity = this.identity()!
    const token = await this.credentials.get()
    check()
    signal.throwIfAborted()

    const response = await this.request(url.href, {
      redirect: 'error',
      signal,
      headers: {
        Authorization: `Bearer ${identity.token}`,
        'X-Drive-Access-Token': token,
        'Accept-Encoding': 'identity'
      }
    })

    try {
      check()
    } catch (error) {
      await response.body?.cancel()
      throw error
    }

    return response
  }
}
