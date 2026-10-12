import { lazy, useEffect } from 'react'

/** 共用设置模块加载入口，预热和首次打开复用浏览器的模块缓存。 */
async function loadSettings() {
  return { default: (await import('../settings')).SettingsView }
}

export const SettingsView = lazy(loadSettings)

/** 在主界面空闲时预热设置代码；卸载后取消尚未开始的任务。 */
export function useSettingsPreload(): void {
  useEffect(() => {
    // 预热失败不影响当前界面，实际打开时由 lazy 正常加载并报告错误。
    const preload = () => {
      void loadSettings().catch(error => console.warn('Settings preload failed', error))
    }

    if (typeof window.requestIdleCallback === 'function') {
      const task = window.requestIdleCallback(preload, { timeout: 2_000 })

      return () => window.cancelIdleCallback(task)
    }

    const task = window.setTimeout(preload, 500)

    return () => window.clearTimeout(task)
  }, [])
}
