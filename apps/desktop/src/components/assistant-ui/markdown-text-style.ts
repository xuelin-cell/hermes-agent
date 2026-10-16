import { cn } from '@/lib/utils'

// 聊天正文与会话分享共用排版样式，避免分享页面另起一套视觉规则。
export const MARKDOWN_CONTAINER_CLASS_NAME = cn(
  'aui-md prose w-full max-w-none overflow-hidden text-[length:var(--conversation-text-font-size)] leading-(--dt-line-height) text-foreground',
  'prose-p:leading-(--dt-line-height) prose-li:leading-(--dt-line-height)',
  'prose-headings:text-foreground prose-strong:text-foreground',
  // Typography styles `pre` as a dark slab: light text (`--tw-prose-pre-code`,
  // gray-200) on a dark bg. We strip its bg for our own light code card but its
  // near-white foreground survives — invisible under Shiki's opaque token
  // spans, but it's what un-highlighted text inherits (streaming delay,
  // Suspense fallback, budget-exceeded blocks): unreadable in light mode.
  'prose-pre:text-foreground',
  'prose-a:break-words prose-p:[overflow-wrap:anywhere]',
  'prose-li:marker:text-muted-foreground/70',
  'prose-code:rounded-[0.25rem] prose-code:px-[0.1875rem] prose-code:py-px prose-code:font-mono prose-code:text-[0.9em] prose-code:font-normal prose-code:before:content-none prose-code:after:content-none',
  '[&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&>*+*]:mt-(--paragraph-gap)'
)
