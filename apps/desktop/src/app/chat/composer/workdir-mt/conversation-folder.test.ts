import { describe, expect, it } from 'vitest'

import { isConversationFolder } from './conversation-folder'

describe('isConversationFolder', () => {
  const workspace = 'C:\\hmt\\acc\\workspace'

  it('认出默认工作区下一层、按时间命名的文件夹，包括同一秒的后缀', () => {
    expect(isConversationFolder(`${workspace}\\20261019-103015`, workspace)).toBe(true)
    expect(isConversationFolder('c:/hmt/acc/workspace/20261019-103015-2/', workspace)).toBe(true)
  })

  it('其它位置或其它名字的文件夹不算', () => {
    expect(isConversationFolder(workspace, workspace)).toBe(false)
    expect(isConversationFolder(`${workspace}\\报告`, workspace)).toBe(false)
    expect(isConversationFolder(`${workspace}\\20261019-103015\\sub`, workspace)).toBe(false)
    expect(isConversationFolder(`${workspace}\\20261019`, workspace)).toBe(false)
    expect(isConversationFolder('D:\\other\\20261019-103015', workspace)).toBe(false)
    expect(isConversationFolder('C:\\hmt\\acc\\elsewhere\\20261019-103015', workspace)).toBe(false)
    expect(isConversationFolder('C:\\hmt\\acc\\workspace2\\20261019-103015', workspace)).toBe(false)
    expect(isConversationFolder(`${workspace}\\20261019-103015`, '')).toBe(false)
  })
})
