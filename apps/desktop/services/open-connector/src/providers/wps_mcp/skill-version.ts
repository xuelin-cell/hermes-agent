import { optionalString } from "../../core/cast.ts";

const defaultWpsSkillVersion = "1.6.3";

/** Resolve the MCP integration version from internal configuration, including for existing connections. */
export function getWpsSkillVersion(): string {
  return optionalString(process.env.WPS_SKILL_VERSION) ?? defaultWpsSkillVersion;
}
