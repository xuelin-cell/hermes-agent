import type { ProfileScope, UniWorkSkill } from '@/hermes'
import { installUniWorkSkill } from '@/hermes'
import { confirm } from '@/store/confirm'

import type { useSkillsCopy } from './copy'

/** Approval only retries the reviewed package, never a different download. */
export async function installMarketSkillWithApproval(
  skill: UniWorkSkill,
  profile: ProfileScope | undefined,
  copy: ReturnType<typeof useSkillsCopy>
) {
  let result = await installUniWorkSkill(skill, profile)

  if (result.requires_confirmation && result.package_hash) {
    const approved = await confirm({
      title: copy('riskTitle'),
      description: copy('riskBody', skill.name),
      details: [{ label: copy('riskReport'), value: result.report ?? '' }],
      confirmLabel: copy('riskInstall'),
      cancelLabel: copy('cancel'),
      destructive: true
    })

    if (!approved) {
      return null
    }

    result = await installUniWorkSkill(skill, profile, result.package_hash)

    if (result.requires_confirmation) {
      throw new Error(copy('riskChanged'))
    }
  }

  return result
}
