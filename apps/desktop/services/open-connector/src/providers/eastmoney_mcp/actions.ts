import type { ProviderActionDefinition } from "../../core/provider-definition.ts";

import { jsonSchema as s } from "../../core/json-schema.ts";
import { defineProviderAction } from "../../core/provider-definition.ts";

const service = "eastmoney_mcp";

const toolAnnotationsSchema = s.looseObject("MCP behavior hints supplied by Eastmoney for a tool.", {
  title: s.optional(s.string("A human-readable title for the tool.")),
  readOnlyHint: s.optional(s.boolean("Whether Eastmoney expects the tool not to modify data.")),
  destructiveHint: s.optional(s.boolean("Whether Eastmoney indicates that the tool may be destructive.")),
  idempotentHint: s.optional(s.boolean("Whether repeated calls with the same arguments are idempotent.")),
  openWorldHint: s.optional(s.boolean("Whether the tool may interact with external entities.")),
});

const mcpToolSummarySchema = s.object(
  "A tool currently exposed by Eastmoney MCP.",
  {
    name: s.nonEmptyString("The exact Eastmoney MCP tool name to pass to call_tool."),
    description: s.string("The current tool description supplied by Eastmoney."),
    annotations: toolAnnotationsSchema,
    inputSchema: s.looseObject("The current JSON Schema for the tool arguments, supplied by Eastmoney MCP."),
  },
  { optional: ["description", "annotations"] },
);

export const eastmoneyMcpActions: ProviderActionDefinition[] = [
  defineProviderAction(service, {
    name: "list_tools",
    description:
      "List the current tool catalog and live input schemas exposed by Eastmoney Choice-data MCP.",
    requiredScopes: ["eastmoney_mcp.tools"],
    followUpActions: ["eastmoney_mcp.call_tool"],
    inputSchema: s.object("Input for discovering Eastmoney MCP tools.", {}),
    outputSchema: s.object("The current Eastmoney MCP tool catalog.", {
      tools: s.array("Tools currently exposed by Eastmoney MCP.", mcpToolSummarySchema),
    }),
  }),
  defineProviderAction(service, {
    name: "call_tool",
    description:
      "Call a current Eastmoney MCP tool with JSON arguments. Discover the live schema first, then call the matching tool.",
    requiredScopes: ["eastmoney_mcp.tools"],
    followUpActions: ["eastmoney_mcp.list_tools"],
    inputSchema: s.object(
      "Input for invoking one current Eastmoney MCP tool.",
      {
        toolName: s.nonEmptyString("The exact tool name returned by Eastmoney MCP discovery."),
        arguments: s.looseObject("JSON arguments matching the current inputSchema for the selected Eastmoney MCP tool."),
      },
      { optional: ["arguments"] },
    ),
    outputSchema: s.object("The normalized result returned by the Eastmoney MCP tool.", {
      result: s.unknown("The current Eastmoney MCP result after standard MCP content normalization."),
    }),
  }),
];
