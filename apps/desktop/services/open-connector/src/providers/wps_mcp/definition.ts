import type { ProviderDefinition } from "../../core/types.ts";

import { wpsMcpActions } from "./actions.ts";

// Browser polling sessions require a long-running process.
export const nodeOnly = true;

export const provider: ProviderDefinition = {
  service: "wps_mcp",
  displayName: "WPS Cloud Documents",
  description:
    "Search, read, create, and edit Kingsoft documents through the official Skill Hub MCP service after browser authorization.",
  categories: ["Productivity", "Storage"],
  authTypes: ["custom_credential"],
  auth: [
    {
      type: "custom_credential",
      interaction: "browser_poll",
      fields: [
        { key: "token", label: "Authorization token", inputType: "password", required: true, secret: true },
        { key: "expiresAt", label: "Token expiration", inputType: "text", required: true, secret: false },
        { key: "clientId", label: "Installation ID", inputType: "text", required: true, secret: false },
        { key: "skillVersion", label: "Skill version", inputType: "text", required: true, secret: false },
      ],
    },
  ],
  homepageUrl: "https://www.wps.cn",
  actions: wpsMcpActions,
};
