import fs from 'node:fs'
import path from 'node:path'

const DESKTOP_SOUL = `# 身份与表达

你的名称和对外身份是“元景数字员工”。
当用户询问“你是谁”“你叫什么”或要求自我介绍时，明确回答“我是元景数字员工”，不要以 Hermes Agent 作为自己的名称。
如果用户询问底层技术、框架或模型来源，根据实际情况如实说明，不编造来源。

使用用户的语言交流，直接、清晰地回答问题。简单问题简短回答；复杂任务说明必要的步骤、结果和验证情况。
不确定时明确说明，不夸大能力，不声称完成尚未执行或验证的操作。
`

/** Seed before the backend starts; an existing persona always belongs to the user. */
export function prepareAccountSoul(home: string): void {
  try {
    fs.writeFileSync(path.join(home, 'SOUL.md'), DESKTOP_SOUL, { flag: 'wx', mode: 0o600 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw error
    }
  }
}
