import { expect, it } from 'vitest'

import type { SessionInfo, SessionMessage } from '@/types/hermes'

import { collectDeliveredLocalArtifacts } from './local-artifact-delivery'

const session = {
  id: 'delivery',
  profile: 'a',
  connection_id: 'local',
  cwd: '/workspace',
  last_active: 10
} as SessionInfo

it('保留各轮正式交付及既有媒体、Markdown、预览格式，不按扩展名或文件名误删', () => {
  const messages: SessionMessage[] = [
    { role: 'assistant', content: 'MEDIA:"/workspace/最终 报告.pdf"', timestamp: 1 },
    { role: 'user', content: '再补一份原始数据和图片' },
    { role: 'assistant', tool_calls: [{ id: 'working' }], content: 'MEDIA:/workspace/draft.png' },
    { role: 'tool', tool_name: 'write_file', content: '{"files_modified":["/workspace/draft.json"]}' },
    {
      role: 'assistant',
      content: [
        '[数据](./final.json)',
        '![图片](#media:%2Fworkspace%2Ffinal.png)',
        '[预览](#preview/%2Fworkspace%2Findex.html)',
        '::preview{file="relative.html"}',
        'MEDIA:./result.custom',
        'MEDIA:"/workspace/draft.pdf final.pdf"',
        'MEDIA:"C:\\Users\\me\\最终 报告.docx"',
        '[下载](<./my%20report.xlsx>)',
        '[网页](https://example.com/page.html)',
        'MEDIA:https://example.com/image.png'
      ].join('\n'),
      timestamp: 2
    }
  ]

  const files = collectDeliveredLocalArtifacts(session, messages)
  expect(files.map(file => file.value)).toEqual([
    '/workspace/最终 报告.pdf',
    './final.json',
    '/workspace/final.png',
    '/workspace/index.html',
    './result.custom',
    '/workspace/draft.pdf final.pdf',
    'C:\\Users\\me\\最终 报告.docx',
    './my report.xlsx',
    './relative.html'
  ])
  expect(files[0]).toMatchObject({ profile: 'a', connectionId: 'local', timestamp: 1000 })
})

it('遵守聊天历史的可见正文与最终答复投影，不从隐藏、过程或原始回放中恢复文件', () => {
  const files = collectDeliveredLocalArtifacts(session, [
    { role: 'assistant', content: 'MEDIA:./raw.json', display_content: '' },
    { role: 'assistant', content: 'MEDIA:./hidden.json', display_kind: 'hidden' },
    { role: 'assistant', content: 'MEDIA:./notice.json', display_kind: 'process_complete' },
    {
      role: 'assistant',
      content: '',
      display_commentary: ['MEDIA:./commentary.json'],
      codex_message_items: JSON.stringify([
        {
          type: 'message',
          role: 'assistant',
          phase: 'analysis',
          content: [{ type: 'output_text', text: 'MEDIA:./analysis.json' }]
        },
        {
          type: 'message',
          role: 'assistant',
          phase: 'commentary',
          content: [{ type: 'output_text', text: 'MEDIA:./draft.json' }]
        },
        {
          type: 'message',
          role: 'assistant',
          phase: 'final_answer',
          content: [{ type: 'output_text', text: 'MEDIA:./delivered.json' }]
        }
      ])
    },
    { role: 'assistant', content: 'MEDIA:./internal.json', display_content: '[交付](#media:.%2Fprojected.png)' }
  ])

  expect(files.map(file => file.value)).toEqual(['./delivered.json', './projected.png'])
})
