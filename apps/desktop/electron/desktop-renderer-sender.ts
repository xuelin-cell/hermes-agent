import { BrowserWindow, type IpcMainInvokeEvent, type Session } from 'electron'

/**
 * 只认当前账号桌面窗口自己的主页面：同一账号分区、窗口本身而非嵌入内容、主框架、同一渲染地址。
 * 同一桌面的副窗靠查询参数和 hash 路由区分，比较地址时忽略这两部分；其它页面或来源一律拒绝。
 */
export function isDesktopRendererSender(event: IpcMainInvokeEvent, session: Session, rendererUrl: string): boolean {
  const window = BrowserWindow.fromWebContents(event.sender)

  if (
    !window ||
    window.isDestroyed() ||
    window.webContents !== event.sender ||
    event.sender.session !== session ||
    !event.senderFrame ||
    event.senderFrame !== event.sender.mainFrame
  ) {
    return false
  }

  try {
    const actual = new URL(event.senderFrame.url)
    const expected = new URL(rendererUrl)
    actual.search = expected.search = ''
    actual.hash = expected.hash = ''

    return actual.href === expected.href
  } catch {
    return false
  }
}
