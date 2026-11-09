import type { ProviderActionDefinition } from "../../core/provider-definition.ts";

import { jsonSchema as s } from "../../core/json-schema.ts";
import { defineProviderAction } from "../../core/provider-definition.ts";

const service = "tianyancha_mcp";
const annotations = s.looseObject("MCP tool behavior hints.", {
  title: s.optional(s.string("A human-readable title for the tool.")),
  readOnlyHint: s.optional(s.boolean("Whether the tool is read-only.")),
  destructiveHint: s.optional(s.boolean("Whether the tool may modify data.")),
  idempotentHint: s.optional(s.boolean("Whether repeated calls are idempotent.")),
  openWorldHint: s.optional(s.boolean("Whether the tool may contact external entities.")),
});
const tool = s.object("A tool currently exposed by Tianyancha MCP.", {
  name: s.nonEmptyString("The exact Tianyancha MCP tool name to call."),
  description: s.string("The current tool description supplied by Tianyancha."),
  annotations,
  inputSchema: s.looseObject("The current JSON Schema for the tool arguments."),
}, { optional: ["description", "annotations"] });

export const tianyanchaMcpActions: ProviderActionDefinition[] = [
  defineProviderAction(service, {
    name: "list_tools",
    description: "List the current tool catalog and live input schemas exposed by Tianyancha MCP.",
    requiredScopes: ["tianyancha_mcp.tools"],
    followUpActions: ["tianyancha_mcp.call_tool"],
    inputSchema: s.object("Input for discovering Tianyancha MCP tools.", {}),
    outputSchema: s.object("The current Tianyancha MCP tool catalog.", { tools: s.array("Tools currently exposed by Tianyancha MCP.", tool) }),
  }),
  defineProviderAction(service, {
    name: "call_tool",
    description: "Call a Tianyancha MCP tool after discovering its live schema.",
    requiredScopes: ["tianyancha_mcp.tools"],
    followUpActions: ["tianyancha_mcp.list_tools"],
    inputSchema: s.object("Input for invoking one Tianyancha MCP tool.", {
      toolName: s.nonEmptyString("The exact Tianyancha MCP tool name."),
      arguments: s.looseObject("Arguments matching the tool's input schema."),
    }, { optional: ["arguments"] }),
    outputSchema: s.object("The normalized Tianyancha MCP result.", { result: s.unknown("The MCP tool result.") }),
  }),
];
