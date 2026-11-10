import type { Locale } from './types'

export interface MessagingConnectionCopy {
  restoring: string
  restoreFailed: string
  ownership: string
  reconnecting: string
  disconnected: string
  saving: string
  restarting: string
  stopping: string
  checking: string
  saveFailed: string
  connecting: string
  savedFailed: string
  unbindFailed: string
  unbindApplyFailed: string
  duplicateTitle: string
  duplicateDescription: string
  invalid: string
  network: string
  timeout: string
  unavailable: string
  newSecret: string
}

export const messagingConnectionCopy: Record<Locale, MessagingConnectionCopy> = {
  en: {
    reconnecting: 'The gateway is reconnecting using its built-in policy. Desktop chat is available.',
    disconnected:
      'Some chat app connections are unavailable. Check the chat app settings or logs. Desktop chat is available.',
    restoring: 'Restoring chat app connections…',
    restoreFailed:
      'Chat app connections could not be restored. Desktop chat is available. Retry the connection or open logs.',
    ownership:
      'The existing gateway’s ownership could not be verified. No new gateway was started. Open logs for details.',
    saving: 'Validating and saving chat app settings…',
    restarting: 'Messaging gateway is restarting… Other chat apps will disconnect briefly.',
    stopping: 'Messaging gateway is stopping…',
    checking: 'Checking chat app status…',
    saveFailed: 'Could not save chat app settings. Your previous configuration is unchanged.',
    connecting: 'Connecting… Other chat apps may disconnect briefly.',
    savedFailed: 'Settings saved, but the chat app connection could not be restored. Retry the connection.',
    unbindFailed: 'Could not disconnect this chat app. Try again or open logs.',
    unbindApplyFailed:
      'Disconnected, but the messaging gateway did not restart or stop properly. Other chat apps may be unavailable. Retry the connection.',
    duplicateTitle: 'Bot already used on this device',
    duplicateDescription: 'Another account or Profile uses this bot. Continuing may disconnect it. Continue?',
    invalid: 'ID or Secret was rejected.',
    network: 'Could not reach the platform. Your saved settings are unchanged.',
    timeout: 'Validation timed out. Your saved settings are unchanged.',
    unavailable: 'The platform returned an unexpected response. Try again.',
    newSecret: 'Enter the Secret when changing the bot ID.'
  },
  zh: {
    reconnecting: '网关正在按原版策略重连，桌面聊天不受影响。',
    disconnected: '部分聊天应用连接不可用，请检查平台配置或日志。桌面聊天不受影响。',
    restoring: '正在恢复聊天应用连接…',
    restoreFailed: '聊天应用自动连接失败，桌面聊天不受影响。可重试连接或查看日志。',
    ownership: '无法确认现有网关归属，未启动新的网关，请查看日志。',
    saving: '正在校验并保存聊天应用配置…',
    restarting: '网关正在重启，其它聊天应用会短暂断开…',
    stopping: '网关正在停止…',
    checking: '正在确认聊天应用状态…',
    saveFailed: '聊天应用配置保存失败，原配置保持不变。',
    connecting: '正在连接，其它聊天应用会短暂断开。',
    savedFailed: '配置已保存，但消息连接恢复失败，请重试连接。',
    unbindFailed: '解绑未完成，请重试或查看日志。',
    unbindApplyFailed: '已解绑，但消息网关没有正常重启或停止，其它聊天应用可能暂时不可用，请重试连接。',
    duplicateTitle: '此机器人已在本机使用',
    duplicateDescription: '其它账号或 Profile 已使用此机器人，继续可能使其断开。是否继续？',
    invalid: 'ID 或 Secret 无效，请检查后重试。',
    network: '无法连接平台，原配置保持不变。',
    timeout: '校验超时，原配置保持不变。',
    unavailable: '平台响应异常，请稍后重试。',
    newSecret: '更换机器人 ID 时，请同时填写对应 Secret。'
  },
  'zh-hant': {
    reconnecting: '閘道正在按原版策略重新連線，桌面聊天不受影響。',
    disconnected: '部分聊天應用連線不可用，請檢查平台設定或日誌。桌面聊天不受影響。',
    restoring: '正在恢復聊天應用連線…',
    restoreFailed: '聊天應用自動連線失敗，桌面聊天不受影響。可重試連線或查看日誌。',
    ownership: '無法確認現有閘道歸屬，未啟動新的閘道，請查看日誌。',
    saving: '正在驗證並儲存聊天應用設定…',
    restarting: '閘道正在重新啟動，其他聊天應用會短暫斷線…',
    stopping: '閘道正在停止…',
    checking: '正在確認聊天應用狀態…',
    saveFailed: '聊天應用設定儲存失敗，原設定保持不變。',
    connecting: '正在連線，其他聊天應用會短暫斷線。',
    savedFailed: '設定已儲存，但訊息連線恢復失敗，請重試連線。',
    unbindFailed: '解除綁定未完成，請重試或查看日誌。',
    unbindApplyFailed: '已解除綁定，但訊息閘道沒有正常重新啟動或停止，其他聊天應用可能暫時無法使用，請重試連線。',
    duplicateTitle: '此機器人已在本機使用',
    duplicateDescription: '其他帳號或 Profile 已使用此機器人，繼續可能使其斷線。是否繼續？',
    invalid: 'ID 或 Secret 無效，請檢查後重試。',
    network: '無法連線至平台，原設定保持不變。',
    timeout: '驗證逾時，原設定保持不變。',
    unavailable: '平台回應異常，請稍後重試。',
    newSecret: '更換機器人 ID 時，請同時填寫對應的 Secret。'
  }
}
