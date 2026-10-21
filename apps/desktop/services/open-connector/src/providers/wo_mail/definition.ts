import type { ProviderDefinition } from "../../core/types.ts";

import { woMailActions } from "./actions.ts";

export const nodeOnly = true;

export const provider: ProviderDefinition = {
  service: "wo_mail",
  displayName: "Wo Mail",
  description:
    "Unavailable on Cloudflare Workers. Wo Mail requires IMAP/SMTP, so run this provider from the Node.js runtime.",
  categories: ["Communication", "Productivity"],
  authTypes: ["custom_credential"],
  auth: [
    {
      type: "custom_credential",
      fields: [
        {
          key: "email",
          label: "Email Address",
          inputType: "text",
          required: true,
          secret: false,
          placeholder: "user@wo.cn",
          description: "The full Wo Mail mailbox address to connect, such as user@wo.cn.",
        },
        {
          key: "authorizationCode",
          label: "Authorization Code or Password",
          inputType: "password",
          required: true,
          secret: true,
          placeholder: "authorization code",
          description:
            "The Wo Mail mailbox authorization code or application password after enabling IMAP/SMTP. Prefer a revocable authorization code over the web login password.",
        },
      ],
      testAction: {
        actionName: "list_folders",
        input: {},
      },
    },
  ],
  homepageUrl: "https://mail.wo.cn/",
  actions: woMailActions,
};
