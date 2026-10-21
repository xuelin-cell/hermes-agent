import type { ActionDefinition } from "../../core/types.ts";

import { s } from "../../core/json-schema.ts";
import { defineProviderAction } from "../../core/provider-definition.ts";

const service = "youdao_note";

const toolAnnotationsSchema = s.looseObject("MCP behavior hints supplied by Youdao Note.", {
  title: s.optional(s.string("A human-readable title for the tool.")),
  readOnlyHint: s.optional(s.boolean("Whether the tool is expected not to modify data.")),
  destructiveHint: s.optional(s.boolean("Whether the tool may modify or delete data.")),
  idempotentHint: s.optional(s.boolean("Whether repeated calls are expected to be idempotent.")),
  openWorldHint: s.optional(s.boolean("Whether the tool may interact with external entities.")),
});

const mcpToolSummarySchema = s.object(
  "A tool currently exposed by the connected Youdao Note account.",
  {
    name: s.nonEmptyString("The exact MCP tool name to pass to call_tool."),
    description: s.string("The tool description supplied by Youdao Note."),
    annotations: toolAnnotationsSchema,
    inputSchema: s.looseObject("The live JSON Schema for this tool's arguments."),
  },
  { optional: ["description", "annotations"] },
);

const toolResultSchema = s.object("The result returned by the official Youdao Note MCP tool.", {
  result: s.unknown("Structured data or text returned by Youdao Note."),
});

const noteFileId = s.nonEmptyString(
  "The note file ID from list_notes or search_notes. The selected entry must have dir=false.",
);

const parentId = s.nonEmptyString(
  'The destination folder ID. Use "0" for the root directory or a folder ID returned by list_notes.',
);

export const youdaoNoteActions: ActionDefinition[] = [
  defineProviderAction(service, {
    name: "list_notes",
    description: "List notes and folders directly inside a Youdao Note directory, with cursor pagination.",
    requiredScopes: [],
    inputSchema: s.object(
      "The directory and optional pagination cursor.",
      {
        parentId,
        lastId: s.optional(
          s.nonEmptyString("The last entry ID from the previous page. Omit it when requesting the first page."),
        ),
      },
      { required: ["parentId"], optional: ["lastId"] },
    ),
    outputSchema: toolResultSchema,
  }),
  defineProviderAction(service, {
    name: "search_notes",
    description: "Search Youdao Note titles and content. Results are returned in pages of 15 entries.",
    requiredScopes: [],
    inputSchema: s.object(
      "The note search query and optional zero-based page offset.",
      {
        keyword: s.nonWhitespaceString("The text to search for in note titles and content."),
        startIndex: s.optional(
          s.nonNegativeInteger("The result offset. Use 0 for the first page, 15 for the second, and so on."),
        ),
      },
      { required: ["keyword"], optional: ["startIndex"] },
    ),
    outputSchema: toolResultSchema,
  }),
  defineProviderAction(service, {
    name: "get_note_content",
    description: "Read the text content of one Youdao note by its file ID.",
    requiredScopes: [],
    inputSchema: s.object("The note to read.", { fileId: noteFileId }),
    outputSchema: toolResultSchema,
  }),
  defineProviderAction(service, {
    name: "get_recent_favorites",
    description:
      "List recently favorited Youdao notes, including their text content. This does not list recently updated notes.",
    requiredScopes: [],
    inputSchema: s.object(
      "The number of recently favorited notes to return.",
      { limit: s.optional(s.integer("The maximum number of notes to return.", { minimum: 1, maximum: 50 })) },
      { optional: ["limit"] },
    ),
    outputSchema: toolResultSchema,
  }),
  defineProviderAction(service, {
    name: "create_note",
    description: "Create a Youdao note in the default location or a selected folder.",
    requiredScopes: [],
    inputSchema: s.object(
      "The new note's title, content, and optional destination folder.",
      {
        title: s.nonWhitespaceString(
          'The note title, up to 80 characters. Do not include \\, /, :, *, ?, ", <, >, or |.',
          { maxLength: 80 },
        ),
        content: s.optional(s.string("The note content. Omit it to create an empty note.")),
        parentId: s.optional(parentId),
      },
      { required: ["title"], optional: ["content", "parentId"] },
    ),
    outputSchema: toolResultSchema,
  }),
  defineProviderAction(service, {
    name: "update_markdown_note",
    description: "Replace the complete content of an existing Markdown note and optionally rename it.",
    requiredScopes: [],
    inputSchema: s.object(
      "The Markdown note and its complete replacement content.",
      {
        fileId: noteFileId,
        content: s.string("The complete Markdown content that will replace the existing note content."),
        title: s.optional(s.nonWhitespaceString("An optional replacement title ending in .md.")),
      },
      { required: ["fileId", "content"], optional: ["title"] },
    ),
    outputSchema: toolResultSchema,
  }),
  defineProviderAction(service, {
    name: "rename_note",
    description: "Rename a Youdao note. Folders cannot be renamed with this action.",
    requiredScopes: [],
    inputSchema: s.object("The note and its new title.", {
      fileId: noteFileId,
      newTitle: s.nonWhitespaceString("The new note title. Do not include path separators."),
    }),
    outputSchema: toolResultSchema,
  }),
  defineProviderAction(service, {
    name: "move_note",
    description: "Move a Youdao note into another directory. Only entries with dir=false can be moved.",
    requiredScopes: [],
    inputSchema: s.object("The note and destination directory.", {
      fileId: noteFileId,
      targetParentId: parentId,
    }),
    outputSchema: toolResultSchema,
  }),
  defineProviderAction(service, {
    name: "delete_note",
    description: "Delete one Youdao note by file ID. Folders cannot be deleted with this action.",
    requiredScopes: [],
    inputSchema: s.object("The note to delete.", { fileId: noteFileId }),
    outputSchema: toolResultSchema,
  }),
  defineProviderAction(service, {
    name: "create_folder",
    description: "Create a folder inside a selected Youdao Note directory.",
    requiredScopes: [],
    inputSchema: s.object("The parent directory and new folder name.", {
      parentId,
      dirName: s.nonWhitespaceString("The new folder name."),
    }),
    outputSchema: toolResultSchema,
  }),
  defineProviderAction(service, {
    name: "list_todos",
    description: "List all Youdao Note todos or only todos in one group.",
    requiredScopes: [],
    inputSchema: s.object(
      "An optional todo group filter.",
      { groupId: s.optional(s.nonEmptyString("The todo group ID. Omit it to list todos from all groups.")) },
      { optional: ["groupId"] },
    ),
    outputSchema: toolResultSchema,
  }),
  defineProviderAction(service, {
    name: "list_tools",
    description: "Discover advanced Youdao Note MCP tools that do not already have a direct OpenConnector action.",
    requiredScopes: [],
    inputSchema: s.object("No input is required.", {}),
    outputSchema: s.object("The current Youdao Note MCP tool catalog.", {
      tools: s.array("Tools currently exposed to the connected account.", mcpToolSummarySchema),
    }),
  }),
  defineProviderAction(service, {
    name: "call_tool",
    description:
      "Call an advanced Youdao Note MCP tool after using list_tools to inspect its exact name and arguments. Prefer direct actions for common note operations.",
    requiredScopes: [],
    inputSchema: s.object(
      "Input for invoking one current Youdao Note MCP tool.",
      {
        toolName: s.nonEmptyString("The exact tool name returned by list_tools."),
        arguments: s.looseObject("JSON arguments matching the tool's live inputSchema."),
      },
      { optional: ["arguments"] },
    ),
    outputSchema: s.object("The normalized result returned by Youdao Note.", {
      result: s.unknown("Structured MCP content, parsed JSON/text, or the original MCP content envelope."),
    }),
  }),
];
