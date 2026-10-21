import type { ProviderDefinition } from "../../core/types.ts";

import { qccMcpActions } from "./actions.ts";
import { qccMcpEntryResource, qccMcpResources } from "./resources.ts";

const scopes = ["mcp:tools"];
const entryResourceUrl = qccMcpResources[qccMcpEntryResource].endpoint;

export const provider: ProviderDefinition = {
  service: "qcc_mcp",
  displayName: "企查查",
  description:
    "连接企查查企业信息、风险、知识产权、经营和董监高服务。",
  categories: ["数据", "商业"],
  authTypes: ["oauth2"],
  auth: [
    {
      type: "oauth2",
      authorizationUrl: "https://agent.qcc.com/oauth/authorize",
      tokenUrl: "https://agent.qcc.com/oauth/token",
      refreshTokenUrl: "https://agent.qcc.com/oauth/token",
      scopes,
      tokenEndpointAuthMethod: "none",
      pkce: { method: "S256" },
      authorizationParams: {
        resource: entryResourceUrl,
      },
      tokenParams: {
        resource: entryResourceUrl,
      },
      dynamicClientRegistration: {
        registrationUrl: "https://agent.qcc.com/oauth/register",
        clientName: "元景数字员工",
        tokenEndpointAuthMethod: "none",
      },
      clientSetup: {
        docsUrl: "https://agent.qcc.com/.well-known/oauth-authorization-server",
        steps: [
          "Qichacha uses the Yuanjing Digital Employee OAuth client for this local runtime.",
          "Register this runtime's exact callback URL in the Qichacha OAuth app before signing in.",
          "After signing in, one grant can be used across the Qichacha resource set.",
        ],
      },
    },
  ],
  homepageUrl: "https://www.qcc.com",
  actions: qccMcpActions,
};
