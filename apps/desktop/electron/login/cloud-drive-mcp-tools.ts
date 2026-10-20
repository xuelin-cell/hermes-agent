/** 云盘连接器与数字员工保持同一组动作，桌面仅额外兼容历史下载文件名参数。 */
interface Field {
  type: 'string' | 'integer' | 'array'
  description?: string
  minLength?: number
  maxLength?: number
  minimum?: number
  maximum?: number
  enum?: string[]
  default?: string | number
  minItems?: number
  maxItems?: number
  items?: Field
}

const id: Field = { type: 'string', minLength: 1, maxLength: 512 }
const name: Field = { type: 'string', minLength: 1, maxLength: 255 }
const ids: Field = { type: 'array', items: id, minItems: 1, maxItems: 100 }
const selection: Field = { ...ids, minItems: 0 }
const parent: Field = { ...id, default: '0' }

const page = {
  page_no: { type: 'integer', minimum: 1, maximum: 1_000_000, default: 1 } as Field,
  page_size: { type: 'integer', minimum: 1, maximum: 200, default: 50 } as Field
}

/** 描述和实际参数校验共用字段定义，不能透传任意路由、空间或认证头。 */
function tool(
  name: string,
  description: string,
  properties: Record<string, Field>,
  required: string[],
  readOnlyHint = true,
  destructiveHint = false
) {
  return {
    name,
    description,
    inputSchema: { type: 'object', properties, required, additionalProperties: false },
    annotations: { readOnlyHint, destructiveHint, idempotentHint: readOnlyHint, openWorldHint: true }
  }
}

export const DRIVE_MCP_TOOLS = [
  tool(
    'list_files',
    '列出个人云盘指定目录的文件和文件夹，根目录 ID 为 0。',
    {
      space_id: { type: 'string', enum: ['personal'], default: 'personal' },
      parent_asset_id: parent,
      ...page,
      sort: { type: 'string', enum: ['name_asc', 'modified_desc'], default: 'name_asc' }
    },
    []
  ),
  tool(
    'filesearch',
    '按名称搜索个人云盘文件，等待后台全盘搜索完成后返回分页结果，最多约 11 分钟。',
    { query: { ...id, maxLength: 1000 }, ...page },
    ['query']
  ),
  tool('make_dir', '在个人云盘中创建文件夹。', { parent_asset_id: parent, name }, ['name'], false),
  tool(
    'rename_file',
    '重命名云盘文件或文件夹。',
    { asset_id: id, new_name: name, kind: { type: 'string', enum: ['file', 'directory'] } },
    ['asset_id', 'new_name', 'kind'],
    false
  ),
  tool(
    'move_files',
    '将云盘文件和文件夹移动到目标目录；至少提供一组非空 ID。',
    { file_ids: selection, directory_ids: selection, target_parent_asset_id: id },
    ['target_parent_asset_id'],
    false
  ),
  tool(
    'delete_files',
    '删除个人云盘资料。trash（默认）按 file_ids/directory_ids 移入回收站；purge 按 list_recycle_bin 返回的 delete_nos 彻底删除，不可恢复。结果未知时先查询确认，不要直接重试。',
    {
      mode: { type: 'string', enum: ['trash', 'purge'], default: 'trash' },
      file_ids: selection,
      directory_ids: selection,
      delete_nos: ids
    },
    [],
    false,
    true
  ),
  tool('get_file_info', '获取云盘文件名称、大小、父目录和时间等详情。', { asset_id: id }, ['asset_id']),
  tool('list_recycle_bin', '列出个人回收站，delete_no 用于恢复或彻底删除。', page, []),
  tool('restore_files', '按回收站 delete_no 恢复文件或文件夹到原位置。', { delete_nos: ids }, ['delete_nos'], false),
  tool('get_capacity', '查询个人云盘总容量和已用容量。', {}, []),
  tool(
    'download',
    '下载当前桌面账号的云盘文件到账号工作区，完成后返回本机 path。读取云盘引用前先调用此工具，再读取 path；仅适用于与桌面同机的 Hermes。',
    { asset_id: id, name: { ...name, description: '可选；省略时从文件详情获取。' } },
    ['asset_id'],
    false
  ),
  tool(
    'upload',
    '将当前机器上的任务文件或附件上传到个人云盘；相对路径基于账号工作区。禁止上传凭据等敏感文件。结果未知时先查询确认，不要直接重试。',
    { source_path: { ...id, maxLength: 4096 }, parent_asset_id: parent },
    ['source_path'],
    false
  )
]

export type DriveMcpInput = Record<string, string | number | string[]>

/** 只支持上述浅层业务参数，不引入通用 schema 解释器。 */
function validField(field: Field, value: unknown): boolean {
  if (field.type === 'string') {
    return (
      typeof value === 'string' &&
      !!value.trim() &&
      !Array.from(value).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) &&
      value.length >= (field.minLength ?? 1) &&
      value.length <= (field.maxLength ?? 512) &&
      (!field.enum || field.enum.includes(value))
    )
  }

  if (field.type === 'integer') {
    return (
      typeof value === 'number' && Number.isSafeInteger(value) && value >= field.minimum! && value <= field.maximum!
    )
  }

  return (
    Array.isArray(value) &&
    value.length >= field.minItems! &&
    value.length <= field.maxItems! &&
    value.every(item => validField(field.items!, item)) &&
    new Set(value).size === value.length
  )
}

/** 拒绝未声明字段与互斥选择，写操作必须在请求前完成校验。 */
export function parseDriveMcpInput(name: string, args: unknown): DriveMcpInput | null {
  const entry = DRIVE_MCP_TOOLS.find(tool => tool.name === name)

  if (!entry || !args || typeof args !== 'object' || Array.isArray(args)) {
    return null
  }

  const fields = entry.inputSchema.properties
  const input = args as Record<string, unknown>

  if (
    entry.inputSchema.required.some(key => !Object.hasOwn(input, key)) ||
    Object.entries(input).some(([key, value]) => !Object.hasOwn(fields, key) || !validField(fields[key], value))
  ) {
    return null
  }

  const result: DriveMcpInput = {}

  for (const [key, field] of Object.entries(fields)) {
    if (Object.hasOwn(input, key)) {
      result[key] = input[key] as string | number | string[]
    } else if (field.default !== undefined) {
      result[key] = field.default
    }
  }

  const selected = ((result.file_ids ?? []) as string[]).length + ((result.directory_ids ?? []) as string[]).length

  if (name === 'move_files' && !selected) {
    return null
  }

  if (name === 'delete_files') {
    if (result.mode === 'purge' ? !result.delete_nos || !!selected : !!result.delete_nos || !selected) {
      return null
    }
  }

  return result
}
