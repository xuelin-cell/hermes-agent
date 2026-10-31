import { expect, it } from 'vitest'

import { mediaTagValues } from '@/lib/chat-messages/parts'
import { deliveryPathIdentity, parseDeliveryBlocks } from '@/lib/delivery-cards'

it('路径仅按可确认的规则去重，临时文件不进入产物列表，格式与 POSIX 大小写仍区分', () => {
  expect(deliveryPathIdentity('/C:/Work/a.pdf')?.key).toBe(deliveryPathIdentity('C:\\work\\a.pdf')?.key)
  expect(deliveryPathIdentity('file:///C:/Work/a%20b.pdf')?.key).toBe(deliveryPathIdentity('C:/work/a b.pdf')?.key)
  expect(deliveryPathIdentity('/work/A.pdf')?.key).not.toBe(deliveryPathIdentity('/work/a.pdf')?.key)
  expect(
    mediaTagValues('MEDIA:C:/work/a.pdf\nMEDIA:C:\\work\\a.pdf\nMEDIA:C:/work/.tmp/a.pdf\nMEDIA:C:/work/a.docx')
  ).toEqual(['C:/work/a.pdf', 'C:/work/a.docx'])
})

it('长回复跨段去重，围栏示例和网页链接不变，追加文本不依赖上次解析状态', () => {
  const prose = '正文分析与数据说明。'.repeat(2000)
  const code = '```md\n[示例](#media:%2Fwork%2F.tmp%2Fexample.pdf)\n```'
  const first = '[成品](#media:%2Fwork%2Freport.pdf)'
  const tail = '[再次说明](#preview/%2Fwork%2Freport.pdf)'
  const text = `${prose}\n\n${code}\n\n${first}\n\n[网站](https://example.com)\n\n${tail}`
  const start = performance.now()

  for (let iteration = 0; iteration < 10; iteration++) {
    const source = text + '后续正文。'.repeat(iteration)
    expect(parseDeliveryBlocks(source).join('')).toBe(source.replace(tail, '再次说明'))
    expect(parseDeliveryBlocks(source)).toBe(parseDeliveryBlocks(source))
  }

  console.info(
    `delivery filter: ${(performance.now() - start).toFixed(1)} ms / 10 growing ${text.length}-character replies`
  )
})
