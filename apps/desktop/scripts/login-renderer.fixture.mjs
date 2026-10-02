import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { build, createServer } from 'vite'
import { build as bundle } from 'esbuild'

const desktop = path.resolve(import.meta.dirname, '..')
let prepared

/** 使用正式 Vite 配置构建独立登录页，构建产物和缓存均与开发数据分离。 */
export function prepareLoginRenderer() {
  prepared ??= (async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'hermes-login-renderer-'))
    const nodeEnv = process.env.NODE_ENV
    try {
      await build({ root: desktop, cacheDir: path.join(root, 'node_modules/.vite'),
        build: { outDir: path.join(root, 'dist'), emptyOutDir: true,
          rolldownOptions: { input: path.join(desktop, 'login.html') } }, logLevel: 'warn' })
    } finally {
      // Vite 构建会设置 NODE_ENV；不能让同进程后续开发服务误判成生产模式。
      if (nodeEnv === undefined) delete process.env.NODE_ENV
      else process.env.NODE_ENV = nodeEnv
    }
    await bundle({ entryPoints: [path.join(desktop, 'electron/login/preload.ts')], bundle: true,
      platform: 'node', format: 'cjs', external: ['electron'], outfile: path.join(root, 'dist/login-preload.js') })
    return root
  })()
  return prepared
}

/** 启动正式配置的隔离开发服务，自动选择空闲端口，不占用用户的开发端口。 */
export async function startLoginDevServer() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hermes-login-vite-'))
  const server = await createServer({ root: desktop, cacheDir: path.join(root, 'node_modules/.vite'),
    server: { host: '127.0.0.1', port: 5173, strictPort: false, open: false }, logLevel: 'warn' })
  await server.listen()
  return { server, url: `http://127.0.0.1:${server.httpServer.address().port}` }
}
