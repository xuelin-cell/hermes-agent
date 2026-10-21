import type { ProviderDefinition } from "../../core/types.ts";

import { youdaoNoteActions } from "./actions.ts";

export const provider: ProviderDefinition = {
  service: "youdao_note",
  displayName: "Youdao Note",
  description:
    "List, search, read, create, update, move, and delete notes; create folders; and review todos through the official Youdao Note MCP service.",
  categories: ["Productivity", "Storage"],
  authTypes: ["api_key"],
  auth: [
    {
      type: "api_key",
      label: "Youdao Note API Key",
      placeholder: "Paste your Youdao Note API Key",
      description:
        "API Key sent to the official Youdao Note MCP service as x-api-key. Create a key at https://mopen.163.com after binding a phone number to your Youdao Note account.",
    },
  ],
  homepageUrl: "https://note.youdao.com",
  actions: youdaoNoteActions,
};
