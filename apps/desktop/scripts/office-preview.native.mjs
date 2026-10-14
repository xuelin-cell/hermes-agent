import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { build } from 'esbuild'

// 真实 COM 可能复用当前 Office，必须由用户明确运行；默认不启动任何 Office。
if (!process.argv.includes('--run')) {
  process.stdout.write('未启动 Office。人工验收请运行：node scripts/office-preview.native.mjs --run\n')
  process.exit(0)
}
if (process.platform !== 'win32') {
  throw new Error('本夹具仅支持真实 Windows 主机')
}

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const output = await fs.mkdtemp(path.join(os.tmpdir(), 'hermes-office-native-'))
await build({
  entryPoints: ['detect', 'convert-com', 'com-scripts', 'run-process'].map(name =>
    path.join(desktop, 'electron', 'office-preview', name + '.ts')
  ),
  outdir: path.join(output, 'runtime'),
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  format: 'esm'
})
const { createOfficeDetector } = await import(pathToFileURL(path.join(output, 'runtime', 'detect.mjs')).href)
const { convertCom, officePowerShellCandidates } = await import(
  pathToFileURL(path.join(output, 'runtime', 'convert-com.mjs')).href
)
const { officeComScript, OFFICE_COM_CLEANUP } = await import(
  pathToFileURL(path.join(output, 'runtime', 'com-scripts.mjs')).href
)
const { runOfficeProcess } = await import(pathToFileURL(path.join(output, 'runtime', 'run-process.mjs')).href)
const available = await createOfficeDetector().get()
const extensions = { word: 'docx', slides: 'pptx', sheet: 'xlsx' }
const results = []

/** 实机生成原生文件及中文路径副本；全过程沿用正式归属、关闭和清理保护。 */
async function generateSample(program, kind) {
  const directory = await fs.mkdtemp(path.join(output, 'sample-'))
  const target = path.join(directory, 'sample.' + extensions[kind])
  const env = {
    ...process.env,
    OFFICE_PROGID: program.progId,
    OFFICE_PROGRAM: await fs.realpath(program.executable),
    OFFICE_PDF: target,
    OFFICE_OWNER: path.join(directory, 'owner.json')
  }
  let shell
  for (const candidate of officePowerShellCandidates(
    program.registryView,
    process.env.SystemRoot || 'C:\\Windows',
    process.arch
  )) {
    try {
      if ((await fs.stat(candidate)).isFile()) {
        shell = candidate
        break
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error
      }
    }
  }
  if (!shell) {
    throw new Error('没有匹配位数的 PowerShell')
  }
  const options = { env, cwd: directory, timeoutMs: 60000 }
  const generated = await runOfficeProcess(
    shell,
    [
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(officeComScript(kind, true), 'utf16le').toString('base64')
    ],
    options
  )
  const cleaned = await runOfficeProcess(
    shell,
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(OFFICE_COM_CLEANUP, 'utf16le').toString('base64')],
    options
  )
  if (cleaned.failure || JSON.parse(cleaned.stdout.trim()).ok !== true) {
    throw new Error('样例进程无法确认安全收尾，请保留目录并人工检查：' + directory)
  }
  const report = JSON.parse(generated.stdout.trim().split(/\r?\n/).at(-1))
  if (generated.failure || report.ok !== true) {
    throw new Error('原生样例生成失败：' + kind + '；记录保留在 ' + directory)
  }
  const chinese = path.join(output, "中文 示例's." + extensions[kind])
  await fs.copyFile(target, chinese)

  return chinese
}

try {
  for (const kind of Object.keys(extensions)) {
    const programs = available[kind].filter(program => program.provider !== 'libreoffice')
    if (!programs.length) {
      results.push({ kind, skipped: '本机没有对应的 COM 转换器' })
      continue
    }
    const source = await generateSample(programs[0], kind)
    for (const program of programs) {
      const work = await fs.mkdtemp(path.join(output, 'conversion-'))
      const result = await convertCom(program, source, work)
      results.push({ kind, provider: program.provider, registryView: program.registryView, source, ...result })
      process.stdout.write(JSON.stringify(results.at(-1)) + '\n')
      if (!result.ok && !result.cleanupSafe) {
        throw new Error('收尾不确定，已停止其它转换，请人工检查并保留 ' + work)
      }
    }
  }
} finally {
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(results, null, 2))
  process.stdout.write(
    '样例、PDF 与记录保留在：' + output + '\n请人工检查中文排版，以及原来打开的 Office 文档仍然存在。\n'
  )
}
