import type { CredentialValidators, ProviderExecutors, ProviderProxyExecutor } from "../../core/types.ts";
import type { OAuthProviderContext, ProviderActionHandlers } from "../provider-runtime.ts";

import { defineOAuthProviderExecutors, defineProviderProxy, mapProviderActionHandlers } from "../provider-runtime.ts";
import { ifindMcpActions } from "./actions.ts";
import { callTool, discoverAccessibleTools, listTools } from "./runtime.ts";

const service = "ifind_mcp";
type IfindMcpHandler = (input: Record<string, unknown>, context: OAuthProviderContext) => Promise<unknown>;

const handlers: ProviderActionHandlers<"ifind_mcp", IfindMcpHandler> = mapProviderActionHandlers(
  service,
  ifindMcpActions,
  (_action, name): IfindMcpHandler => {
    if (name === "list_tools") {
      return (input, context) => listTools(String(input.serverType) as Parameters<typeof listTools>[0], context);
    }
    return (input, context) => callTool(input, context);
  },
);

export const executors: ProviderExecutors = defineOAuthProviderExecutors(service, handlers);

export const credentialValidators: CredentialValidators = {
  async oauth2(input, { fetcher, signal }) {
    const discovered = await discoverAccessibleTools({ accessToken: input.accessToken, fetcher, signal });
    const bytes = new TextEncoder().encode(input.accessToken);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const keyHash = Array.from(new Uint8Array(digest))
      .slice(0, 8)
      .map((value) => value.toString(16).padStart(2, "0"))
      .join("");
    return {
      profile: {
        accountId: input.profile?.accountId ?? `ifind_mcp:mcp:${keyHash}`,
        displayName: input.profile?.displayName ?? `同花顺 iFinD · ${keyHash.slice(-6)}`,
      },
      grantedScopes: [],
      metadata: {
        mcpOrigin: "https://api-mcp.51ifind.com:8643",
        validationServerType: discovered.serverType,
        discoveredToolCount: discovered.tools.length,
      },
    };
  },
};

export const proxy: ProviderProxyExecutor = defineProviderProxy({
  service,
  baseUrl: "https://api-mcp.51ifind.com:8643",
  auth: { type: "oauth_bearer" },
  skipDnsValidation: true,
  customizeRequest({ headers }) {
    if (!headers.has("accept")) headers.set("accept", "application/json, text/event-stream");
    if (!headers.has("content-type")) headers.set("content-type", "application/json");
  },
});
