import { createHash } from "node:crypto";
import { optionalRecord, optionalString } from "../../core/cast.ts";
import { readBoundedResponseBytes } from "../../core/request.ts";
import {
  createProviderTimeout,
  isAbortLikeError,
  isAbortSignalError,
  ProviderRequestError,
  providerUserAgent,
} from "../provider-runtime.ts";

export const wpsV7BaseUrl = "https://openapi.wps.cn";
export const wpsAgentTokenEndpoint = "https://account.wps.cn/api/authorization/agent/v1/token";

const requestTimeoutMs = 55_000;
const tokenResponseMaxBytes = 256 * 1024;
const responseMaxBytes = 16 * 1024 * 1024;
const accessTokenRefreshSkewMs = 30 * 60 * 1000;

type CachedAccessToken = {
  accessToken: string;
  expiresAt: number;
};

export type WpsV7RequestOptions = {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  query?: Record<string, unknown>;
  body?: Record<string, unknown>;
  headers?: HeadersInit;
};

const agentAccessTokenCache = new Map<string, Promise<CachedAccessToken>>();

export async function requestWpsV7(
  apiKey: string,
  fetcher: typeof fetch,
  signal: AbortSignal | undefined,
  path: string,
  options: WpsV7RequestOptions = {},
): Promise<Record<string, unknown>> {
  const credential = normalizeWpsCredential(apiKey);
  if (!isAgentApiKey(credential)) {
    throw new ProviderRequestError(
      401,
      "WPS requires an Agent API Key beginning with apik:",
      undefined,
      "authorization_failed",
    );
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const accessToken = await resolveWpsAccessToken(credential, fetcher, signal, attempt > 0);
    const timeout = createProviderTimeout(signal, requestTimeoutMs);
    try {
      const url = buildUrl(path, options.query);
      const headers = new Headers(options.headers);
      headers.set("accept", "application/json");
      headers.set("authorization", `Bearer ${accessToken}`);
      headers.set("user-agent", providerUserAgent);
      if (options.body !== undefined) headers.set("content-type", "application/json");

      let response: Response;
      try {
        response = await fetcher(url, {
          method: options.method ?? "GET",
          headers,
          body: options.body === undefined ? undefined : JSON.stringify(options.body),
          redirect: "manual",
          signal: timeout.signal,
        });
      } catch (error) {
        if (error instanceof ProviderRequestError) throw error;
        if (
          timeout.didTimeout() ||
          isAbortLikeError(error) ||
          isAbortSignalError(signal, error) ||
          isAbortSignalError(timeout.signal, error)
        ) {
          throw new ProviderRequestError(504, "WPS OpenAPI request timed out");
        }
        throw new ProviderRequestError(
          502,
          `WPS OpenAPI request failed${error instanceof Error ? `: ${error.message}` : ""}`,
        );
      }

      const bytes = await readBoundedResponseBytes(response, {
        maxBytes: responseMaxBytes,
        fieldName: "WPS OpenAPI response",
        createError: (message) => new ProviderRequestError(413, message),
      });
      const payload = parseJsonRecord(bytes);
      const providerCode = readProviderCode(payload);

      if (attempt === 0 && isAuthenticationResponse(response.status, providerCode)) {
        invalidateAgentAccessToken(credential);
        continue;
      }

      if (!response.ok || (providerCode !== undefined && providerCode !== 0)) {
        throw mapWpsApiError(response.status, payload, providerCode);
      }

      return payload;
    } finally {
      timeout.cleanup();
    }
  }

  throw new ProviderRequestError(401, "WPS OpenAPI authorization failed", undefined, "authorization_failed");
}

export function normalizeWpsCredential(value: string): string {
  return value
    .trim()
    .replace(/^Bearer\s+/i, "")
    .trim();
}

export function isAgentApiKey(value: string): boolean {
  return /^apik:/i.test(value);
}

function buildUrl(path: string, query?: Record<string, unknown>): string {
  const url = new URL(path, wpsV7BaseUrl);
  if (url.origin !== wpsV7BaseUrl || !url.pathname.startsWith("/v7/")) {
    throw new ProviderRequestError(400, "WPS OpenAPI endpoint must be under /v7/");
  }

  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item !== undefined && item !== null) url.searchParams.append(key, String(item));
      }
      continue;
    }
    if (typeof value === "object") {
      url.searchParams.set(key, JSON.stringify(value));
      continue;
    }
    url.searchParams.set(key, String(value));
  }

  return url.toString();
}

export async function resolveWpsAccessToken(
  credentialInput: string,
  fetcher: typeof fetch,
  signal: AbortSignal | undefined,
  forceRefresh = false,
): Promise<string> {
  const credential = normalizeWpsCredential(credentialInput);
  const cacheKey = credentialHash(credential);
  if (forceRefresh) agentAccessTokenCache.delete(cacheKey);

  const cached = agentAccessTokenCache.get(cacheKey);
  if (cached) {
    try {
      const token = await cached;
      if (token.expiresAt > Date.now() + accessTokenRefreshSkewMs) return token.accessToken;
    } catch {
      // The failed promise is removed below and the normal exchange path retries.
    }
    if (agentAccessTokenCache.get(cacheKey) === cached) agentAccessTokenCache.delete(cacheKey);
  }

  const pending = exchangeAgentApiKey(credential, fetcher, signal);
  agentAccessTokenCache.set(cacheKey, pending);
  try {
    return (await pending).accessToken;
  } catch (error) {
    if (agentAccessTokenCache.get(cacheKey) === pending) agentAccessTokenCache.delete(cacheKey);
    throw error;
  }
}

async function exchangeAgentApiKey(
  apiKey: string,
  fetcher: typeof fetch,
  parentSignal: AbortSignal | undefined,
): Promise<CachedAccessToken> {
  const timeout = createProviderTimeout(parentSignal, requestTimeoutMs);
  try {
    let response: Response;
    try {
      response = await fetcher(wpsAgentTokenEndpoint, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "user-agent": providerUserAgent,
        },
        body: JSON.stringify({ grant_type: "api_key", api_key: apiKey }),
        redirect: "manual",
        signal: timeout.signal,
      });
    } catch (error) {
      if (error instanceof ProviderRequestError) throw error;
      if (
        timeout.didTimeout() ||
        isAbortLikeError(error) ||
        isAbortSignalError(parentSignal, error) ||
        isAbortSignalError(timeout.signal, error)
      ) {
        throw new ProviderRequestError(504, "WPS Agent API Key exchange timed out");
      }
      throw new ProviderRequestError(
        502,
        `WPS Agent API Key exchange failed${error instanceof Error ? `: ${error.message}` : ""}`,
      );
    }

    const bytes = await readBoundedResponseBytes(response, {
      maxBytes: tokenResponseMaxBytes,
      fieldName: "WPS Agent API Key response",
      createError: (message) => new ProviderRequestError(413, message),
    });
    const payload = parseJsonRecord(bytes);
    const data = optionalRecord(payload.data);
    const accessToken =
      optionalString(data?.access_token) ?? optionalString(data?.accessToken) ?? optionalString(payload.access_token);
    const expiresIn =
      positiveNumber(data?.expires_in) ?? positiveNumber(data?.expiresIn) ?? positiveNumber(payload.expires_in) ?? 3600;
    const providerCode = readProviderCode(payload);
    const result = optionalString(payload.result)?.toLowerCase();
    const message = readProviderMessage(payload);
    const succeeded =
      response.ok &&
      Boolean(accessToken) &&
      (result === undefined || result === "ok" || result === "success") &&
      (providerCode === undefined || providerCode === 0);

    if (!succeeded) {
      const status = response.status >= 500 ? 502 : 401;
      throw new ProviderRequestError(
        status,
        message ? `WPS Agent API Key exchange failed: ${message}` : "WPS Agent API Key exchange failed",
        providerCode === undefined ? undefined : { providerCode },
        status === 401 ? "authorization_failed" : undefined,
      );
    }

    return { accessToken: accessToken!, expiresAt: Date.now() + expiresIn * 1000 };
  } finally {
    timeout.cleanup();
  }
}

function parseJsonRecord(bytes: Uint8Array): Record<string, unknown> {
  try {
    return optionalRecord(JSON.parse(new TextDecoder().decode(bytes))) ?? {};
  } catch {
    throw new ProviderRequestError(502, "WPS OpenAPI returned invalid JSON");
  }
}

function readProviderCode(payload: Record<string, unknown>): number | undefined {
  const candidates = [payload.code, payload.error_code, payload.err_code];
  for (const candidate of candidates) {
    if (typeof candidate === "number" && Number.isFinite(candidate)) return candidate;
    if (typeof candidate === "string" && candidate.trim() && Number.isFinite(Number(candidate)))
      return Number(candidate);
  }
  return undefined;
}

function readProviderMessage(payload: Record<string, unknown>): string | undefined {
  return optionalString(payload.msg) ?? optionalString(payload.message) ?? optionalString(payload.error_description);
}

function isAuthenticationResponse(status: number, providerCode: number | undefined): boolean {
  return status === 401 || status === 403 || providerCode === 400006;
}

function mapWpsApiError(
  status: number,
  payload: Record<string, unknown>,
  providerCode: number | undefined,
): ProviderRequestError {
  const message = readProviderMessage(payload) ?? `WPS OpenAPI request failed (HTTP ${status})`;
  if (status === 401 || status === 403 || providerCode === 400006) {
    return new ProviderRequestError(
      401,
      message,
      providerCode === undefined ? undefined : { providerCode },
      "authorization_failed",
    );
  }
  if (status === 429)
    return new ProviderRequestError(429, message, providerCode === undefined ? undefined : { providerCode });
  return new ProviderRequestError(
    status >= 500 ? 502 : 400,
    message,
    providerCode === undefined ? undefined : { providerCode },
  );
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function credentialHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function invalidateAgentAccessToken(credential: string): void {
  agentAccessTokenCache.delete(credentialHash(normalizeWpsCredential(credential)));
}
