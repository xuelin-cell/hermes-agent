export const qccMcpResources = {
  company: {
    label: "Company",
    endpoint: "https://agent.qcc.com/mcp/company/stream",
  },
  risk: {
    label: "Risk",
    endpoint: "https://agent.qcc.com/mcp/risk/stream",
  },
  ipr: {
    label: "IPR",
    endpoint: "https://agent.qcc.com/mcp/ipr/stream",
  },
  operation: {
    label: "Operation",
    endpoint: "https://agent.qcc.com/mcp/operation/stream",
  },
  executive: {
    label: "Executive",
    endpoint: "https://agent.qcc.com/mcp/executive/stream",
  },
} as const;

export type QccMcpResourceKey = keyof typeof qccMcpResources;

export const qccMcpResourceKeys = Object.keys(qccMcpResources) as QccMcpResourceKey[];

export const qccMcpEntryResource: QccMcpResourceKey = "company";
