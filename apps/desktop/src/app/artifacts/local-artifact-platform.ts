import { hermesApi } from '@/api/client'
import type { HermesPreviewTarget } from '@/global'
import { isBrowserShell } from '@/lib/browser-shell'
import { localPreviewTarget } from '@/lib/local-preview'

import { readBrowserAuth } from '../../../../shared/src/browser-maas-auth.js'

/** Only the production instance bridge owns these paths; ordinary remote desktops keep their existing view. */
export function usesInstanceArtifactLibrary(): boolean {
  return isBrowserShell() && !!window.hermesDesktop?.prepareCloudDriveTurn
}

/** A login generation scopes browser metadata without persisting any credential with the files. */
export function artifactLibraryIdentity(): string | undefined {
  if (!usesInstanceArtifactLibrary()) {
    return 'desktop'
  }

  try {
    return readBrowserAuth(import.meta.env.BASE_URL || '/')?.loginId
  } catch {
    return undefined
  }
}

interface InstanceFileEntry {
  name: string
  path: string
  is_directory: boolean
  size: number | null
  mime_type: string | null
}

/** A scan shares directory metadata, never file contents. Click actions use a fresh resolver. */
export function artifactFileResolver(): (value: string, cwd?: string) => Promise<HermesPreviewTarget | null> {
  const directories = new Map<string, Promise<{ entries: InstanceFileEntry[] }>>()
  const identity = artifactLibraryIdentity()

  return async (value, cwd) => {
    if (!usesInstanceArtifactLibrary()) {
      return cwd === undefined
        ? window.hermesDesktop.normalizePreviewTarget(value)
        : window.hermesDesktop.normalizePreviewTarget(value, cwd)
    }

    if (/^file:/i.test(value)) {
      const url = new URL(value)

      if ((url.hostname && url.hostname !== 'localhost') || url.search || url.hash) {
        return null
      }
    }

    const target = localPreviewTarget(value, cwd)

    if (target?.kind !== 'file' || !target.path?.startsWith('/')) {
      return null
    }

    const directory = target.path.slice(0, target.path.lastIndexOf('/')) || '/'
    let listing = directories.get(directory)

    if (!listing) {
      listing = hermesApi({
        connectionId: 'local',
        profile: 'default',
        path: `/api/files?path=${encodeURIComponent(directory)}`
      })
      directories.set(directory, listing)
    }

    // The managed-files endpoint enforces the instance root and sensitive-path policy, including symlinks.
    const file = (await listing).entries.find(entry => entry.name === target.label && !entry.is_directory)

    if (!file || artifactLibraryIdentity() !== identity) {
      return null
    }

    return {
      ...target,
      kind: 'file',
      path: file.path,
      label: file.name,
      byteSize: file.size ?? undefined,
      mimeType: file.mime_type ?? undefined
    }
  }
}
