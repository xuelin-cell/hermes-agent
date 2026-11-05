import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { installSkillsCli } from '../electron/entry_local/skills-cli-registration.mjs'

const desktop = path.resolve(import.meta.dirname, '..')
const require = createRequire(path.join(desktop, 'package.json'))
if (!fs.existsSync(path.join(desktop, 'dist/electron-main.mjs'))) {
  throw new Error('请先完成 Electron 开发构建。')
}
const root = path.resolve(desktop, '../..')
const python = process.env.HERMES_DESKTOP_PYTHON || ['.venv', 'venv']
  .map(name => path.join(root, name, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'))
  .find(file => fs.existsSync(file))
const directory = await installSkillsCli({ executable: require('electron'), appPath: desktop, python,
  helperDirectory: import.meta.dirname })
console.log(`已注册 ${directory} 中的 hermes。请重新打开终端检查命令位置。`)
