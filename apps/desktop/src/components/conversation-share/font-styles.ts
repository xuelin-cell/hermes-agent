interface FontResourceReader {
  text: (url: string, signal: AbortSignal) => Promise<string>
  data: (url: string, signal: AbortSignal, image: boolean) => Promise<string>
}

/** 以浏览器规范化的字体描述匹配字重和字形范围，避免同名字体互相冒充。 */
function fontIdentity(font: Pick<FontFace, 'family' | 'style' | 'weight' | 'stretch' | 'unicodeRange'>): string {
  return JSON.stringify([
    font.family.trim().replace(/["']/g, ''),
    font.style || 'normal',
    font.weight === 'bold' ? '700' : font.weight === 'normal' || !font.weight ? '400' : font.weight,
    font.stretch === 'normal' || !font.stretch ? '100%' : font.stretch,
    (font.unicodeRange || 'U+0-10FFFF').replace(/\s/g, '').toLowerCase()
  ])
}

/** 收集使用中的字体；跨域 CSSOM 不可读时通过正常 CORS 请求读取，不降低浏览器安全限制。 */
export async function collectFontStyles(
  families: Set<string>,
  signal: AbortSignal,
  resources: FontResourceReader
): Promise<string> {
  const visited = new Set<CSSStyleSheet>()
  const opaque: CSSStyleSheet[] = []

  const remaining = new Set(
    [...document.fonts]
      .filter(font => font.status === 'loaded' && families.has(font.family.replace(/["']/g, '')))
      .map(fontIdentity)
  )

  /** 保持每张样式表自己的相对地址基准，递归处理分组及原生导入规则。 */
  async function stylesheet(sheet: CSSStyleSheet, readOpaque = false): Promise<string> {
    signal.throwIfAborted()

    if (!readOpaque && visited.has(sheet)) {
      return ''
    }

    visited.add(sheet)
    let rules: CSSRuleList

    try {
      rules = sheet.cssRules
    } catch (error) {
      if (!(error instanceof DOMException) || error.name !== 'SecurityError' || !sheet.href) {
        throw error
      }

      // 先处理可读的本地样式；无关主题及已由内置字体覆盖的远程样式不发起请求。
      if (!readOpaque) {
        opaque.push(sheet)

        return ''
      }

      const text = await resources.text(sheet.href, signal)

      // 构造样式表不会加载外部资源，但浏览器会忽略 @import；不能静默丢失导入字体。
      if (/@import\b/i.test(text.replace(/\/\*[\s\S]*?\*\//g, ''))) {
        throw new Error('Imported cross-origin font stylesheet is unsupported')
      }

      const parsed = new CSSStyleSheet()
      parsed.replaceSync(text)
      rules = parsed.cssRules
    }

    return await collect(rules, sheet.href || location.href, readOpaque)
  }

  /** 只内嵌实际使用的字体，保留字形范围等描述，字体缺失时停止分享。 */
  async function collect(rules: CSSRuleList, base: string, onlyRemaining = false): Promise<string> {
    let output = ''

    for (const rule of rules) {
      signal.throwIfAborted()

      if (rule.type === CSSRule.IMPORT_RULE) {
        const imported = (rule as CSSImportRule).styleSheet

        if (!imported) {
          throw new Error('Font stylesheet is not loaded')
        }

        output += await stylesheet(imported)
      } else if (rule.type === CSSRule.FONT_FACE_RULE) {
        const font = rule as CSSFontFaceRule

        if (!families.has(font.style.getPropertyValue('font-family').trim().replace(/["']/g, ''))) {
          continue
        }

        const identity = fontIdentity({
          family: font.style.getPropertyValue('font-family'),
          style: font.style.getPropertyValue('font-style'),
          weight: font.style.getPropertyValue('font-weight'),
          stretch: font.style.getPropertyValue('font-stretch'),
          unicodeRange: font.style.getPropertyValue('unicode-range')
        })

        // 外部字体常按语言拆成多个字形包，只内嵌当前实际加载的包。
        if (onlyRemaining && !remaining.has(identity)) {
          continue
        }

        const url = /url\(["']?([^"')]+)["']?\)/.exec(font.style.getPropertyValue('src'))

        if (!url) {
          throw new Error('Font has no embeddable source')
        }

        const data = await resources.data(new URL(url[1], base).href, signal, false)
        const embedded = new CSSStyleSheet()
        embedded.insertRule(font.cssText)
        const descriptors = (embedded.cssRules[0] as CSSFontFaceRule).style
        descriptors.setProperty('src', `url("${data}")`)
        output += `@font-face{${descriptors.cssText}}`
        remaining.delete(identity)
      } else if ('cssRules' in rule) {
        output += await collect((rule as CSSGroupingRule).cssRules, base, onlyRemaining)
      }
    }

    return output
  }

  let output = ''

  for (const sheet of document.styleSheets) {
    output += await stylesheet(sheet)
  }

  // 只为快照字体链中已实际加载、尚未找到来源的字体读取跨域样式。
  let resourceFailure: unknown

  for (const sheet of opaque) {
    if (!remaining.size) {
      break
    }

    const before = [...remaining]

    try {
      output += await stylesheet(sheet, true)
    } catch (error) {
      signal.throwIfAborted()
      // 其他样式可能提供所需字体；失败的整张样式不保留部分收集结果。
      remaining.clear()

      for (const identity of before) {
        remaining.add(identity)
      }

      resourceFailure ??= error
    }
  }

  if (remaining.size) {
    throw resourceFailure || new Error('Used font source is unavailable')
  }

  return output
}
