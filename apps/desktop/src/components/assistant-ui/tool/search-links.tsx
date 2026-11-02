import { PrettyLink } from '@/lib/external-link'
import { Globe } from '@/lib/icons'

import type { SearchResultRow, ToolPart } from './fallback-model'
import { buildToolView } from './fallback-model'

export function SearchLinks({ hits }: { hits: SearchResultRow[] }) {
  return (
    <ol className="m-0 grid list-none gap-1 rounded-2xl bg-foreground/5 p-3" data-slot="web-search-links">
      {hits.map((hit, index) => (
        <li
          className="flex min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-foreground/5"
          key={`${hit.url}-${index}`}
        >
          <Globe aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
          {hit.url ? (
            <PrettyLink
              className="min-w-0 truncate text-sm text-foreground/85"
              fallbackLabel={hit.url}
              href={hit.url}
              label={hit.title || undefined}
            />
          ) : (
            <span className="truncate text-sm">{hit.title}</span>
          )}
        </li>
      ))}
    </ol>
  )
}

export function SearchSources({ parts }: { parts: ToolPart[] }) {
  return parts.map(part => {
    const view = buildToolView(part, '')

    if (!view.searchHits?.length) {
      return null
    }

    return (
      <details className="min-w-0 text-sm" data-slot="web-search-sources" key={part.toolCallId}>
        <summary className="cursor-pointer py-2 text-muted-foreground">
          <Globe aria-hidden="true" className="mr-2 inline size-4" />
          {view.searchQuery || view.title}
        </summary>
        <SearchLinks hits={view.searchHits} />
      </details>
    )
  })
}
