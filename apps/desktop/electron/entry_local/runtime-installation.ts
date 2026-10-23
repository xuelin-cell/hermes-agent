import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { INSTALL_STAMP } from '../install-stamp'
import { bundledPayload, type PayloadInfo } from '../payload-backend'
import { resolveSourcePython } from '../source-python'

export interface AccountInstallation {
  installationRoot: string
  python: string
  sitePackages?: string
  gatewayLogoutScript?: string
}

/** 安装版只采用构建契约中的组件；开发模式保留显式源码解释器，不跨安装回退。 */
export function resolveAccountInstallation(
  sourceRoot: string,
  pythonOverride?: string,
  payload: PayloadInfo | null = bundledPayload(process.resourcesPath),
  packaged = INSTALL_STAMP !== null
): AccountInstallation {
  if (payload) {
    // dist 已由 electron-builder 解包，Python 无法读取 app.asar 内的脚本。
    const directory = path.dirname(fileURLToPath(import.meta.url)).replace(
      /([\\/])(app(?:-(?:arm64|x64))?\.asar)([\\/])/, '$1$2.unpacked$3'
    )

    return {
      installationRoot: payload.repoDir,
      python: payload.storePython,
      sitePackages: payload.sitePackages,
      gatewayLogoutScript: path.join(directory, 'gateway-logout.py')
    }
  }

  const python = packaged ? null : resolveSourcePython(sourceRoot, { override: pythonOverride })

  if (!python) {
    throw new Error('账号运行组件不可用，请安装包含 Agent 的完整安装包。')
  }

  return { installationRoot: sourceRoot, python }
}
