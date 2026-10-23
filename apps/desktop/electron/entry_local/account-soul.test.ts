import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { expect, it, vi } from 'vitest'

import { prepareAccountSoul } from './account-soul'

it('统一新旧账号的 SOUL，A→B→A 只覆盖当前账号且保留专家人设', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'uniwork-soul-'))
  const first = path.join(root, 'a')
  const second = path.join(root, 'b')
  const expert = path.join(first, 'profiles', 'expert')
  fs.mkdirSync(expert, { recursive: true })
  fs.mkdirSync(second)

  try {
    fs.writeFileSync(path.join(first, 'SOUL.md'), 'You are Hermes Agent, built by Nous Research.')
    fs.writeFileSync(path.join(expert, 'SOUL.md'), '专家自己的身份')
    prepareAccountSoul(first)

    const expected = fs.readFileSync(path.join(first, 'SOUL.md'), 'utf8')
    expect(expected).toContain('你的名称和对外身份是“元景数字员工”。')
    expect(expected).toContain('明确回答“我是元景数字员工”，不要以 Hermes Agent 作为自己的名称。')
    expect(expected).toContain('根据实际情况如实说明，不编造来源。')
    expect(expected).toContain('不确定时明确说明，不夸大能力，不声称完成尚未执行或验证的操作。')
    expect(fs.existsSync(path.join(second, 'SOUL.md'))).toBe(false)
    prepareAccountSoul(second)
    expect(fs.readFileSync(path.join(second, 'SOUL.md'), 'utf8')).toBe(expected)
    fs.writeFileSync(path.join(first, 'SOUL.md'), '手动修改的账号 A 身份')
    fs.writeFileSync(path.join(second, 'SOUL.md'), '账号 B 尚未再次启动')
    prepareAccountSoul(first)
    expect(fs.readFileSync(path.join(first, 'SOUL.md'), 'utf8')).toBe(expected)
    expect(fs.readFileSync(path.join(second, 'SOUL.md'), 'utf8')).toBe('账号 B 尚未再次启动')
    expect(fs.readFileSync(path.join(expert, 'SOUL.md'), 'utf8')).toBe('专家自己的身份')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

it('替换失败时保留原 SOUL 并向账号准备流程报错', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'uniwork-soul-failure-'))
  const soulFile = path.join(home, 'SOUL.md')
  fs.writeFileSync(soulFile, '原账号身份')

  const rename = vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
    throw new Error('fixture rename failure')
  })

  try {
    expect(() => prepareAccountSoul(home)).toThrow('fixture rename failure')
    expect(fs.readFileSync(soulFile, 'utf8')).toBe('原账号身份')
  } finally {
    rename.mockRestore()
    fs.rmSync(home, { recursive: true, force: true })
  }
})
