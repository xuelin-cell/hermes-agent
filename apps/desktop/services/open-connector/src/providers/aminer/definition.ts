import type { ProviderDefinition } from "../../core/types.ts";

import { aminerActions } from "./actions.ts";

export const provider: ProviderDefinition = {
  service: "aminer",
  displayName: "AMiner 学术",
  description: "搜索和查询 AMiner 的论文、学者、机构、专利及期刊会议数据。",
  categories: ["数据", "研究"],
  authTypes: ["api_key"],
  auth: [
    {
      type: "api_key",
      label: "AMiner Auth Token",
      placeholder: "粘贴 AMiner Auth Token",
      description:
        "在 AMiner 开放平台控制台申请 Auth Token。OpenConnector 会通过 Authorization: Bearer 请求头访问 AMiner MCP。",
    },
  ],
  homepageUrl: "https://www.aminer.cn/open/docs?mcp=1",
  actions: aminerActions,
};
