import { Blob as NodeBlob } from 'node:buffer'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { setApiRequestConnection } from '@/api/client'
import { $connection } from '@/store/session'

import { readPreviewBytes } from './source'

const originalBridge = window.hermesDesktop

describe('preview bytes', () => {
  beforeEach(() => {
    $connection.set(null)
    setApiRequestConnection(null)
    vi.stubGlobal('Blob', NodeBlob)
  })
  afterEach(() => {
    $connection.set(null)
    setApiRequestConnection(null)
    window.hermesDesktop = originalBridge
    vi.unstubAllGlobals()
  })

  it('decodes bytes through the existing local reader without imposing another size cap', async () => {
    const bytes = Uint8Array.of(0, 255, 128, 10)

    const readFileDataUrl = vi.fn(
      async () => `data:application/octet-stream;base64,${btoa(String.fromCharCode(...bytes))}`
    )

    window.hermesDesktop = { readFileDataUrl } as never
    expect(new Uint8Array(await readPreviewBytes('C:/fixture/中文.tiff'))).toEqual(bytes)
    expect(readFileDataUrl).toHaveBeenCalledWith('C:/fixture/中文.tiff')
  })

  it('uses the existing authenticated remote reader with the owning connection and profile', async () => {
    $connection.set({ connectionId: 'remote-test', mode: 'remote', profile: 'team' } as never)
    setApiRequestConnection('remote-test')
    const api = vi.fn(async () => ({ dataUrl: 'data:image/tiff;base64,AQID' }))
    window.hermesDesktop = { api, readFileDataUrl: vi.fn() } as never
    expect(new Uint8Array(await readPreviewBytes('/work/中文.tif'))).toEqual(Uint8Array.of(1, 2, 3))
    expect(api).toHaveBeenCalledWith({
      connectionId: 'remote-test',
      path: '/api/fs/read-data-url?path=%2Fwork%2F%E4%B8%AD%E6%96%87.tif',
      profile: 'team'
    })
    expect(window.hermesDesktop.readFileDataUrl).not.toHaveBeenCalled()
  })

  it.each([
    [{ code: 'EFBIG' }, 'too_large'],
    [
      new Error(
        "Error invoking remote method 'hermes:readFileDataUrl': Error: File read failed: file is too large (20000000 bytes; limit 16777216 bytes)."
      ),
      'too_large'
    ],
    [{ statusCode: 413 }, 'too_large'],
    [new Error('Error invoking remote method: Error: 413: {"detail":"File too large"}'), 'too_large'],
    [{ code: 'ENOENT' }, 'not_found'],
    [new Error('File read failed: path does not exist.'), 'not_found'],
    [new Error('Error invoking remote method: Error: 404: {"detail":"File not found"}'), 'not_found'],
    [new Error('private internal details'), 'unavailable']
  ])('maps reader failure %# without exposing internal details', async (error, code) => {
    window.hermesDesktop = { readFileDataUrl: vi.fn().mockRejectedValue(error) } as never
    await expect(readPreviewBytes('/fixture/file.tif')).rejects.toEqual({ code })
  })

  it.each(['', 'data:image/tiff;base64,!!!', 'https://unexpected.test/file'])(
    'rejects an invalid data URL %#',
    async dataUrl => {
      window.hermesDesktop = { readFileDataUrl: vi.fn(async () => dataUrl) } as never
      await expect(readPreviewBytes('/fixture/file.tif')).rejects.toEqual({ code: 'unavailable' })
    }
  )
})
