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
  entryPoints: ['detect', 'convert-com', 'com-scripts'].map(name =>
    path.join(desktop, 'electron', 'office-preview', name + '.ts')
  ),
  outdir: path.join(output, 'runtime'),
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  format: 'esm'
})
const runtime = name => import(pathToFileURL(path.join(output, 'runtime', name + '.mjs')).href)
const { createOfficeDetector } = await runtime('detect')
const { convertCom, runComScript } = await runtime('convert-com')
const { officeComScript } = await runtime('com-scripts')
const available = await createOfficeDetector().get()
const results = []

// 用正式转换脚本的同一套启动、归属和收尾流程生成样例，只替换打开和导出两步。
const WORD_TEXT =
  '$doc=$documents.Add($missing,$false,0,$false); $range=$doc.Content; try {$range.Text="中文 Office 预览测试"} finally {Release-OfficeObject $range; $range=$null}'
const SHEET_TEXT =
  '$doc=$documents.Add(); $worksheets=$doc.Worksheets; $sheet=$worksheets.Item(1); $cells=$sheet.Cells; $first=$cells.Item(1,1); $second=$cells.Item(2,1); $first.Value2="中文表格预览测试"; $second.Value2=12345; foreach ($ref in @($second,$first,$cells,$sheet,$worksheets)) {Release-OfficeObject $ref}; $second=$first=$cells=$sheet=$worksheets=$null'
const SAMPLES = {
  word: { extension: 'docx', open: WORD_TEXT, export: '[void]$doc.SaveAs($env:OFFICE_PDF,12)' },
  slides: {
    extension: 'pptx',
    open: '$doc=$documents.Add(0); $slides=$doc.Slides; $slide=$slides.Add(1,12); $shapes=$slide.Shapes; $shape=$shapes.AddTextbox(1,40,40,640,100); $frame=$shape.TextFrame; $range=$frame.TextRange; $range.Text="中文幻灯片预览测试"; foreach ($ref in @($range,$frame,$shape,$shapes,$slide,$slides)) {Release-OfficeObject $ref}; $range=$frame=$shape=$shapes=$slide=$slides=$null',
    export: '[void]$doc.SaveAs($env:OFFICE_PDF,24)'
  },
  sheet: { extension: 'xlsx', open: SHEET_TEXT, export: '[void]$doc.SaveAs($env:OFFICE_PDF,51)' }
}
// 加了打开密码的样例：新格式会变成 OLE 文件，旧格式靠占位密码让 Office 直接报错，两者都不应等到超时。
const ENCRYPTED = {
  word: [
    { extension: 'docx', open: WORD_TEXT, export: '[void]$doc.SaveAs2($env:OFFICE_PDF,12,$false,"hermes")' },
    { extension: 'doc', open: WORD_TEXT, export: '[void]$doc.SaveAs2($env:OFFICE_PDF,0,$false,"hermes")' }
  ],
  sheet: [{ extension: 'xls', open: SHEET_TEXT, export: '$doc.Password="hermes"; [void]$doc.SaveAs($env:OFFICE_PDF,56)' }],
  slides: []
}

/** 实机生成原生样例并复制到中文文件名；收尾不确定时停止，保留目录供检查。 */
async function generateSample(program, kind, sample, label) {
  const directory = await fs.mkdtemp(path.join(output, 'sample-'))
  const target = path.join(directory, 'sample.' + sample.extension)
  const started = performance.now()
  const outcome = await runComScript(program, officeComScript(kind, sample), { OFFICE_PDF: target }, directory, 60000)
  const owner = await fs.readFile(path.join(directory, 'owner.json'), 'utf8').then(JSON.parse, () => null)
  const diagnostic = { operation: 'sample', label, kind, provider: program.provider, progId: program.progId, elapsedMs: Math.round(performance.now() - started), ...outcome, owner }
  results.push(diagnostic)
  process.stdout.write(JSON.stringify(diagnostic) + '\n')
  if (!outcome.cleanupSafe) {
    throw new Error('样例进程无法确认安全收尾，请保留目录并人工检查：' + directory)
  }
  if (!outcome.ok) {
    throw new Error('原生样例生成失败：' + label + '；记录保留在 ' + directory)
  }
  const chinese = path.join(output, `中文 ${label}'s.` + sample.extension)
  await fs.copyFile(target, chinese)

  return chinese
}

/** 用每个可用厂家转换同一份样例；收尾不确定时停止其它转换。 */
async function convertWithEach(programs, kind, source, label, timeoutMs) {
  for (const program of programs) {
    const work = await fs.mkdtemp(path.join(output, 'conversion-'))
    const started = performance.now()
    const result = await convertCom(program, source, work, timeoutMs)
    const owner = await fs.readdir(work).then(
      ([attempt]) => attempt && fs.readFile(path.join(work, attempt, 'owner.json'), 'utf8').then(JSON.parse, () => null),
      () => null
    )
    results.push({ operation: 'convert', label, kind, provider: program.provider, registryView: program.registryView, source, elapsedMs: Math.round(performance.now() - started), ...result, owner })
    process.stdout.write(JSON.stringify(results.at(-1)) + '\n')
    if (!result.ok && !result.cleanupSafe) {
      throw new Error('收尾不确定，已停止其它转换，请人工检查并保留 ' + work)
    }
  }
}

try {
  for (const kind of Object.keys(SAMPLES)) {
    const programs = available[kind].filter(program => program.provider !== 'libreoffice')
    if (!programs.length) {
      results.push({ kind, skipped: '本机没有对应的 COM 转换器' })
      continue
    }
    await convertWithEach(programs, kind, await generateSample(programs[0], kind, SAMPLES[kind], kind), kind, undefined)
    for (const sample of ENCRYPTED[kind]) {
      const label = `${kind}-encrypted-${sample.extension}`
      await convertWithEach(programs, kind, await generateSample(programs[0], kind, sample, label), label, 60000)
    }
  }
} finally {
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(results, null, 2))
  process.stdout.write(
    '验收文件与报告保留在：' + output + '\n' +
    (results.some(result => result.operation === 'convert' && result.ok === true)
      ? '请检查成功转换的 PDF 中文排版，以及原来打开的 Office 文档仍然存在。\n'
      : '本次没有成功转换的 PDF，请保留报告并检查前面的失败诊断。\n')
  )
}
