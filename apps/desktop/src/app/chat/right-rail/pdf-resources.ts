import { GlobalWorkerOptions, version } from 'pdfjs-dist/legacy/build/pdf.mjs'

// PDF 分页查看器和 PPT 渲染共用同一套随包资源；不能由后加载的显示器改成另一份 Worker。
const base = new URL(`${import.meta.env.BASE_URL}assets/pdfjs-${version}/`, document.baseURI).href
GlobalWorkerOptions.workerSrc = `${base}pdf.worker.js`

export const PDF_RESOURCE_OPTIONS = {
  cMapUrl: `${base}cmaps/`,
  cMapPacked: true,
  iccUrl: `${base}iccs/`,
  standardFontDataUrl: `${base}standard_fonts/`,
  wasmUrl: `${base}wasm/`
}
