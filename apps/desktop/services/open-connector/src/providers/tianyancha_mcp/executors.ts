import type { CredentialValidators, ProviderExecutors } from "../../core/types.ts";
import type { Client } from "@modelcontextprotocol/client";
import type { OAuthProviderContext, ProviderActionHandlers, ProviderRuntimeHandler } from "../provider-runtime.ts";
import { ProtocolError, SdkHttpError, UnauthorizedError } from "@modelcontextprotocol/client";
import { createHash } from "node:crypto";
import { optionalRecord, requiredString } from "../../core/cast.ts";
import { withMcpClient } from "../mcp-client.ts";
import { defineOAuthProviderExecutors, providerInputError, providerUserAgent, ProviderRequestError } from "../provider-runtime.ts";

const service = "tianyancha_mcp";
const endpoint = new URL("https://mcp.tianyancha.com/mcp");
const timeout = 60_000;
async function withClient<T>(context: Pick<OAuthProviderContext, "accessToken" | "fetcher" | "signal">, run: (client: Client) => Promise<T>): Promise<T> {
  return withMcpClient({ endpoint, transport: "streamable_http", fetcher: context.fetcher, headers: new Headers({ authorization: `Bearer ${context.accessToken}`, "user-agent": providerUserAgent }), signal: context.signal, mapError }, run);
}
export const tianyanchaMcpActionHandlers: ProviderActionHandlers<"tianyancha_mcp", ProviderRuntimeHandler<OAuthProviderContext>> = {
  async list_tools(_input, context) { return { tools: (await withClient(context, client => client.listTools({}, { timeout, signal: context.signal }))).tools }; },
  async call_tool(input, context) {
    const toolName = requiredString(input.toolName, "toolName", providerInputError);
    const result = await withClient(context, client => client.callTool({ name: toolName, arguments: optionalRecord(input.arguments) ?? {} }, { timeout, signal: context.signal }));
    if (!("toolResult" in result) && result.isError) throw new ProviderRequestError(502, `Tianyancha MCP tool ${toolName} returned an error`, result);
    return { result };
  },
};
export const executors: ProviderExecutors = defineOAuthProviderExecutors(service, tianyanchaMcpActionHandlers, { skipDnsValidation: true });
export const credentialValidators: CredentialValidators = {
  async oauth2(input, { fetcher, signal }) {
    const result = await withClient({ accessToken: input.accessToken, fetcher, signal }, client => client.listTools({}, { timeout, signal }));
    if (!result.tools.length) throw providerInputError("Tianyancha MCP did not expose any tools");
    const hash = createHash("sha256").update(input.accessToken).digest("hex").slice(0, 16);
    return { profile: { accountId: `tianyancha-mcp:${hash}`, displayName: `Tianyancha MCP - ${hash.slice(-6)}` }, grantedScopes: ["mcp:tools.call", "mcp:quota.read"], metadata: { mcpEndpoint: endpoint.href, discoveredToolCount: result.tools.length } };
  },
};
function mapError(error: unknown): ProviderRequestError {
  if (error instanceof ProviderRequestError) return error;
  if (error instanceof UnauthorizedError) return new ProviderRequestError(401, "Tianyancha MCP credential is invalid or expired", error);
  if (error instanceof SdkHttpError) return new ProviderRequestError(error.status === 401 || error.status === 403 ? 401 : error.status && error.status >= 400 && error.status < 500 ? 400 : 502, `Tianyancha MCP request failed: ${error.message}`, error);
  return new ProviderRequestError(502, error instanceof ProtocolError || error instanceof Error ? `Tianyancha MCP request failed: ${error.message}` : "Tianyancha MCP request failed", error);
}
