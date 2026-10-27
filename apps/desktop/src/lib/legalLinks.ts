// Legal documents every UniWork desktop build links out to. The URLs live here
// only: a policy can be re-pointed in one place, and the settings page plus its
// palette row read the same list. Display names are i18n
// (`settings.legal.items.<id>`), so an id is the only contract between the two.
const LEGAL_BASE = 'https://www.yjworker.10010.com/app/uniwork'

export type LegalLinkId =
  | 'userAgreement'
  | 'privacyPolicy'
  | 'informationCollection'
  | 'accountCancellation'
  | 'deliveryAgreement'
  | 'childrenPrivacy'
  | 'openSourceTerms'

export interface LegalLink {
  id: LegalLinkId
  url: string
}

/** Rendered in this order on the Privacy & terms page. */
export const LEGAL_LINKS: readonly LegalLink[] = [
  { id: 'userAgreement', url: `${LEGAL_BASE}/service.html` },
  { id: 'privacyPolicy', url: `${LEGAL_BASE}/privacy.html` },
  { id: 'informationCollection', url: `${LEGAL_BASE}/data-collection.html` },
  { id: 'accountCancellation', url: `${LEGAL_BASE}/account-cancellation.html` },
  { id: 'deliveryAgreement', url: `${LEGAL_BASE}/delivery.html` },
  { id: 'childrenPrivacy', url: `${LEGAL_BASE}/children-privacy.html` },
  { id: 'openSourceTerms', url: `${LEGAL_BASE}/open-source.html` }
]
