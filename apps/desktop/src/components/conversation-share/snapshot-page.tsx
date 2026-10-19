import type { ConversationShareDocument } from '@hermes/shared/conversation-share'
import type { ReactNode } from 'react'

import brandLogo from '@/assets/login-brand-logo.png?inline'
import { Brain, Lock, MessageCircle, Users, Wrench } from '@/lib/icons'

import type { SharePageLabels } from './snapshot-renderer'

interface ConversationSharePageProps {
  source: ConversationShareDocument
  labels: SharePageLabels
  renderMarkdown: (text: string) => ReactNode
}

/** 静态页面只借用聊天的视觉语义，不挂载依赖会话运行时的交互组件。 */
export function ConversationSharePage({ source, labels, renderMarkdown }: ConversationSharePageProps) {
  const messages: ConversationShareDocument['messages'] = []

  // 同一回复的思考、工具和正文在数据库中可分段保存，公开页只显示一次助手标识。
  for (const message of source.messages) {
    const previous = messages.at(-1)

    if (message.role === 'assistant' && previous?.role === 'assistant') {
      previous.blocks.push(...message.blocks)
    } else {
      messages.push({ ...message, blocks: [...message.blocks] })
    }
  }

  return (
    <main
      className="share-page"
      lang={source.locale}
      style={{
        background: 'var(--ui-chat-surface-background)',
        color: 'var(--foreground)',
        padding: '32px',
        fontFamily: 'var(--dt-font-sans)',
        maxWidth: '860px',
        minHeight: '100vh'
      }}
    >
      <header className="mb-8 flex flex-col gap-6 border-b border-border pb-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2 font-semibold text-foreground">
            <img
              alt="元景数字员工"
              data-share-image-source={brandLogo}
              style={{
                width: 160,
                height: 28,
                objectFit: 'cover',
                flexShrink: 0,
                filter: source.theme === 'dark' ? 'brightness(0) invert(1)' : undefined
              }}
            />
          </div>
          <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-3 py-1 text-xs text-muted-foreground">
            <Lock aria-hidden="true" style={{ width: 12, height: 12 }} />
            {labels.readonly}
          </span>
        </div>
        <h1 className="m-0 text-2xl font-semibold tracking-tight" style={{ overflowWrap: 'anywhere' }}>
          {source.title}
        </h1>
      </header>
      <div className="flex flex-col gap-8">
        {messages.map((message, index) => (
          <article className="share-message flex min-w-0 flex-col gap-3" key={index}>
            <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
              <span
                className="inline-flex items-center justify-center rounded-md"
                style={{
                  width: 24,
                  height: 24,
                  flexShrink: 0,
                  color: message.role === 'assistant' ? 'var(--dt-primary)' : 'var(--dt-muted-foreground)',
                  background:
                    message.role === 'assistant'
                      ? 'color-mix(in srgb, var(--dt-primary) 10%, transparent)'
                      : 'var(--dt-muted)'
                }}
              >
                {message.role === 'assistant' ? (
                  <MessageCircle aria-hidden="true" style={{ width: 14, height: 14 }} />
                ) : (
                  <Users aria-hidden="true" style={{ width: 14, height: 14 }} />
                )}
              </span>
              {message.role === 'user' ? labels.user : labels.assistant}
            </div>
            <div
              className={
                message.role === 'user'
                  ? 'flex min-w-0 flex-col gap-3 rounded-xl border border-border px-4 py-3'
                  : 'flex min-w-0 flex-col gap-3'
              }
              data-slot={message.role === 'assistant' ? 'aui_assistant-message-content' : undefined}
              style={message.role === 'user' ? { background: 'var(--dt-user-bubble)' } : undefined}
            >
              {message.blocks.map((block, part) =>
                block.type === 'tool' ? (
                  <div className="flex items-center gap-2 text-xs text-muted-foreground" key={part}>
                    <Wrench aria-hidden="true" style={{ width: 14, height: 14, flexShrink: 0 }} />
                    <span>{block.name}</span>
                  </div>
                ) : block.type === 'reasoning' ? (
                  <details className="rounded-lg bg-muted/40 px-3 py-2 text-sm text-muted-foreground" key={part}>
                    <summary>
                      <Brain
                        aria-hidden="true"
                        style={{ width: 14, height: 14, display: 'inline', verticalAlign: 'middle', marginRight: 6 }}
                      />
                      {labels.process}
                    </summary>
                    <div className="pt-3">{renderMarkdown(block.text || '')}</div>
                  </details>
                ) : (
                  <div className="min-w-0" key={part}>
                    {renderMarkdown(block.text || '')}
                  </div>
                )
              )}
            </div>
          </article>
        ))}
      </div>
    </main>
  )
}
