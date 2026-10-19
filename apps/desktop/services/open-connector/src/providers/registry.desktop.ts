import type { ExecutorModule } from "./provider-loader.ts";

/** 桌面仅加载推荐目录开放的 Provider，不导入其他第三方服务。 */
export const executorModules: Record<string, () => Promise<ExecutorModule>> = {
  qq_mail: () => import("./qq_mail/executors.ts"),
  netease_mail: () => import("./netease_mail/executors.ts"),
  amap: () => import("./amap/executors.ts"),
  wps_mcp: () => import("./wps_mcp/executors.ts"),
  youdao_note: () => import("./youdao_note/executors.ts"),
  ima: () => import("./ima/executors.ts"),
  qcc_mcp: () => import("./qcc_mcp/executors.ts"),
  eastmoney_mcp: () => import("./eastmoney_mcp/executors.ts"),
  ifind_mcp: () => import("./ifind_mcp/executors.ts"),
  aminer: () => import("./aminer/executors.ts"),
  wecom_bot: () => import("./wecom_bot/executors.ts"),
};
