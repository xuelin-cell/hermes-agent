import type { ProviderDefinition } from "../../core/types.ts";
import { tianyanchaMcpActions } from "./actions.ts";

const resource = "https://mcp.tianyancha.com/mcp";

export const provider: ProviderDefinition = {
  service: "tianyancha_mcp",
  displayName: "天眼查",
  description: "通过天眼查 MCP 查询企业工商、股权、风险、司法、投资和知识产权数据。",
  categories: ["Data", "Business"],
  authTypes: ["oauth2"],
  auth: [{
    type: "oauth2",
    authorizationUrl: "https://capi.tianyancha.com/oauth/authorize",
    tokenUrl: "https://capi.tianyancha.com/oauth/token",
    refreshTokenUrl: "https://capi.tianyancha.com/oauth/token",
    scopes: ["mcp:tools.call", "mcp:quota.read"],
    tokenEndpointAuthMethod: "none",
    pkce: { method: "S256" },
    authorizationParams: { resource },
    tokenParams: { resource },
    dynamicClientRegistration: {
      registrationUrl: "https://capi.tianyancha.com/oauth/register",
      clientName: "联通数智",
      tokenEndpointAuthMethod: "none",
    },
    clientSetup: {
      docsUrl: "https://capi.tianyancha.com/oauth/.well-known/oauth-authorization-server",
      steps: ["天眼查 MCP 使用 OAuth 2.0 和 PKCE S256。", "完成授权后，凭据仅保存在本地并用于天眼查 MCP。"],
    },
  }],
  homepageUrl: "https://www.tianyancha.com/ai/guide.md",
  actions: tianyanchaMcpActions,
};
