import type { ProviderActionDefinition } from "../../core/provider-definition.ts";
import type { MailActionName } from "../../mail/imap-smtp/actions.ts";

import { createMailActions } from "../../mail/imap-smtp/actions.ts";

export const woMailActions: readonly ProviderActionDefinition<MailActionName>[] = createMailActions(
  "wo_mail",
  "Wo Mail",
);
