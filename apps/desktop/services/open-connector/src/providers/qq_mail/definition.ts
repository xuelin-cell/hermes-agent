import type { ProviderDefinition } from "../../core/types.ts";

import { qqMailActions } from "./actions.ts";

export const nodeOnly = true;

const qqMailIconUrl =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 128 128'%3E%3Cdefs%3E%3ClinearGradient id='a' x1='28' y1='105' x2='101' y2='21' gradientUnits='userSpaceOnUse'%3E%3Cstop stop-color='%23ff7a00'/%3E%3Cstop offset='.55' stop-color='%23ffd400'/%3E%3Cstop offset='1' stop-color='%23bde900'/%3E%3C/linearGradient%3E%3C/defs%3E%3Ccircle cx='64' cy='64' r='48' fill='url(%23a)'/%3E%3Crect x='28' y='43' width='72' height='50' rx='6' fill='none' stroke='%23fff' stroke-width='8'/%3E%3Cpath d='M32 48l32 25 32-25' fill='none' stroke='%23fff' stroke-width='8' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E";

export const provider: ProviderDefinition = {
  service: "qq_mail",
  displayName: "QQ Mail",
  description:
    "Unavailable on Cloudflare Workers. QQ Mail requires IMAP/SMTP, so run this provider from the Node.js runtime.",
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
          placeholder: "user@qq.com",
          description: "The full QQ Mail address to connect, such as user@qq.com.",
        },
        {
          key: "authorizationCode",
          label: "Authorization Code",
          inputType: "password",
          required: true,
          secret: true,
          placeholder: "16-character code",
          description:
            "The 16-character QQ Mail authorization code from QQ Mail web settings > Account and Security after enabling POP3/IMAP/SMTP service: https://help.mail.qq.com/detail/0/1087. This is not the QQ Mail web login password.",
        },
      ],
      testAction: {
        actionName: "list_folders",
        input: {},
      },
    },
  ],
  homepageUrl: "https://mail.qq.com/",
  iconUrl: qqMailIconUrl,
  actions: qqMailActions,
};
