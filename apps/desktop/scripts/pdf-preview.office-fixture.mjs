import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

import { build } from 'esbuild'

/** 仅在显式 --office 验收中调用；使用没有现用实例的 MS Office，样例和缓存均留在独立目录。 */
export async function realOfficePdfs(root, desktop) {
  const powershell = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe')
  /** 只读核对现用程序；不借用用户窗口，不按名称结束任何进程。 */
  async function activeOffice() {
    const { stdout } = await promisify(execFile)(
      powershell,
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '@(Get-Process -Name WINWORD,POWERPNT -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id) | ConvertTo-Json -Compress'
      ],
      { windowsHide: true }
    )
    return stdout.trim() ? JSON.parse(stdout) : []
  }
  assert.deepEqual(await activeOffice(), [], '已有 Word/PPT 实例，停止真实转换验收，避免影响用户窗口')
  const entry = path.join(root, 'office-runtime.mjs')
  await build({
    stdin: {
      contents: `
    export {createOfficeDetector} from './electron/office-preview/detect'
    export {runComScript} from './electron/office-preview/convert-com'
    export {officeComScript} from './electron/office-preview/com-scripts'
    export {createOfficePreviewService} from './electron/office-preview/service'
  `,
      resolveDir: desktop
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile: entry
  })
  const { createOfficeDetector, runComScript, officeComScript, createOfficePreviewService } = await import(
    pathToFileURL(entry).href
  )
  const detected = await createOfficeDetector().get()
  // 此夹具刻意不走其它厂家回退，不能因 MS Office 失败而借用用户正在使用的 WPS。
  const programs = Object.fromEntries(
    Object.entries(detected).map(([kind, list]) => [kind, list.filter(program => program.provider === 'ms-office')])
  )
  const service = createOfficePreviewService(path.join(root, 'office-account'), {
    detector: {
      get: async () => programs,
      /** 固定本轮已核对的 MS Office 名单，禁止触发 WPS 回退。 */
      invalidate() {}
    }
  })
  const samples = [
    {
      kind: 'word',
      extension: 'docx',
      open: String.raw`
      $doc=$documents.Add($missing,$false,0,$false)
      $range=$doc.Content
      try {$range.Text=((1..4|ForEach-Object {"StageTwo Word page $_ 中文预览"}) -join [char]12)} finally {Release-OfficeObject $range; $range=$null}
    `,
      export: '[void]$doc.SaveAs($env:OFFICE_PDF,12)'
    },
    {
      kind: 'slides',
      extension: 'pptx',
      open: String.raw`
      $doc=$documents.Add(0); $setup=$doc.PageSetup
      $setup.SlideWidth=960; $setup.SlideHeight=540; Release-OfficeObject $setup; $setup=$null
      $slides=$doc.Slides
      try {
        foreach ($number in 1..24) {
          $slide=$slides.Add($number,12); $shapes=$slide.Shapes; $shape=$shapes.AddTextbox(1,40,40,800,100)
          $frame=$shape.TextFrame; $range=$frame.TextRange; $range.Text="StageTwo slide $number 中文预览"
          foreach ($ref in @($range,$frame,$shape,$shapes,$slide)) {Release-OfficeObject $ref}
          $range=$frame=$shape=$shapes=$slide=$null
        }
      } finally {Release-OfficeObject $slides; $slides=$null}
    `,
      export: '[void]$doc.SaveAs($env:OFFICE_PDF,24)'
    }
  ]
  const report = []
  const pdfs = {}
  try {
    for (const sample of samples) {
      const program = programs[sample.kind][0]
      assert.ok(program, '未检测到 MS Office ' + sample.kind)
      const directory = await fs.mkdtemp(path.join(root, 'office-sample-'))
      const source = path.join(root, `${sample.kind === 'word' ? 'word' : 'slides'}.${sample.extension}`)
      const generated = await runComScript(
        program,
        officeComScript(sample.kind, sample),
        { OFFICE_PDF: source },
        directory,
        60000
      )
      report.push({
        kind: sample.kind,
        progId: program.progId,
        source,
        generated,
        owner: JSON.parse(await fs.readFile(path.join(directory, 'owner.json'), 'utf8'))
      })
      assert.ok(generated.cleanupSafe, '样例生成无法确认收尾，停止其它转换：' + directory)
      assert.ok(generated.ok, '样例生成失败：' + directory)
      const converted = await service.convert(source)
      assert.equal(converted.ok, true, JSON.stringify(converted))
      pdfs[sample.kind] = converted.pdf
      await fs.writeFile(path.join(root, sample.kind + '-converted.pdf'), converted.pdf)
      Object.assign(report.at(-1), { converter: converted.converter, pdfBytes: converted.pdf.length })
      assert.deepEqual(await activeOffice(), [], '转换后仍有 Office 进程，停止其它转换并保留记录')
    }
    return pdfs
  } finally {
    await fs.writeFile(path.join(root, 'office-report.json'), JSON.stringify(report, null, 2))
  }
}
