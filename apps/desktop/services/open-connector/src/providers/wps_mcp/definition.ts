import type { ProviderDefinition } from "../../core/types.ts";

import { wpsMcpActions } from "./actions.ts";

export const provider: ProviderDefinition = {
  service: "wps_mcp",
  displayName: "WPS Cloud Documents",
  description: "Search, inspect, read, and organize WPS cloud files through the WPS OpenAPI V7 service.",
  categories: ["Productivity", "Storage"],
  authTypes: ["api_key"],
  auth: [
    {
      type: "api_key",
      label: "WPS Agent API Key",
      placeholder: "Paste your WPS Agent API Key (apik:...)",
      description:
        "Paste the Agent API Key from https://account.wps.cn/usercenter/agent-identity?isclient=false. OpenConnector exchanges it for a short-lived WPS OpenAPI access token automatically.",
    },
  ],
  homepageUrl: "https://www.wps.cn",
  actions: wpsMcpActions,
};
