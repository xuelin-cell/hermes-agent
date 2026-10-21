import fs from 'node:fs'
import path from 'node:path'

/**
 * 把发行包自带的目录拷进账号目录：同名文件覆盖，目标里多出来的文件不删（同 cpSync 的 force）。
 * 安装版的来源在 app.asar 里，Electron 40 的 fs.cpSync 拷不了 asar 里的目录（报 ENOENT），
 * 所以逐层 readdirSync、逐个 copyFileSync，这两个都能读 asar。
 */
export function copyAppTree(source: string, destination: string): void {
  fs.mkdirSync(destination, { recursive: true })

  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name)
    const to = path.join(destination, entry.name)

    if (entry.isDirectory()) {
      copyAppTree(from, to)
    } else {
      fs.copyFileSync(from, to)
    }
  }
}
