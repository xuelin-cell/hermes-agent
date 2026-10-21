import { afterEach, describe, expect, it, vi } from 'vitest'

import { $selectedWorkspaceMode } from '@/store/workspace-category'

import { applyConversationFolder, isConversationFolder } from './conversation-folder'

describe('isConversationFolder', () => {
  const workspace = 'C:\\uniworker\\acc\\workspace'

  it('认出默认工作区下一层、按时间命名的文件夹，包括同一秒的后缀', () => {
    expect(isConversationFolder(`${workspace}\\20261019-103015`, workspace)).toBe(true)
    expect(isConversationFolder('c:/uniworker/acc/workspace/20261019-103015-2/', workspace)).toBe(true)
  })

  it('其它位置或其它名字的文件夹不算', () => {
    expect(isConversationFolder(workspace, workspace)).toBe(false)
    expect(isConversationFolder(`${workspace}\\报告`, workspace)).toBe(false)
    expect(isConversationFolder(`${workspace}\\20261019-103015\\sub`, workspace)).toBe(false)
    expect(isConversationFolder(`${workspace}\\20261019`, workspace)).toBe(false)
    expect(isConversationFolder('D:\\other\\20261019-103015', workspace)).toBe(false)
    expect(isConversationFolder('C:\\uniworker\\acc\\elsewhere\\20261019-103015', workspace)).toBe(false)
    expect(isConversationFolder('C:\\uniworker\\acc\\workspace2\\20261019-103015', workspace)).toBe(false)
    expect(isConversationFolder(`${workspace}\\20261019-103015`, '')).toBe(false)
  })
})

describe('applyConversationFolder', () => {
  const workspace = 'C:\\uniworker\\acc\\workspace'
  const folder = `${workspace}\\20261021-090000`
  const inherited = `${workspace}\\20261020-052645`

  /** 主进程按账号工作区建文件夹，后端默认目录就是账号工作区。 */
  async function apply(params: Record<string, unknown>) {
    const create = vi.fn(async () => folder)
    window.hermesDesktop = { createConversationFolder: create } as never

    return { create, result: await applyConversationFolder(params, async () => ({ cwd: workspace })) }
  }

  afterEach(() => {
    window.hermesDesktop = undefined as never
    $selectedWorkspaceMode.set(null)
  })

  it('日常办公里带过来的旧目录不算选择，照样新建专属文件夹', async () => {
    $selectedWorkspaceMode.set('work')
    const params: Record<string, unknown> = { cwd: inherited, cwd_explicit: false }

    expect((await apply(params)).result).toBe(folder)
    expect(params).toMatchObject({ cwd: folder, cwd_explicit: true })
  })

  it('这次亲手选的目录照用，不建文件夹', async () => {
    $selectedWorkspaceMode.set('work')
    const params: Record<string, unknown> = { cwd: 'D:\\资料', cwd_explicit: true }
    const { create, result } = await apply(params)

    expect(result).toBeNull()
    expect(create).not.toHaveBeenCalled()
    expect(params.cwd).toBe('D:\\资料')
  })

  it('代码开发保持原样：带过来的目录照用，没有目录才建', async () => {
    $selectedWorkspaceMode.set('codex')

    expect((await apply({ cwd: inherited, cwd_explicit: false })).result).toBeNull()
    expect((await apply({})).result).toBe(folder)
  })
})
