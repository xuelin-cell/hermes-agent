import { useValue } from '@hermes/plugin-sdk'
import { useEffect } from 'react'

import { $expertAvatars, loadAvatar } from './experts-store'
import type { ExpertCard } from './types'

interface ExpertFaceProps {
  expert: ExpertCard
  size?: number
}

/** The expert's avatar as the Bots list shows it, else its first character. */
export function ExpertFace({ expert, size = 28 }: ExpertFaceProps) {
  const avatars = useValue($expertAvatars)
  const image = avatars[expert.name]

  useEffect(() => {
    loadAvatar(expert.name)
  }, [expert.name])

  if (image) {
    return (
      <img
        alt=""
        aria-hidden
        className="shrink-0 object-cover"
        src={image}
        style={{ borderRadius: '22%', height: size, width: size }}
      />
    )
  }

  return (
    <span
      aria-hidden
      className="grid shrink-0 place-items-center bg-(--ui-bg-tertiary) font-medium text-(--ui-text-secondary)"
      style={{ borderRadius: '22%', fontSize: size * 0.45, height: size, width: size }}
    >
      {Array.from(expert.display_name)[0] ?? '?'}
    </span>
  )
}
