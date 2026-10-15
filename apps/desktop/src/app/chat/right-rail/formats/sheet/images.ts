import type { Image } from '@fortune-sheet/core'
import { strFromU8, strToU8 } from 'fflate'

import type { PreviewSheet } from './model'
import { attr, child, workbookDrawings, type WorkbookPackage } from './package'

const EMU_PER_PIXEL = 9525

const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp'
}

export interface PreviewImage {
  anchor: Element
  src: string
  crop: { left: number; top: number; right: number; bottom: number }
  rotation: number
  flipH: boolean
  flipV: boolean
}

/** 只接受包内位图，外链不请求；不支持或缺失的内嵌图片交给原有 PDF 候选。 */
export function readWorkbookImages(archive: WorkbookPackage) {
  const result = new Map<string, PreviewImage[]>()
  let count = 0
  let imageBytes = 0

  for (const { name, anchor, relations } of workbookDrawings(archive)) {
    const picture = child(anchor, 'pic')

    if (!picture) {
      continue
    }

    const fill = child(picture, 'blipFill')
    const blip = child(fill, 'blip')
    const embed = Array.from(blip?.attributes || []).find(attribute => attribute.localName === 'embed')?.value

    if (!embed) {
      continue
    } // 链接图像不属于文件内嵌内容。

    const part = relations.find(rel => rel.id === embed)?.target
    const bytes = part && archive.parts[part]
    const mime = MIME[part?.split('.').at(-1)?.toLowerCase() || '']

    if (!bytes || !mime) {
      throw { code: 'unsupported' }
    }

    imageBytes += bytes.length

    if (++count > 64 || imageBytes > 32 * 1024 * 1024) {
      throw { code: 'too_large' }
    }

    const rect = child(fill, 'srcRect')

    const crop = Object.fromEntries(
      ['left', 'top', 'right', 'bottom'].map(side => [
        side,
        Math.max(0, Math.min(0.99, Number(attr(rect, side[0]) || 0) / 100000))
      ])
    ) as PreviewImage['crop']

    if (!Object.values(crop).every(Number.isFinite) || crop.left + crop.right >= 1 || crop.top + crop.bottom >= 1) {
      throw { code: 'unsupported' }
    }

    const transform = child(child(picture, 'spPr'), 'xfrm')
    const rotation = Number(attr(transform, 'rot') || 0) / 60000

    if (!Number.isFinite(rotation)) {
      throw { code: 'unsupported' }
    }

    const images = result.get(name) || []
    images.push({
      anchor,
      src: `data:${mime};base64,${btoa(strFromU8(bytes, true))}`,
      crop,
      rotation,
      flipH: ['1', 'true'].includes(attr(transform, 'flipH') || ''),
      flipV: ['1', 'true'].includes(attr(transform, 'flipV') || '')
    })
    result.set(name, images)
  }

  return result
}

/** 隐藏行列不占位置，超出实际单元格区域仍按组件的尾部网格尺寸定位。 */
function offset(sizes: number[], hidden: number[], index: number, fallback: number) {
  if (!Number.isInteger(index) || index < 0 || index > 16384) {
    throw { code: 'unsupported' }
  }

  let value = 0
  const excluded = new Set(hidden)

  for (let item = 0; item < index; item++) {
    if (!excluded.has(item)) {
      value += sizes[item] || fallback
    }
  }

  return value
}

/** EMU 转为组件像素，保留单格、双格和绝对三种锚点。 */
export function drawingBox(anchor: Element, sheet: PreviewSheet) {
  if (anchor.localName !== 'absoluteAnchor' && Number(child(child(anchor, 'from'), 'row')?.textContent) >= 500) {
    return null
  }

  /** 单元格坐标和偏移仅作为数字读取，不执行文档属性。 */
  function marker(group: string, field: string) {
    const value = Number(child(child(anchor, group), field)?.textContent || 0)

    if (!Number.isFinite(value) || value < 0) {
      throw { code: 'unsupported' }
    }

    return value
  }

  const absolute = anchor.localName === 'absoluteAnchor'

  const pos = child(anchor, 'pos'),
    extent = child(anchor, 'ext')

  const left = absolute
    ? Number(attr(pos, 'x')) / EMU_PER_PIXEL
    : offset(sheet.columnWidths, sheet.hiddenColumns, marker('from', 'col'), 64) +
      marker('from', 'colOff') / EMU_PER_PIXEL

  const top = absolute
    ? Number(attr(pos, 'y')) / EMU_PER_PIXEL
    : offset(sheet.rowHeights, sheet.hiddenRows, marker('from', 'row'), 20) + marker('from', 'rowOff') / EMU_PER_PIXEL

  const right = extent
    ? left + Number(attr(extent, 'cx')) / EMU_PER_PIXEL
    : offset(sheet.columnWidths, sheet.hiddenColumns, marker('to', 'col'), 64) + marker('to', 'colOff') / EMU_PER_PIXEL

  const bottom = extent
    ? top + Number(attr(extent, 'cy')) / EMU_PER_PIXEL
    : offset(sheet.rowHeights, sheet.hiddenRows, marker('to', 'row'), 20) + marker('to', 'rowOff') / EMU_PER_PIXEL

  if (![left, top, right, bottom].every(Number.isFinite) || left < 0 || top < 0 || right <= left || bottom <= top) {
    throw { code: 'unsupported' }
  }

  if (top >= offset(sheet.rowHeights, sheet.hiddenRows, 500, 20)) {
    return null
  }

  const width = right - left,
    height = bottom - top

  if (width > 32768 || height > 32768 || width * height > 16 * 1024 * 1024) {
    throw { code: 'too_large' }
  }

  return { left, top, width, height }
}

/** 只生成自己的 SVG 容器，内部只有包内位图；不插入文件自带的 SVG 或 HTML。 */
function pictureSource(image: PreviewImage, width: number, height: number) {
  const { crop, rotation, flipH, flipV, src } = image

  if (!Object.values(crop).some(Boolean) && !rotation && !flipH && !flipV) {
    return src
  }

  const w = width / (1 - crop.left - crop.right),
    h = height / (1 - crop.top - crop.bottom)

  const transform = `translate(${width / 2} ${height / 2}) rotate(${rotation}) scale(${flipH ? -1 : 1} ${flipV ? -1 : 1}) translate(${-width / 2} ${-height / 2})`
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><defs><clipPath id="crop"><rect width="${width}" height="${height}"/></clipPath></defs><g clip-path="url(#crop)"><g transform="${transform}"><image xlink:href="${src}" x="${-crop.left * w}" y="${-crop.top * h}" width="${w}" height="${h}" preserveAspectRatio="none"/></g></g></svg>`

  return `data:image/svg+xml;base64,${btoa(strFromU8(strToU8(svg), true))}`
}

/** 图片只显示在前 500 行的可见区域；尺寸和位置随表格布局一起交给组件。 */
export function toFortuneImages(sheet: PreviewSheet, sheetIndex: number): Image[] {
  return (sheet.images || []).flatMap((image, index) => {
    const box = drawingBox(image.anchor, sheet)

    if (!box) {
      return []
    }

    return [{ id: `preview-image-${sheetIndex}-${index}`, ...box, src: pictureSource(image, box.width, box.height) }]
  })
}

/** 挂载前确认实际解码成功，损坏位图不能以空白图片冒充预览成功。 */
export async function validateWorkbookImages(sheets: PreviewSheet[]) {
  let pixels = 0

  for (const sheet of sheets) {
    for (const source of sheet.images || []) {
      const image = new globalThis.Image()
      image.src = source.src

      try {
        await image.decode()
      } catch {
        throw { code: 'unsupported' }
      }

      pixels += image.naturalWidth * image.naturalHeight

      if (pixels > 32 * 1024 * 1024) {
        throw { code: 'too_large' }
      }
    }
  }
}
