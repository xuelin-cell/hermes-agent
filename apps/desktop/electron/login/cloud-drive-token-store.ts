import fs from 'node:fs'
import path from 'node:path'

import { safeStorage } from 'electron'

import { writeSecretFileAtomic } from '../hardening'

import type { DriveTokenRecord, DriveTokenStorage } from './cloud-drive-credentials'

const NAMESPACE = 'uniwork.personal-drive.token.v1'

/** 云盘凭据只存账号桌面目录的系统加密文件，不进入 Hermes 配置或数据库。 */
export class CloudDriveTokenStore implements DriveTokenStorage {
  private readonly directory: string

  /** 根目录由主进程账号运行时确定，不接受页面指定路径。 */
  constructor(desktopState: string) {
    this.directory = path.join(desktopState, 'cloud-drive-tokens')
  }

  /** 拒绝不可用密钥环或明文后端；不降级写入令牌。 */
  private file(owner: string): string {
    if (
      !/^[a-f0-9]{64}$/.test(owner) ||
      !safeStorage.isEncryptionAvailable() ||
      safeStorage.getSelectedStorageBackend?.() === 'basic_text'
    ) {
      throw new Error('个人云盘凭据无法安全存储')
    }

    return path.join(this.directory, `${owner}.enc`)
  }

  /** 解密后核对记录归属和有效期字段，损坏记录不作为有效令牌使用。 */
  load(owner: string): DriveTokenRecord | null {
    const file = this.file(owner)

    try {
      const value = JSON.parse(safeStorage.decryptString(fs.readFileSync(file)))

      if (
        value.namespace !== NAMESPACE ||
        value.owner !== owner ||
        typeof value.token !== 'string' ||
        !value.token.trim() ||
        !Number.isSafeInteger(value.expiresAt) ||
        value.expiresAt <= 0
      ) {
        return null
      }

      return { token: value.token, expiresAt: value.expiresAt }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && (error as NodeJS.ErrnoException).code !== undefined) {
        throw new Error('个人云盘凭据无法读取')
      }

      return null
    }
  }

  /** 先系统加密再原子替换，错误不泄露密钥环原文，不留下明文副本。 */
  save(owner: string, record: DriveTokenRecord): void {
    try {
      const file = this.file(owner)
      const encrypted = safeStorage.encryptString(JSON.stringify({ ...record, owner, namespace: NAMESPACE }))
      fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 })
      writeSecretFileAtomic(file, encrypted)
    } catch {
      throw new Error('个人云盘凭据无法安全保存')
    }
  }

  /** 仅删除本账号云盘令牌目录，保留文件、预览及 Hermes 数据。 */
  clear(): void {
    fs.rmSync(this.directory, { recursive: true, force: true })
  }
}
