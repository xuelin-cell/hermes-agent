interface DriveRenewal {
  renewCredentials(): Promise<void>
}

interface ResumeEvents {
  on(event: 'resume', listener: () => void): unknown
  removeListener(event: 'resume', listener: () => void): unknown
}

/** 每三十分钟及系统唤醒检查到期令牌，停止时释放监听，不触发业务写操作。 */
export function installDriveCredentialRenewal(drive: DriveRenewal, power: ResumeEvents): () => void {
  /** 失败留给下一次检查或显式使用处理，后台不循环重试或弹出登录窗口。 */
  function check(): void {
    void drive.renewCredentials().catch(() => {})
  }

  const timer = setInterval(check, 30 * 60 * 1000)
  timer.unref?.()
  power.on('resume', check)

  return () => {
    clearInterval(timer)
    power.removeListener('resume', check)
  }
}
