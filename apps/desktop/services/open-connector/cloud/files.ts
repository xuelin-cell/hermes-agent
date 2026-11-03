import { createHmac, timingSafeEqual } from 'node:crypto'
import { TransitFileService } from '../src/server/files/transit-files.ts'

/** Provider downloads remain inside the owning instance; links expire with the stored file. */
export class ConnectorFiles extends TransitFileService {
  origin = 'http://127.0.0.1'
  constructor(directory: string, private readonly key: string) {
    super({ rootDir: directory, publicOrigin: 'http://127.0.0.1', ttlSeconds: 3600, maxBytes: 20 * 1024 * 1024 })
  }
  private signature(id: string, expiry: number) {
    return createHmac('sha256', this.key).update(`connector-file:${id}:${expiry}`).digest('hex')
  }
  override async create(file: File) {
    const uploaded = await super.create(file)
    const expiry = Math.floor(Date.now() / 1000) + 3600
    return { ...uploaded, downloadUrl: `${this.origin}/api/files/${encodeURIComponent(uploaded.fileId)}?e=${expiry}&s=${this.signature(uploaded.fileId, expiry)}` }
  }
  async download(request: Request) {
    const url = new URL(request.url)
    const id = url.pathname.slice('/api/files/'.length)
    const expiry = Number(url.searchParams.get('e'))
    const now = Math.floor(Date.now() / 1000)
    const given = Buffer.from(url.searchParams.get('s') ?? '')
    const expected = Buffer.from(this.signature(id, expiry))
    if (!Number.isInteger(expiry) || expiry <= now || expiry > now + 3600 || given.length !== expected.length || !timingSafeEqual(given, expected)) {
      return new Response(null, { status: 401 })
    }
    try {
      const result = await this.response(id)
      result.headers.set('Cache-Control', 'no-store')
      result.headers.set('Content-Security-Policy', "default-src 'none'; sandbox")
      result.headers.set('X-Content-Type-Options', 'nosniff')
      return result
    } catch {
      return new Response(null, { status: 404 })
    }
  }
}
