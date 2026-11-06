import type { Client, JsonSchemaType, Tool } from "@modelcontextprotocol/client";
import type { WpsMcpContext } from "./skill-hub-client.ts";

import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/client/validators/cf-worker";
import { optionalRecord, optionalString, requiredString } from "../../core/cast.ts";
import { ProviderRequestError } from "../provider-runtime.ts";
import { withWpsMcpClient } from "./skill-hub-client.ts";

const argumentValidator = new CfWorkerJsonSchemaValidator();
const guidance = "Use get_tool_schema with an exact name from list_tools. Then call_tool with toolName and an arguments object. Do not guess tool names or retry uncertain writes.";
const keywords: Record<string, string> = {
  list_my_files: "root directory list files folders 我的云文档 根目录 列目录",
  list_files: "directory folder children list files 子目录 文件夹 列目录",
  search_files: "search files folders 搜索 文件 文件夹",
  read_file: "read document content 读取 文档 正文",
  create_file: "create document file 创建 文档",
  create_file_with_content: "create document content 创建 文档 内容",
};

async function discoverTools(client: Client, signal?: AbortSignal): Promise<Tool[]> {
  const tools: Tool[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await client.listTools(cursor ? { cursor } : {}, { signal });
    tools.push(...page.tools);
    cursor = page.nextCursor;
    if (cursor) {
      if (cursors.has(cursor) || cursors.size >= 100) throw new ProviderRequestError(502, "Kingsoft tool catalog pagination did not complete.");
      cursors.add(cursor);
    }
  } while (cursor);
  return tools;
}

function selectTool(tools: Tool[], name: string): Tool {
  const tool = tools.find(item => item.name === name);
  if (!tool) throw new ProviderRequestError(400, `Unknown Kingsoft tool: ${name}. Use wps_mcp.list_tools then wps_mcp.get_tool_schema.`, undefined, "invalid_input");
  return tool;
}

export async function listWpsToolSummaries(context: WpsMcpContext, input: Record<string, unknown>) {
  const query = optionalString(input.query)?.toLowerCase();
  const offset = input.offset === undefined ? 0 : Number(input.offset);
  const limit = input.limit === undefined ? 10 : Number(input.limit);
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 20) {
    throw new ProviderRequestError(400, "offset must be a non-negative integer and limit an integer from 1 to 20.", undefined, "invalid_input");
  }
  const terms = query?.split(/\s+/).filter(Boolean) ?? [];
  const matches = (await withWpsMcpClient(context, client => discoverTools(client, context.signal))).filter(tool => {
    const name = tool.name.startsWith("drive.") ? tool.name.slice(6) : tool.name;
    return terms.length === 0 || terms.some(term => `${tool.name} ${tool.description ?? ""} ${keywords[name] ?? ""}`.toLowerCase().includes(term));
  });
  matches.sort((left, right) => left.name.localeCompare(right.name));
  return {
    tools: matches.slice(offset, offset + limit).map(tool => ({ name: tool.name, description: (tool.description ?? "").slice(0, 120) })),
    total: matches.length, offset, nextOffset: offset + limit < matches.length ? offset + limit : null, guidance,
  };
}

export async function getWpsToolSchema(context: WpsMcpContext, input: Record<string, unknown>) {
  const toolName = requiredString(input.toolName, "toolName", message => new ProviderRequestError(400, message, undefined, "invalid_input"));
  return withWpsMcpClient(context, async client => ({ tool: selectTool(await discoverTools(client, context.signal), toolName), guidance }));
}

export async function callWpsTool(context: WpsMcpContext, input: Record<string, unknown>) {
  const toolName = requiredString(input.toolName, "toolName", message => new ProviderRequestError(400, message, undefined, "invalid_input"));
  const args = optionalRecord(input.arguments) ?? {};
  return withWpsMcpClient(context, async client => {
    const tool = selectTool(await discoverTools(client, context.signal), toolName);
    const validation = argumentValidator.getValidator<Record<string, unknown>>(tool.inputSchema as JsonSchemaType)(args);
    if (!validation.valid) throw new ProviderRequestError(400, `Invalid arguments for ${toolName}. Retrieve wps_mcp.get_tool_schema first.`, undefined, "invalid_input");
    return { result: await client.callTool({ name: toolName, arguments: args }, { signal: context.signal }) };
  });
}
