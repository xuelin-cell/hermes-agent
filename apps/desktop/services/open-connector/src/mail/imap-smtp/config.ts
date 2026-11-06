export const mailImapPort: number = 993;
export const mailSmtpPort: number = 465;
export const mailMessageFetchByteLimit: number = 5 * 1024 * 1024;
export const mailAttachmentDownloadByteLimit: number = 25 * 1024 * 1024;
export const mailConnectionTimeoutMs: number = 30_000;

/**
 * Hard cap for one credential-validation phase (IMAP or SMTP connect).
 *
 * Validation is the synchronous part of the mailbox-enable flow (the backend
 * saves the credential, which runs IMAP + SMTP validation in sequence), so it
 * must fail before the caller's budget runs out: 90s + 90s < the backend's 240s
 * request timeout. Data operations (fetch/send/
 * attachments) keep using mailConnectionTimeoutMs.
 */
export const mailValidationTimeoutMs: number = 90_000;
