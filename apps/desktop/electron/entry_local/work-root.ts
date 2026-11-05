import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { isMap, isScalar, parseDocument } from 'yaml'

import { writeSecretFileAtomic } from '../hardening'

export const CODE_FOLDER = 'UniWorkSpace'
export const WORK_ROOT_FILE = 'desktop-work-root.json'

/** 默认位置本身就是工作根；试建一个文件夹确认可用，只读、无权限都会在这里报错。 */
export function usableWorkRoot(dir: string, blocked: (dir: string) => boolean): string {
  // 对话文件夹只在真实目录下创建，所以目录联接要先解析成实际路径。
  const root = fs.realpathSync(dir)

  if (blocked(root)) {
    throw new Error('默认位置在安装目录内')
  }

  fs.rmdirSync(fs.mkdtempSync(path.join(root, '.uniwork-check-')))

  return root
}

/** 启动时固定工作根并告知同账号插件；默认位置不可用时退回账号工作区，并记下它供设置页提示。 */
export function prepareWorkRoot({
  defaultDir,
  workspace,
  home,
  blocked,
  log
}: {
  defaultDir: null | string
  workspace: string
  home: string
  blocked: (dir: string) => boolean
  log: (message: string) => void
}): { root: string; unusableDir: null | string } {
  let root = workspace
  let unusableDir: null | string = null

  if (defaultDir) {
    try {
      root = usableWorkRoot(defaultDir, blocked)
    } catch (error) {
      log(String(error))
      unusableDir = defaultDir
    }
  }

  try {
    writeSecretFileAtomic(path.join(home, WORK_ROOT_FILE), JSON.stringify({ root, fallback: workspace }), {
      encoding: 'utf8'
    })
  } catch (error) {
    log(String(error))
  }

  return { root, unusableDir }
}

/** 仅迁移主账号独立映射中的旧工作目录，先保存有效偏好，再删除旧键。 */
export function migrateTerminalCwd(home: string, defaultProjectFile: string, log: (message: string) => void): void {
  const file = path.join(home, 'config.yaml')

  try {
    if (!fs.lstatSync(file, { throwIfNoEntry: false })?.isFile()) {
      return
    }

    const doc = parseDocument(fs.readFileSync(file, 'utf8'), {
      version: '1.1',
      prettyErrors: false,
      logLevel: 'silent'
    })

    if (doc.errors.length || doc.warnings.length || !doc.has('terminal')) {
      return
    }

    const terminal = doc.get('terminal')

    if (
      !isMap(terminal) ||
      terminal.anchor ||
      terminal.items.some(p => isScalar(p.key) && typeof p.key.value === 'symbol')
    ) {
      log('跳过非独立 terminal 配置')

      return
    }

    const raw = terminal.get('cwd')

    if (raw == null || (typeof raw === 'string' && ['', '.', 'cwd', 'auto'].includes(raw.trim()))) {
      return
    }

    const dir = typeof raw === 'string' ? raw.trim().replace(/^~(?=$|[\\/])/, () => os.homedir()) : ''
    const saved = fs.existsSync(defaultProjectFile) ? JSON.parse(fs.readFileSync(defaultProjectFile, 'utf8')).dir : null

    // 先序列化候选配置；如果其它配置引用了 cwd 的锚点，保留两份原文件。
    doc.deleteIn(['terminal', 'cwd'])
    const next = String(doc)

    if (!saved && path.isAbsolute(dir) && fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory()) {
      fs.mkdirSync(path.dirname(defaultProjectFile), { recursive: true })
      writeSecretFileAtomic(defaultProjectFile, JSON.stringify({ dir }), { encoding: 'utf8' })
    } else {
      log(`清理旧 terminal.cwd: ${String(raw)}`)
    }

    writeSecretFileAtomic(file, next, { encoding: 'utf8' })
  } catch (error) {
    log(String(error))
  }
}
