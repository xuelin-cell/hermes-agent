import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { isMap, isScalar, parseDocument } from 'yaml'

import { writeSecretFileAtomic } from '../hardening'

export const CODE_FOLDER = 'UniWorkSpace'
export const WORK_ROOT_FILE = 'desktop-work-root.json'

/** 自选位置下只追加账号短标识。 */
export function workRootFor(defaultDir: null | string, workspace: string): string {
  return defaultDir ? path.join(defaultDir, path.basename(path.dirname(workspace))) : workspace
}

/** 启动时固定工作根并告知同账号插件。 */
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
}): string {
  let root = workRootFor(defaultDir, workspace)

  try {
    if (blocked(root)) {
      throw new Error('默认位置在安装目录内')
    }

    fs.mkdirSync(root, { recursive: true })
  } catch (error) {
    log(String(error))
    root = workspace
  }

  try {
    writeSecretFileAtomic(path.join(home, WORK_ROOT_FILE), JSON.stringify({ root, fallback: workspace }), {
      encoding: 'utf8'
    })
  } catch (error) {
    log(String(error))
  }

  return root
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
