import { composerHost } from '@/sdk/composer'
import { $activeGatewayProfile, newSessionInProfile } from '@/store/profile'

// 新对话的输入框在跳转后才挂上，晚一点新草稿还可能把框清一次；隔几次补写，
// 每次都只往空框里写，用户已经在打的字不会被盖掉。
const FILL_DELAYS_MS = [120, 400, 900, 1800]

/** 「去试试」：开一个新对话，把提示词放进输入框，不自动发送（同 UniWork）。 */
export function trySkillInNewChat(prompt: string): void {
  newSessionInProfile($activeGatewayProfile.get())
  window.location.hash = '#/'

  for (const delay of FILL_DELAYS_MS) {
    setTimeout(() => {
      void composerHost
        .getDraft('new')
        .then(current => (current?.trim() ? undefined : composerHost.setDraft('new', prompt)))
        .catch(() => undefined)
    }, delay)
  }
}
