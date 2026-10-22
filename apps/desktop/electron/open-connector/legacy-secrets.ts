import fs from 'node:fs'
import path from 'node:path'

const FILES = ['secrets.enc', 'connect.sqlite', 'connect.sqlite-wal', 'connect.sqlite-shm']

/** 启动侧车前恢复或执行一次旧钥匙串备份；逐文件移动可在中断后继续。 */
export function preserveLegacyConnector(directory: string, begin = false): void {
  const backup = path.join(directory, 'legacy-keychain-backup')

  if (!begin && !fs.existsSync(backup)) {return}
  fs.mkdirSync(backup, { recursive: true, mode: 0o700 })
  const complete = path.join(backup, 'complete')

  if (fs.existsSync(complete)) {
    if (begin) {throw new Error('已有旧连接器备份，请联系支持处理凭据恢复。')}

    return
  }

  for (const name of FILES) {
    const source = path.join(directory, name)
    const target = path.join(backup, name)
    const stat = fs.lstatSync(source, { throwIfNoEntry: false })

    if (!stat) {continue}

    if (!stat.isFile() || stat.isSymbolicLink() || fs.existsSync(target)) {
      throw new Error('连接器备份状态异常，原文件已保留。')
    }

    fs.renameSync(source, target)
  }

  fs.writeFileSync(complete, '旧钥匙串凭据已备份，连接器需要重新授权。\n', { flag: 'wx', mode: 0o600 })
}
