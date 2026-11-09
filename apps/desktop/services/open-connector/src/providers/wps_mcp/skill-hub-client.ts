import type { Client } from "@modelcontextprotocol/client";

import { ProtocolError } from "@modelcontextprotocol/client";
import { optionalRecord, optionalString, looseArray } from "../../core/cast.ts";
import { withMcpClient } from "../mcp-client.ts";
import { ProviderRequestError, readProviderJsonBody, runProviderRequest } from "../provider-runtime.ts";
import { getWpsSkillVersion } from "./skill-version.ts";

export const wpsMcpEndpoint = "https://mcp-center.wps.cn/skill_hub/mcp";
export const wpsExchangeEndpoint = "https://api.wps.cn/office/v5/ai/skill_hub/wps_auth/exchange";

export interface WpsMcpContext {
  values: Record<string, string>;
  fetcher: typeof fetch;
  signal?: AbortSignal;
}

const blockedUntil = new Map<string, number>();

export async function withWpsMcpClient<T>(context: WpsMcpContext, run: (client: Client) => Promise<T>): Promise<T> {
  const { token, clientId, expiresAt } = context.values;
  if (!token || !/^[0-9a-f]{16}$/.test(clientId ?? "") || !Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.now()) {
    throw new ProviderRequestError(401, "WPS authorization expired or is incomplete. Reauthorize WPS.", undefined, "reauthorization_required");
  }
  const key = await tokenDigest(token);
  if ((blockedUntil.get(key) ?? 0) > Date.now()) {
    throw new ProviderRequestError(429, "Kingsoft MCP requests are temporarily paused.");
  }
  blockedUntil.delete(key);
  let upstreamError: ProviderRequestError | undefined;
  const fetcher: typeof fetch = async (url, init) => {
    try {
      const response = await context.fetcher(url, init);
      if (response.status >= 500) throw new ProviderRequestError(response.status, `Kingsoft MCP returned HTTP ${response.status}.`);
      if (response.status === 401 || response.status === 403) {
        throw new ProviderRequestError(401, "WPS authorization expired. Reauthorize WPS.", undefined, "reauthorization_required");
      }
      const retryAt = retryAfter(response.headers.get("retry-after"));
      if (response.status === 429) pause(key, retryAt, false);
      if (response.headers.get("content-type")?.includes("application/json")) {
        inspectResult(await readProviderJsonBody(response.clone(), { emptyBody: {}, invalidJsonMessage: "Invalid Kingsoft MCP response" }), key, retryAt);
      }
      return response;
    } catch (error) {
      if (error instanceof ProviderRequestError) upstreamError = error;
      throw error;
    }
  };
  return runProviderRequest({ signal: context.signal, label: "Kingsoft MCP", timeoutMs: 60_000 }, async signal => {
    try {
      const result = await withMcpClient({
        endpoint: new URL(wpsMcpEndpoint), transport: "streamable_http", fetcher,
        headers: { Authorization: `Bearer ${token}`, "X-Request-Source": "liantong", "X-Skill-Version": getWpsSkillVersion(), "X-Client-Id": clientId }, signal,
      }, run);
      inspectResult(result, key, NaN);
      return result;
    } catch (error) {
      if (upstreamError) throw upstreamError;
      if (error instanceof ProviderRequestError) throw error;
      if (error instanceof ProtocolError && (error.code === -32601 || error.code === -32602)) {
        throw new ProviderRequestError(400, "Kingsoft MCP rejected the tool name or arguments. Use list_tools and get_tool_schema before retrying.", undefined, "invalid_tool_request");
      }
      if (signal.aborted) signal.throwIfAborted();
      throw new ProviderRequestError(502, "Kingsoft MCP transport or protocol failed.", undefined, "mcp_transport_error");
    }
  });
}

async function tokenDigest(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest)).map(byte => byte.toString(16).padStart(2, "0")).join("");
}

function retryAfter(value: string | null): number {
  return value && /^\d+(\.\d+)?$/.test(value) ? Date.now() + Number(value) * 1000 : value ? Date.parse(value) : NaN;
}

function pause(key: string, retryAt: number, circuit: boolean): never {
  const until = Number.isFinite(retryAt) && retryAt > Date.now() ? retryAt : circuit ? Infinity : Date.now() + 60_000;
  blockedUntil.set(key, until);
  throw new ProviderRequestError(429, circuit ? "Kingsoft MCP circuit is open; requests are paused." : "Kingsoft MCP rate limit reached; requests are paused.");
}

function inspectResult(value: unknown, key: string, retryAt: number, depth = 0): void {
  if (depth > 8) return;
  const record = optionalRecord(value);
  if (!record) return;
  const code = Number(record.code);
  if (code === 400006) throw new ProviderRequestError(401, "WPS authorization expired. Reauthorize WPS.", undefined, "reauthorization_required");
  if (code === 429001 || code === 429002) {
    const seconds = Number(optionalRecord(record.data)?.retry_after ?? record.retry_after);
    pause(key, Number.isFinite(seconds) && seconds > 0 ? Date.now() + seconds * 1000 : retryAt, code === 429002);
  }
  if (Number.isInteger(code) && code >= 400000 && code < 500000) throw new ProviderRequestError(400, `Kingsoft rejected the tool request (business code ${code}).`, undefined, "provider_request_rejected");
  for (const field of ["result", "structuredContent", "toolResult", "error", "data"]) inspectResult(record[field], key, retryAt, depth + 1);
  for (const item of looseArray(record.content)) {
    const text = optionalString(optionalRecord(item)?.text);
    if (text) { try { inspectResult(JSON.parse(text), key, retryAt, depth + 1); } catch { /* non-JSON tool content */ } }
  }
  if (record.isError === true || (Number.isFinite(code) && code > 0)) throw new ProviderRequestError(502, "Kingsoft MCP returned a tool error.");
}
