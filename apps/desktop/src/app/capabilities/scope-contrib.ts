import type { Contribution } from '@/contrib/types'

/**
 * 「技能与工具」页「正在配置」下拉框的插件接口：插件自己托管的档案（例如装成独立档案、
 * 配置由插件同步的专家）不出现在下拉框里，用户不在这里手动改它们的技能、工具和插件。
 */
export const CAPABILITY_SCOPE_AREA = 'capabilities.scope'

/** `capabilities.scope` 贡献的 `data`。 */
export interface CapabilityScopeContribution {
  /** 不出现在下拉框里的档案名。多个贡献取并集；默认档案永远不隐藏。 */
  hideProfiles?: readonly string[]
}

/** 所有贡献要隐藏的档案名（并集，去掉默认档案）。纯函数，不依赖界面，便于单测。 */
export function hiddenScopeProfiles(contributions: readonly Contribution[]): ReadonlySet<string> {
  const hidden = new Set<string>()

  for (const contribution of contributions) {
    const names = (contribution.data as CapabilityScopeContribution | undefined)?.hideProfiles

    if (!Array.isArray(names)) {
      continue
    }

    for (const name of names) {
      const key = typeof name === 'string' ? name.trim() : ''

      if (key && key !== 'default') {
        hidden.add(key)
      }
    }
  }

  return hidden
}
