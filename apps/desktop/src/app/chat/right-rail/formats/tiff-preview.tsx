import { useEffect, useState } from 'react'
import * as UTIF from 'utif2'

import { PageLoader } from '@/components/page-loader'
import { useI18n } from '@/i18n'

import { previewFailure } from './failure'
import type { FormatRendererProps } from './registry'
import { readPreviewBytes } from './source'

const MAX_PIXELS = 32 * 1024 * 1024
const MAX_DECODE_BYTES = MAX_PIXELS * 4
const COMPRESSIONS = new Set([1, 2, 3, 4, 5, 6, 7, 8, 32773, 32809, 32946, 34892])
const COLOR_SPACES = new Set([0, 1, 2, 3, 5, 6, 32845])

/** 在分配像素内存前检查尺寸，只解码第一目录，避免遍历损坏的后续页。 */
export function decodeTiffFirstPage(input: ArrayBuffer) {
  const buffer = input.slice(0)
  const view = new DataView(buffer)
  const littleEndian = view.byteLength >= 8 && view.getUint16(0) === 0x4949

  if (
    view.byteLength < 8 ||
    (!littleEndian && view.getUint16(0) !== 0x4d4d) ||
    view.getUint16(2, littleEndian) !== 42
  ) {
    throw { code: 'unsupported' }
  }

  const offset = view.getUint32(4, littleEndian)

  if (offset < 8 || offset + 2 > view.byteLength) {
    throw { code: 'unsupported' }
  }

  const end = offset + 2 + view.getUint16(offset, littleEndian) * 12

  if (end + 4 > view.byteLength) {
    throw { code: 'unsupported' }
  }

  const multiplePages = view.getUint32(end, littleEndian) !== 0
  view.setUint32(end, 0, littleEndian)
  const page = UTIF.decode(buffer)[0]

  if (!page) {
    throw { code: 'unsupported' }
  }

  /** 读取 TIFF 数值标签；不存在时使用格式规定的默认值。 */
  function tag(id: string, fallback = 0) {
    const value = page[id]

    return Array.isArray(value) ? Number(value[0]) : fallback
  }

  const width = tag('t256')
  const height = tag('t257')
  const pixels = width * height
  const rawBytes = Math.ceil((width * tag('t258', 1) * tag('t277', 1)) / 8) * height

  if (!Number.isSafeInteger(pixels) || width < 1 || height < 1) {
    throw { code: 'unsupported' }
  }

  if (pixels > MAX_PIXELS || width > 32767 || height > 32767 || rawBytes > MAX_DECODE_BYTES) {
    throw { code: 'too_large' }
  }

  if (!COMPRESSIONS.has(tag('t259', 1)) || !COLOR_SPACES.has(tag('t262', 2))) {
    throw { code: 'unsupported' }
  }

  const offsets = page.t324 || page.t273
  const lengths = page.t325 || page.t279

  if (
    !Array.isArray(offsets) ||
    !Array.isArray(lengths) ||
    !offsets.length ||
    offsets.length !== lengths.length ||
    offsets.some(
      (start, index) =>
        !Number.isInteger(start) ||
        !Number.isInteger(lengths[index]) ||
        Number(start) < 8 ||
        Number(lengths[index]) < 1 ||
        Number(start) + Number(lengths[index]) > buffer.byteLength
    )
  ) {
    throw { code: 'unsupported' }
  }

  UTIF.decodeImage(buffer, page)

  if (!page.data?.length) {
    throw { code: 'unsupported' }
  }

  const rgba = UTIF.toRGBA8(page)

  return { height, multiplePages, rgba, width }
}

/** 把解码后的像素转为本机 PNG，不将文档上传或请求外部转换服务。 */
async function tiffPng(input: ArrayBuffer) {
  const { height, multiplePages, rgba, width } = decodeTiffFirstPage(input)
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')

  if (!context) {
    throw { code: 'unavailable' }
  }

  const pixels = context.createImageData(width, height)
  pixels.data.set(rgba)
  context.putImageData(pixels, 0, 0)
  const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'))

  if (!blob) {
    throw { code: 'unsupported' }
  }

  return { multiplePages, url: URL.createObjectURL(blob) }
}

/** TIFF 按图片显示第一页；关闭、刷新及换文件时释放 PNG，并忽略迟到结果。 */
export default function TiffPreview({ onFailure, reloadKey, target }: FormatRendererProps) {
  const { t } = useI18n()
  const [image, setImage] = useState<{ multiplePages: boolean; url: string } | null>(null)
  const path = target.path || target.source || target.url

  useEffect(() => {
    let active = true
    let objectUrl: string | undefined
    setImage(null)

    void readPreviewBytes(path)
      .then(bytes => (active ? tiffPng(bytes) : null))
      .then(result => {
        if (!result) {
          return
        }

        if (!active) {
          URL.revokeObjectURL(result.url)

          return
        }

        objectUrl = result.url
        setImage(result)
      })
      .catch(error => {
        if (active) {
          onFailure(previewFailure(error))
        }
      })

    return () => {
      active = false

      if (objectUrl) {
        URL.revokeObjectURL(objectUrl)
      }
    }
  }, [onFailure, path, reloadKey])

  if (!image) {
    return <PageLoader label={t.preview.loading} />
  }

  return (
    <div className="flex size-full min-h-0 flex-col">
      {image.multiplePages && (
        <div className="shrink-0 px-3 py-2 text-xs text-muted-foreground" role="status">
          {t.preview.tiffFirstPage}
        </div>
      )}
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-3">
        <img
          alt={target.label}
          className="max-h-full max-w-full object-contain"
          onError={() => onFailure({ code: 'unsupported' })}
          src={image.url}
        />
      </div>
    </div>
  )
}
