import path from 'node:path'

import { SECRET_STORAGE_POLICY_FILE } from '../secret-storage-policy'

import type { AccountPaths } from './account-paths'

export interface AccountDesktopStatePaths {
  readonly profileConfig: string
  readonly connectionConfig: string
  readonly connectionsRegistry: string
  readonly backendOwnership: string
  readonly backendReady: string
  readonly defaultProject: string
  readonly managedSshRecovery: string
  readonly faviconCache: string
  readonly composerImages: string
  readonly nativeTokens: string
  readonly secretStoragePolicy: string
  readonly terminalScripts: string
}

/** 只定位当前账号的桌面状态；不改变应用根目录，也不读取旧全局文件。 */
export function accountDesktopStatePaths(account: Pick<AccountPaths, 'desktopState'>): AccountDesktopStatePaths {
  const root = account.desktopState

  return Object.freeze({
    profileConfig: path.join(root, 'active-profile.json'),
    connectionConfig: path.join(root, 'connection.json'),
    connectionsRegistry: path.join(root, 'connections.json'),
    backendOwnership: path.join(root, 'backend-ownership.json'),
    backendReady: path.join(root, 'backend-ready'),
    defaultProject: path.join(root, 'project-dir.json'),
    managedSshRecovery: path.join(root, 'managed-ssh-update-recovery.json'),
    faviconCache: path.join(root, 'favicon-cache.json'),
    composerImages: path.join(root, 'composer-images'),
    nativeTokens: path.join(root, 'native-oauth-tokens.json'),
    secretStoragePolicy: path.join(root, SECRET_STORAGE_POLICY_FILE),
    terminalScripts: path.join(root, 'open-in-terminal')
  })
}
