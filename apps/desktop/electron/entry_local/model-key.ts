import fs from 'node:fs'
import path from 'node:path'
import { parseEnv } from 'node:util'

import { writeSecretFileAtomic } from '../hardening'

import { MAAS_MODEL_KEY_ENV } from './model-config'

/** 与 Windows 环境变量规则一致，避免同一个专用 Key 的大小写副本复活。 */
function isManagedKey(name: string): boolean {
  return (process.platform === 'win32' ? name.toUpperCase() : name) === MAAS_MODEL_KEY_ENV
}

/** 生成原版能读取的单行凭据；拒绝控制字符及会被 dotenv 展开的变量引用。 */
function keyAssignment(apiKey: string | null): string {
  if (apiKey !== null && (!apiKey.trim() || /[^\x20-\x7e]/.test(apiKey) || apiKey.includes('${'))) {
    throw new Error('MaaS 模型凭据格式无效，未更新账号凭据。')
  }

  const value = apiKey === null ? '' : `"${apiKey.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`

  return `${MAAS_MODEL_KEY_ENV}=${value}`
}

/** 只替换完整的专用变量记录，其他记录与换行原样保留，不触碰多行个人值。 */
function mergeKey(original: string, assignment: string): string {
  const bom = original.startsWith('\uFEFF') ? '\uFEFF' : ''
  const text = original.slice(bom.length)
  const eol = text.includes('\r\n') ? '\r\n' : '\n'

  const records =
    /^([ \t]*(?:export[ \t]+)?)([A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t]*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^'"\r\n][^\r\n]*|)[ \t]*(?:#[^\r\n]*)?(?:\r?\n|$)/gm

  let next = text.replace(records, (record: string, _prefix: string, name: string) =>
    isManagedKey(name) ? '' : record
  )

  // 原版部分凭据路径逐行读取，末尾唯一赋值同时覆盖多行个人值中的同名文本。
  next += `${next && !next.endsWith('\n') ? eol : ''}${assignment}${eol}`

  try {
    const before = parseEnv(text)
    const after = parseEnv(next)
    const personalNames = new Set([...Object.keys(before), ...Object.keys(after)].filter(name => !isManagedKey(name)))

    if (
      [...personalNames].some(name => before[name] !== after[name]) ||
      after[MAAS_MODEL_KEY_ENV] !== parseEnv(assignment)[MAAS_MODEL_KEY_ENV]
    ) {
      throw new Error()
    }
  } catch {
    throw new Error('账号凭据文件结构存在冲突，请修复 .env 后重试。')
  }

  return `${bom}${next}`
}

/** 原子更新账号专用模型 Key；null 写为空值以阻断旧环境凭据，不保存登录 token。 */
export function writeAccountMaasKey(home: string, apiKey: string | null): void {
  const assignment = keyAssignment(apiKey)
  const file = path.join(home, '.env')
  let original: string

  try {
    const existing = fs.lstatSync(file, { throwIfNoEntry: false })

    if (existing && (!existing.isFile() || existing.isSymbolicLink())) {
      throw new Error()
    }

    original = existing ? new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(fs.readFileSync(file)) : ''
  } catch (error) {
    throw new Error('无法读取账号凭据文件，请确认 .env 是 UTF-8 编码的可读普通文件。', { cause: error })
  }

  const next = mergeKey(original, assignment)

  if (next === original) {
    return
  }

  try {
    writeSecretFileAtomic(file, next, { encoding: 'utf8' })
  } catch (error) {
    throw new Error('无法保存账号模型凭据，本次环境准备未完成。', { cause: error })
  }
}
