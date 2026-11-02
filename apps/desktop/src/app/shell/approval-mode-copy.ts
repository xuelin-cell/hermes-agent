import { registerPluginLocales, usePluginI18n } from '@/i18n/plugin-i18n'

const SCOPE = 'desktop-mt.approval-mode'
registerPluginLocales(SCOPE, {
  en: {
    title: 'How should agent actions be approved?',
    learnMore: 'Learn more',
    manual: 'Request approval',
    smart: 'Help me approve',
    off: 'Full access',
    manualDescription: 'Ask before actions that require approval',
    smartDescription: 'Assess risk and request approval when needed',
    offDescription: 'Run without approval prompts within the current environment',
    help: 'Request approval asks you before guarded operations. Help me approve evaluates risks automatically. Full access skips approval prompts; available file and network access still follows your runtime configuration.',
    failed: 'Could not change approval mode'
  },
  zh: {
    title: '应如何批准智能体操作？',
    learnMore: '了解更多',
    manual: '请求批准',
    smart: '帮我批准',
    off: '完全访问权限',
    manualDescription: '执行需要审批的操作前请求批准',
    smartDescription: '自动评估风险，必要时请求批准',
    offDescription: '无需逐次批准，按当前运行环境权限执行操作',
    help: '请求批准：在受审批保护的操作执行前询问你。帮我批准：自动评估操作风险，必要时请求你批准。完全访问权限：跳过操作审批提示；文件和网络的可访问范围仍由运行环境配置决定。',
    failed: '无法切换审批模式'
  },
  'zh-hant': {
    title: '應如何批准智慧體操作？',
    learnMore: '瞭解更多',
    manual: '請求批准',
    smart: '幫我批准',
    off: '完整存取權限',
    manualDescription: '執行需要審批的操作前請求批准',
    smartDescription: '自動評估風險，必要時請求批准',
    offDescription: '無需逐次批准，按目前執行環境權限執行操作',
    help: '請求批准：在受審批保護的操作執行前詢問你。幫我批准：自動評估操作風險，必要時請求你批准。完整存取權限：略過操作審批提示；檔案和網路的可存取範圍仍由執行環境設定決定。',
    failed: '無法切換審批模式'
  }
})
export const useApprovalModeCopy = () => usePluginI18n(SCOPE)
