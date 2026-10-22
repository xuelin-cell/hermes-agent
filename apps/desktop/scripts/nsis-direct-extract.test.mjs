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

test('direct-extract.nsh 换成直接解压到输出目录', () => {
  const direct = read(path.join(nsisDir, 'direct-extract.nsh'))
  assert.match(direct, /!macroundef extractUsing7za/)
  assert.match(direct, /Nsis7z::Extract "\$\{FILE\}"/)
  assert.doesNotMatch(direct, /7z-out|CopyFiles/)
})
