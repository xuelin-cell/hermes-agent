import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'

import { LocalFilePreview } from '@/app/chat/right-rail/preview-file'

afterEach(cleanup)

it('正式图片预览支持面板缩放和双击还原，更换图片不沿用旧变换', async () => {
  const target = {
    kind: 'file' as const,
    previewKind: 'image' as const,
    source: '/fixture/a.png',
    url: 'file:///fixture/a.png',
    label: '图片',
    dataUrl: 'data:image/png;base64,eA=='
  }

  const view = render(<LocalFilePreview reloadKey={0} target={target} />)
  const image = await screen.findByRole('img', { name: '图片' })
  const transformed = image.parentElement!
  fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }))
  expect(transformed.style.transform).toContain('scale(1.25)')
  fireEvent.doubleClick(screen.getByRole('region', { name: '图片' }))
  expect(transformed.style.transform).toContain('scale(1)')
  fireEvent.wheel(screen.getByRole('region', { name: '图片' }), { deltaY: -80 })
  expect(transformed.style.transform).toContain('scale(1.1)')
  view.rerender(
    <LocalFilePreview
      reloadKey={0}
      target={{
        ...target,
        source: '/fixture/b.png',
        url: 'file:///fixture/b.png',
        dataUrl: 'data:image/png;base64,eQ=='
      }}
    />
  )
  expect((await screen.findByRole('img', { name: '图片' })).parentElement!.style.transform).toContain('scale(1)')
})
