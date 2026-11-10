/** 只有桌面端（preload 暴露了 ntfy 通道）才有通知中心：入口与订阅共用这一判据。
 *
 *  单独成文件是为了打断 maas-account-status ↔ message-center/index 的循环导入
 *  （后者要读账号，前者要读这个判据）。 */
export function messageCenterAvailable(): boolean {
  return typeof window !== 'undefined' && !!window.hermesDesktop?.ntfy
}
