import path from 'node:path'

import { app, safeStorage } from 'electron'

import { type AppSecretStorage, createLocalSecretStorage } from './local-secret-storage'

let local: AppSecretStorage | undefined

/** userData 在登录初始化后解析；非 macOS 保留系统加密行为。 */
export function getAppSecretStorage(): AppSecretStorage {
  if (process.platform !== 'darwin') {return safeStorage}
  local ??= createLocalSecretStorage(path.join(app.getPath('userData'), 'app-secret.key'))

  return local
}

// 主进程原有凭据策略也经过此入口，避免旧记录迁移重新访问钥匙串。
export const appSecretStorage: AppSecretStorage = {
  /** 按当前平台检查凭据后端。 */
  isEncryptionAvailable: () => getAppSecretStorage().isEncryptionAvailable(),
  /** 在主进程加密，不向页面暴露密钥。 */
  encryptString: value => getAppSecretStorage().encryptString(value),
  /** 旧格式错误由已有凭据策略处理。 */
  decryptString: value => getAppSecretStorage().decryptString(value),
  /** 保留原有 basic_text 判断。 */
  getSelectedStorageBackend: () => getAppSecretStorage().getSelectedStorageBackend?.() ?? 'unknown',
  /** 仅转发其他平台原有的显式明文设置。 */
  setUsePlainTextEncryption: enabled => getAppSecretStorage().setUsePlainTextEncryption?.(enabled)
}
