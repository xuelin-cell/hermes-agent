import { useStore } from '@nanostores/react'
import { useEffect } from 'react'
import { useLocation } from 'react-router'

import { setTreePaneHidden } from '@/components/pane-shell/tree/store'
import { $dockedPreviewTabs } from '@/store/preview'
import { PREVIEW_TILE_PREFIX } from '@/store/preview-explicit'

import { appViewForPath } from '../routes'

/** Task previews stay with the conversation while browsing capabilities. */
export function usePreviewPageVisibility() {
  const { pathname } = useLocation()
  const tabs = useStore($dockedPreviewTabs)
  const hidden = appViewForPath(pathname) === 'capabilities'

  useEffect(() => {
    if (!hidden) return
    const panes = tabs.map(tab => `${PREVIEW_TILE_PREFIX}:${tab.id}`)
    panes.forEach(id => setTreePaneHidden(id, true))
    return () => panes.forEach(id => setTreePaneHidden(id, false))
  }, [hidden, tabs])
}
