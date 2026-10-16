/**
 * Above the composer, while the chat on screen belongs to an expert.
 *
 * A fresh chat (a summon, or "+" in the expert's profile) gets 数字员工's
 * welcome: face, name, what it does and its quick prompts — clicking one puts
 * it in the input box. Once the chat exists it shrinks to one line naming the
 * expert, which stands in for 数字员工's per-reply signature. Either way the
 * user can go back to the general assistant (a new chat; see ./summon).
 */

import { host, usePluginI18n, useValue } from '@hermes/plugin-sdk'

import { ExpertFace } from './expert-face'
import { $expertDirectory } from './experts-store'
import { fillPrompt, leaveExpert } from './summon'
import { expertForProfile, quickPrompts } from './summon-model'

export function ExpertBar() {
  const t = usePluginI18n('uniwork-kits')
  const directory = useValue($expertDirectory)
  const profile = useValue(host.state.focusedSessionProfile)
  const sessionId = useValue(host.state.focusedSessionId)
  const expert = expertForProfile(directory, profile)

  if (!expert) {
    return null
  }

  const leave = (
    <button
      className="shrink-0 text-xs text-(--ui-text-tertiary) underline-offset-2 hover:underline"
      onClick={leaveExpert}
      type="button"
    >
      {t('leaveExpert')}
    </button>
  )

  if (sessionId) {
    return (
      <div
        className="flex items-center gap-2 px-3 pt-1.5 pb-0.5 text-xs text-(--ui-text-tertiary)"
        data-slot="uniwork_expert_bar"
      >
        <ExpertFace expert={expert} size={18} />
        <span className="min-w-0 flex-1 truncate">
          {t('talkingTo')}
          <span className="text-(--ui-text-secondary)">{expert.display_name}</span>
          {expert.profession && expert.profession !== expert.display_name ? ` · ${expert.profession}` : ''}
        </span>
        {leave}
      </div>
    )
  }

  const prompts = quickPrompts(expert)

  return (
    <div
      className="mx-2 mt-2 mb-1 rounded-lg border border-(--ui-stroke-secondary) px-3 py-2.5"
      data-slot="uniwork_expert_welcome"
    >
      <div className="flex items-start gap-3">
        <ExpertFace expert={expert} size={40} />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="truncate text-sm font-medium text-(--ui-text-primary)">{expert.display_name}</span>
            {expert.profession && expert.profession !== expert.display_name ? (
              <span className="truncate text-xs text-(--ui-text-tertiary)">{expert.profession}</span>
            ) : null}
          </div>
          {expert.description ? (
            <p
              className="m-0 mt-0.5 line-clamp-2 text-xs leading-5 text-(--ui-text-secondary)"
              title={expert.description}
            >
              {expert.description}
            </p>
          ) : null}
        </div>
        {leave}
      </div>
      {prompts.length ? (
        <div className="mt-2">
          <p className="m-0 mb-1 text-[0.7rem] text-(--ui-text-tertiary)">{t('tryAsking')}</p>
          <div className="grid gap-1.5 sm:grid-cols-3">
            {prompts.map(prompt => (
              <button
                className="line-clamp-2 rounded-md border border-(--ui-stroke-secondary) px-2 py-1.5 text-left text-xs leading-5 text-(--ui-text-secondary) hover:bg-(--ui-bg-tertiary)"
                key={prompt}
                onClick={() => fillPrompt(prompt)}
                title={prompt}
                type="button"
              >
                {prompt}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  )
}
