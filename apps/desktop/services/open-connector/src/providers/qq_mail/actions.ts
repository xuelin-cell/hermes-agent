import type { ProviderActionDefinition } from "../../core/provider-definition.ts";
import type { MailActionName } from "../../mail/imap-smtp/actions.ts";

import { createMailActions } from "../../mail/imap-smtp/actions.ts";

export const qqMailActions: readonly ProviderActionDefinition<MailActionName>[] = createMailActions(
  "qq_mail",
  "QQ Mail",
);
