import fs from 'node:fs'
import path from 'node:path'

import { safeStorage } from 'electron'

import { writeSecretFileAtomic } from '../hardening'

import type { LoginIdentity } from './session'

export const MAAS_IDENTITY_NAMESPACE = 'maas.ai-yuanjing.com/uniwork'

export interface StoredLoginIdentity extends LoginIdentity {
  namespace: typeof MAAS_IDENTITY_NAMESPACE
}

/** 校验整份记录的身份域和字段，不把解密成功当作登录有效。 */
function parseRecord(value: unknown): StoredLoginIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('登录记录格式无效。')
  }

  const record = value as Record<string, unknown>

  if (
    record.namespace !== MAAS_IDENTITY_NAMESPACE ||
    typeof record.uid !== 'string' ||
    !record.uid ||
    record.uid !== record.uid.trim() ||
    typeof record.token !== 'string' ||
    !record.token ||
    record.token !== record.token.trim() ||
    typeof record.expiresAt !== 'number' ||
    !Number.isSafeInteger(record.expiresAt) ||
    record.expiresAt <= 0 ||
    record.expiresAt > 8_640_000_000_000_000 ||
    typeof record.maskedPhone !== 'string' ||
    !/^1\d{2}\*{4}\d{4}$/.test(record.maskedPhone)
  ) {
    throw new Error('登录记录字段无效。')
  }

  return {
    namespace: MAAS_IDENTITY_NAMESPACE,
    uid: record.uid,
    token: record.token,
    expiresAt: record.expiresAt,
    maskedPhone: record.maskedPhone
  }
}

/** 要求真实系统密钥存储，拒绝原版可选的明文和 Linux basic 后端。 */
function requireEncryption(): void {
  if (
    !safeStorage.isEncryptionAvailable() ||
    (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')
  ) {
    throw new Error('系统凭据加密不可用。')
  }
}

/** 在固定应用级目录保存一个完整密文，不访问账号 Home 或连接配置。 */
export class CredentialStore {
  private readonly file: string

  /** 目录由主进程选择，页面不能指定文件位置。 */
  constructor(userData: string) {
    this.file = path.join(userData, 'maas-login.enc')
  }

  /** 先加密再原子替换；失败向调用方报告，不启用明文回退。 */
  save(identity: LoginIdentity): void {
    try {
      const record = parseRecord({ ...identity, namespace: MAAS_IDENTITY_NAMESPACE })
      requireEncryption()
      const encrypted = safeStorage.encryptString(JSON.stringify(record))
      writeSecretFileAtomic(this.file, encrypted)
    } catch {
      throw new Error('无法安全保存登录记录。')
    }
  }

  /** 只读取和校验记录；坏文件原样保留，是否到期由 LoginSession 判断。 */
  load(): StoredLoginIdentity | null {
    let encrypted: Buffer

    try {
      encrypted = fs.readFileSync(this.file)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null
      }

      throw new Error('无法读取登录记录。')
    }

    try {
      requireEncryption()

      return parseRecord(JSON.parse(safeStorage.decryptString(encrypted)))
    } catch {
      throw new Error('无法解密或校验登录记录。')
    }
  }
}
