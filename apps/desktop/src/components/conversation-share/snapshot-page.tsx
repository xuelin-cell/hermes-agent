import type { ConversationShareBlock, ConversationShareDocument } from '@hermes/shared/conversation-share'
import type { ReactNode } from 'react'

import brandLogo from '@/assets/login-brand-logo.png?inline'
import { responseDurationParts } from '@/components/assistant-ui/thread/response-presentation'
import { summarizeToolRun } from '@/components/assistant-ui/tool/run-summary'
import { SCAFFOLD_LABEL_CLASS } from '@/components/chat/scaffold-row'
import type { Locale } from '@/i18n'
import { registerPluginLocales, translatePlugin } from '@/i18n/plugin-i18n'
import { translateNow } from '@/i18n/runtime'
import { ChevronRight, Clock, Lock, Wrench } from '@/lib/icons'
import { cn } from '@/lib/utils'

import type { SharePageLabels } from './snapshot-renderer'

const SCOPE = 'desktop-mt.conversation-share-page'
registerPluginLocales(SCOPE, {
  en: {
    process: 'Execution process',
    duration: (time: string) => `Worked for ${time}`,
    time: (h: number, m: number, s: number) => (h ? `${h}h ${m}m ${s}s` : m ? `${m}m ${s}s` : `${s}s`)
  },
  zh: {
    process: '执行过程',
    duration: (time: string) => `用时 ${time}`,
    time: (h: number, m: number, s: number) => (h ? `${h}小时${m}分钟${s}秒` : m ? `${m}分${s}秒` : `${s}秒`)
  },
  'zh-hant': {
    process: '執行過程',
    duration: (time: string) => `用時 ${time}`,
    time: (h: number, m: number, s: number) => (h ? `${h}小時${m}分鐘${s}秒` : m ? `${m}分${s}秒` : `${s}秒`)
  }
})

const USER_BUBBLE = {
  light: '#f2f2f2',
  dark: '#2b2d34'
}

type ShareMessage = ConversationShareDocument['messages'][number]

interface ConversationSharePageProps {
  source: ConversationShareDocument
  labels: SharePageLabels
  renderMarkdown: (text: string) => ReactNode
}

/** 与桌面版的轮次标签一致：有时长显示「用时」，否则显示「执行过程」。 */
function processLabel(locale: string, seconds: number | undefined): string {
  const t = (key: string, ...args: unknown[]) => translatePlugin(SCOPE, locale as Locale, key, args)

  if (seconds === undefined) {
    return t('process')
  }

  const { hours, minutes, seconds: rest } = responseDurationParts(seconds)

  return t('duration', t('time', hours, minutes, rest))
}

type ProcessItem =
  { kind: 'reasoning'; text: string } | { kind: 'text'; text: string } | { kind: 'tools'; names: string[] }

/** 与桌面版一致：连续的工具调用合并为一组，思考和旁白各自成段。 */
function groupProcess(blocks: readonly ConversationShareBlock[]): ProcessItem[] {
  const items: ProcessItem[] = []

  for (const block of blocks) {
    const previous = items.at(-1)

    if (block.type === 'tool') {
      if (previous?.kind === 'tools') {
        previous.names.push(block.name || 'tool')
      } else {
        items.push({ kind: 'tools', names: [block.name || 'tool'] })
      }
    } else {
      items.push({ kind: block.type === 'reasoning' ? 'reasoning' : 'text', text: block.text || '' })
    }
  }

  return items
}

/** 静态页的折叠行，对应桌面版的 ScaffoldRow：灰色小字标签加展开箭头，默认收起。 */
function Disclosure({ label, children }: { label: string; children: ReactNode }) {
  return (
    <details>
      <summary className={cn(SCAFFOLD_LABEL_CLASS, 'flex w-fit items-center gap-1.5 text-(--ui-text-tertiary)')}>
        <span>{label}</span>
        <ChevronRight aria-hidden="true" className="share-chevron" style={{ width: 12, height: 12, flexShrink: 0 }} />
      </summary>
      <div className="mt-1 flex min-w-0 flex-col gap-1">{children}</div>
    </details>
  )
}

function ToolLine({ label }: { label: string }) {
  return (
    <div className={cn(SCAFFOLD_LABEL_CLASS, 'flex min-w-0 items-center gap-1.5 text-(--ui-text-tertiary)')}>
      <Wrench aria-hidden="true" style={{ width: 12, height: 12, flexShrink: 0 }} />
      <span className="min-w-0 truncate">{label}</span>
    </div>
  )
}

/** 过程逐段对齐桌面版：旁白正常显示，思考收为「已思考」，多次工具调用收为一行摘要。 */
function ProcessItemView({ item, renderMarkdown }: { item: ProcessItem; renderMarkdown: (text: string) => ReactNode }) {
  if (item.kind === 'text') {
    return <div className="min-w-0">{renderMarkdown(item.text)}</div>
  }

  if (item.kind === 'reasoning') {
    return (
      <Disclosure label={translateNow('assistant.thread.thought')}>
        {/* 与桌面版思考正文一致的弱化透明度。 */}
        <div className="min-w-0" style={{ opacity: 0.67 }}>
          {renderMarkdown(item.text)}
        </div>
      </Disclosure>
    )
  }

  // 快照只保存已结束调用的名称，不含参数和输出；空结果表示已完成，避免被读作「结果不可用」。
  const summary = (names: readonly string[]) =>
    summarizeToolRun(
      names.map(toolName => ({ toolName, result: '' })),
      false
    )

  if (item.names.length === 1) {
    return <ToolLine label={summary(item.names)} />
  }

  return (
    <Disclosure label={summary(item.names)}>
      {item.names.map((name, index) => (
        <ToolLine key={index} label={summary([name])} />
      ))}
    </Disclosure>
  )
}

function AssistantTurn({
  message,
  source,
  renderMarkdown
}: {
  message: ShareMessage
  source: ConversationShareDocument
  renderMarkdown: (text: string) => ReactNode
}) {
  const label = processLabel(source.locale, message.durationS)
  const process = groupProcess(message.process ?? [])

  return (
    <article className="flex min-w-0 flex-col gap-1">
      {process.length > 0 ? (
        <details>
          <summary className="flex w-fit items-center gap-1.5 py-2 text-xs font-medium text-muted-foreground">
            <span>{label}</span>
            <ChevronRight aria-hidden="true" className="share-chevron" style={{ width: 14, height: 14 }} />
          </summary>
          <div className="mb-2 flex flex-col gap-3">
            {process.map((item, index) => (
              <ProcessItemView item={item} key={index} renderMarkdown={renderMarkdown} />
            ))}
          </div>
        </details>
      ) : message.durationS !== undefined ? (
        <div className="flex w-fit items-center gap-1.5 py-2 text-xs font-medium text-muted-foreground">
          <Clock aria-hidden="true" style={{ width: 14, height: 14 }} />
          {label}
        </div>
      ) : null}
      {message.blocks.map((block, index) => (
        <div className="min-w-0" key={index}>
          {renderMarkdown(block.text || '')}
        </div>
      ))}
    </article>
  )
}

/** 静态页面按桌面版聊天的版式呈现：用户消息为右侧气泡，回复正文直接展开，过程折叠。 */
export function ConversationSharePage({ source, labels, renderMarkdown }: ConversationSharePageProps) {
  const dark = source.theme === 'dark'

  return (
    <main
      className="share-page"
      lang={source.locale}
      style={{
        background: 'var(--ui-chat-surface-background)',
        color: 'var(--foreground)',
        padding: '32px',
        fontFamily: 'var(--dt-font-sans)',
        fontSize: 15,
        maxWidth: '860px'
      }}
    >
      <header className="mb-8 flex flex-col gap-5 border-b border-border pb-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <img
            alt="元景数字员工"
            data-share-image-source={brandLogo}
            style={{
              width: 160,
              height: 28,
              objectFit: 'cover',
              flexShrink: 0,
              filter: dark ? 'brightness(0) invert(1)' : undefined
            }}
          />
          <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-3 py-1 text-xs text-muted-foreground">
            <Lock aria-hidden="true" style={{ width: 12, height: 12 }} />
            {labels.readonly}
          </span>
        </div>
        <h1 className="m-0 text-xl font-semibold tracking-tight" style={{ overflowWrap: 'anywhere' }}>
          {source.title}
        </h1>
      </header>
      <div className="flex flex-col gap-6">
        {source.messages.map((message, index) =>
          message.role === 'user' ? (
            <div className="flex justify-end" key={index}>
              <div
                className="flex min-w-0 flex-col gap-2 text-foreground"
                style={{
                  maxWidth: '80%',
                  background: dark ? USER_BUBBLE.dark : USER_BUBBLE.light,
                  borderRadius: '20px 20px 0 20px',
                  padding: '12px 16px'
                }}
              >
                {message.blocks.map((block, part) => (
                  <div className="min-w-0" key={part}>
                    {renderMarkdown(block.text || '')}
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <AssistantTurn key={index} message={message} renderMarkdown={renderMarkdown} source={source} />
          )
        )}
      </div>
    </main>
  )
}
