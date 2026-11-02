import { registerPluginLocales, usePluginI18n } from '@/i18n/plugin-i18n'

// 文案随本模块自带，不改动上游语言文件；缺少的语言回退到英文。
const SCOPE = 'desktop-mt.workdir'

registerPluginLocales(SCOPE, {
  en: {
    title: 'Working folder',
    selectLabel: 'Choose working folder',
    defaultName: 'Default workspace',
    defaultHint: 'The default workspace of this account',
    recent: 'Recent',
    choose: 'Choose another folder…',
    draftHint: 'The agent reads and writes files in this folder. It cannot be changed after the conversation starts.',
    folderHint:
      'Each new conversation gets its own folder inside the default workspace. It cannot be changed after the conversation starts.',
    settingsHint:
      'New conversations work in this folder unless you pick another. Leave it unset to use the default workspace of this account, where each new conversation gets its own folder.',
    restartTitle: 'Default workspace saved. Restart to apply',
    restartBody: (dir: string, root: string) =>
      `New location: ${dir}. Until restart, new conversations use ${root}. Restarting stops this account’s running tasks.`,
    restartNow: 'Restart now',
    later: 'Later',
    accountDefault: 'Account workspace',
    autoName: 'New folder each time',
    codeName: 'Default project',
    under: (root: string) => `Create under ${root}`,
    autoHint: 'Files go in a new folder for this conversation. The folder is fixed once you start.',
    codeHint: 'Conversations without a selected project share this folder. The folder is fixed once you start.',
    pickedOfficeHint: 'Work directly in this folder without creating a new one. The folder is fixed once you start.',
    pickedHint: 'Work directly in this folder. The folder is fixed once you start.',
    blocked: (path: string) =>
      `"${path}" is a system folder, a drive root, or a home folder. Choose a specific subfolder instead.`,
    pickFailed: 'Could not open the folder picker'
  },
  zh: {
    title: '工作目录',
    selectLabel: '选择工作目录',
    defaultName: '默认工作区',
    defaultHint: '当前账号的默认工作区',
    recent: '最近使用',
    choose: '选择其他文件夹…',
    draftHint: 'Agent 会在这个目录中读写文件，开始对话后不能更改。',
    folderHint: '每个新对话会在默认工作区中新建一个文件夹，Agent 在其中读写文件。开始对话后不能更改。',
    settingsHint:
      '新对话默认在此文件夹中工作，除非你另选目录。留空则使用当前账号的默认工作区，每个新对话会在其中新建一个文件夹。',
    restartTitle: '默认工作空间已保存，重启后生效',
    restartBody: (dir: string, root: string) =>
      `新位置：${dir}。重启前，新会话仍保存在：${root}。立即重启会停止当前账号正在运行的任务。`,
    restartNow: '立即重启',
    later: '稍后',
    accountDefault: '账号默认工作区',
    autoName: '每次新建文件夹',
    codeName: '默认项目',
    under: (root: string) => `新建在 ${root} 下`,
    autoHint: '本次对话的文件放在新建的文件夹里。开始对话后不能更改。',
    codeHint: '未选择项目的会话共用这个文件夹。开始对话后不能更改。',
    pickedOfficeHint: '直接在这个文件夹里工作，不新建文件夹。开始对话后不能更改。',
    pickedHint: '直接在这个文件夹里工作。开始对话后不能更改。',
    blocked: (path: string) => `「${path}」是系统目录、盘符根目录或用户主目录，请选择一个具体的子目录。`,
    pickFailed: '无法打开文件夹选择窗口'
  },
  'zh-hant': {
    title: '工作目錄',
    selectLabel: '選擇工作目錄',
    defaultName: '預設工作區',
    defaultHint: '目前帳號的預設工作區',
    recent: '最近使用',
    choose: '選擇其他資料夾…',
    draftHint: 'Agent 會在這個目錄中讀寫檔案，開始對話後不能變更。',
    folderHint: '每個新對話會在預設工作區中新建一個資料夾，Agent 在其中讀寫檔案。開始對話後不能變更。',
    settingsHint:
      '新對話預設在此資料夾中工作，除非您另選目錄。留空則使用目前帳號的預設工作區，每個新對話會在其中新建一個資料夾。',
    restartTitle: '預設工作空間已儲存，重新啟動後生效',
    restartBody: (dir: string, root: string) =>
      `新位置：${dir}。重新啟動前，新對話仍儲存在：${root}。立即重新啟動會停止目前帳號正在執行的工作。`,
    restartNow: '立即重新啟動',
    later: '稍後',
    accountDefault: '帳號預設工作區',
    autoName: '每次新增資料夾',
    codeName: '預設專案',
    under: (root: string) => `新增在 ${root} 下`,
    autoHint: '本次對話的檔案放在新建的資料夾裡。開始對話後不能更改。',
    codeHint: '未選擇專案的對話共用這個資料夾。開始對話後不能更改。',
    pickedOfficeHint: '直接在這個資料夾裡工作，不新增資料夾。開始對話後不能更改。',
    pickedHint: '直接在這個資料夾裡工作。開始對話後不能更改。',
    blocked: (path: string) => `「${path}」是系統目錄、磁碟根目錄或使用者主目錄，請選擇一個具體的子目錄。`,
    pickFailed: '無法開啟資料夾選擇視窗'
  }
})

/** 工作目录选择器的响应式文案。 */
export function useWorkdirCopy() {
  return usePluginI18n(SCOPE)
}
