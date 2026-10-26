export const DRIVE_MCP_SERVER = 'UniWork-Drive'
export const DRIVE_MCP_TOOL = 'download'
export const DRIVE_MCP_MANAGED = 'uniwork.desktop.drive.v1'

/** 名称与受管标记同时匹配，避免接管用户自己添加的同名 MCP。 */
export function isManagedDriveServer(name: string | null, entry: unknown): entry is Record<string, unknown> {
  return (
    name === DRIVE_MCP_SERVER &&
    !!entry &&
    typeof entry === 'object' &&
    !Array.isArray(entry) &&
    'uniwork_managed' in entry &&
    entry.uniwork_managed === DRIVE_MCP_MANAGED
  )
}
