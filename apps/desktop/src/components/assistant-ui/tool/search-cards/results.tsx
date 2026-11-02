import './search-cards.css'

import { createContext, useContext, useMemo } from 'react'

import { RichBoundary } from '../../embeds/rich-boundary'

import { searchCards } from './result'

import { getCardComponent } from './index'

export const InlineSearchCardsVisible = createContext(true)

interface SearchCardResultsProps {
  results: readonly unknown[]
}

/** Result content remains visible when its process activity is folded away. */
/** 结果卡片与过程折叠独立，单卡错误在局部边界内消化。 */
export function SearchCardResults({ results }: SearchCardResultsProps) {
  const visible = useContext(InlineSearchCardsVisible)
  const cards = useMemo(() => results.flatMap(searchCards), [results])

  if (!visible || !cards.length) {
    return null
  }

  return (
    <div className="search-cards vrcard-list" data-search-cards="">
      {cards.map((card, index) => {
        const Component = getCardComponent(card.type)!

        return (
          <RichBoundary fallback={null} key={index} resetKey={JSON.stringify(card)}>
            <Component card={card} />
          </RichBoundary>
        )
      })}
    </div>
  )
}
