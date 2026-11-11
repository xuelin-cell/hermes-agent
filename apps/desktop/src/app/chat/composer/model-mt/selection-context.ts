import { createContext } from 'react'

// The dropdown marks the same catalog row that the composer button displays.
export const ComposerModelSelectionContext = createContext<string | null>(null)
