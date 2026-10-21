import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'

import { CompactMarkdown } from '@/components/chat/compact-markdown'
import { PageLoader } from '@/components/page-loader'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { getSkillContent, type ProfileScope, profileScopeKey } from '@/hermes'
import type { SkillInfo } from '@/types/hermes'

import { parseFrontmatter } from '../skills/frontmatter'

import { useSkillsCopy } from './copy'
import { SkillTile } from './skill-cards'

/** 已安装技能的详情：名称、简介和完整 SKILL.md 正文（只读）。 */
export function SkillDetailDialog({
  onClose,
  profile,
  skill
}: {
  onClose: () => void
  profile?: ProfileScope
  skill: SkillInfo | null
}) {
  const t = useSkillsCopy()

  const content = useQuery({
    enabled: Boolean(skill),
    queryKey: ['skill-content', skill?.name ?? '', profileScopeKey(profile)],
    queryFn: () => getSkillContent(skill!.name, profile),
    staleTime: 60_000
  })

  const body = useMemo(() => (content.data ? parseFrontmatter(content.data.content).body.trim() : ''), [content.data])

  return (
    <Dialog onOpenChange={open => !open && onClose()} open={Boolean(skill)}>
      <DialogContent className="max-h-[80vh] max-w-[44rem] overflow-hidden">
        {skill ? (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-3">
                <SkillTile name={skill.name} />
                <span className="min-w-0 truncate">{skill.name}</span>
              </DialogTitle>
              <DialogDescription>{skill.description || t('detailTitle')}</DialogDescription>
            </DialogHeader>
            <div className="min-h-0 overflow-y-auto pr-1" data-selectable-text="true">
              {content.isLoading ? (
                <PageLoader className="h-40" label={t('loading')} />
              ) : (
                <CompactMarkdown className="text-sm text-(--ui-text-secondary)" text={body || t('noBody')} />
              )}
            </div>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
