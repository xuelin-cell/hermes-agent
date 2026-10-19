import type { ProviderDefinition } from "../../core/types.ts";

import { wecomBotActions } from "./actions.ts";

const service = "wecom_bot";

/**
 * WeCom Bot provider for group webhooks and API-mode smart bots.
 */
export const provider: ProviderDefinition = {
  service,
  displayName: "WeCom Bot",
  description:
    "Send group webhook messages and use WeCom API-mode smart bot tools for contacts, chats, todos, meetings, schedules, documents, sheets, and smart pages.",
  categories: ["Communication", "Productivity"],
  authTypes: ["api_key", "custom_credential"],
  auth: [
    {
      type: "api_key",
      label: "Webhook Key",
      placeholder: "693a91f6-7xxx-4bc4-97a0-0ec2sifa5aaa",
      description:
        "Paste the key query value from the WeCom group bot webhook URL. The full webhook URL is also accepted. Create a group bot and copy its webhook URL from https://developer.work.weixin.qq.com/document/path/91770.",
    },
    {
      type: "custom_credential",
      fields: [
        {
          key: "botId",
          label: "Bot ID",
          inputType: "text",
          required: true,
          secret: false,
          placeholder: "Bot ID",
          description:
            "The Bot ID for a WeCom API-mode smart bot. Create the bot and copy its Bot ID from https://open.work.weixin.qq.com/help2/pc/cat?doc_id=21677.",
        },
        {
          key: "secret",
          label: "Secret",
          inputType: "password",
          required: true,
          secret: true,
          placeholder: "Bot Secret",
          description:
            "The Secret for the same WeCom API-mode smart bot. Copy it with the Bot ID from https://open.work.weixin.qq.com/help2/pc/cat?doc_id=21677.",
        },
      ],
    },
  ],
  homepageUrl: "https://work.weixin.qq.com",
  actions: wecomBotActions,
};
