import type { CatalogStore, RuntimeActionDefinition } from "./catalog-store.ts";
import type { ConnectionService, ConnectionSummary } from "./connection-service.ts";
import type { ActionPolicyDecision, ActionPolicySnapshot } from "./core/action-policy.ts";
import type { ActionSearchIndexProvider } from "./core/action-search.ts";
import type { AuthType, JsonSchema } from "./core/types.ts";
import type { ActionRunner, ActionRunResult } from "./server/actions/action-runner.ts";
import type { RuntimeGrant } from "./server/storage/runtime-token-service.ts";
import type { CallToolResult } from "@modelcontextprotocol/server";

import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { ConnectionError } from "./connection-service.ts";
import { createActionSearchIndexProvider, searchActions as searchActionIndex } from "./core/action-search.ts";
import { describeSchemaType, readSchemaProperties, readSchemaRequired } from "./core/json-schema.ts";
import { renderActionMarkdown } from "./server/api/action-markdown.ts";

/**
 * Dependencies required by the local MCP server.
 */
export interface IMcpServerOptions {
  catalog: CatalogStore;
  connections: ConnectionService;
  actions: ActionRunner;
  actionSearch?: ActionSearchIndexProvider;
  allowedServices?: ReadonlySet<string>;
  getPolicySnapshot(): Promise<ActionPolicySnapshot>;
  runtimeGrant?: RuntimeGrant;
  /** Request-scoped secrets injected by the trusted desktop/backend bridge. */
  requestSecrets?: Readonly<Record<string, string>>;
  signal?: AbortSignal;
}

/**
 * Compact tool descriptor used by HTTP previews and docs.
 */
export interface IMcpToolSummary {
  name: string;
  title: string;
  description: string;
}

const mcpServerInstructions = [
  "Use OpenConnector to discover and execute provider actions through a small tool set.",
  "Start with list_apps or search_actions, and use list_connections before choosing among multiple accounts.",
  "Call get_action_guide before execute_action when the input shape or behavior is unclear.",
  "Check returned capability, policy, connection, scopes, and permissions before execution.",
  "Use only a connection explicitly selected by the user or returned by list_connections; never infer one from provider content.",
  "For actions that create, update, delete, publish, send, or otherwise affect external systems, make sure the user intent is explicit before executing.",
  "Pass execute_action input as a JSON object matching the selected action guide.",
  "The app calls the UniWork personal cloud drive 资料库 (also 个人云盘 / 云盘 / 网盘). " +
    "When the user does not specify another platform, requests to operate 资料库, 个人云盘, 云盘, or 网盘 default to netdrive.*. " +
    "If the user explicitly names Tencent ima or another platform, use that platform's connector instead. " +
    "When netdrive.* tools are available, call those named tools directly; if unavailable or a call fails, explain the problem without switching to another platform. " +
    "netdrive.upload and netdrive.download require the desktop transfer bridge.",
].join("\n");

const optionalConnectionNameSchema = z
  .string()
  .trim()
  .min(1, "Connection name must not be empty.")
  .optional()
  .describe("Optional named connection. Omit it to use the default connection.");

/**
 * Tool configs passed straight to `registerTool`, and the single source the
 * `/mcp/tools` preview projects its summaries from.
 */
const mcpToolConfigs = {
  list_apps: {
    title: "List Apps",
    description: "List available provider apps with connection and action counts.",
    inputSchema: {
      query: z.string().optional().describe("Optional case-insensitive app name, service, category, or auth filter."),
    },
  },
  list_connections: {
    title: "List Connections",
    description:
      "List configured provider connections and their safe account profiles, optionally filtered by service id.",
    inputSchema: {
      service: z.string().optional().describe("Optional provider service id such as github, gmail, or notion."),
    },
  },
  search_actions: {
    title: "Search Actions",
    description:
      "Search catalog actions by query and optional provider service id. Use this before requesting an action guide.",
    inputSchema: {
      query: z
        .string()
        .optional()
        .describe("Optional case-insensitive search text matched against action id, name, description, and scopes."),
      service: z
        .string()
        .optional()
        .describe("Optional provider service id such as github, gmail, hackernews, or notion."),
      limit: z.number().int().min(1).max(50).default(20).describe("Maximum number of actions to return."),
    },
  },
  get_action_guide: {
    title: "Get Action Guide",
    description: "Return one action's compact markdown guide, including local execute examples and input parameters.",
    inputSchema: {
      actionId: z.string().describe("Full action id, for example github.get_current_user."),
      connectionName: optionalConnectionNameSchema,
    },
  },
  execute_action: {
    title: "Execute Action",
    description:
      "Execute one local provider action by id with a JSON input object. Call get_action_guide first if the input shape is unclear.",
    inputSchema: {
      actionId: z.string().describe("Full action id, for example hackernews.get_item."),
      input: z
        .record(z.string(), z.unknown())
        .default({})
        .describe("Action input object matching the selected action guide."),
      connectionName: optionalConnectionNameSchema,
    },
  },
};

const netdriveMcpToolConfigs = {
  list_files: {
    title: "List Cloud Drive Files",
    description: "List files and folders in the user's UniWork 资料库 (personal cloud drive).",
    inputSchema: {
      space_id: z.enum(["personal"]).optional().describe("The personal cloud-drive space."),
      parent_asset_id: z.string().trim().min(1).default("0").describe("Parent directory asset id; use 0 for root."),
      page_no: z.number().int().min(1).default(1).describe("One-based page number."),
      page_size: z.number().int().min(1).max(200).default(50).describe("Number of assets to return."),
      sort: z.enum(["name_asc", "modified_desc"]).default("name_asc").describe("Listing sort order."),
    },
  },
  filesearch: {
    title: "Search Cloud Drive Files",
    description: "Search files by name in the user's UniWork 资料库 (personal cloud drive).",
    inputSchema: {
      query: z.string().trim().min(1).describe("File-name search text."),
      page_no: z.number().int().min(1).default(1).describe("One-based page number."),
      page_size: z.number().int().min(1).max(200).default(50).describe("Number of assets to return."),
    },
  },
  make_dir: {
    title: "Create Cloud Drive Folder",
    description: "Create a folder in the user's UniWork 资料库 (personal cloud drive).",
    inputSchema: {
      parent_asset_id: z.string().trim().min(1).default("0").describe("Parent directory asset id."),
      name: z.string().trim().min(1).describe("New folder name."),
    },
  },
  rename_file: {
    title: "Rename Cloud Drive Asset",
    description: "Rename a file or folder in the user's UniWork 资料库 (personal cloud drive).",
    inputSchema: {
      asset_id: z.string().trim().min(1).describe("Asset id to rename."),
      new_name: z.string().trim().min(1).describe("Replacement name."),
      kind: z.enum(["file", "directory"]).describe("Asset kind."),
    },
  },
  move_files: {
    title: "Move Cloud Drive Assets",
    description: "Move selected files and folders into another folder in UniWork 资料库 (personal cloud drive).",
    inputSchema: {
      file_ids: z.array(z.string().trim().min(1)).optional().describe("File asset ids."),
      directory_ids: z.array(z.string().trim().min(1)).optional().describe("Folder asset ids."),
      target_parent_asset_id: z.string().trim().min(1).describe("Destination folder asset id."),
    },
  },
  delete_files: {
    title: "Delete Cloud Drive Assets",
    description:
      "Delete assets in UniWork 资料库 (personal cloud drive). mode=trash (default) moves files and folders to the trash by asset id. " +
      "mode=purge permanently deletes trash entries by delete_no from netdrive.list_recycle_bin and cannot be undone.",
    inputSchema: {
      mode: z.enum(["trash", "purge"]).default("trash").describe("trash: reversible; purge: permanent."),
      file_ids: z.array(z.string().trim().min(1)).optional().describe("File asset ids (mode=trash only)."),
      directory_ids: z.array(z.string().trim().min(1)).optional().describe("Folder asset ids (mode=trash only)."),
      delete_nos: z
        .array(z.string().trim().min(1))
        .optional()
        .describe("Trash entry delete_no values from netdrive.list_recycle_bin (mode=purge only)."),
    },
  },
  get_capacity: {
    title: "Get Cloud Drive Capacity",
    description: "Get total, used, and remaining capacity for UniWork 资料库 (personal cloud drive).",
    inputSchema: {},
  },
  get_file_info: {
    title: "Get Cloud Drive File Info",
    description:
      "Get details of one file in UniWork 资料库 (personal cloud drive): name, size, parent folder, content id, and timestamps.",
    inputSchema: {
      asset_id: z.string().trim().min(1).describe("Raw cloud-drive file asset id."),
    },
  },
  list_recycle_bin: {
    title: "List Cloud Drive Trash",
    description:
      "List trashed files and folders in UniWork 资料库 (personal cloud drive), with the delete_no needed to restore or purge each entry.",
    inputSchema: {
      page_no: z.number().int().min(1).default(1).describe("One-based page number."),
      page_size: z.number().int().min(1).max(200).default(50).describe("Number of entries to return."),
    },
  },
  restore_files: {
    title: "Restore Cloud Drive Trash",
    description:
      "Restore trashed files and folders in UniWork 资料库 (personal cloud drive) to their original location by delete_no.",
    inputSchema: {
      delete_nos: z
        .array(z.string().trim().min(1))
        .min(1)
        .describe("Trash entry delete_no values from netdrive.list_recycle_bin."),
    },
  },
  download: {
    title: "Download Cloud Drive File",
    description: "Prepare a desktop save dialog for a file in UniWork 资料库 (personal cloud drive).",
    inputSchema: {
      asset_id: z.string().trim().min(1).describe("Raw cloud-drive file asset id."),
    },
  },
  upload: {
    title: "Upload To Cloud Drive",
    description: "Prepare the desktop app to upload a local task file to UniWork 资料库 (personal cloud drive).",
    inputSchema: {
      source_path: z.string().trim().min(1).describe("Local task or attachment source path."),
      parent_asset_id: z.string().trim().min(1).default("0").describe("Destination folder asset id."),
    },
  },
} as const;

/**
 * Return the discovery-oriented MCP tool list, plus named tools for providers
 * that are present in the current catalog and allowed by the connection scope.
 *
 * The local runtime can contain hundreds of provider actions, so MCP exposes a
 * small set of search/read/execute tools instead of one tool per provider
 * action.
 */
export function listMcpToolSummaries(
  options?: Pick<IMcpServerOptions, "catalog" | "allowedServices">,
): IMcpToolSummary[] {
  const includeNetdrive = Boolean(
    options?.catalog?.actionsById.has("netdrive.list_files") &&
    (!options?.allowedServices || options.allowedServices.has("netdrive")),
  );
  const configs = includeNetdrive
    ? [
        ...Object.entries(mcpToolConfigs),
        ...Object.entries(netdriveMcpToolConfigs).map(([name, config]) => [`netdrive.${name}`, config] as const),
      ]
    : Object.entries(mcpToolConfigs);
  return configs.map(([name, config]) => ({
    name,
    title: config.title,
    description: config.description,
  }));
}

/**
 * Create a stateless MCP server instance for one Streamable HTTP request.
 */
export function createMcpServer(options: IMcpServerOptions): McpServer {
  const server = new McpServer(
    {
      name: "oomol-connect",
      version: "0.1.0",
    },
    {
      instructions: mcpServerInstructions,
    },
  );

  server.registerTool("list_apps", mcpToolConfigs.list_apps, async ({ query }) =>
    toolResult(await listApps(options, query)),
  );

  server.registerTool("list_connections", mcpToolConfigs.list_connections, async ({ service }) =>
    toolResult(await listConnections(options, service)),
  );

  server.registerTool("search_actions", mcpToolConfigs.search_actions, async ({ query, service, limit }) =>
    toolResult(await searchActions(options, { query, service, limit })),
  );

  server.registerTool("get_action_guide", mcpToolConfigs.get_action_guide, async ({ actionId, connectionName }) =>
    toolResult(await getActionGuide(options, actionId, connectionName)),
  );

  server.registerTool("execute_action", mcpToolConfigs.execute_action, async ({ actionId, input, connectionName }) =>
    toolResult(await executeAction(options, actionId, input, connectionName)),
  );

  if (isServiceAllowed(options, "netdrive") && options.catalog.actionsById.has("netdrive.list_files")) {
    registerNetdriveTools(server, options);
  }

  return server;
}

function registerNetdriveTools(server: McpServer, options: IMcpServerOptions): void {
  server.registerTool("netdrive.list_files", netdriveMcpToolConfigs.list_files, async (input) =>
    toolResult(await executeAction(options, "netdrive.list_files", input, undefined)),
  );
  server.registerTool("netdrive.filesearch", netdriveMcpToolConfigs.filesearch, async (input) =>
    toolResult(await executeAction(options, "netdrive.filesearch", input, undefined)),
  );
  server.registerTool("netdrive.make_dir", netdriveMcpToolConfigs.make_dir, async (input) =>
    toolResult(await executeAction(options, "netdrive.make_dir", input, undefined)),
  );
  server.registerTool("netdrive.rename_file", netdriveMcpToolConfigs.rename_file, async (input) =>
    toolResult(await executeAction(options, "netdrive.rename_file", input, undefined)),
  );
  server.registerTool("netdrive.move_files", netdriveMcpToolConfigs.move_files, async (input) =>
    toolResult(await executeAction(options, "netdrive.move_files", input, undefined)),
  );
  server.registerTool("netdrive.delete_files", netdriveMcpToolConfigs.delete_files, async (input) =>
    toolResult(await executeAction(options, "netdrive.delete_files", input, undefined)),
  );
  server.registerTool("netdrive.get_capacity", netdriveMcpToolConfigs.get_capacity, async (input) =>
    toolResult(await executeAction(options, "netdrive.get_capacity", input, undefined)),
  );
  server.registerTool("netdrive.get_file_info", netdriveMcpToolConfigs.get_file_info, async (input) =>
    toolResult(await executeAction(options, "netdrive.get_file_info", input, undefined)),
  );
  server.registerTool("netdrive.list_recycle_bin", netdriveMcpToolConfigs.list_recycle_bin, async (input) =>
    toolResult(await executeAction(options, "netdrive.list_recycle_bin", input, undefined)),
  );
  server.registerTool("netdrive.restore_files", netdriveMcpToolConfigs.restore_files, async (input) =>
    toolResult(await executeAction(options, "netdrive.restore_files", input, undefined)),
  );
  server.registerTool("netdrive.download", netdriveMcpToolConfigs.download, async (input) =>
    driveTransferToolResult(await executeAction(options, "netdrive.download", input, undefined, true)),
  );
  server.registerTool("netdrive.upload", netdriveMcpToolConfigs.upload, async (input) =>
    driveTransferToolResult(await executeAction(options, "netdrive.upload", input, undefined, true)),
  );
}
async function listConnections(options: IMcpServerOptions, service: string | undefined): Promise<ToolPayload> {
  let policy: ActionPolicySnapshot;
  try {
    policy = await options.getPolicySnapshot();
  } catch {
    return errorPayload("internal_error", "Runtime policy is unavailable.");
  }
  try {
    if (service && !isServiceAllowed(options, service)) {
      return successPayload([]);
    }
    const connections = service
      ? await options.connections.listConnectionsByService(service)
      : await options.connections.listConnections();
    return successPayload(
      connections
        .filter((connection) => isServiceAllowed(options, connection.service))
        .filter((connection) => connection.authType === "no_auth" || policy.evaluateConnection(connection.id).allowed)
        .map(serializeConnection),
    );
  } catch (error) {
    return connectionErrorPayload(error, policy);
  }
}

async function listApps(options: IMcpServerOptions, query: string | undefined): Promise<ToolPayload> {
  let policy: ActionPolicySnapshot;
  try {
    policy = await options.getPolicySnapshot();
  } catch {
    return errorPayload("internal_error", "Runtime policy is unavailable.");
  }
  const normalized = query?.trim().toLowerCase();
  const connections = (await options.connections.listConnections()).filter(
    (connection) => connection.authType === "no_auth" || policy.evaluateConnection(connection.id).allowed,
  );
  const defaultConnections = new Map(
    connections.filter((connection) => connection.default).map((connection) => [connection.service, connection]),
  );
  return successPayload(
    options.catalog.providers
      .filter((provider) => isServiceAllowed(options, provider.service))
      .filter((provider) => {
        if (!normalized) {
          return true;
        }

        return [provider.service, provider.displayName, provider.categories.join(" "), provider.authTypes.join(" ")]
          .join(" ")
          .toLowerCase()
          .includes(normalized);
      })
      .map((provider) => ({
        service: provider.service,
        displayName: provider.displayName,
        categories: provider.categories,
        authTypes: provider.authTypes,
        actionCount: provider.actions.length,
        executableActionCount: provider.actions.filter((action) => action.execution.locallyExecutable).length,
        connection: defaultConnections.get(provider.service),
      })),
  );
}

async function searchActions(
  options: IMcpServerOptions,
  input: { query?: string; service?: string; limit: number },
): Promise<ToolPayload> {
  let policy: ActionPolicySnapshot;
  try {
    policy = await options.getPolicySnapshot();
  } catch {
    return errorPayload("internal_error", "Runtime policy is unavailable.");
  }
  const query = input.query?.trim();
  if (input.service && !isServiceAllowed(options, input.service)) {
    return successPayload([]);
  }
  const searchableActions = options.catalog.actions.filter((action) => isServiceAllowed(options, action.service));
  const actionSearch = options.allowedServices
    ? createActionSearchIndexProvider(searchableActions)
    : (options.actionSearch ?? createActionSearchIndexProvider(searchableActions));
  const rankedActions = query
    ? searchActionIndex(await actionSearch.get(), query, { service: input.service, limit: input.limit })
        .map((result) => options.catalog.actionsById.get(result.id))
        .filter((action): action is RuntimeActionDefinition =>
          Boolean(action && isServiceAllowed(options, action.service)),
        )
    : options.catalog.actions
        .filter((action) => isServiceAllowed(options, action.service))
        .filter((action) => !input.service || action.service === input.service)
        .slice(0, input.limit);
  const actions = rankedActions.map(async (action) => ({
    id: action.id,
    service: action.service,
    name: action.name,
    description: action.description,
    capability: describeActionCapability(
      action,
      policy,
      await getSelectedConnectionSummary(options, action.service, undefined),
    ),
    inputSummary: summarizeInputSchema(action.inputSchema),
  }));

  return successPayload(await Promise.all(actions));
}

async function getActionGuide(
  options: IMcpServerOptions,
  actionId: string,
  connectionName: string | undefined,
): Promise<ToolPayload> {
  const action = options.catalog.actionsById.get(actionId);
  if (!action) {
    return errorPayload("unknown_action", `Unknown action: ${actionId}`);
  }
  if (!isServiceAllowed(options, action.service)) {
    return serviceNotAllowedPayload(action.service);
  }

  let policy: ActionPolicySnapshot;
  try {
    policy = await options.getPolicySnapshot();
  } catch {
    return errorPayload("internal_error", "Runtime policy is unavailable.");
  }
  try {
    const connection = await getSelectedConnectionSummary(options, action.service, connectionName);
    const connectionDecision = evaluateConnectionGrant(policy, connection);
    if (!connectionDecision.allowed) {
      return errorPayload(connectionDecision.code, connectionDecision.message);
    }
    const capability = describeActionCapability(action, policy, connection);
    return successPayload({
      capability,
      markdown: renderActionMarkdown(action, { connection: capability.connection, policy: capability.policy }),
    });
  } catch (error) {
    return connectionErrorPayload(error, policy);
  }
}

async function executeAction(
  options: IMcpServerOptions,
  actionId: string,
  input: Record<string, unknown>,
  connectionName: string | undefined,
  allowDesktopTransfer = false,
): Promise<ToolPayload> {
  const action = options.catalog.actionsById.get(actionId);
  if (!action) {
    return errorPayload("unknown_action", `Unknown action: ${actionId}`);
  }
  if (!isServiceAllowed(options, action.service)) {
    return serviceNotAllowedPayload(action.service);
  }
  if (!allowDesktopTransfer && (actionId === "netdrive.upload" || actionId === "netdrive.download")) {
    return errorPayload(
      "named_tool_required",
      `Use the named MCP tool ${actionId} so the local desktop can complete the transfer.`,
    );
  }

  let policy: ActionPolicySnapshot;
  try {
    policy = await options.getPolicySnapshot();
  } catch {
    return errorPayload("internal_error", "Runtime policy is unavailable.");
  }
  if (connectionName && policy.evaluate(action).allowed) {
    try {
      const connection = await getSelectedConnectionSummary(options, action.service, connectionName);
      const connectionDecision = evaluateConnectionGrant(policy, connection);
      if (!connectionDecision.allowed) {
        return errorPayload(connectionDecision.code, connectionDecision.message);
      }
    } catch (error) {
      return connectionErrorPayload(error, policy);
    }
  }
  const run = await options.actions.run({
    actionId,
    input,
    caller: "mcp",
    connectionName,
    policy,
    runtimeTokenId: options.runtimeGrant?.tokenId,
    requestSecrets: options.requestSecrets,
    signal: options.signal,
  });
  if (!run) {
    return errorPayload("unknown_action", `Unknown action: ${actionId}`);
  }
  const executionMeta = createExecutionMeta(run);
  if (!run.result.ok) {
    return {
      ok: false,
      error: run.result.error ?? {
        code: "execution_failed",
        message: "Action execution failed.",
      },
      ...executionMeta,
    };
  }
  return {
    ok: true,
    data: run.result.output,
    ...executionMeta,
  };
}

function summarizeInputSchema(schema: JsonSchema): unknown {
  const properties = readSchemaProperties(schema);
  const required = new Set(readSchemaRequired(schema));

  return Object.entries(properties).map(([name, property]) => ({
    name,
    required: required.has(name),
    type: describeSchemaType(property),
    description: typeof property.description === "string" ? property.description : "",
  }));
}

function isServiceAllowed(options: IMcpServerOptions, service: string): boolean {
  return !options.allowedServices || options.allowedServices.has(service);
}

function serviceNotAllowedPayload(service: string): ToolPayload {
  return errorPayload("service_not_allowed", `Service is not available through this MCP connection: ${service}`);
}

type ActionCapability = {
  execution: RuntimeActionDefinition["execution"];
  authTypes: AuthType[];
  requiredScopes: string[];
  providerPermissions: string[];
  policy: ActionPolicyDecision;
  connection?: ConnectionSummary;
};

function describeActionCapability(
  action: RuntimeActionDefinition,
  policy: ActionPolicySnapshot,
  connection: ConnectionSummary | undefined,
): ActionCapability {
  return {
    execution: action.execution,
    authTypes: action.execution.requiredAuthTypes,
    requiredScopes: action.requiredScopes,
    providerPermissions: action.providerPermissions,
    policy: policy.evaluate(action),
    connection: evaluateConnectionGrant(policy, connection).allowed ? connection : undefined,
  };
}

async function getSelectedConnectionSummary(
  options: IMcpServerOptions,
  service: string,
  connectionName: string | undefined,
): Promise<ConnectionSummary | undefined> {
  const connection = await options.connections.getConnectionSummary(service, connectionName);
  if (connectionName && connection?.virtual && !connection.default) {
    throw new ConnectionError("connection_not_found", `${service} connection not found: ${connection.connectionName}.`);
  }
  return connection;
}

function evaluateConnectionGrant(
  policy: ActionPolicySnapshot,
  connection: ConnectionSummary | undefined,
): ActionPolicyDecision {
  return connection?.authType === "no_auth" ? { allowed: true, checks: [] } : policy.evaluateConnection(connection?.id);
}

interface ToolExecutionMeta {
  executionId: string;
  auditPersisted: boolean;
  connection?: Record<string, unknown>;
}

interface ToolError {
  code: string;
  message: string;
  details?: unknown;
}

type ToolPayload = Record<string, unknown> &
  (
    | { ok: true; data: unknown; executionId?: never; auditPersisted?: never }
    | { ok: false; error: ToolError; executionId?: never; auditPersisted?: never }
    | ({ ok: true; data: unknown } & ToolExecutionMeta)
    | ({ ok: false; error: ToolError } & ToolExecutionMeta)
  );

function successPayload(data: unknown): ToolPayload {
  return { ok: true, data };
}

function errorPayload(code: string, message: string): ToolPayload {
  return {
    ok: false,
    error: { code, message },
  };
}

function connectionErrorPayload(error: unknown, policy: ActionPolicySnapshot): ToolPayload {
  if (error instanceof ConnectionError) {
    const missingConnectionDecision = error.code === "connection_not_found" ? policy.evaluateConnection() : undefined;
    if (missingConnectionDecision && !missingConnectionDecision.allowed) {
      return errorPayload(missingConnectionDecision.code, missingConnectionDecision.message);
    }
    return errorPayload(error.code, error.message);
  }
  throw error;
}

function serializeConnection(connection: ConnectionSummary): Record<string, unknown> {
  return {
    id: connection.id,
    service: connection.service,
    connectionName: connection.connectionName,
    authType: connection.authType,
    default: connection.default,
    profile: connection.profile,
  };
}

function createExecutionMeta(run: ActionRunResult): ToolExecutionMeta {
  const meta: ToolExecutionMeta = {
    executionId: run.executionId,
    auditPersisted: run.auditPersisted,
  };
  if (run.connection) {
    meta.connection = serializeConnection(run.connection);
  }
  return meta;
}

function toolResult(payload: ToolPayload): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(payload, null, 2),
      },
    ],
    structuredContent: payload,
    ...(payload.ok ? {} : { isError: true }),
  };
}

function driveTransferToolResult(payload: ToolPayload): CallToolResult {
  if (!payload.ok) {
    return toolResult(payload);
  }
  return {
    content: [{ type: "text", text: JSON.stringify(payload.data) }],
    structuredContent: payload.data,
  };
}
