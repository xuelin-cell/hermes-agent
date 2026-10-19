import type { CredentialValidators, ProviderExecutors } from "../../core/types.ts";
import type { ApiKeyProviderContext, ProviderRuntimeHandler } from "../provider-runtime.ts";
import type { ProviderActionHandlers } from "../provider-runtime.ts";
import type { Client } from "@modelcontextprotocol/client";

import { ProtocolError, SseError, UnauthorizedError } from "@modelcontextprotocol/client";
import { createHash } from "node:crypto";
import { withMcpClient } from "../mcp-client.ts";
import {
  defineApiKeyProviderExecutors,
  isAbortLikeError,
  mapProviderActionHandlers,
  providerUserAgent,
  ProviderRequestError,
  requiredInputString,
} from "../provider-runtime.ts";
import { youdaoNoteActions } from "./actions.ts";

export const youdaoNoteMcpEndpoint = "https://open.mail.163.com/api/ynote/mcp/sse";
const requestTimeoutMs = 60_000;

const directToolNames: Record<string, string> = {
  list_notes: "listNotes",
  search_notes: "searchNotes",
  get_note_content: "getNoteTextContent",
  get_recent_favorites: "getRecentFavoriteNotes",
  create_note: "createNote",
  update_markdown_note: "updateMarkdownNote",
  rename_note: "renameNote",
  move_note: "moveNote",
  delete_note: "deleteNote",
  create_folder: "createDir",
  list_todos: "listTodos",
};
const directToolNameSet = new Set(Object.values(directToolNames));

const handlers: ProviderActionHandlers<
  "youdao_note",
  ProviderRuntimeHandler<ApiKeyProviderContext>
> = mapProviderActionHandlers(
  "youdao_note",
  youdaoNoteActions,
  (_action, name) => (input, context) => executeYoudaoNoteAction(name, input, context),
);

export const executors: ProviderExecutors = defineApiKeyProviderExecutors("youdao_note", handlers, {
  skipDnsValidation: true,
});

export const credentialValidators: CredentialValidators = {
  async apiKey(input, { fetcher, signal }) {
    const tools = await listTools(input.apiKey, fetcher, signal);
    if (tools.length === 0) {
      throw new ProviderRequestError(400, "Youdao Note MCP did not expose any tools for this API Key");
    }
    const keyHash = createHash("sha256").update(input.apiKey).digest("hex").slice(0, 16);
    return {
      profile: {
        accountId: `youdao-note:${keyHash}`,
        displayName: `Youdao Note ${keyHash.slice(-6)}`,
      },
      metadata: {
        mcpEndpoint: youdaoNoteMcpEndpoint,
        discoveredToolCount: tools.length,
      },
    };
  },
};

async function executeYoudaoNoteAction(
  actionName: string,
  input: Record<string, unknown>,
  context: ApiKeyProviderContext,
): Promise<unknown> {
  if (actionName === "list_tools") {
    const tools = await listTools(context.apiKey, context.fetcher, context.signal);
    return { tools: tools.filter((tool) => !directToolNameSet.has(tool.name)) };
  }

  const toolName =
    directToolNames[actionName] ??
    (actionName === "call_tool" ? requiredInputString(input.toolName, "toolName") : undefined);
  if (!toolName) {
    throw new ProviderRequestError(400, `Unsupported Youdao Note action: ${actionName}`);
  }
  const args = actionName === "call_tool" ? readArguments(input.arguments) : input;
  const output = await withYoudaoNoteClient(context.apiKey, context.fetcher, context.signal, async (client) => {
    const result = await client.callTool(
      { name: toolName, arguments: args },
      { timeout: requestTimeoutMs, signal: context.signal },
    );
    if (result.isError) {
      throw new ProviderRequestError(502, `Youdao Note MCP tool ${toolName} returned an error`);
    }
    if (result.structuredContent) return result.structuredContent;
    const text = result.content.find((item) => item.type === "text");
    if (!text || text.type !== "text") return result;
    try {
      return JSON.parse(text.text) as unknown;
    } catch {
      return text.text;
    }
  });
  return { result: output };
}

async function listTools(apiKey: string, fetcher: typeof fetch, signal?: AbortSignal) {
  return withYoudaoNoteClient(apiKey, fetcher, signal, async (client) => {
    const result = await client.listTools({}, { timeout: requestTimeoutMs, signal });
    return result.tools;
  });
}

function withYoudaoNoteClient<T>(
  apiKey: string,
  fetcher: typeof fetch,
  signal: AbortSignal | undefined,
  run: (client: Client) => Promise<T>,
): Promise<T> {
  return withMcpClient(
    {
      endpoint: new URL(youdaoNoteMcpEndpoint),
      transport: "sse",
      fetcher,
      headers: { "x-api-key": apiKey, "user-agent": providerUserAgent },
      signal,
      protocolVersion: "legacy",
      mapError: mapYoudaoNoteMcpError,
    },
    run,
  );
}

function mapYoudaoNoteMcpError(error: unknown): ProviderRequestError {
  if (error instanceof ProviderRequestError) return error;
  if (error instanceof UnauthorizedError) {
    return new ProviderRequestError(401, "Youdao Note API Key is invalid or expired", error);
  }
  if (error instanceof SseError) {
    const status = error.code;
    return new ProviderRequestError(
      status === 401 || status === 403 ? 401 : status && status >= 400 && status < 500 ? 400 : 502,
      `Youdao Note MCP connection failed: ${error.message}`,
      error,
    );
  }
  if (error instanceof ProtocolError) {
    return new ProviderRequestError(502, `Youdao Note MCP request failed: ${error.message}`, error);
  }
  if (isAbortLikeError(error)) {
    return new ProviderRequestError(504, "Youdao Note MCP request timed out", error);
  }
  return new ProviderRequestError(
    502,
    error instanceof Error ? `Youdao Note MCP request failed: ${error.message}` : "Youdao Note MCP request failed",
    error,
  );
}

function readArguments(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
