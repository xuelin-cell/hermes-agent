import type { CredentialValidators, ProviderExecutors } from "../../core/types.ts";
import type { OAuthProviderContext, ProviderActionHandlers, ProviderRuntimeHandler } from "../provider-runtime.ts";
import type { QccMcpResourceKey } from "./resources.ts";
import type { Client } from "@modelcontextprotocol/client";

import { ProtocolError, SdkHttpError, UnauthorizedError } from "@modelcontextprotocol/client";
import { createHash } from "node:crypto";
import { optionalRecord, optionalString, requiredString } from "../../core/cast.ts";
import { withMcpClient } from "../mcp-client.ts";
import {
  defineOAuthProviderExecutors,
  providerInputError,
  providerUserAgent,
  ProviderRequestError,
} from "../provider-runtime.ts";
import { qccMcpEntryResource, qccMcpResourceKeys, qccMcpResources } from "./resources.ts";

const service = "qcc_mcp";
const requestTimeoutMs = 60_000;

function readResource(value: unknown): QccMcpResourceKey {
  const resource = optionalString(value) ?? qccMcpEntryResource;
  if (qccMcpResourceKeys.includes(resource as QccMcpResourceKey)) {
    return resource as QccMcpResourceKey;
  }
  throw providerInputError(`resource must be one of: ${qccMcpResourceKeys.join(", ")}`);
}

async function withQccMcpClient<T>(
  context: Pick<OAuthProviderContext, "accessToken" | "fetcher" | "signal">,
  resource: QccMcpResourceKey,
  run: (client: Client) => Promise<T>,
): Promise<T> {
  return withMcpClient(
    {
      endpoint: new URL(qccMcpResources[resource].endpoint),
      transport: "streamable_http",
      fetcher: context.fetcher,
      headers: new Headers({
        authorization: `Bearer ${context.accessToken}`,
        "user-agent": providerUserAgent,
      }),
      signal: context.signal,
      mapError: mapQccMcpError,
    },
    run,
  );
}

export const qccMcpActionHandlers: ProviderActionHandlers<"qcc_mcp", ProviderRuntimeHandler<OAuthProviderContext>> = {
  async list_tools(input, context) {
    const resource = readResource(input.resource);
    const result = await withQccMcpClient(context, resource, (client) =>
      client.listTools({}, { timeout: requestTimeoutMs, signal: context.signal }),
    );
    return { resource, tools: result.tools };
  },
  async call_tool(input, context) {
    const resource = readResource(input.resource);
    const toolName = requiredString(input.toolName, "toolName", providerInputError);
    const result = await withQccMcpClient(context, resource, (client) =>
      client.callTool(
        { name: toolName, arguments: optionalRecord(input.arguments) ?? {} },
        { timeout: requestTimeoutMs, signal: context.signal },
      ),
    );
    if (!("toolResult" in result) && result.isError) {
      throw new ProviderRequestError(502, `Qichacha MCP tool ${toolName} returned an error`, result);
    }
    return { resource, result };
  },
};

export const executors: ProviderExecutors = defineOAuthProviderExecutors(service, qccMcpActionHandlers, {
  skipDnsValidation: true,
});

export const credentialValidators: CredentialValidators = {
  async oauth2(input, { fetcher, signal }) {
    const result = await withQccMcpClient(
      { accessToken: input.accessToken, fetcher, signal },
      qccMcpEntryResource,
      (client) => client.listTools({}, { timeout: requestTimeoutMs, signal }),
    );
    if (result.tools.length === 0) throw providerInputError("Qichacha MCP did not expose any tools");
    const tokenHash = createHash("sha256").update(input.accessToken).digest("hex").slice(0, 16);
    return {
      profile: {
        accountId: `qcc-mcp:${tokenHash}`,
        displayName: `Qichacha MCP - ${tokenHash.slice(-6)}`,
      },
      grantedScopes: ["mcp:tools"],
      metadata: {
        entryResource: qccMcpResources[qccMcpEntryResource].endpoint,
        resources: Object.fromEntries(
          qccMcpResourceKeys.map((resource) => [resource, qccMcpResources[resource].endpoint]),
        ),
        discoveredToolCount: result.tools.length,
      },
    };
  },
};

function mapQccMcpError(error: unknown): ProviderRequestError {
  if (error instanceof ProviderRequestError) return error;
  if (error instanceof UnauthorizedError) {
    return new ProviderRequestError(401, "Qichacha MCP credential is invalid or expired", error);
  }
  if (error instanceof SdkHttpError) {
    const status = error.status;
    return new ProviderRequestError(
      status === 401 || status === 403 ? 401 : status && status >= 400 && status < 500 ? 400 : 502,
      `Qichacha MCP request failed: ${error.message}`,
      error,
    );
  }
  if (error instanceof ProtocolError) {
    return new ProviderRequestError(502, `Qichacha MCP request failed: ${error.message}`, error);
  }
  return new ProviderRequestError(
    502,
    error instanceof Error ? `Qichacha MCP request failed: ${error.message}` : "Qichacha MCP request failed",
    error,
  );
}
