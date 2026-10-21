import type { MailCredential } from "../../mail/imap-smtp/protocol.ts";
import type { MailRuntimeConfig } from "../../mail/imap-smtp/runtime.ts";

import { ProviderRequestError } from "../provider-runtime.ts";

export const woMailRuntimeConfig: MailRuntimeConfig = {
  service: "wo_mail",
  displayName: "Wo Mail",
  attachmentFallbackPrefix: "wo-mail",
  saveSentCopy: true,
  connectAuthMessage:
    "Verify that Wo Mail IMAP/SMTP service is enabled and use the mailbox authorization code or application password instead of the web login password.",
  readCredential(values): MailCredential {
    const email = values.email?.trim() ?? "";
    const authorizationCode = values.authorizationCode?.trim() ?? "";

    const parts = email.split("@");
    const hasWhitespace = [...email].some((character) => character.trim().length === 0);
    if (parts.length !== 2 || !parts[0] || !parts[1] || hasWhitespace) {
      throw new ProviderRequestError(400, "Wo Mail email must be a valid email address.");
    }
    if (!authorizationCode) {
      throw new ProviderRequestError(400, "Wo Mail authorization code must not be empty.");
    }

    return {
      email,
      authorizationCode,
      imapHost: "imap.wo.cn",
      smtpHost: "smtp.wo.cn",
      smtpPort: 465,
    };
  },
};
