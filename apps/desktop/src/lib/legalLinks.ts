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

/** Rendered in this order on the Privacy & terms page. Every document's file
 *  name carries the product prefix (`uniwork-`); the bare names 404. */
export const LEGAL_LINKS: readonly LegalLink[] = [
  { id: 'userAgreement', url: `${LEGAL_BASE}/uniwork-service.html` },
  { id: 'privacyPolicy', url: `${LEGAL_BASE}/uniwork-privacy.html` },
  { id: 'informationCollection', url: `${LEGAL_BASE}/uniwork-data-collection.html` },
  { id: 'accountCancellation', url: `${LEGAL_BASE}/uniwork-account-cancellation.html` },
  { id: 'deliveryAgreement', url: `${LEGAL_BASE}/uniwork-delivery.html` },
  { id: 'childrenPrivacy', url: `${LEGAL_BASE}/uniwork-children-privacy.html` },
  { id: 'openSourceTerms', url: `${LEGAL_BASE}/uniwork-open-source.html` }
]
