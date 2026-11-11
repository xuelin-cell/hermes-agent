import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, expect, it } from 'vitest'

import { installSkillsCli } from './skills-cli-registration.mjs'
import { skillsCliAddress } from './skills-cli-state'

const directories: string[] = []

/** 所有安装入口与 Shell 配置均写入独立临时目录。 */
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "uniwork-cli-mac space's-"))
  directories.push(root)
  const python = path.join(root, 'python')
  fs.writeFileSync(python, '')

  return {
    home: root,
    zshDirectory: root,
    localAppData: root,
    python,
    helperDirectory: path.resolve('scripts'),
    executable: '/Applications/UniWork.app/Contents/MacOS/UniWork'
  }
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

it('macOS 注册保留用户 Shell 配置，重复注册不重复加 PATH，升级刷新应用位置', async () => {
  const options = fixture()
  const profile = path.join(options.home, '.zshrc')
  fs.writeFileSync(profile, 'export USER_SETTING=kept\n')
  const directory = await installSkillsCli({ ...options, platform: 'darwin' })
  await installSkillsCli({
    ...options,
    platform: 'darwin',
    executable: '/Applications/New UniWork.app/Contents/MacOS/UniWork'
  })

  expect(fs.readFileSync(profile, 'utf8')).toContain('export USER_SETTING=kept\n')
  expect(fs.readFileSync(profile, 'utf8').match(/UniWork desktop skills CLI PATH/g)).toHaveLength(1)

  for (const name of ['.zshrc', '.bash_profile', '.bashrc']) {
    expect(fs.readFileSync(path.join(options.home, name), 'utf8')).toContain(path.join('.uniwork', 'bin'))
  }

  const launcher = fs.readFileSync(path.join(directory, 'hermes'), 'utf8')
  expect(launcher).toContain('/Applications/New UniWork.app/Contents/MacOS/UniWork')
  expect(launcher).toContain("'\\''")
  expect(launcher).toContain('"$@"')
  expect(launcher).toContain(" '' ")
  expect(fs.readFileSync(path.join(directory, 'skills-cli.py'), 'utf8')).toContain('os.execve')
})

it('macOS 源码入口携带源码目录，拒绝覆盖外部命令', async () => {
  const options = fixture()

  const directory = await installSkillsCli({
    ...options,
    appPath: '/Source/Hermes Desktop',
    platform: 'darwin',
    registerPath: false
  })

  expect(fs.readFileSync(path.join(directory, 'hermes'), 'utf8')).toContain("'/Source/Hermes Desktop'")
  fs.writeFileSync(path.join(directory, 'hermes'), '#!/bin/sh\necho outside\n')
  await expect(installSkillsCli({ ...options, platform: 'darwin', registerPath: false })).rejects.toThrow('不属于')
  expect(fs.readFileSync(path.join(directory, 'hermes'), 'utf8')).toContain('outside')
})

it('Windows 安装包不携带源码参数，仍生成 CMD、PowerShell 和 Git Bash 配套文件', async () => {
  const options = fixture()

  const directory = await installSkillsCli({
    ...options,
    executable: 'C:\\Program Files\\UniWork\\UniWork.exe',
    platform: 'win32',
    registerPath: false
  })

  const script = fs.readFileSync(path.join(directory, 'skills-cli.ps1'), 'utf8')
  expect(script).toContain("$cliDesktop = ''")
  expect(script).toContain('if ($cliDesktop)')
  expect(script).toContain('WaitForExit(30000)')
  expect(fs.readFileSync(path.join(directory, 'hermes'), 'utf8')).toContain('powershell.exe')
  expect(fs.readFileSync(path.join(directory, 'hermes.cmd'), 'utf8')).toContain('exit /b %errorlevel%')
})

it('长 macOS 路径使用短 Socket 地址，并保留大小写身份区别', () => {
  const address = skillsCliAddress('/Users/' + '很长目录'.repeat(100), 'darwin')
  expect(address.length).toBeLessThan(100)
  expect(address).toMatch(/^\/tmp\/uniwork-cli-[a-f0-9]+\.sock$/)
  expect(skillsCliAddress('/Users/A', 'darwin')).not.toBe(skillsCliAddress('/Users/a', 'darwin'))
  expect(skillsCliAddress('C:\\Users\\A', 'win32')).toBe(skillsCliAddress('c:\\users\\a', 'win32'))
})

it('macOS 缺少当前安装 Python 时明确拒绝注册', async () => {
  await expect(installSkillsCli({ ...fixture(), python: '', platform: 'darwin', registerPath: false })).rejects.toThrow(
    'Python'
  )
})
