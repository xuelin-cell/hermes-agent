// 模型 ID 转成好读的显示名（deepseek-v4-flash → DeepSeek V4 Flash），规则与 UniWork 桌面版一致。
const CANON: Record<string, string> = {
  ai: 'AI',
  claude: 'Claude',
  codestral: 'Codestral',
  deepseek: 'DeepSeek',
  devstral: 'Devstral',
  gemini: 'Gemini',
  gemma: 'Gemma',
  glm: 'GLM',
  gpt: 'GPT',
  grok: 'Grok',
  haiku: 'Haiku',
  hd: 'HD',
  kimi: 'Kimi',
  llama: 'Llama',
  llm: 'LLM',
  minimax: 'MiniMax',
  ministral: 'Ministral',
  mistral: 'Mistral',
  moe: 'MoE',
  nova: 'Nova',
  o1: 'o1',
  o3: 'o3',
  o4: 'o4',
  ocr: 'OCR',
  opus: 'Opus',
  oss: 'OSS',
  phi: 'Phi',
  qwen: 'Qwen',
  sonnet: 'Sonnet',
  tts: 'TTS',
  vl: 'VL',
  xs: 'XS'
}

const SIZE = /^\d+(?:\.\d+)?[bmk]$/i
const EXPERT = /^a\d+b$/i
const MIXTURE = /^\d+x\d+b$/i
const VISION_VERSION = /^\d+(?:\.\d+)*v$/i
const VERSION = /^v\d+(?:\.\d+)*$/i
const DATE8 = /^\d{8}$/

/** 单个片段按固定写法、尺寸、版本和日期规则美化。 */
function prettyToken(token: string): string {
  const low = token.toLowerCase()

  if (low in CANON) {
    return CANON[low]
  }

  if (SIZE.test(token)) {
    return token.slice(0, -1) + token.slice(-1).toUpperCase()
  }

  if (EXPERT.test(token)) {
    return `A${token.slice(1, -1)}B`
  }

  if (MIXTURE.test(token)) {
    return `${token.slice(0, -1)}B`
  }

  if (VISION_VERSION.test(token)) {
    return `${token.slice(0, -1)}V`
  }

  if (VERSION.test(token)) {
    return token.toUpperCase()
  }

  if (DATE8.test(token)) {
    return `${token.slice(0, 4)}-${token.slice(4, 6)}-${token.slice(6, 8)}`
  }

  return token.charAt(0).toUpperCase() + token.slice(1)
}

/** 去掉 `provider/` 前缀和 `:free` 之类的尾标，按连字符切开逐段美化。 */
export function prettifyModelId(rawId: string): string {
  const id = (rawId ?? '').trim()

  if (!id) {
    return ''
  }

  let tail = id.includes('/') ? id.slice(id.lastIndexOf('/') + 1) : id
  let suffix = ''
  const colon = tail.indexOf(':')

  if (colon !== -1) {
    const flag = tail
      .slice(colon + 1)
      .trim()
      .toLowerCase()

    tail = tail.slice(0, colon)

    if (flag) {
      suffix = ` (${flag})`
    }
  }

  const name = tail.split(/[-_]/).filter(Boolean).map(prettyToken).join(' ').replace(/\s+/g, ' ').trim()

  return (name || id) + suffix
}
