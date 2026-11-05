import type { ActionDefinition } from "../../core/types.ts";

import { s } from "../../core/json-schema.ts";
import { defineProviderAction } from "../../core/provider-definition.ts";

export const wpsMcpActions: ActionDefinition[] = [
  defineProviderAction("wps_mcp", {
    name: "list_tools",
    description:
      "Search or browse a compact, paginated catalog of official Kingsoft MCP tools. Search list_my_files for root listing (我的云文档根目录) or list_files for folder children; preserve the exact name and prefix returned. Use get_tool_schema for exact parameters. Do not search local skills, configure mcporter, or guess tool names.",
    inputSchema: s.object(
      "Search and pagination for official tools, not cloud files.",
      {
        query: s.string("Optional keyword or exact tool name, such as list_my_files, directory, 目录 or sheet."),
        offset: s.number("Zero-based position in the filtered tool catalog. Defaults to 0.", { minimum: 0 }),
        limit: s.number("Number of compact tool summaries, from 1 to 20. Defaults to 10.", { minimum: 1, maximum: 20 }),
      },
      { optional: ["query", "offset", "limit"] },
    ),
    outputSchema: s.object("The current Kingsoft MCP tool catalog.", {
      tools: s.array(
        "Compact names and descriptions, without parameter schemas.",
        s.looseObject("An official tool summary."),
      ),
      total: s.number("Number of matching tools."),
      offset: s.number("Current offset."),
      nextOffset: s.unknown("Next page offset, or null when complete."),
      guidance: s.string("How to retrieve parameters and call the selected tool."),
    }),
    followUpActions: ["wps_mcp.get_tool_schema", "wps_mcp.call_tool"],
  }),
  defineProviderAction("wps_mcp", {
    name: "get_tool_schema",
    description:
      'Get the business parameter schema for one upstream Kingsoft tool. Required input: {"toolName":"create_folder"}, replacing create_folder with the exact discovered name. Never pass {}. This does not inspect local connector actions such as wps_mcp.call_tool: use get_action_guide with that actionId instead. Tool names and prefixes must match discovery exactly.',
    inputSchema: s.object("One discovered official tool.", {
      toolName: s.nonEmptyString(
        "Required upstream tool name returned by list_tools, e.g. create_folder; not the local action call_tool.",
      ),
    }),
    outputSchema: s.object("The selected official tool, including its full inputSchema.", {
      tool: s.looseObject("Official MCP tool definition."),
      guidance: s.string("How to wrap business arguments in a connector execution request."),
    }),
    followUpActions: ["wps_mcp.call_tool"],
  }),
  defineProviderAction("wps_mcp", {
    name: "call_tool",
    description:
      'Execute a discovered upstream Kingsoft tool. Input shape: {"toolName":"create_folder","arguments":{"name":"Project Materials"}}. The outer selector is toolName, never name; business fields such as a folder name go inside arguments. Check the selected tool schema first and preserve its exact name. To inspect this connector action use get_action_guide({"actionId":"wps_mcp.call_tool"}), not get_tool_schema. Do not retry uncertain writes automatically.',
    inputSchema: s.object(
      "An official tool invocation.",
      {
        toolName: s.nonEmptyString(
          "Required outer selector for the upstream tool, e.g. create_folder. Do not rename this field to name.",
        ),
        arguments: s.looseObject(
          "Business arguments matching the selected tool's inputSchema. A folder's name belongs here as arguments.name, not in the outer input.",
        ),
      },
      { optional: ["arguments"] },
    ),
    outputSchema: s.object("The official tool result.", { result: s.unknown("MCP tool result.") }),
    followUpActions: ["wps_mcp.list_tools", "wps_mcp.get_tool_schema"],
  }),
];
