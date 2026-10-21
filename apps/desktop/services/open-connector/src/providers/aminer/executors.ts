import type { CredentialValidators, ProviderExecutors } from "../../core/types.ts";
import type { McpHttpTransport } from "../mcp-client.ts";
import type { ApiKeyProviderContext, ProviderActionHandlers, ProviderRuntimeHandler } from "../provider-runtime.ts";
import type { Client } from "@modelcontextprotocol/client";

import { ProtocolError, SdkHttpError, SseError, UnauthorizedError } from "@modelcontextprotocol/client";
import { optionalInteger, optionalRecord, optionalString } from "../../core/cast.ts";
import { withMcpClient } from "../mcp-client.ts";
import {
  defineApiKeyProviderExecutors,
  isAbortLikeError,
  mapProviderActionHandlers,
  providerInputError,
  providerUserAgent,
  ProviderRequestError,
} from "../provider-runtime.ts";
import { aminerActions } from "./actions.ts";

const service = "aminer";
const aminerMcpEndpoint = new URL("https://mcp.aminer.cn/mcp");
const aminerMcpSseEndpoint = new URL("https://mcp.aminer.cn/sse");
const aminerValidationPaperId = "5c6eb520e1cd8ef8f9057b21";
const requestTimeoutMs = 60_000;
type AminerHandler = ProviderRuntimeHandler<ApiKeyProviderContext>;
type AminerMcpToolResult = Awaited<ReturnType<Client["callTool"]>>;

const handlers: ProviderActionHandlers<"aminer", AminerHandler> = mapProviderActionHandlers(
  service,
  aminerActions,
  (_action, name): AminerHandler =>
    (input, context) =>
      callAminerTool(name, input, context),
);

export const executors: ProviderExecutors = defineApiKeyProviderExecutors(service, handlers, {
  skipDnsValidation: true,
});

export const credentialValidators: CredentialValidators = {
  async apiKey(input, { fetcher, signal }) {
    const token = normalizeAminerToken(input.apiKey);
    let tools;
    try {
      tools = await validateAminerCredentials({ apiKey: token, fetcher, signal });
    } catch (error) {
      if (error instanceof ProviderRequestError && error.status === 401) {
        throw providerInputError("AMiner Auth Token is invalid or expired");
      }
      if (error instanceof ProviderRequestError && error.status === 403) {
        throw providerInputError("AMiner MCP access is disabled for this Auth Token");
      }
      throw error;
    }

    const availableNames = new Set(tools.map((tool) => tool.name));
    const missingNames = aminerActions.map((action) => action.name).filter((name) => !availableNames.has(name));
    if (missingNames.length > 0) {
      throw new ProviderRequestError(502, `AMiner MCP is missing documented tools: ${missingNames.join(", ")}`);
    }

    const bytes = new TextEncoder().encode(token);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const tokenHash = Array.from(new Uint8Array(digest))
      .slice(0, 8)
      .map((value) => value.toString(16).padStart(2, "0"))
      .join("");
    return {
      profile: {
        accountId: `aminer:mcp:${tokenHash}`,
        displayName: `AMiner 学术 · ${tokenHash.slice(-6)}`,
      },
      grantedScopes: [],
      metadata: {
        mcpEndpoint: aminerMcpEndpoint.href,
        mcpFallbackEndpoint: aminerMcpSseEndpoint.href,
        discoveredToolCount: tools.length,
      },
    };
  },
};

async function validateAminerCredentials(context: ApiKeyProviderContext): Promise<Array<{ name: string }>> {
  try {
    return await listAminerTools(context, aminerMcpEndpoint, "streamable_http");
  } catch (primaryError) {
    if (!shouldFallbackToSse(primaryError)) throw primaryError;

    try {
      return await withAminerTransport(context, aminerMcpSseEndpoint, "sse", async (client) => {
        const tools = await client.listTools({}, { timeout: requestTimeoutMs, signal: context.signal });
        const result = await client.callTool(
          { name: "get_paper_detail", arguments: { id: aminerValidationPaperId } },
          { timeout: requestTimeoutMs, signal: context.signal },
        );
        normalizeAminerResult("get_paper_detail", result);
        return tools.tools;
      });
    } catch (fallbackError) {
      if (isAminerBusinessError(fallbackError)) {
        throw fallbackError;
      }
      throw combinedAminerTransportError(primaryError, fallbackError);
    }
  }
}

async function listAminerTools(
  context: ApiKeyProviderContext,
  endpoint: URL,
  transport: McpHttpTransport,
): Promise<Array<{ name: string }>> {
  return withAminerTransport(context, endpoint, transport, async (client) => {
    const result = await client.listTools({}, { timeout: requestTimeoutMs, signal: context.signal });
    return result.tools;
  });
}

async function callAminerTool(
  toolName: string,
  input: Record<string, unknown>,
  context: ApiKeyProviderContext,
): Promise<unknown> {
  return withAminerClient(context, async (client) => {
    const result = await client.callTool(
      { name: toolName, arguments: input },
      { timeout: requestTimeoutMs, signal: context.signal },
    );
    return normalizeAminerResult(toolName, result);
  });
}

async function withAminerClient<T>(context: ApiKeyProviderContext, run: (client: Client) => Promise<T>): Promise<T> {
  try {
    return await withAminerTransport(context, aminerMcpEndpoint, "streamable_http", run);
  } catch (error) {
    if (!shouldFallbackToSse(error)) throw error;

    try {
      return await withAminerTransport(context, aminerMcpSseEndpoint, "sse", run);
    } catch (fallbackError) {
      if (isAminerBusinessError(fallbackError)) {
        throw fallbackError;
      }
      throw combinedAminerTransportError(error, fallbackError);
    }
  }
}

function withAminerTransport<T>(
  context: ApiKeyProviderContext,
  endpoint: URL,
  transport: McpHttpTransport,
  run: (client: Client) => Promise<T>,
): Promise<T> {
  return withMcpClient(
    {
      endpoint,
      transport,
      fetcher: context.fetcher,
      headers: new Headers({
        authorization: `Bearer ${normalizeAminerToken(context.apiKey)}`,
        "user-agent": providerUserAgent,
      }),
      signal: context.signal,
      mapError: mapAminerMcpError,
    },
    run,
  );
}

function normalizeAminerResult(toolName: string, result: AminerMcpToolResult): unknown {
  if ("toolResult" in result) return result;
  const payload = readAminerPayload(result);
  if (payload && isAminerErrorPayload(payload)) {
    throw mapAminerPayloadError(payload);
  }
  if (result.isError) {
    throw new ProviderRequestError(502, `AMiner MCP tool ${toolName} returned an error`, result);
  }
  return result.structuredContent ?? result;
}

function readAminerPayload(result: AminerMcpToolResult): Record<string, unknown> | undefined {
  const structuredPayload = optionalRecord(result.structuredContent);
  if (structuredPayload) return structuredPayload;

  const text = result.content.find((item) => item.type === "text");
  if (!text || text.type !== "text") return undefined;
  try {
    return optionalRecord(JSON.parse(text.text));
  } catch {
    return undefined;
  }
}

function isAminerErrorPayload(payload: Record<string, unknown>): boolean {
  const code = optionalInteger(payload.code);
  return (
    payload.success === false ||
    code === 40001 ||
    (code !== undefined && code >= 40301 && code <= 40308) ||
    code === 50001
  );
}

function mapAminerPayloadError(payload: Record<string, unknown>): ProviderRequestError {
  const code = optionalInteger(payload.code);
  const message = optionalString(payload.msg) ?? optionalString(payload.message) ?? "AMiner MCP tool returned an error";
  const status = isAminerQuotaError(message)
    ? 429
    : code === 40001
      ? 400
      : code === 40302 || code === 40307 || code === 40308
        ? 401
        : code === 40301
          ? 403
          : code === 40306
            ? 429
            : 502;
  return new ProviderRequestError(status, `AMiner MCP request failed: ${message}`, payload);
}

function isAminerQuotaError(message: string): boolean {
  return /余额不足|请充值|额度不足|insufficient\s+(?:balance|credit)|quota\s+(?:exceeded|exhausted)/iu.test(message);
}

function isAminerBusinessError(error: unknown): error is ProviderRequestError {
  return error instanceof ProviderRequestError && error.status >= 400 && error.status < 500;
}

function shouldFallbackToSse(error: unknown): boolean {
  return error instanceof ProviderRequestError && error.status === 502 && error.details instanceof Error;
}

function combinedAminerTransportError(primaryError: unknown, fallbackError: unknown): ProviderRequestError {
  const fallbackStatus = fallbackError instanceof ProviderRequestError ? fallbackError.status : 502;
  return new ProviderRequestError(
    fallbackStatus,
    "AMiner MCP connection failed over both streamable HTTP and SSE. Check the AMiner Auth Token or try again later.",
    {
      streamableHttp: describeAminerError(primaryError),
      sse: describeAminerError(fallbackError),
    },
  );
}

function describeAminerError(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown AMiner MCP error";
}

function normalizeAminerToken(value: string): string {
  const token = value.trim();
  return /^Bearer\s+/iu.test(token) ? token.replace(/^Bearer\s+/iu, "").trim() : token;
}

function mapAminerMcpError(error: unknown): ProviderRequestError {
  if (error instanceof ProviderRequestError) return error;
  if (error instanceof UnauthorizedError) {
    return new ProviderRequestError(401, "AMiner Auth Token is invalid or expired", error);
  }
  if (error instanceof SdkHttpError) {
    const status = error.status;
    return new ProviderRequestError(
      status === 401 || status === 403 ? 401 : status && status >= 400 && status < 500 ? 400 : 502,
      `AMiner MCP request failed: ${error.message}`,
      error,
    );
  }
  if (error instanceof SseError) {
    const status = error.code;
    return new ProviderRequestError(
      status === 401 || status === 403 ? 401 : status && status >= 400 && status < 500 ? 400 : 502,
      `AMiner MCP connection failed: ${error.message}`,
      error,
    );
  }
  if (error instanceof ProtocolError) {
    return new ProviderRequestError(502, `AMiner MCP request failed: ${error.message}`, error);
  }
  if (isAbortLikeError(error)) {
    return new ProviderRequestError(504, "AMiner MCP request timed out", error);
  }
  return new ProviderRequestError(
    502,
    error instanceof Error ? `AMiner MCP request failed: ${error.message}` : "AMiner MCP request failed",
    error,
  );
}
