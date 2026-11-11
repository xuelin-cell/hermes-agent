import type { ModelOptionsResult } from '@hermes/shared'

export function pptDefaultModel(text: string, manual: boolean, options: ModelOptionsResult, effort = '') {
  if (manual || !/pptx?|powerpoint|幻灯片|演示文稿|课件/i.test(text)) {return null}

  for (const provider of options.providers ?? []) {
    if (provider.models?.includes('deepseek-v4.1-flash')) {
      const supported = ['low', 'high', 'xhigh', 'max']

      return {
        provider: provider.slug,
        model: 'deepseek-v4.1-flash',
        reasoning_effort: supported.includes(effort) ? effort : 'high'
      }
    }
  }

  return null
}
