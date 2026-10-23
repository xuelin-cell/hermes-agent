import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export interface AppSecretStorage {
  isEncryptionAvailable(): boolean
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
  getSelectedStorageBackend(): string
  setUsePlainTextEncryption?(enabled: boolean): void
}

const MAGIC = Buffer.from('UWLS1\0')

/** 标识旧系统密文；调用方可以重新认证，但不能混同新密文损坏。 */
export class LegacySecretFormatError extends Error {
  /** 不携带密文或令牌，避免错误日志泄露凭据。 */
  constructor() { super('旧版凭据需要重新登录或连接。') }
}

/** 用本地密钥保护磁盘凭据；同用户可读密钥，不具备系统钥匙串的隔离能力。 */
export function createLocalSecretStorage(keyPath: string): AppSecretStorage {
  /** 完整临时文件通过硬链接独占发布，竞争者不会读到尚未写完的密钥。 */
  const loadKey = (): Buffer => {
    let stat = fs.lstatSync(keyPath, { throwIfNoEntry: false })

    if (!stat) {
      fs.mkdirSync(path.dirname(keyPath), { recursive: true, mode: 0o700 })
      const temporary = `${keyPath}.${randomBytes(12).toString('hex')}.tmp`

      try {
        fs.writeFileSync(temporary, randomBytes(32), { mode: 0o600, flag: 'wx' })

        try { fs.linkSync(temporary, keyPath) } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {throw error}
        }
      } finally {
        fs.rmSync(temporary, { force: true })
      }

      stat = fs.lstatSync(keyPath)
    }

    if (!stat.isFile() || stat.isSymbolicLink()) {throw new Error('本地凭据密钥文件无效。')}
    const key = fs.readFileSync(keyPath)

    if (key.length !== 32) {throw new Error('本地凭据密钥损坏，请联系支持；原文件已保留。')}
    fs.chmodSync(keyPath, 0o600)

    return key
  }

  return {
    /** 可用性检查不接触系统钥匙串，不覆盖损坏密钥。 */
    isEncryptionAvailable() { try { if (fs.existsSync(keyPath)) {loadKey();}

 return true } catch { return false } },
    /** 标明本地密钥后端，避免与 Linux 明文回退混淆。 */
    getSelectedStorageBackend() { return 'app_local_key' },
    /** 每次加密使用独立随机 IV，认证标签保护密文完整性。 */
    encryptString(value) {
      const iv = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', loadKey(), iv)
      const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])

      return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), body])
    },
    /** 旧格式从不尝试钥匙串解密；新格式认证失败直接报错。 */
    decryptString(value) {
      if (!value.subarray(0, MAGIC.length).equals(MAGIC)) {throw new LegacySecretFormatError()}

      if (value.length < MAGIC.length + 28) {throw new Error('本地凭据密文不完整。')}

      // 已有密文缺少密钥时不能偷偷生成新密钥，使恢复问题被掩盖。
      if (!fs.existsSync(keyPath)) {throw new Error('本地凭据密钥缺失，请联系支持。')}
      const decipher = createDecipheriv('aes-256-gcm', loadKey(), value.subarray(MAGIC.length, MAGIC.length + 12))
      decipher.setAuthTag(value.subarray(MAGIC.length + 12, MAGIC.length + 28))

      return Buffer.concat([decipher.update(value.subarray(MAGIC.length + 28)), decipher.final()]).toString('utf8')
    }
  }
}
