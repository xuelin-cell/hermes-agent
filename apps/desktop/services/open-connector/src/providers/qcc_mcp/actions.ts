import type { ProviderActionDefinition } from "../../core/provider-definition.ts";

import { jsonSchema as s } from "../../core/json-schema.ts";
import { defineProviderAction } from "../../core/provider-definition.ts";
import { qccMcpResourceKeys } from "./resources.ts";

const service = "qcc_mcp";

const resourceSchema = s.stringEnum(
  "The Qichacha MCP resource group to inspect or call. Defaults to company.",
  qccMcpResourceKeys,
);

const toolAnnotationsSchema = s.looseObject("MCP behavior hints supplied by Qichacha for a tool.", {
  title: s.optional(s.string("A human-readable title for the tool.")),
  readOnlyHint: s.optional(s.boolean("Whether Qichacha expects the tool not to modify data.")),
  destructiveHint: s.optional(s.boolean("Whether Qichacha indicates that the tool may be destructive.")),
  idempotentHint: s.optional(s.boolean("Whether repeated calls with the same arguments are idempotent.")),
  openWorldHint: s.optional(s.boolean("Whether the tool may interact with external entities.")),
});

const mcpToolSummarySchema = s.object(
  "A tool currently exposed by Qichacha MCP.",
  {
    name: s.nonEmptyString("The exact Qichacha MCP tool name to pass to call_tool."),
    description: s.string("The current tool description supplied by Qichacha."),
    annotations: toolAnnotationsSchema,
    inputSchema: s.looseObject("The current JSON Schema for the tool arguments, supplied by Qichacha MCP."),
  },
  { optional: ["description", "annotations"] },
);

export const qccMcpActions: ProviderActionDefinition[] = [
  defineProviderAction(service, {
    name: "list_tools",
    description:
      "List the current tool catalog and live input schemas exposed by one Qichacha MCP resource group.",
    requiredScopes: ["qcc_mcp.tools"],
    followUpActions: ["qcc_mcp.call_tool"],
    inputSchema: s.object(
      "Input for discovering Qichacha MCP tools.",
      {
        resource: resourceSchema,
      },
      { optional: ["resource"] },
    ),
    outputSchema: s.object("The current Qichacha MCP tool catalog for the selected resource.", {
      resource: resourceSchema,
      tools: s.array("Tools currently exposed by the selected MCP resource.", mcpToolSummarySchema),
    }),
  }),
  defineProviderAction(service, {
    name: "call_tool",
    description:
      "Call a current Qichacha MCP tool with JSON arguments. Discover the live schema first, then choose the matching resource group before calling.",
    requiredScopes: ["qcc_mcp.tools"],
    followUpActions: ["qcc_mcp.list_tools"],
    inputSchema: s.object(
      "Input for invoking one current Qichacha MCP tool.",
      {
        resource: resourceSchema,
        toolName: s.nonEmptyString("The exact tool name returned by Qichacha MCP discovery."),
        arguments: s.looseObject("JSON arguments matching the current inputSchema for the selected Qichacha MCP tool."),
      },
      { optional: ["resource", "arguments"] },
    ),
    outputSchema: s.object("The normalized result returned by the Qichacha MCP tool.", {
      resource: resourceSchema,
      result: s.unknown("The current Qichacha MCP result after standard MCP content normalization."),
    }),
  }),
];
