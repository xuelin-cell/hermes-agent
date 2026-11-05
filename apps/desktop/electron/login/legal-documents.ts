export const LOGIN_LEGAL_DOCUMENTS = {
  privacy: 'https://www.yjworker.10010.com/app/uniwork/uniwork-privacy.html',
  service: 'https://www.yjworker.10010.com/app/uniwork/uniwork-service.html'
} as const

export type LoginLegalDocument = keyof typeof LOGIN_LEGAL_DOCUMENTS
