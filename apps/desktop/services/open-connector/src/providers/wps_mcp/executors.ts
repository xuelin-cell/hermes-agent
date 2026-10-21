import type { CredentialValidators, ProviderExecutors, ProviderProxyExecutor } from "../../core/types.ts";
import type { ApiKeyProviderContext, ProviderRuntimeHandler } from "../provider-runtime.ts";
import type { ProviderActionHandlers } from "../provider-runtime.ts";

import { createHash } from "node:crypto";
import { optionalRecord, optionalString } from "../../core/cast.ts";
import {
  createProviderFetch,
  defineApiKeyProviderExecutors,
  defineProviderProxy,
  mapProviderActionHandlers,
  ProviderRequestError,
} from "../provider-runtime.ts";
import { wpsMcpActions } from "./actions.ts";
import {
  isAgentApiKey,
  normalizeWpsCredential,
  requestWpsV7,
  resolveWpsAccessToken,
  wpsAgentTokenEndpoint,
  wpsV7BaseUrl,
} from "./wps-v7-client.ts";

export { wpsAgentTokenEndpoint, wpsV7BaseUrl } from "./wps-v7-client.ts";

const service = "wps_mcp";
const wpsFileSearchPath = "/v7/files/search";

const handlers: ProviderActionHandlers<
  "wps_mcp",
  ProviderRuntimeHandler<ApiKeyProviderContext>
> = mapProviderActionHandlers(
  "wps_mcp",
  wpsMcpActions,
  (_action, name) => (input, context) => executeWpsAction(name, input, context),
);

export const executors: ProviderExecutors = defineApiKeyProviderExecutors(service, handlers, {
  // WPS is a code-controlled public host. Skipping the duplicate DNS check
  // avoids false positives on corporate/VPN DNS while retaining URL guards.
  skipDnsValidation: true,
});

/**
 * Keep the generic provider proxy useful for callers that need a raw WPS V7
 * endpoint, but never proxy the old Skill Hub MCP endpoint.
 */
export const proxy: ProviderProxyExecutor = defineProviderProxy({
  service,
  baseUrl: wpsV7BaseUrl,
  auth: { type: "none" },
  allowedEndpoint: (endpoint) => endpoint.startsWith("/v7/"),
  async customizeRequest({ context, headers, fetcher }) {
    const credential = await context.getCredential(service);
    if (credential?.authType !== "api_key") {
      throw new ProviderRequestError(401, "Configure wps_mcp Agent API Key credentials first.");
    }
    const accessToken = await resolveWpsAccessToken(credential.apiKey, fetcher, context.signal);
    headers.set("authorization", `Bearer ${accessToken}`);
    headers.set("accept", "application/json");
  },
  skipDnsValidation: true,
});

export const credentialValidators: CredentialValidators = {
  async apiKey(input, { fetcher, signal }) {
    const egressFetcher = createProviderFetch({ fetch: fetcher, skipDnsValidation: true });
    await requestWpsV7(input.apiKey, egressFetcher, signal, wpsFileSearchPath, {
      query: {
        type: "file_name",
        scope: ["personal_drive"],
        page_size: 1,
        order_by: "mtime",
        order: "desc",
      },
    });

    const normalizedCredential = normalizeWpsCredential(input.apiKey);
    const tokenHash = createHash("sha256").update(normalizedCredential).digest("hex").slice(0, 16);
    return {
      profile: { accountId: `wps-v7:${tokenHash}`, displayName: `WPS ${tokenHash.slice(-6)}` },
      metadata: {
        apiBaseUrl: wpsV7BaseUrl,
        apiVersion: "v7",
        credentialType: isAgentApiKey(normalizedCredential) ? "agent_api_key" : "unsupported",
        validationAction: "search_files",
      },
    };
  },
};

async function executeWpsAction(
  actionName: string,
  input: Record<string, unknown>,
  context: ApiKeyProviderContext,
): Promise<unknown> {
  if (actionName === "list_tools") return listLocalActions();

  if (actionName === "call_tool") {
    const toolName = requireString(input.toolName, "toolName");
    if (!supportedActionNames.has(toolName)) {
      throw new ProviderRequestError(400, `Unsupported WPS V7 action: ${toolName}`);
    }
    return {
      result: await executeWpsAction(toolName, readArguments(input.arguments), context),
    };
  }

  switch (actionName) {
    case "search_files":
      return requestWpsV7(context.apiKey, context.fetcher, context.signal, wpsFileSearchPath, {
        query: searchQuery(input),
      });
    case "list_my_files":
      return requestWpsV7(context.apiKey, context.fetcher, context.signal, wpsFileSearchPath, {
        query: {
          type: "file_name",
          scope: ["personal_drive"],
          page_size: input.page_size ?? 50,
          ...fileListQuery(input),
        },
      });
    case "list_files": {
      const driveId = requireString(input.drive_id, "drive_id");
      const parentId = requireString(input.parent_id, "parent_id");
      return requestWpsV7(
        context.apiKey,
        context.fetcher,
        context.signal,
        `/v7/drives/${pathPart(driveId)}/files/${pathPart(parentId)}/children`,
        {
          query: fileListQuery(input),
        },
      );
    }
    case "get_file_info": {
      const ref = await resolveFileReference(context, input);
      const response = await requestWpsV7(
        context.apiKey,
        context.fetcher,
        context.signal,
        `/v7/drives/${pathPart(ref.driveId)}/files/${pathPart(ref.fileId)}/meta`,
        { query: metadataQuery(input) },
      );
      return ref.link ? { ...response, data: { ...optionalRecord(response.data), link: ref.link } } : response;
    }
    case "read_file": {
      const ref = await resolveFileReference(context, input);
      return requestWpsV7(
        context.apiKey,
        context.fetcher,
        context.signal,
        `/v7/drives/${pathPart(ref.driveId)}/files/${pathPart(ref.fileId)}/content`,
        {
          query: {
            format: input.format ?? "markdown",
            mode: "auto",
            task_id: input.task_id,
          },
        },
      );
    }
    case "create_folder": {
      const driveId = requireString(input.drive_id, "drive_id");
      const parentId = requireString(input.parent_id, "parent_id");
      return requestWpsV7(
        context.apiKey,
        context.fetcher,
        context.signal,
        `/v7/drives/${pathPart(driveId)}/files/${pathPart(parentId)}/create`,
        {
          method: "POST",
          body: {
            file_type: "folder",
            name: requireString(input.name, "name"),
            on_name_conflict: input.on_name_conflict,
            parent_path: input.parent_path,
          },
        },
      );
    }
    default:
      throw new ProviderRequestError(400, `Unsupported WPS action: ${actionName}`);
  }
}

const supportedActionNames = new Set([
  "search_files",
  "list_my_files",
  "list_files",
  "get_file_info",
  "read_file",
  "create_folder",
]);

function listLocalActions(): { tools: Array<{ name: string; description: string }> } {
  return {
    tools: wpsMcpActions
      .filter((action) => supportedActionNames.has(action.name))
      .map((action) => ({ name: action.name, description: action.description })),
  };
}

function searchQuery(input: Record<string, unknown>): Record<string, unknown> {
  const query: Record<string, unknown> = { type: input.type ?? "all", page_size: input.page_size ?? 50 };
  for (const key of [
    "keyword",
    "file_type",
    "file_exts",
    "exclude_file_exts",
    "file_ext_groups",
    "channels",
    "exclude_channels",
    "device_ids",
    "creator_ids",
    "modifier_ids",
    "receiver_ids",
    "sharer_ids",
    "scope",
    "filter_user_id",
    "search_operator_name",
    "start_time",
    "end_time",
    "time_type",
    "order_by",
    "order",
    "page_token",
    "with_drive",
    "with_link",
    "with_permission",
    "with_total",
    "drive_ids",
    "parent_ids",
  ]) {
    if (input[key] !== undefined) query[key] = input[key];
  }
  return query;
}

function fileListQuery(input: Record<string, unknown>): Record<string, unknown> {
  const query: Record<string, unknown> = {};
  for (const key of [
    "filter_exts",
    "filter_type",
    "order",
    "order_by",
    "page_size",
    "page_token",
    "with_ext_attrs",
    "with_permission",
  ]) {
    if (input[key] !== undefined) query[key] = input[key];
  }
  return query;
}

function metadataQuery(input: Record<string, unknown>): Record<string, unknown> {
  const query: Record<string, unknown> = {};
  for (const key of ["with_drive", "with_ext_attrs", "with_permission"]) {
    if (input[key] !== undefined) query[key] = input[key];
  }
  return query;
}

type WpsFileReference = {
  fileId: string;
  driveId: string;
  link?: Record<string, unknown>;
};

async function resolveFileReference(
  context: ApiKeyProviderContext,
  input: Record<string, unknown>,
): Promise<WpsFileReference> {
  const fileId = optionalString(input.file_id);
  const rawLinkId = optionalString(input.link_id) ?? extractLinkId(optionalString(input.url));

  if (fileId && !rawLinkId) {
    const response = await requestWpsV7(
      context.apiKey,
      context.fetcher,
      context.signal,
      `/v7/files/${pathPart(fileId)}/meta`,
      { query: { with_drive: true } },
    );
    const data = requireResponseRecord(response, "file metadata");
    return { fileId, driveId: requireString(data.drive_id, "drive_id") };
  }

  const linkId = requireString(rawLinkId, "link_id or url");
  const linkResponse = await requestWpsV7(
    context.apiKey,
    context.fetcher,
    context.signal,
    `/v7/links/${pathPart(linkId)}/meta`,
  );
  const link = requireResponseRecord(linkResponse, "link metadata");
  return {
    fileId: requireString(link.file_id, "file_id"),
    driveId: requireString(link.drive_id, "drive_id"),
    link,
  };
}

function extractLinkId(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    const match = parsed.pathname.match(/\/l\/([A-Za-z0-9]+)/);
    if (match) return match[1];
  } catch {
    // The schema rejects invalid URLs before execution; keep this helper safe
    // for direct executor calls and return the standard input error below.
  }
  return undefined;
}

function requireResponseRecord(response: Record<string, unknown>, label: string): Record<string, unknown> {
  const data = optionalRecord(response.data);
  if (!data) throw new ProviderRequestError(502, `WPS OpenAPI ${label} response is missing data`);
  return data;
}

function pathPart(value: string): string {
  return encodeURIComponent(value);
}

function requireString(value: unknown, name: string): string {
  if (typeof value === "string" && value.trim()) return value.trim();
  throw new ProviderRequestError(400, `${name} is required`);
}

function readArguments(value: unknown): Record<string, unknown> {
  return optionalRecord(value) ?? {};
}
