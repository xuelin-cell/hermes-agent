import type { CredentialValidators, ProviderExecutors } from "../../core/types.ts";
import type { OAuthProviderContext, ProviderActionHandlers, ProviderRuntimeHandler } from "../provider-runtime.ts";
import type { Client } from "@modelcontextprotocol/client";

import { ProtocolError, SdkHttpError, UnauthorizedError } from "@modelcontextprotocol/client";
import { createHash } from "node:crypto";
import { optionalRecord, requiredString } from "../../core/cast.ts";
import { withMcpClient } from "../mcp-client.ts";
import {
  defineOAuthProviderExecutors,
  providerInputError,
  providerUserAgent,
  ProviderRequestError,
} from "../provider-runtime.ts";

const service = "eastmoney_mcp";
const requestTimeoutMs = 180_000;
const eastmoneyMcpEndpoint = new URL("https://mxapi-stg.eastmoney.com/mxds/v2/mcp");

async function withEastmoneyMcpClient<T>(
  context: Pick<OAuthProviderContext, "accessToken" | "fetcher" | "signal">,
  run: (client: Client) => Promise<T>,
): Promise<T> {
  return withMcpClient(
    {
      endpoint: eastmoneyMcpEndpoint,
      transport: "streamable_http",
      fetcher: context.fetcher,
      headers: new Headers({
        authorization: `Bearer ${context.accessToken}`,
        "user-agent": providerUserAgent,
      }),
      signal: context.signal,
      mapError: mapEastmoneyMcpError,
    },
    run,
  );
}

export const eastmoneyMcpActionHandlers: ProviderActionHandlers<
  "eastmoney_mcp",
  ProviderRuntimeHandler<OAuthProviderContext>
> = {
  async list_tools(_input, context) {
    const result = await withEastmoneyMcpClient(context, (client) =>
      client.listTools({}, { timeout: requestTimeoutMs, signal: context.signal }),
    );
    return { tools: result.tools };
  },
  async call_tool(input, context) {
    const toolName = requiredString(input.toolName, "toolName", providerInputError);
    const result = await withEastmoneyMcpClient(context, (client) =>
      client.callTool(
        { name: toolName, arguments: optionalRecord(input.arguments) ?? {} },
        { timeout: requestTimeoutMs, signal: context.signal },
      ),
    );
    if (!("toolResult" in result) && result.isError) {
      throw new ProviderRequestError(502, `Eastmoney MCP tool ${toolName} returned an error`, result);
    }
    return { result };
  },
};

export const executors: ProviderExecutors = defineOAuthProviderExecutors(service, eastmoneyMcpActionHandlers, {
  skipDnsValidation: true,
});

export const credentialValidators: CredentialValidators = {
  async oauth2(input, { fetcher, signal }) {
    const result = await withEastmoneyMcpClient(
      { accessToken: input.accessToken, fetcher, signal },
      (client) => client.listTools({}, { timeout: requestTimeoutMs, signal }),
    );
    if (result.tools.length === 0) throw providerInputError("Eastmoney MCP did not expose any tools");
    const tokenHash = createHash("sha256").update(input.accessToken).digest("hex").slice(0, 16);
    return {
      profile: {
        accountId: `eastmoney-mcp:${tokenHash}`,
        displayName: `东方财富 MCP - ${tokenHash.slice(-6)}`,
      },
      grantedScopes: ["mcp:tools"],
      metadata: {
        mcpEndpoint: eastmoneyMcpEndpoint.href,
        discoveredToolCount: result.tools.length,
      },
    };
  },
};

function mapEastmoneyMcpError(error: unknown): ProviderRequestError {
  if (error instanceof ProviderRequestError) return error;
  if (error instanceof UnauthorizedError) {
    return new ProviderRequestError(401, "Eastmoney MCP credential is invalid or expired", error);
  }
  if (error instanceof SdkHttpError) {
    const status = error.status;
    return new ProviderRequestError(
      status === 401 || status === 403 ? 401 : status && status >= 400 && status < 500 ? 400 : 502,
      `Eastmoney MCP request failed: ${error.message}`,
      error,
    );
  }
  if (error instanceof ProtocolError) {
    return new ProviderRequestError(502, `Eastmoney MCP request failed: ${error.message}`, error);
  }
  return new ProviderRequestError(
    502,
    error instanceof Error ? `Eastmoney MCP request failed: ${error.message}` : "Eastmoney MCP request failed",
    error,
  );
}
