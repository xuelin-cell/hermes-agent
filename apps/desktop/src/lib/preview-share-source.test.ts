import { expect, it } from 'vitest'

import type { HermesConnection } from '@/global'
import {
  $previewTabs,
  decodePreviewTabs,
  dropPreviewTabsForProfile,
  migratePreviewTabsForProfile,
  openPreview,
  type PreviewTarget,
  setPreviewScope
} from '@/store/preview'

import { previewShareSource } from './preview-share-source'

it('持久化文件预览来源跨 A→B→A Profile 切换不会借用当前聊天，普通预览保留原行为', () => {
  const target: PreviewTarget = {
    kind: 'file',
    label: 'report.html',
    path: '/workspace/report.html',
    source: '/workspace/report.html',
    url: 'file:///workspace/report.html',
    shareOrigin: { connectionId: 'local', profile: 'A', sessionId: 'source-chat', path: '/workspace/report.html' }
  }

  const restored = decodePreviewTabs(JSON.stringify([{ id: 'file:/workspace/report.html', target }]))[0].target
  // 构造独立 Profile 上下文，验证来源随当前路由重新核对。
  const connection = (profile: string, mode = 'local') => ({ profile, mode }) as HermesConnection
  expect(previewShareSource(restored, connection('A'))).toEqual({ sessionId: 'source-chat', path: target.path })
  expect(previewShareSource(restored, connection('B'))).toBeNull()
  expect(previewShareSource(restored, connection('A'))).toEqual({ sessionId: 'source-chat', path: target.path })
  expect(previewShareSource(restored, connection('A', 'remote'))).toBeNull()
  expect(previewShareSource(restored, connection('A'), 'file:///workspace/other.html')).toBeNull()
  expect(previewShareSource(restored, connection('A'), 'https://example.com/report.html')).toBeNull()
  expect(previewShareSource({ ...restored, shareOrigin: undefined }, connection('A'))).toBeUndefined()
  expect(previewShareSource({ ...restored, shareOrigin: null }, connection('A'))).toBeNull()
})

it('Profile 改名同步其他 Profile 标签中的来源，删除后保留文件预览并关闭分享来源', () => {
  setPreviewScope('viewer')
  $previewTabs.set([])
  openPreview({
    kind: 'file',
    label: 'report.md',
    path: '/workspace/report.md',
    source: '/workspace/report.md',
    url: 'file:///workspace/report.md',
    shareOrigin: { connectionId: 'local', profile: 'source', sessionId: 'source-chat', path: '/workspace/report.md' }
  })
  migratePreviewTabsForProfile('source', 'renamed')
  expect($previewTabs.get()[0].target.shareOrigin?.profile).toBe('renamed')
  dropPreviewTabsForProfile('renamed')
  expect($previewTabs.get()[0].target.path).toBe('/workspace/report.md')
  expect($previewTabs.get()[0].target.shareOrigin).toBeNull()
  dropPreviewTabsForProfile('viewer')
  setPreviewScope('default')
})
