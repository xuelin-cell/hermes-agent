import { registerPluginLocales, usePluginI18n } from '@/i18n/plugin-i18n'

const SCOPE = 'desktop-mt.composer-model'

registerPluginLocales(SCOPE, {
  en: {
    custom: 'Custom models',
    configure: 'Configure custom model',
    loading: 'Loading models…',
    empty: 'No models available',
    search: 'Search models',
    noMatch: 'No models found',
    contextTooltip: (percent: string, used: string, max: string) => `${percent}% · ${used} / ${max} context used`,
    contextAria: (percent: string, used: string, max: string) => `Context used ${percent}%, ${used} / ${max} tokens`,
    contextChip: (size: string) => `${size} context`
  },
  zh: {
    custom: '自定义模型',
    configure: '配置自定义模型',
    loading: '正在加载模型…',
    empty: '暂无可用模型',
    search: '搜索模型',
    noMatch: '未找到模型',
    contextTooltip: (percent: string, used: string, max: string) => `${percent}% · ${used} / ${max} 上下文已使用`,
    contextAria: (percent: string, used: string, max: string) => `上下文已使用 ${percent}%，${used} / ${max} tokens`,
    contextChip: (size: string) => `${size} 上下文`
  },
  'zh-hant': {
    custom: '自訂模型',
    configure: '配置自訂模型',
    loading: '正在載入模型…',
    empty: '暫無可用模型',
    search: '搜尋模型',
    noMatch: '未找到模型',
    contextTooltip: (percent: string, used: string, max: string) => `${percent}% · ${used} / ${max} 上下文已使用`,
    contextAria: (percent: string, used: string, max: string) => `上下文已使用 ${percent}%，${used} / ${max} tokens`,
    contextChip: (size: string) => `${size} 上下文`
  }
})

/** 输入框模型列表和用量圆环的独立文案。 */
export function useComposerModelCopy() {
  return usePluginI18n(SCOPE)
}
