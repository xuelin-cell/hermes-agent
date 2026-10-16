// 仅登记原生云盘准备并完成规范化的原文件；生命周期属于当前账号窗口。
const owners = new Map<string, object>()

/** 已准备文件按本机归属读取，不随当前 Agent 的远程连接改变。 */
export function registerDesktopPreviewFile(path: string): void {
  owners.set(path, window.hermesDesktop)
}

/** 只改变文件读取位置，不参与格式判断、转换或显示器选择。 */
export function isDesktopPreviewFile(path: string): boolean {
  return owners.has(path)
}

/** 切换原生账号桥后拒绝旧路径，不能降级到当前账号或远程后端。 */
export function assertDesktopPreviewFileOwner(path: string): void {
  if (owners.has(path) && owners.get(path) !== window.hermesDesktop) {
    throw { code: 'unavailable' }
  }
}
