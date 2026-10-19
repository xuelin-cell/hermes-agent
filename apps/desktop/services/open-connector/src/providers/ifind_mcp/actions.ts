import type { ProviderActionDefinition } from "../../core/provider-definition.ts";

import { s } from "../../core/json-schema.ts";
import { defineProviderAction } from "../../core/provider-definition.ts";

const service = "ifind_mcp" as const;
const maxToolArgumentsBytes = 1_000_000;

export const ifindMcpServerTypes = ["finance", "enterprise", "law"] as const;

export type IfindMcpServerType = (typeof ifindMcpServerTypes)[number];

const serverTypeSchema = s.stringEnum("The iFinD MCP service that owns the requested tool.", [...ifindMcpServerTypes]);

const toolAnnotationsSchema = s.looseObject("MCP behavior hints supplied by iFinD.", {
  title: s.optional(s.string("A human-readable title for the tool.")),
  readOnlyHint: s.optional(s.boolean("Whether the tool is expected not to modify data.")),
  destructiveHint: s.optional(s.boolean("Whether the tool may perform destructive operations.")),
  idempotentHint: s.optional(
    s.boolean("Whether repeated calls with the same arguments are expected to be idempotent."),
  ),
  openWorldHint: s.optional(s.boolean("Whether the tool may interact with entities outside iFinD.")),
});

const toolSchema = s.object(
  "A tool currently exposed by one iFinD MCP service.",
  {
    name: s.nonEmptyString("The exact iFinD MCP tool name to pass to call_tool."),
    description: s.string("The current tool description supplied by iFinD MCP."),
    annotations: toolAnnotationsSchema,
    inputSchema: s.looseObject("The current JSON Schema for the tool arguments, supplied by iFinD MCP."),
  },
  { optional: ["description", "annotations"] },
);

const toolResultOutputSchema = s.object("The normalized result returned by the iFinD MCP tool.", {
  result: s.unknown(
    "The tool result. Structured MCP content is returned directly; otherwise the MCP content envelope is preserved.",
  ),
});

const toolArgumentsSchema = s.looseObject(
  `JSON arguments matching the inputSchema returned for the selected tool; serialized arguments must not exceed ${maxToolArgumentsBytes} bytes.`,
);

export const ifindMcpActions: readonly ProviderActionDefinition[] = [
  defineProviderAction(service, {
    name: "list_tools",
    description:
      "Discover the current iFinD tools and their live input schemas for financial data, enterprise information, or legal content.",
    followUpActions: ["ifind_mcp.call_tool"],
    inputSchema: s.object("The iFinD MCP service whose tools should be discovered.", {
      serverType: serverTypeSchema,
    }),
    outputSchema: s.object("The current tool catalog for one iFinD MCP service.", {
      serverType: serverTypeSchema,
      tools: s.array("Tools currently exposed by the selected iFinD MCP service.", toolSchema),
    }),
  }),
  defineProviderAction(service, {
    name: "call_tool",
    description: "Call a current iFinD MCP tool with JSON arguments after checking its live schema with list_tools.",
    followUpActions: ["ifind_mcp.list_tools"],
    inputSchema: s.object(
      "Input for invoking one current iFinD MCP tool.",
      {
        serverType: serverTypeSchema,
        toolName: s.nonEmptyString("The exact tool name returned by list_tools."),
        arguments: toolArgumentsSchema,
      },
      { optional: ["arguments"] },
    ),
    outputSchema: toolResultOutputSchema,
  }),
];
