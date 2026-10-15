import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { convertLibreOffice } from './convert-libreoffice'
import type { runOfficeProcess } from './run-process'

let root: string
let executable: string
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'hermes-office-lo-'))
  executable = path.join(root, process.platform === 'win32' ? 'soffice.exe' : 'soffice')
  await fs.writeFile(process.platform === 'win32' ? path.join(root, 'soffice.com') : executable, 'controlled executable, never launched')
})
afterEach(async () => {
  if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith('hermes-office-lo-')) {
    throw new Error('Unsafe cleanup')
  }

  await fs.rm(root, { recursive: true, force: true })
})

it('为每次转换独立配置并禁宏，参数不走 shell；正常结束删除配置，原文件不变', async () => {
  const source = path.join(root, "中文 '源文件'.docx")
  await fs.writeFile(source, 'source')
  let profile = ''

  const run = vi.fn<typeof runOfficeProcess>().mockImplementation(async (executable, args, options) => {
    profile = fileURLToPath(args[0].slice('-env:UserInstallation='.length))
    expect(executable).toBe(path.join(root, process.platform === 'win32' ? 'soffice.com' : 'soffice'))
    expect(args).toContain(source)
    expect(args).toContain('--headless')
    expect(args).toContain('--norestore')
    expect(options.timeoutMs).toBe(2000)
    expect(await fs.readFile(path.join(profile, 'user', 'registrymodifications.xcu'), 'utf8')).toContain(
      '<value>3</value>'
    )
    await fs.writeFile(path.join(options.cwd, path.basename(source, '.docx') + '.pdf'), '%PDF-fixture')

    return { stdout: '' }
  })

  const result = await convertLibreOffice(
    { provider: 'libreoffice', executable },
    source,
    root,
    2000,
    run
  )

  expect(result.ok).toBe(true)
  expect(await fs.stat(profile).catch(() => null)).toBeNull()
  expect(await fs.readFile(source, 'utf8')).toBe('source')
})

it('超时保留配置并报告收尾不确定，不把启动器退出当作后代全部已结束', async () => {
  const run = vi.fn<typeof runOfficeProcess>().mockResolvedValue({ stdout: '', failure: 'timeout' })
  expect(
    await convertLibreOffice(
      { provider: 'libreoffice', executable },
      path.join(root, 'source.docx'),
      root,
      2000,
      run
    )
  ).toEqual({ ok: false, code: 'timeout', cleanupSafe: false })
  const directory = (await fs.readdir(root)).find(name => name.startsWith('lo-'))!
  expect((await fs.stat(path.join(root, directory, 'profile'))).isDirectory()).toBe(true)
})
