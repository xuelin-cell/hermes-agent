/** Only identity stamped by the executing product provider earns a brand badge. */
/** 标识仅来自执行后端身份，缺少身份的结果不推断品牌。 */
export function webProviderLabel(value: unknown): string | null {
  const record = decodeWebResult(value)
  const data = record?.data

  const row = Array.isArray(data)
    ? data.find(item => item && typeof item === 'object' && item.metadata?.provider)
    : null

  const provider =
    record?.provider ?? (record?.metadata as Record<string, unknown> | undefined)?.provider ?? row?.metadata?.provider

  return provider === 'unisearch'
    ? 'UniSearch'
    : provider === 'builtin_parse'
      ? 'BuiltinCrawl'
      : provider === 'unicrawl'
        ? 'UniCrawl'
        : null
}

/** 把原生不可信包装解析为数据，不执行或接受尾随指令。 */
export function decodeWebResult(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string') {
    // Hermes marks external content as untrusted before persisting it. Only decode data.
    if (/^<untrusted_tool_result source="web_(search|extract)">\n/.test(value)) {
      const separator = value.indexOf('\n\n')
      const end = value.lastIndexOf('\n</untrusted_tool_result>')

      if (separator < 0 || end < separator || end + '\n</untrusted_tool_result>'.length !== value.length) {
        return null
      }

      value = value.slice(separator + 2, end)
    }

    try {
      value = JSON.parse(value as string)
    } catch {
      return null
    }
  }

  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}
