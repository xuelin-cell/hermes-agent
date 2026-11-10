import { afterEach, expect, it, vi } from 'vitest'

import { enableMail } from './api'

afterEach(() => {
  delete window.hermesDesktop
})

it('shows only the mailbox provider message from an Electron IPC rejection', async () => {
  window.hermesDesktop = {
    agentMail: vi
      .fn()
      .mockRejectedValue(new Error("Error invoking remote method 'hermes:agent-mail': Error: 用户已被停用，请联系客服解停"))
  } as never

  await expect(enableMail('default')).rejects.toThrow('用户已被停用，请联系客服解停')
  await expect(enableMail('default')).rejects.not.toThrow('Error invoking remote method')
})
