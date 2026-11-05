import type { WpsMcpContext } from "./skill-hub-client.ts";
import type { Client, Tool, JsonSchemaType } from "@modelcontextprotocol/client";

import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/client/validators/cf-worker";
import { optionalString, requiredString, optionalRecord } from "../../core/cast.ts";
import { providerInputError, ProviderRequestError } from "../provider-runtime.ts";
import { withWpsMcpClient } from "./skill-hub-client.ts";

const argumentValidator = new CfWorkerJsonSchemaValidator();
const invocationGuidance =
  'get_tool_schema input must be {"toolName":"EXACT_DISCOVERED_NAME"}. call_tool input must contain toolName and an arguments object; input.name is invalid, and a folder name belongs in arguments.name. get_tool_schema inspects upstream tools only. For the local connector call shape use get_action_guide({"actionId":"wps_mcp.call_tool"}). Preserve discovered names and prefixes. Do not configure mcporter or execute CLI scripts.';
const commonToolKeywords: Record<string, string> = {
  list_my_files: "root directory list files folders 我的云文档 根目录 列目录",
  list_files: "directory folder children list files 子目录 文件夹 列目录",
  search_files: "search files folders 搜索 文件 文件夹",
  read_file: "read document content 读取 文档 正文",
  create_file: "create document file 创建 文档",
  create_file_with_content: "create document content 创建 文档 内容",
};

interface ToolSummaryPage {
  tools: Array<{ name: string; description: string }>;
  total: number;
  offset: number;
  nextOffset: number | null;
  guidance: string;
}

/** Fetch all upstream pages internally; never expose hundreds of schemas in one model response. */
async function discoverTools(client: Client, signal?: AbortSignal): Promise<Tool[]> {
  const tools: Tool[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await client.listTools(cursor ? { cursor } : {}, { signal });
    tools.push(...page.tools);
    cursor = page.nextCursor;
    if (cursor) {
      if (cursors.has(cursor) || cursors.size >= 100)
        throw new ProviderRequestError(502, "Kingsoft tool catalog pagination did not complete.");
      cursors.add(cursor);
    }
  } while (cursor);
  return tools;
}

function selectTool(tools: Tool[], name: string): Tool {
  const tool = tools.find((item) => item.name === name);
  if (
    !tool &&
    [
      "call_tool",
      "get_tool_schema",
      "list_tools",
      "wps_mcp.call_tool",
      "wps_mcp.get_tool_schema",
      "wps_mcp.list_tools",
    ].includes(name)
  ) {
    const actionId = name.startsWith("wps_mcp.") ? name : `wps_mcp.${name}`;
    throw providerInputError(
      `${name} is a local connector action, not a discovered Kingsoft tool. Use get_action_guide with actionId="${actionId}" to inspect its input. To execute an upstream tool use actionId="wps_mcp.call_tool" and input={"toolName":"EXACT_DISCOVERED_NAME","arguments":{...business arguments}}.`,
    );
  }
  if (!tool)
    throw providerInputError(
      `Unknown Kingsoft tool: ${name}. Use wps_mcp.list_tools with query, then wps_mcp.get_tool_schema. Do not guess a service prefix or search local mcporter configuration.`,
    );
  return tool;
}

/** Search compact descriptions and paginate before the response reaches model truncation. */
export async function listWpsToolSummaries(
  context: WpsMcpContext,
  input: Record<string, unknown>,
): Promise<ToolSummaryPage> {
  const query = optionalString(input.query)?.toLowerCase();
  const offset = input.offset === undefined ? 0 : Number(input.offset);
  const limit = input.limit === undefined ? 10 : Number(input.limit);
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 20) {
    throw providerInputError("offset must be a non-negative integer and limit an integer from 1 to 20.");
  }
  const discovered = await withWpsMcpClient(context, (client) => discoverTools(client, context.signal));
  const terms = query?.split(/\s+/).filter(Boolean) ?? [];
  const matches = discovered.filter((tool) => {
    const keywordName = tool.name.startsWith("drive.") ? tool.name.slice(6) : tool.name;
    const text = `${tool.name} ${tool.description ?? ""} ${commonToolKeywords[keywordName] ?? ""}`.toLowerCase();
    return terms.length === 0 || terms.some((term) => text.includes(term));
  });
  const priorities = Object.keys(commonToolKeywords);
  matches.sort((left, right) => {
    if (query === left.name && query !== right.name) return -1;
    if (query === right.name && query !== left.name) return 1;
    const leftIndex = priorities.indexOf(left.name.startsWith("drive.") ? left.name.slice(6) : left.name);
    const rightIndex = priorities.indexOf(right.name.startsWith("drive.") ? right.name.slice(6) : right.name);
    return (
      (leftIndex < 0 ? priorities.length : leftIndex) - (rightIndex < 0 ? priorities.length : rightIndex) ||
      left.name.localeCompare(right.name)
    );
  });
  return {
    tools: matches
      .slice(offset, offset + limit)
      .map((tool) => ({ name: tool.name, description: (tool.description ?? "").slice(0, 120) })),
    total: matches.length,
    offset,
    nextOffset: offset + limit < matches.length ? offset + limit : null,
    guidance: invocationGuidance,
  };
}

/** Retrieve a single full schema, without dumping unrelated tools. */
export async function getWpsToolSchema(
  context: WpsMcpContext,
  input: Record<string, unknown>,
): Promise<{ tool: Tool; guidance: string }> {
  const name = requiredString(input.toolName, "toolName", providerInputError);
  return withWpsMcpClient(context, async (client) => ({
    tool: selectTool(await discoverTools(client, context.signal), name),
    guidance: invocationGuidance,
  }));
}

/** Reject unknown names and invalid arguments before dispatching any external tool action. */
export async function callWpsTool(
  context: WpsMcpContext,
  input: Record<string, unknown>,
): Promise<{ result: Awaited<ReturnType<Client["callTool"]>> }> {
  const name = requiredString(input.toolName, "toolName", providerInputError);
  const args = optionalRecord(input.arguments) ?? {};
  return withWpsMcpClient(context, async (client) => {
    const tool = selectTool(await discoverTools(client, context.signal), name);
    const validation = argumentValidator.getValidator<Record<string, unknown>>(tool.inputSchema as JsonSchemaType)(
      args,
    );
    if (!validation.valid) {
      throw providerInputError(
        `Invalid arguments for ${name}. Retrieve wps_mcp.get_tool_schema and follow its required fields and types.`,
      );
    }
    return { result: await client.callTool({ name, arguments: args }, { signal: context.signal }) };
  });
}
