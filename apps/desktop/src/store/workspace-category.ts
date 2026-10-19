import { computed } from 'nanostores'

import { persistentAtom } from '@/lib/persisted'
import { $interfaceMode, setInterfaceMode } from '@/store/interface-mode'

export type WorkspaceCategory = 'work' | 'code' | 'life'

// Remember the non-code selection without creating a second owner for layout mode.
const $everydayCategory = persistentAtom<'work' | 'life'>('hermes.desktop.global.everydayCategory.v1', 'work', {
  decode: raw => (raw === 'life' ? 'life' : 'work'),
  encode: value => value
})

export const $workspaceCategory = computed([$interfaceMode, $everydayCategory], (mode, everyday): WorkspaceCategory =>
  mode === 'advanced' ? 'code' : everyday
)

export function setWorkspaceCategory(category: WorkspaceCategory) {
  if (category !== 'code') {
    $everydayCategory.set(category)
  }

  const mode = category === 'code' ? 'advanced' : 'simple'

  if ($interfaceMode.get() !== mode) {
    setInterfaceMode(mode)
  }
}
