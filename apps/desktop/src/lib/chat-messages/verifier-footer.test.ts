import { describe, expect, it } from 'vitest'

import { withoutVerifierFooter } from './verifier-footer'

const ANSWER = 'PPT 已生成成功。\n\nMEDIA:C:\\ws\\output.pptx'

// 与 agent/turn_explainers.py 的输出格式一致：标题一行，明细行两个空格缩进。
const FOOTER = [
  '⚠️ File-mutation verifier: 1 file edit(s) FAILED this turn despite any wording above that may suggest otherwise. Run `git status` or `read_file` to confirm what actually landed.',
  '  • `C:\\ws\\slides_4.js` — [patch] Could not find a match for old_string in the file'
].join('\n')

describe('withoutVerifierFooter', () => {
  it('removes the trailing footer and the blank line before it', () => {
    expect(withoutVerifierFooter(`${ANSWER}\n\n${FOOTER}`)).toBe(ANSWER)
  })

  it('removes every bullet, the overflow line and CRLF line endings', () => {
    const footer = [FOOTER, '  • `C:\\ws\\b.js` — [write_file] failed', '  • … and 3 more'].join('\n')

    expect(withoutVerifierFooter(`${ANSWER}\r\n\r\n${footer.replace(/\n/g, '\r\n')}\r\n`)).toBe(ANSWER)
  })

  it('accepts the warning sign without the emoji variation selector', () => {
    expect(withoutVerifierFooter(`${ANSWER}\n\n${FOOTER.replace('⚠️', '⚠')}`)).toBe(ANSWER)
  })

  it('keeps text that has no footer', () => {
    expect(withoutVerifierFooter(ANSWER)).toBe(ANSWER)
    expect(withoutVerifierFooter(`${ANSWER}\n`)).toBe(`${ANSWER}\n`)
  })

  it('keeps the sentence when it is quoted before other content', () => {
    const quoted = `原版会输出：\n\n${FOOTER}\n\n以上就是它的格式。`

    expect(withoutVerifierFooter(quoted)).toBe(quoted)
  })

  it('keeps a code block that ends the reply', () => {
    const fenced = `示例：\n\n\`\`\`\n${FOOTER}\n\`\`\``

    expect(withoutVerifierFooter(fenced)).toBe(fenced)
  })
})
