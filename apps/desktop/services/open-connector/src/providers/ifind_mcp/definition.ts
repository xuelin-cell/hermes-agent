import type { ProviderDefinition } from "../../core/types.ts";

import { ifindMcpActions } from "./actions.ts";

// RFC 8707 resource indicator approved on the iFinD OAuth server. It travels
// with the authorization request, the code exchange and every token refresh so
// the issued access token is bound to the iFinD MCP resource audience.
const ifindMcpResource = "https://api-mcp.51ifind.com:8643/ds-mcp-servers/hexin-ifind-financial-mcp";

export const provider: ProviderDefinition = {
  service: "ifind_mcp",
  displayName: "同花顺 iFinD",
  categories: ["Finance", "Data"],
  authTypes: ["oauth2"],
  auth: [
    {
      type: "oauth2",
      authorizationUrl: "https://upass.10jqka.com.cn/oidc/ifcwb/authorize",
      tokenUrl: "https://upass.10jqka.com.cn/oidc/ifcwb/token",
      refreshTokenUrl: "https://upass.10jqka.com.cn/oidc/ifcwb/token",
      scopes: ["openid", "base_userinfo", "offline_access", "ca:goods.ver.r"],
      tokenEndpointAuthMethod: "none",
      pkce: { method: "S256" },
      // Pre-registered public client (Authorization Code + PKCE S256): the
      // issuer allows loopback callback URLs per RFC 8252, so the runtime
      // ships this built-in client and no dynamic registration is needed.
      defaultClientConfig: { clientId: "upoc_f572ssz_ltif_prod" },
      authorizationParams: { resource: ifindMcpResource },
      tokenParams: { resource: ifindMcpResource },
      clientSetup: {
        docsUrl: "https://upass.10jqka.com.cn/oidc/ifcwb/.well-known/oauth-authorization-server",
        steps: [
          "iFinD uses the Yuanjing Digital Employee OAuth public client for this local runtime.",
          "The client allows loopback callback URLs (http://127.0.0.1:<port>/oauth/callback); the port may change on every launch.",
          "After signing in, one grant covers the iFinD MCP resource.",
        ],
      },
    },
  ],
  homepageUrl: "https://mcp.51ifind.com/",
  actions: ifindMcpActions,
};
