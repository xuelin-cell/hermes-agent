import type { OAuthProviderContext } from "../provider-runtime.ts";
import type { IfindMcpServerType } from "./actions.ts";
import type { Client } from "@modelcontextprotocol/client";

import { withMcpClient } from "../mcp-client.ts";
import { ProviderRequestError, providerUserAgent } from "../provider-runtime.ts";

const origin = "https://api-mcp.51ifind.com:8643";
const actionTimeoutMs = 28_000;
const validationTimeoutMs = 30_000;
const maxResponseBytes = 16 * 1024 * 1024;
const maxToolPages = 100;
const maxTools = 10_000;
const maxToolArgumentsBytes = 1_000_000;
const maxErrorMessageLength = 2_000;

export const serverTypes: readonly IfindMcpServerType[] = ["finance", "enterprise", "law"];

// OAuth tokens issued by upass.10jqka.com.cn carry an audience bound to the
// hexin-ifind-financial-mcp resource, and the iFinD gateway rejects them on
// any other path with "Gateway authentication failed" (401). The legacy
// per-service endpoints (hexin-ifind-ds-mcp / kuaicha-enterprise-mcp /
// hexin-law-mcp) only accept the retired personal api-key tokens, and no
// OAuth equivalents exist yet for the enterprise/law services. Keep every
// server type on the OAuth-bound endpoint until iFinD publishes the other
// resources.
const oauthBoundEndpoint = `${origin}/ds-mcp-servers/hexin-ifind-financial-mcp`;

const endpointByServerType: Record<IfindMcpServerType, string> = {
  finance: oauthBoundEndpoint,
  enterprise: oauthBoundEndpoint,
  law: oauthBoundEndpoint,
};

export interface DiscoveredTools {
  serverType: IfindMcpServerType;
  tools: unknown[];
}

export async function listTools(
  serverType: IfindMcpServerType,
  context: OAuthProviderContext,
): Promise<DiscoveredTools> {
  const tools = await runIfindRequest("execute", context.accessToken, () =>
    withClient(context, serverType, actionTimeoutMs, async (client) => {
      const output: unknown[] = [];
      const seenCursors = new Set<string>();
      let totalBytes = 0;
      let cursor: string | undefined;
      for (let page = 0; page < maxToolPages; page += 1) {
        const response = await client.listTools(cursor ? { cursor } : {}, { timeout: actionTimeoutMs });
        totalBytes += new TextEncoder().encode(JSON.stringify(response.tools)).byteLength;
        if (totalBytes > maxResponseBytes) {
          throw new ProviderRequestError(502, `iFinD MCP tool listing exceeds ${maxResponseBytes} bytes`);
        }
        output.push(...response.tools);
        if (output.length > maxTools) {
          throw new ProviderRequestError(502, `iFinD MCP exposed more than ${maxTools} tools`);
        }
        cursor = response.nextCursor;
        if (!cursor) return output;
        if (seenCursors.has(cursor)) {
          throw new ProviderRequestError(502, "iFinD MCP tool listing returned a repeated cursor");
        }
        seenCursors.add(cursor);
      }
      throw new ProviderRequestError(502, `iFinD MCP tool listing exceeded ${maxToolPages} pages`);
    }),
  );
  return { serverType, tools };
}

export async function callTool(
  input: Record<string, unknown>,
  context: OAuthProviderContext,
): Promise<{ result: unknown }> {
  const serverType = readServerType(input.serverType);
  const toolName = requireString(input.toolName, "toolName");
  const args = readArguments(input.arguments);
  assertArgumentBudget(args);

  const result = await runIfindRequest("execute", context.accessToken, () =>
    withClient(context, serverType, actionTimeoutMs, async (client) => {
      const response = await client.callTool({ name: toolName, arguments: args }, { timeout: actionTimeoutMs });
      if (response.isError) {
        const message = readToolErrorMessage(response) ?? `iFinD MCP tool ${toolName} returned an error`;
        throw new ProviderRequestError(502, message, response);
      }
      return transformIfindToolResult(response, context.accessToken);
    }),
  );
  return { result };
}

export async function discoverAccessibleTools(input: {
  accessToken: string;
  fetcher: typeof fetch;
  signal?: AbortSignal;
}): Promise<DiscoveredTools> {
  const deadline = Date.now() + validationTimeoutMs;
  const context: OAuthProviderContext = { accessToken: input.accessToken, fetcher: input.fetcher, signal: input.signal };
  let lastError: unknown;
  for (const serverType of serverTypes) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new ProviderRequestError(504, "iFinD MCP credential validation timed out");
    try {
      const tools = await runIfindRequest("validate", input.accessToken, () =>
        withClient(context, serverType, Math.max(1, Math.floor(remaining / 2)), async (client) => {
          const discovered: unknown[] = [];
          const seenCursors = new Set<string>();
          let totalBytes = 0;
          let cursor: string | undefined;
          for (let page = 0; page < maxToolPages; page += 1) {
            const response = await client.listTools(cursor ? { cursor } : {}, {
              timeout: Math.max(1, Math.floor(remaining / 2)),
            });
            totalBytes += new TextEncoder().encode(JSON.stringify(response.tools)).byteLength;
            if (totalBytes > maxResponseBytes) {
              throw new ProviderRequestError(502, `iFinD MCP tool listing exceeds ${maxResponseBytes} bytes`);
            }
            discovered.push(...response.tools);
            if (discovered.length > maxTools) {
              throw new ProviderRequestError(502, `iFinD MCP exposed more than ${maxTools} tools`);
            }
            cursor = response.nextCursor;
            if (!cursor) return discovered;
            if (seenCursors.has(cursor)) {
              throw new ProviderRequestError(502, "iFinD MCP tool listing returned a repeated cursor");
            }
            seenCursors.add(cursor);
          }
          throw new ProviderRequestError(502, `iFinD MCP tool listing exceeded ${maxToolPages} pages`);
        }),
      );
      return { serverType, tools };
    } catch (error) {
      if (error instanceof ProviderRequestError && (error.status === 401 || error.status === 403)) {
        lastError = error;
        continue;
      }
      throw error;
    }
  }
  throw lastError ?? new ProviderRequestError(403, "iFinD MCP credential validation found no accessible service");
}

async function withClient<T>(
  context: OAuthProviderContext,
  serverType: IfindMcpServerType,
  timeoutMs: number,
  run: (client: Client) => Promise<T>,
): Promise<T> {
  return withMcpClient(
    {
      endpoint: new URL(endpointByServerType[serverType]),
      transport: "streamable_http",
      fetcher: createLimitedFetch(context.fetcher),
      headers: { authorization: `Bearer ${context.accessToken}`, "user-agent": providerUserAgent },
      signal: context.signal,
      mapError: mapIfindMcpError,
    },
    run,
  );
}

function mapIfindMcpError(error: unknown): unknown {
  if (error instanceof ProviderRequestError) return error;
  const status = readErrorStatus(error);
  return new ProviderRequestError(
    status ?? 502,
    error instanceof Error ? `iFinD MCP request failed: ${error.message}` : "iFinD MCP request failed",
    error,
  );
}

function createLimitedFetch(fetcher: typeof fetch): typeof fetch {
  return async (request, init) => {
    const response = await fetcher(request, { ...init, redirect: "error" });
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel().catch(() => undefined);
      throw new ProviderRequestError(response.status, "iFinD MCP denied access to this service or tool");
    }
    const length = Number(response.headers.get("content-length"));
    if (Number.isFinite(length) && length > maxResponseBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw new ProviderRequestError(502, `iFinD MCP response exceeds ${maxResponseBytes} bytes`);
    }
    if (!response.body) return response;
    let received = 0;
    const body = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          received += chunk.byteLength;
          if (received > maxResponseBytes) {
            throw new ProviderRequestError(502, `iFinD MCP response exceeds ${maxResponseBytes} bytes`);
          }
          controller.enqueue(chunk);
        },
      }),
    );
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}

async function runIfindRequest<T>(phase: "validate" | "execute", accessToken: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    const source = error instanceof ProviderRequestError ? error : new ProviderRequestError(502, String(error), error);
    if (source.status === 401 || source.status === 403) {
      throw new ProviderRequestError(phase === "validate" ? 400 : 401, "iFinD token is invalid or expired", error);
    }
    const safeMessage = redactSecrets(source.message, accessToken).slice(0, maxErrorMessageLength);
    const classified = classifyIfindError(safeMessage, phase);
    if (classified) throw classified;
    if (source.status === 429) {
      throw new ProviderRequestError(429, safeMessage, { reason: "qps_limit", retryAfterSeconds: 5 });
    }
    throw new ProviderRequestError(source.status, safeMessage, source.details);
  }
}

function classifyIfindError(message: string, phase: "validate" | "execute"): ProviderRequestError | undefined {
  const normalized = message.toLowerCase();
  if (includesAny(normalized, ["令牌无效", "认证失败", "未授权", "unauthorized", "token invalid", "auth fail"])) {
    return new ProviderRequestError(phase === "validate" ? 400 : 401, "iFinD token is invalid or expired");
  }
  if (
    includesAny(normalized, [
      "请求次数超限",
      "daily limit",
      "daily quota",
      "并发",
      "concurrency",
      "请求过于频繁",
      "qps",
      "rate limit",
      "too frequent",
    ])
  )
    return new ProviderRequestError(429, message);
  if (includesAny(normalized, ["余额不足", "请先充值", "insufficient balance", "quota exceeded"]))
    return new ProviderRequestError(402, message);
  return undefined;
}

function transformIfindToolResult(result: unknown, accessToken: string): unknown {
  const cloned = structuredClone(result);
  const error = readEmbeddedIfindError(cloned, accessToken);
  if (error) throw new ProviderRequestError(502, error);
  return asRecord(cloned)?.structuredContent ?? cloned;
}

function readEmbeddedIfindError(result: unknown, accessToken: string): string | undefined {
  const record = asRecord(result);
  const content = Array.isArray(record?.content) ? record.content : [];
  const text = asRecord(content[0])?.text;
  const embedded = typeof text === "string" ? parseRecord(text) : record;
  if (!embedded) return undefined;
  const nested = asRecord(embedded.error);
  const nestedMessage = nested ? readMessage(nested.message) : undefined;
  if (nestedMessage) return redactSecrets(nestedMessage, accessToken).slice(0, maxErrorMessageLength);
  const code = Number(embedded.code ?? asRecord(embedded.data)?.code);
  if (Number.isFinite(code) && (code < 200 || code >= 300)) {
    const message = readMessage(embedded.message ?? asRecord(embedded.data)?.message);
    if (message) return redactSecrets(message, accessToken).slice(0, maxErrorMessageLength);
  }
  return undefined;
}

function readToolErrorMessage(result: unknown): string | undefined {
  const content = asRecord(result)?.content;
  if (!Array.isArray(content)) return undefined;
  return content.map((item) => asRecord(item)?.text).find((value): value is string => typeof value === "string");
}

function readArguments(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  const record = asRecord(value);
  if (!record) throw new ProviderRequestError(400, "arguments must be a JSON object");
  return record;
}

function assertArgumentBudget(value: Record<string, unknown>): void {
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > maxToolArgumentsBytes) {
    throw new ProviderRequestError(400, `arguments must not exceed ${maxToolArgumentsBytes} JSON bytes`);
  }
}

function readServerType(value: unknown): IfindMcpServerType {
  if (typeof value === "string" && serverTypes.includes(value as IfindMcpServerType)) {
    return value as IfindMcpServerType;
  }
  throw new ProviderRequestError(400, "serverType is invalid");
}

function requireString(value: unknown, field: string): string {
  if (typeof value === "string" && value.trim()) return value.trim();
  throw new ProviderRequestError(400, `${field} is required`);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function parseRecord(value: string): Record<string, unknown> | undefined {
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return undefined;
  }
}

function readMessage(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function includesAny(value: string, fragments: readonly string[]): boolean {
  return fragments.some((fragment) => value.includes(fragment));
}

function redactSecrets(message: string, accessToken: string): string {
  return message
    .replaceAll(accessToken, "[REDACTED]")
    .replace(/\bBearer\s+[^\s,;"']+/giu, "Bearer [REDACTED]")
    .replace(/\bAuthorization\s*[:=]\s*[^\s,;"']+/giu, "Authorization=[REDACTED]");
}

function readErrorStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const value = "code" in error ? error.code : "status" in error ? error.status : undefined;
  return typeof value === "number" ? value : undefined;
}
