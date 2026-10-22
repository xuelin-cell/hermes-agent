import path from 'node:path'

import { INSTALL_STAMP, type InstallStamp } from './install-stamp'

interface UniversalLayout {
  commit: string
  arch: string
}

/** 通用包入口在加载主进程前写入只读布局，不通过磁盘探测或环境变量猜测。 */
function launchLayout(): UniversalLayout | undefined {
  return (process as NodeJS.Process & { uniworkUniversalLayout?: UniversalLayout }).uniworkUniversalLayout
}

/** 根据签封的启动契约选择整套载荷，保持原有无文件系统探测的解析约束。 */
export function packagedResourceRoot(
  resources: string,
  name: 'agent-payload' | 'open-connector',
  stamp: Readonly<InstallStamp> | null = INSTALL_STAMP,
  arch: string = process.arch,
  layout: UniversalLayout | undefined = launchLayout()
): string {
  if (!layout) {return path.join(resources, name)}

  if (!stamp?.commit || layout.commit !== stamp.commit || layout.arch !== arch || !['arm64', 'x64'].includes(arch)) {
    throw new Error('通用安装包的运行环境声明无效，请重新安装。')
  }

  return path.join(resources, name, `darwin-${arch}`)
}
