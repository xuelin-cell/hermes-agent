// Browser build only: pdf.js behind the PDF viewer (pdf-preview.tsx), loaded
// with it the first time a PDF is opened. pdf.js's own viewer component does
// what is easy to get wrong: drawing only the pages near the view and letting
// the others go, the text layer that makes the text selectable, links, and the
// search with its highlights. The pane draws its own toolbar around it. pdf.js
// fetches its worker, CMaps, fonts and decoders by name: the build publishes
// them under assets/pdfjs-<version>/ (scripts/pdfjs-assets.mjs). The legacy
// build: the modern one runs only in the newest browsers.
import 'pdfjs-dist/legacy/web/pdf_viewer.css'
import './pdf-preview.css'

import {
  AnnotationEditorType,
  AnnotationMode,
  getDocument,
  GlobalWorkerOptions,
  PasswordResponses,
  type PDFDocumentProxy,
  PDFWorker,
  version
} from 'pdfjs-dist/legacy/build/pdf.mjs'
import {
  EventBus,
  FindState,
  LinkTarget,
  PDFFindController,
  PDFLinkService,
  PDFViewer
} from 'pdfjs-dist/legacy/web/pdf_viewer.mjs'

import type { PdfDocumentSource } from '@/lib/browser-shell'

import { clampZoom, fitScale, stepZoom } from './pdf-zoom'

const ASSETS = new URL(`${import.meta.env.BASE_URL}assets/pdfjs-${version}/`, window.location.href).href

GlobalWorkerOptions.workerSrc = `${ASSETS}pdf.worker.js`

// .pdfViewer's side padding (pdf-preview.css): the room a page is fitted into.
const SIDE_PADDING_PX = 16
// A wheel turn this big, or one counted in lines, is a mouse notch: one zoom
// step. Smaller ones come from a touchpad pinch and zoom smoothly.
const WHEEL_NOTCH_PX = 50
// While the wheel zooms, pages are stretched and drawn again once it stops.
const WHEEL_DRAWING_DELAY_MS = 400

export interface PdfFindResult {
  current: number
  status: 'found' | 'none' | 'pending'
  total: number
}

export interface PdfEngineEvents {
  /** The PDF could not be opened (pdf.js's exception: InvalidPDFException,
   * ResponseException …). */
  onError: (error: unknown) => void
  onFind: (result: PdfFindResult) => void
  /** The pages are laid out: how many there are. */
  onPages: (pages: number) => void
  /** The PDF needs a password: `retry` with one (`incorrect` after a wrong one). */
  onPassword: (retry: (password: string) => void, incorrect: boolean) => void
  onScale: (scale: number) => void
}

export interface PdfEngine {
  destroy: () => void
  /** No more searching: the highlights go. */
  endFind: () => void
  /** Search as the query is typed; `again` steps to the next (or `previous`) match. */
  find: (query: string, options?: { again?: boolean; previous?: boolean }) => void
  /** Back to the zoom that fits the pane, kept as the pane is resized. */
  fitWidth: () => void
  zoom: (direction: -1 | 1) => void
}

interface PageView {
  height: number
  scale: number
  width: number
}

interface MatchesCount {
  current: number
  total: number
}

let sharedWorker: null | PDFWorker = null

// One worker for every PDF in the pane, started with the first one opened.
function pdfWorker(): PDFWorker {
  if (!sharedWorker || sharedWorker.destroyed) {
    sharedWorker = new PDFWorker()
  }

  return sharedWorker
}

/** Show the PDF `source` in `container` (absolutely positioned, the one that
 * scrolls), drawing the pages into `viewerElement` (its only child). */
export function createPdfEngine(
  container: HTMLDivElement,
  viewerElement: HTMLDivElement,
  source: PdfDocumentSource,
  events: PdfEngineEvents
): PdfEngine {
  const lifetime = new AbortController()
  const eventBus = new EventBus()

  const linkService = new PDFLinkService({
    eventBus,
    externalLinkRel: 'noopener noreferrer nofollow',
    externalLinkTarget: LinkTarget.BLANK,
    ignoreDestinationZoom: true
  })

  // `abortSignal` is not in pdf.js's typings: the viewer stops watching the
  // container (resize, scroll) when it fires.
  const viewerOptions = {
    abortSignal: lifetime.signal,
    annotationEditorMode: AnnotationEditorType.DISABLE,
    annotationMode: AnnotationMode.ENABLE,
    container,
    eventBus,
    findController: new PDFFindController({ eventBus, linkService }),
    linkService,
    removePageBorders: true,
    viewer: viewerElement
  }

  const viewer = new PDFViewer(viewerOptions)
  let destroyed = false
  let fitting = true
  let pdf: null | PDFDocumentProxy = null
  let findStatus: PdfFindResult['status'] = 'pending'

  linkService.setViewer(viewer)

  // pdf.js keeps the reading position across a zoom by scrolling the page it was
  // on to the top, padding and all. At the start of the document that would hide
  // the gap above the first page, which the page viewer shows.
  const setScale = (scale: number) => {
    const atStart = container.scrollTop <= SIDE_PADDING_PX

    viewer.currentScale = scale

    if (atStart) {
      container.scrollTop = 0
    }
  }

  // The pages have no scale until one is set. A pane with no room yet (hidden)
  // shows them at 100% until it has some: the resize brings the fitting one.
  const fit = () => {
    const page = viewer.getPageView(0) as PageView | undefined
    const room = container.clientWidth - 2 * SIDE_PADDING_PX

    const scale =
      (page && fitScale(page.width / page.scale, page.height / page.scale, room)) || viewer.currentScale || 1

    if (Math.abs(scale - viewer.currentScale) > 0.001) {
      setScale(scale)
    }
  }

  // A wheel zoom keeps the point under the pointer where it is.
  const zoomTo = (scale: number, origin?: [number, number]) => {
    const current = viewer.currentScale

    fitting = false

    if (scale === current) {
      return
    }

    if (origin) {
      viewer.updateScale({ drawingDelay: WHEEL_DRAWING_DELAY_MS, origin, scaleFactor: scale / current })
    } else {
      setScale(scale)
    }
  }

  eventBus.on('pagesinit', () => {
    fit()
    events.onPages(viewer.pagesCount)
  })
  eventBus.on('scalechanging', ({ scale }: { scale: number }) => events.onScale(scale))
  eventBus.on('updatefindcontrolstate', ({ matchesCount, state }: { matchesCount: MatchesCount; state: number }) => {
    findStatus = state === FindState.PENDING ? 'pending' : state === FindState.NOT_FOUND ? 'none' : 'found'
    events.onFind({ ...matchesCount, status: findStatus })
  })
  eventBus.on('updatefindmatchescount', ({ matchesCount }: { matchesCount: MatchesCount }) =>
    events.onFind({ ...matchesCount, status: findStatus })
  )

  const resizes = new ResizeObserver(() => fitting && fit())

  resizes.observe(container)
  lifetime.signal.addEventListener('abort', () => resizes.disconnect())

  // Ctrl + wheel (and a touchpad pinch, which arrives as one) zooms the PDF
  // around the pointer rather than the whole page.
  container.addEventListener(
    'wheel',
    event => {
      if (!event.ctrlKey) {
        return
      }

      event.preventDefault()

      const current = viewer.currentScale
      const notch = event.deltaMode !== WheelEvent.DOM_DELTA_PIXEL || Math.abs(event.deltaY) >= WHEEL_NOTCH_PX

      zoomTo(
        notch ? stepZoom(current, event.deltaY < 0 ? 1 : -1) : clampZoom(current * Math.exp(-event.deltaY / 100)),
        [event.clientX, event.clientY]
      )
    },
    { passive: false, signal: lifetime.signal }
  )

  const task = getDocument({
    ...source,
    cMapUrl: `${ASSETS}cmaps/`,
    iccUrl: `${ASSETS}iccs/`,
    standardFontDataUrl: `${ASSETS}standard_fonts/`,
    wasmUrl: `${ASSETS}wasm/`,
    worker: pdfWorker()
  })

  task.onPassword = (retry: (password: string) => void, reason: number) =>
    events.onPassword(retry, reason === PasswordResponses.INCORRECT_PASSWORD)

  task.promise.then(
    loaded => {
      if (destroyed) {
        return
      }

      pdf = loaded
      viewer.setDocument(loaded)
      linkService.setDocument(loaded)
    },
    (error: unknown) => {
      if (!destroyed) {
        events.onError(error)
      }
    }
  )

  return {
    destroy: () => {
      destroyed = true
      lifetime.abort()

      if (pdf) {
        // pdf.js takes null to stop drawing and drop the pages; its typings do not.
        viewer.setDocument(null as unknown as PDFDocumentProxy)
        linkService.setDocument(null)
      }

      void task.destroy()
    },
    endFind: () => eventBus.dispatch('findbarclose', { source: null }),
    find: (query, { again = false, previous = false } = {}) =>
      eventBus.dispatch('find', {
        caseSensitive: false,
        entireWord: false,
        findPrevious: previous,
        highlightAll: true,
        matchDiacritics: false,
        query,
        source: null,
        type: again ? 'again' : ''
      }),
    fitWidth: () => {
      fitting = true
      fit()
    },
    zoom: direction => zoomTo(stepZoom(viewer.currentScale, direction))
  }
}
