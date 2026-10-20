import { registerPluginLocales, usePluginI18n } from '@/i18n/plugin-i18n'

// 文案随本模块自带，不改动上游语言文件；缺少的语言回退到英文。
const SCOPE = 'desktop-mt.workdir'

registerPluginLocales(SCOPE, {
  en: {
    title: 'Working folder',
    defaultName: 'Default workspace',
    defaultHint: 'The default workspace of this account',
    recent: 'Recent',
    choose: 'Choose another folder…',
    draftHint: 'The agent reads and writes files in this folder. It cannot be changed after the conversation starts.',
    folderHint:
      'Each new conversation gets its own folder inside the default workspace. It cannot be changed after the conversation starts.',
    settingsHint:
      'New conversations work in this folder unless you pick another. Leave it unset to use the default workspace of this account, where each new conversation gets its own folder.',
    lockedHint: 'Selected for this conversation. To work in a different folder, start a new conversation.',
    blocked: (path: string) =>
      `"${path}" is a system folder, a drive root, or a home folder. Choose a specific subfolder instead.`,
    pickFailed: 'Could not open the folder picker'
  },
  zh: {
    title: '工作目录',
    defaultName: '默认工作区',
    defaultHint: '当前账号的默认工作区',
    recent: '最近使用',
    choose: '选择其他文件夹…',
    draftHint: 'Agent 会在这个目录中读写文件，开始对话后不能更改。',
    folderHint: '每个新对话会在默认工作区中新建一个文件夹，Agent 在其中读写文件。开始对话后不能更改。',
    settingsHint:
      '新对话默认在此文件夹中工作，除非你另选目录。留空则使用当前账号的默认工作区，每个新对话会在其中新建一个文件夹。',
    lockedHint: '本次对话已绑定该目录，无法在对话中更改。如需使用其他目录，请新建对话。',
    blocked: (path: string) => `「${path}」是系统目录、盘符根目录或用户主目录，请选择一个具体的子目录。`,
    pickFailed: '无法打开文件夹选择窗口'
  },
  'zh-hant': {
    title: '工作目錄',
    defaultName: '預設工作區',
    defaultHint: '目前帳號的預設工作區',
    recent: '最近使用',
    choose: '選擇其他資料夾…',
    draftHint: 'Agent 會在這個目錄中讀寫檔案，開始對話後不能變更。',
    folderHint: '每個新對話會在預設工作區中新建一個資料夾，Agent 在其中讀寫檔案。開始對話後不能變更。',
    settingsHint:
      '新對話預設在此資料夾中工作，除非您另選目錄。留空則使用目前帳號的預設工作區，每個新對話會在其中新建一個資料夾。',
    lockedHint: '本次對話已綁定該目錄，無法在對話中變更。如需使用其他目錄，請新建對話。',
    blocked: (path: string) => `「${path}」是系統目錄、磁碟根目錄或使用者主目錄，請選擇一個具體的子目錄。`,
    pickFailed: '無法開啟資料夾選擇視窗'
  }
})

/** 工作目录选择器的响应式文案。 */
export function useWorkdirCopy() {
  return usePluginI18n(SCOPE)
}
