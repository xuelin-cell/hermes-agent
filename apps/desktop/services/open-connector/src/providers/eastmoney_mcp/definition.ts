import type { ProviderDefinition } from "../../core/types.ts";

import { eastmoneyMcpActions } from "./actions.ts";

const scopes = ["mcp:tools"];
const eastmoneyMcpResource = "https://mxapi-stg.eastmoney.com/mxds/v2/mcp";

export const provider: ProviderDefinition = {
  service: "eastmoney_mcp",
  displayName: "东方财富",
  description:
    "连接东方财富妙想 MCP，基于 Choice 数据查询 A 股、基金、债券、指数、宏观、资讯公告和证券筛选等金融研究数据。",
  categories: ["Finance", "Data"],
  authTypes: ["oauth2"],
  auth: [
    {
      type: "oauth2",
      authorizationUrl: "https://mkcs.dfcfs.com/oauth/authorize",
      tokenUrl: "https://mkcs.dfcfs.com/oauth/token",
      refreshTokenUrl: "https://mkcs.dfcfs.com/oauth/token",
      scopes,
      tokenEndpointAuthMethod: "none",
      pkce: { method: "S256" },
      authorizationParams: {
        resource: eastmoneyMcpResource,
      },
      tokenParams: {
        resource: eastmoneyMcpResource,
      },
      dynamicClientRegistration: {
        registrationUrl: "https://mkcs.dfcfs.com/oauth/register",
        clientName: "联通元景数字员工",
        tokenEndpointAuthMethod: "none",
      },
      clientSetup: {
        docsUrl: "https://mkcs.dfcfs.com/.well-known/oauth-authorization-server",
        steps: [
          "Eastmoney supports OAuth 2.0 with PKCE S256 for this local runtime.",
          "The runtime opens the Eastmoney authorization page and stores the returned credential locally.",
          "After signing in, the grant can call the Eastmoney Choice-data MCP endpoint.",
        ],
      },
    },
  ],
  homepageUrl: "https://ai.eastmoney.com/mxmcp",
  actions: eastmoneyMcpActions,
};
