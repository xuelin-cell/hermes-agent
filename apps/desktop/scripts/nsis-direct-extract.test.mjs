// desktop-mt: 安装包直接解到安装目录（apps/desktop/nsis）靠 electron-builder NSIS 模板里的几个宏名接进去。
// 模板升级后宏改名时，direct-extract.nsh 的 !ifmacrodef 会悄悄跳过、退回先解到临时目录再复制，
// 所以这里同时核对我们的文件互相能找到，以及模板仍然提供这些宏；另外核对安装目录名（同在 installer.nsh）。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { test } from 'vitest'

const require = createRequire(import.meta.url)
const desktop = path.resolve(import.meta.dirname, '..')
const nsisDir = path.join(desktop, 'nsis')
const templates = path.resolve(desktop, '../../node_modules/app-builder-lib/templates/nsis')

const read = file => fs.readFileSync(file, 'utf8')

test('nsis.include 指向的文件存在，三份 .nsh 互相引用的文件都在', () => {
  const config = require(path.join(desktop, 'electron-builder.config.cjs'))
  const include = path.resolve(desktop, config.nsis.include)
  assert.equal(path.dirname(include), nsisDir)
  assert.ok(fs.existsSync(include), include)

  for (const name of fs.readdirSync(nsisDir).filter(file => file.endsWith('.nsh'))) {
    for (const [, target] of read(path.join(nsisDir, name)).matchAll(/!include "\$\{UNIWORK_NSIS_DIR\}\\([^"]+)"/g)) {
      assert.ok(fs.existsSync(path.join(nsisDir, target)), `${name} -> ${target}`)
    }
  }
})

test('模板仍提供换解压方式要用的宏和钩子', () => {
  const extract = read(path.join(templates, 'include/extractAppPackage.nsh'))
  assert.match(extract, /!macro extractUsing7za FILE/)
  assert.match(extract, /!insertmacro extractUsing7za "\$PLUGINSDIR\\app-\$packageArch\.7z"/)

  const appRunning = read(path.join(templates, 'include/allowOnlyOneInstallerInstance.nsh'))
  assert.match(appRunning, /!ifmacrodef customCheckAppRunning\s+!insertmacro customCheckAppRunning\s+!else\s+!insertmacro IS_POWERSHELL_AVAILABLE\s+!insertmacro _CHECK_APP_RUNNING/)

  // customHeader 要在引入运行检查之后展开；CHECK_APP_RUNNING 要在引入解压宏之后、装文件之前展开。
  const installer = read(path.join(templates, 'installer.nsi'))
  assert.ok(installer.indexOf('allowOnlyOneInstallerInstance.nsh') < installer.indexOf('!insertmacro customHeader'))
  const section = read(path.join(templates, 'installSection.nsh'))
  assert.ok(section.indexOf('!include installer.nsh') < section.indexOf('!insertmacro CHECK_APP_RUNNING'))
  assert.ok(section.indexOf('!insertmacro CHECK_APP_RUNNING') < section.indexOf('!insertmacro installApplicationFiles'))
})

test('安装目录不叫 UniWork，检查脚本读得到同一个名字', () => {
  // 老 UniWork 按机器装在 %ProgramFiles%\UniWork；同一个目录会混装、卸一个删两个。
  const define = /^\s*!define APP_FILENAME "([^"]+)"/m.exec(read(path.join(nsisDir, 'installer.nsh')))
  assert.ok(define, 'installer.nsh 没有 !define APP_FILENAME')
  assert.notEqual(define[1].toLowerCase(), 'uniwork')

  const checker = read(path.resolve(desktop, '../../scripts/bundles/check-windows-installer.ps1'))
  assert.ok(checker.includes(String.raw`apps\desktop\nsis\installer.nsh`))
  assert.ok(checker.includes(String.raw`'^\s*!define APP_FILENAME "([^"]+)"'`))
})

test('direct-extract.nsh 换成增量解压 + 整包解压两条路径', () => {
  const direct = read(path.join(nsisDir, 'direct-extract.nsh'))
  assert.match(direct, /!macroundef extractUsing7za/)
  assert.match(direct, /Call UNIWORK_TryIncremental/)
  assert.match(direct, /Call UNIWORK_ExtractFull/)
  assert.match(direct, /UNIWORK_RESTORE_UNINSTALLER/)
  assert.match(direct, /uninstallOldVersion SHELL_CONTEXT/)
  assert.doesNotMatch(direct, /7z-out|CopyFiles/)
})

test('增量更新用到的脚本和指纹工具都在 nsis 目录里', () => {
  for (const name of ['incremental-update.nsh', 'direct-extract.nsh', 'app-running.nsh', 'installer.nsh',
                      'install-log.nsh', 'update-plan.ps1', 'payload-digest.py']) {
    assert.ok(fs.existsSync(path.join(nsisDir, name)), name)
  }
  const incremental = read(path.join(nsisDir, 'incremental-update.nsh'))
  assert.match(incremental, /Var UNIWORK_INCREMENTAL/)
  assert.match(incremental, /Var UNIWORK_PLANNED/)
  assert.match(incremental, /Var UNIWORK_EXTRACT_RC/)
  assert.match(incremental, /!macro UNIWORK_DECIDE\b/)
  assert.match(incremental, /Function UNIWORK_TryIncremental/)
  assert.match(incremental, /Function UNIWORK_ExtractFull/)
  assert.match(incremental, /Function UNIWORK_ExtractExcluded/)
})

test('安装详情既显示在面板上，也按阶段落进日志文件', () => {
  const installer = read(path.join(nsisDir, 'installer.nsh'))
  const log = read(path.join(nsisDir, 'install-log.nsh'))
  const appRunning = read(path.join(nsisDir, 'app-running.nsh'))
  const incremental = read(path.join(nsisDir, 'incremental-update.nsh'))

  // 面板默认是关的：ShowInstDetails 要在脚本层覆盖回来（customHeader），
  // SetDetailsPrint 要在段里覆盖回来（customCheckAppRunning），少一个就什么都看不到。
  // 而且必须是 both：实测 NSIS 3.12 下 textonly 只写进度条上方那行「当前操作」文字，
  // 详情列表一条都不进，用户点开"显示详情"只能看到空白面板。
  assert.match(installer, /!macro customHeader[\s\S]*ShowInstDetails hide[\s\S]*!macroend/)
  assert.match(appRunning, /SetDetailsPrint both/)

  // 打包分两遍编译，卸载器那一遍（BUILD_UNINSTALLER）也会展开 customCheckAppRunning
  // （templates/nsis/uninstaller.nsh:2 的 un.checkAppRunning → CHECK_APP_RUNNING）。
  // install-log.nsh 的阶段变量只在 !ifndef BUILD_UNINSTALLER 里声明，卸载器单元里一旦引用
  // 就是 warning 6000，而 makensis 带 -WX，警告直接变错误、整个打包失败。
  assert.match(appRunning, /!ifndef BUILD_UNINSTALLER\s*\n\s*SetDetailsPrint both\s*\n\s*!insertmacro UniPhaseBegin 1/)

  // 明细只能走 UniSay：裸 DetailPrint 进不了日志文件。
  assert.doesNotMatch(incremental, /(^|\s)DetailPrint /)
  assert.match(log, /macro UniSay[\s\S]*DetailPrint "\$\{TEXT\}"[\s\S]*!insertmacro UniLog/)
  assert.match(incremental, /!insertmacro UniPhaseBegin 2 /)
  assert.match(incremental, /!insertmacro UniPhaseBegin 3 /)

  // "显示详情"按钮交给用户自己点：ShowInstDetails hide 让按钮可见、面板收起，
  // 安装器不替用户点（实测这个按钮是单向的，展开后没有收回面板的控件）。
  assert.doesNotMatch(appRunning, /UniShowDetailsPane/)
  assert.doesNotMatch(log, /GetDlgItem/)
})

test('7za 跳过了哪些组件逐条报出来：计划写 keep.txt，安装器读出来拼中文', () => {
  const incremental = read(path.join(nsisDir, 'incremental-update.nsh'))
  const plan = read(path.join(nsisDir, 'update-plan.ps1'))

  // 数字只能来自包本身（安装目录里数一遍要 40 多秒），所以要把包和 7za 一起交给计划。
  assert.match(incremental, /-Archive "\$UNIWORK_ARCHIVE"/)
  assert.match(incremental, /-SevenZip "\$PLUGINSDIR\\uniwork\\7za\.exe"/)
  // 两侧必须指向同一个文件，不然安装器读的是上一次安装留下的那份。
  assert.match(plan, /\[string\]\$KeepFile/)
  assert.match(incremental, /-KeepFile "\$PLUGINSDIR\\uniwork\\keep\.txt"/)
  assert.match(incremental, /Function UNIWORK_PrintKept/)
  assert.match(incremental, /Call UNIWORK_PrintKept/)

  // 一条记录的字段顺序：类型、名字、版本、文件数、体积——写和读必须一致。
  assert.match(plan, /\$records\.Add\(\$item\.Kind\)[\s\S]*\$records\.Add\(\$item\.Name\)[\s\S]*\$records\.Add\(\$item\.Version\)[\s\S]*\$records\.Add\(\$files\)[\s\S]*\$records\.Add\(\$megabytes\)/)
  assert.match(incremental, /StrCpy \$UNIWORK_KEEP_KIND \$UNIWORK_KEEP_LINE[\s\S]*StrCpy \$UNIWORK_KEEP_NAME[\s\S]*StrCpy \$UNIWORK_KEEP_VER[\s\S]*StrCpy \$UNIWORK_KEEP_FILES[\s\S]*StrCpy \$UNIWORK_KEEP_MB/)
  const written = (plan.match(/\$records\.Add\(/g) ?? []).length
  const consumed = (incremental.match(/Call UNIWORK_ReadKeepLine/g) ?? []).length
  assert.ok(written > 0 && written === consumed, `每条记录写 ${written} 行、读 ${consumed} 行`)

  // 明细走 UniSay（面板 + 日志同一句），归档路径太长只进日志文件。
  assert.match(incremental, /!insertmacro UniSay "保留工具/)
  assert.match(incremental, /!insertmacro UniLog "本批跳过：\$UNIWORK_EXCLUDES"/)
  assert.match(incremental, /!insertmacro UniSay "跳过上面保留的组件，解压其余文件（第 \$UNIWORK_EXTRACT_BATCH 批）"/)

  // 计划自己的英文流水只进日志文件：面板上的话必须是人话，中文由 NSIS 现拼。
  assert.match(incremental, /Function UNIWORK_PrintLog[\s\S]*!insertmacro UniLog "\$1"/)
  // "整包覆盖"只在真跳过过东西时才说；批次计数在 DECIDE 里归零，不能靠空值比较的运气。
  assert.match(incremental, /!macro UNIWORK_DECIDE[\s\S]*StrCpy \$UNIWORK_EXTRACT_BATCH 0/)
  assert.match(incremental, /IntOp \$UNIWORK_EXTRACT_BATCH \$UNIWORK_EXTRACT_BATCH \+ 1/)
  assert.match(incremental, /\$\{If\} \$UNIWORK_EXTRACT_BATCH > 0[\s\S]*整包覆盖/)
})
