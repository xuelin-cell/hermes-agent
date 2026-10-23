import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { rehashPayloadDigests } from './payload-digests.mjs'

// 内层签名改变运行时摘要；更新摘要后重新封存外层，校验失败则禁止生成安装包。
export default async function afterSignAdHoc({ electronPlatformName, appOutDir, packager }) {
  if (electronPlatformName !== 'darwin') throw new Error('Ad-hoc packaging requires macOS')
  const app = path.join(appOutDir, `${packager.appInfo.productFilename}.app`)
  rehashPayloadDigests(path.join(app, 'Contents', 'Resources', 'agent-payload'))
  execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none',
    '--options', 'runtime', '--entitlements',
    path.resolve(import.meta.dirname, '../electron/entitlements.mac.plist'), app], { stdio: 'inherit' })
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', app], { stdio: 'inherit' })
}
