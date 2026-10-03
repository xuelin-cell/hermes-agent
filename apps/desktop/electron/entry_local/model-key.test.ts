import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseEnv } from 'node:util'

import { expect, it, vi } from 'vitest'

import { MAAS_MODEL_KEY_ENV } from './model-config'
import { writeAccountMaasKey } from './model-key'

it('实际文件只更新专用变量，保留 BOM、CRLF、个人 Key 和多行值；去重、重复写入及轮换稳定', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-key-update-'))
  const file = path.join(home, '.env')

  const personal =
    '\uFEFF# 个人配置保留\r\nPERSONAL_KEY="my#secret"\r\nMCP_DATA="first\r\nDESKTOP_MT_MAAS_API_KEY=inside-personal-value\r\nlast"\r\n'

  const old = `${personal} export ${MAAS_MODEL_KEY_ENV} = old-key # 旧平台变量\r\n${MAAS_MODEL_KEY_ENV}=duplicate-key\r\nOTHER=keep`

  try {
    fs.writeFileSync(file, old)
    writeAccountMaasKey(home, 'fixture-A-key')
    const saved = fs.readFileSync(file, 'utf8')
    expect(saved.startsWith(personal)).toBe(true)
    expect(saved).toContain('OTHER=keep\r\n')
    expect(saved.endsWith(`${MAAS_MODEL_KEY_ENV}="fixture-A-key"\r\n`)).toBe(true)
    expect(saved).not.toContain('old-key')
    expect(saved).not.toContain('duplicate-key')
    expect(parseEnv(saved)[MAAS_MODEL_KEY_ENV]).toBe('fixture-A-key')
    writeAccountMaasKey(home, 'fixture-A-key')
    expect(fs.readFileSync(file, 'utf8')).toBe(saved)
    writeAccountMaasKey(home, 'fixture-A-refreshed-key')
    expect(fs.readFileSync(file, 'utf8')).toBe(saved.replace('fixture-A-key', 'fixture-A-refreshed-key'))

    if (process.platform === 'win32') {
      fs.appendFileSync(file, `\r\nexport ${MAAS_MODEL_KEY_ENV.toLowerCase()} = stale-lowercase`)
      writeAccountMaasKey(home, 'fixture-A-refreshed-key')
      expect(fs.readFileSync(file, 'utf8')).not.toContain('stale-lowercase')
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

it('无套餐以空赋值撤销全部专用副本，个人变量不动；新文件和临时文件采用现有凭据写入机制', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-key-empty-'))
  const file = path.join(home, '.env')

  try {
    writeAccountMaasKey(home, 'fixture-model-key')
    fs.appendFileSync(file, 'PERSONAL_KEY=keep-key\n')
    writeAccountMaasKey(home, null)
    const cleared = fs.readFileSync(file, 'utf8')
    expect(parseEnv(cleared)).toEqual({ [MAAS_MODEL_KEY_ENV]: '', PERSONAL_KEY: 'keep-key' })
    expect(cleared).not.toContain('fixture-model-key')
    writeAccountMaasKey(home, null)
    expect(fs.readFileSync(file, 'utf8')).toBe(cleared)
    expect(fs.existsSync(`${file}.tmp`)).toBe(false)

    if (process.platform !== 'win32') {
      expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

it('拒绝注入、变量展开、坏编码和非普通文件；临时写入或替换失败保留旧 Key，并可修复重试', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-key-fail-'))
  const file = path.join(home, '.env')

  try {
    fs.writeFileSync(file, 'PERSONAL_KEY=keep\n')
    const original = fs.readFileSync(file)

    for (const key of ['', '  ', 'key\nOTHER=attack', 'key\r', 'key\u0000', 'key-${PERSONAL_KEY}', '非ASCII凭据']) {
      expect(() => writeAccountMaasKey(home, key)).toThrow('MaaS 模型凭据格式无效')
      expect(fs.readFileSync(file)).toEqual(original)
    }

    fs.mkdirSync(`${file}.tmp`)
    expect(() => writeAccountMaasKey(home, 'new-key')).toThrow('本次环境准备未完成')
    expect(fs.readFileSync(file)).toEqual(original)
    fs.rmdirSync(`${file}.tmp`)

    const rename = vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
      throw new Error('private-path-and-key')
    })

    expect(() => writeAccountMaasKey(home, 'new-key')).toThrow('本次环境准备未完成')
    expect(fs.readFileSync(file)).toEqual(original)
    expect(fs.readFileSync(`${file}.tmp`, 'utf8')).toContain('new-key')

    if (process.platform !== 'win32') {
      expect(fs.statSync(`${file}.tmp`).mode & 0o777).toBe(0o600)
    }

    rename.mockRestore()
    writeAccountMaasKey(home, 'new-key')
    expect(fs.existsSync(`${file}.tmp`)).toBe(false)
    const invalid = Buffer.from([0xff, 0xfe, 0x41])
    fs.writeFileSync(file, invalid)
    expect(() => writeAccountMaasKey(home, 'new-key')).toThrow('UTF-8')
    expect(fs.readFileSync(file)).toEqual(invalid)
    fs.unlinkSync(file)
    const outside = path.join(home, 'outside')
    fs.mkdirSync(outside)
    fs.writeFileSync(path.join(outside, 'marker'), 'keep')
    fs.symlinkSync(outside, file, process.platform === 'win32' ? 'junction' : 'dir')
    expect(() => writeAccountMaasKey(home, 'new-key')).toThrow('普通文件')
    expect(fs.readFileSync(path.join(outside, 'marker'), 'utf8')).toBe('keep')
  } finally {
    vi.restoreAllMocks()
    fs.rmSync(home, { recursive: true, force: true })
  }
})
