import type { BrowserAuthorizationRuntime } from "../../browser-authorization-service.ts";
import type { CredentialValidators, ProviderExecutors } from "../../core/types.ts";
import type { WpsMcpContext } from "./skill-hub-client.ts";

import { optionalRecord, optionalString } from "../../core/cast.ts";
import {
  defineProviderExecutors,
  ProviderRequestError,
  requireCustomCredential,
  runProviderRequest,
  readProviderJsonBody,
} from "../provider-runtime.ts";
import { wpsMcpEndpoint, wpsExchangeEndpoint, withWpsMcpClient } from "./skill-hub-client.ts";
import { getWpsSkillVersion } from "./skill-version.ts";
import { listWpsToolSummaries, getWpsToolSchema, callWpsTool } from "./tool-catalog.ts";

export const browserAuthorization: BrowserAuthorizationRuntime = {
  authorizationUrl(code) {
    return `https://mcp-center.wps.cn/kdocs-auth/auth-guide?auth_code=${encodeURIComponent(code)}`;
  },
  async exchange(code, clientId, fetcher, signal) {
    try {
      return await runProviderRequest(
        { signal, label: "WPS authorization exchange", timeoutMs: 10_000 },
        async (requestSignal) => {
          const response = await fetcher(wpsExchangeEndpoint, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ code }),
            signal: requestSignal,
          });
          if (response.status >= 500) return { status: "pending" };
          const payload = optionalRecord(
            await readProviderJsonBody(response, {
              emptyBody: {},
              invalidJsonMessage: "Invalid WPS authorization response",
              invalidJsonFallback: () => ({}),
            }),
          );
          const businessCode = Number(payload?.code);
          const status =
            response.ok && ([200, 202, 403, 409].includes(businessCode) || (businessCode >= 500 && businessCode <= 599))
              ? businessCode
              : response.status;
          if (status === 202 || (status >= 500 && status <= 599)) return { status: "pending" };
          if (status === 403) return { status: "failed", message: "仅支持 WPS 个人账号，请切换账号后重新授权。" };
          if (status === 409) return { status: "cancelled", message: "授权已取消，可以重新发起。" };
          if (status !== 200 || (payload?.code !== undefined && ![0, 200].includes(businessCode))) {
            return { status: "failed", message: "金山授权失败，请重新发起授权。" };
          }
          const data = optionalRecord(payload?.data);
          const token = optionalString(data?.token);
          const expiresIn = Number(data?.expires_in);
          if (!token || !Number.isFinite(expiresIn) || expiresIn <= 0 || expiresIn > 31_536_000) {
            return { status: "failed", message: "金山授权返回的凭据或有效期无效，请重试。" };
          }
          return {
            status: "authorized",
            values: {
              token,
              clientId,
              expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
              skillVersion: getWpsSkillVersion(),
            },
          };
        },
      );
    } catch {
      signal.throwIfAborted();
      return { status: "pending", message: "暂时无法连接金山授权服务，正在重试，请检查网络连接。" };
    }
  },
};

export const executors: ProviderExecutors = defineProviderExecutors<WpsMcpContext>({
  service: "wps_mcp",
  async createContext(context, fetcher) {
    const credential = await requireCustomCredential(context, "wps_mcp");
    return { values: credential.values, fetcher, signal: context.signal };
  },
  handlers: {
    async list_tools(input, context) {
      return listWpsToolSummaries(context, input);
    },
    get_tool_schema: (input, context) => getWpsToolSchema(context, input),
    call_tool: (input, context) => callWpsTool(context, input),
  },
});

export const credentialValidators: CredentialValidators = {
  async customCredential(input, { fetcher, signal }) {
    const result = await withWpsMcpClient({ values: input.values, fetcher, signal }, (client) =>
      client.listTools({}, { signal }),
    );
    if (result.tools.length === 0) throw new ProviderRequestError(502, "Kingsoft MCP did not expose any tools");
    const bytes = new TextEncoder().encode(input.values.token);
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)))
      .slice(0, 8)
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    return {
      profile: { accountId: `wps-skill:${hash}`, displayName: `WPS · ${hash.slice(-6)}` },
      metadata: {
        expiresAt: input.values.expiresAt,
        mcpEndpoint: wpsMcpEndpoint,
        credentialType: "skill_hub",
        discoveredToolCount: result.tools.length,
      },
    };
  },
};
