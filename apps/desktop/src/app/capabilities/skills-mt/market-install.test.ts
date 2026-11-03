import { beforeEach, expect, it, vi } from 'vitest'

import { installUniWorkSkill, type UniWorkSkill } from '@/hermes'
import { confirm } from '@/store/confirm'

import { type useSkillsCopy } from './copy'
import { installMarketSkillWithApproval } from './market-install'

vi.mock('@/hermes', () => ({ installUniWorkSkill: vi.fn() }))
vi.mock('@/store/confirm', () => ({ confirm: vi.fn() }))
const skill = { id: 'review', name: 'Review', download_url: 'https://example.test/package.zip' } as UniWorkSkill
const copy = ((key: string) => key) as ReturnType<typeof useSkillsCopy>
const review = { ok: false, requires_confirmation: true, package_hash: 'reviewed-hash', report: 'DANGEROUS: scan details' }
beforeEach(() => vi.resetAllMocks())

it('cancellation makes no second install request and keeps the scan report available for expansion', async () => {
  vi.mocked(installUniWorkSkill).mockResolvedValue(review)
  vi.mocked(confirm).mockResolvedValue(false)
  expect(await installMarketSkillWithApproval(skill, 'default', copy)).toBeNull()
  expect(installUniWorkSkill).toHaveBeenCalledTimes(1)
  expect(confirm).toHaveBeenCalledWith(expect.objectContaining({
    details: [expect.objectContaining({ value: review.report, expandLabel: 'riskDetails' })]
  }))
})

it('approves only the reviewed hash and stops when the downloaded package changes again', async () => {
  vi.mocked(installUniWorkSkill).mockResolvedValueOnce(review).mockResolvedValueOnce({ ...review, package_hash: 'changed' })
  vi.mocked(confirm).mockResolvedValue(true)
  await expect(installMarketSkillWithApproval(skill, 'default', copy)).rejects.toThrow('riskChanged')
  expect(installUniWorkSkill).toHaveBeenNthCalledWith(2, skill, 'default', 'reviewed-hash')
  expect(installUniWorkSkill).toHaveBeenCalledTimes(2)
})
