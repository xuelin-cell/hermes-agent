import { registerPluginLocales, usePluginI18n } from '@/i18n/plugin-i18n'

// 文案随本模块自带，不改动上游语言文件；缺少的语言回退到英文。
const SCOPE = 'desktop-mt.interrupted'

registerPluginLocales(SCOPE, {
  en: {
    placeholder: 'The last reply was cut off when the app closed. Press ▶ to continue, or type a new message.',
    continue: 'Continue the interrupted reply'
  },
  zh: {
    placeholder: '上次回答因程序退出被中断，点击 ▶ 继续，或直接输入新内容',
    continue: '继续上次中断的回答'
  },
  'zh-hant': {
    placeholder: '上次回答因程式結束被中斷，點擊 ▶ 繼續，或直接輸入新內容',
    continue: '繼續上次中斷的回答'
  }
})

/** 中断续跑提示的响应式文案。 */
export function useInterruptedCopy() {
  return usePluginI18n(SCOPE)
}
