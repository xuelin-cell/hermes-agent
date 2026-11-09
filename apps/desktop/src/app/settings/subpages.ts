import {
  Archive,
  Bell,
  Box,
  Brain,
  CircleLetterA,
  Cpu,
  Download,
  FileImage,
  FileText,
  FolderOpen,
  Globe,
  type IconComponent,
  Keyboard,
  KeyRound,
  Lock,
  MessageCircle,
  Mic,
  Monitor,
  Network,
  Palette,
  PawPrint,
  Settings2,
  ShieldLock,
  Terminal,
  Users,
  Volume2,
  Wrench
} from '@/lib/icons'

import { APPEARANCE_SUBPAGES } from './appearance-subpages'
import { CONFIG_SUBPAGES, configSubpageForField } from './config-subpages'
import { OTHER_SUBPAGES } from './other-subpages'
import { settingDefinition } from './settings-manifest'
import type { SettingsView } from './types'

export interface SettingsSubpage {
  id: string
  labelKey: string
  /**
   * An in-page anchor of a page that merged its children (About's version and
   * terms sections): still a routable `?page=<id>` destination — the page
   * scrolls to that section — but never a nav entry, so the parent opens whole.
   */
  anchor?: boolean
}

const SUBPAGE_ICONS: Record<string, IconComponent> = {
  appearanceTheme: Palette,
  appearanceTypography: CircleLetterA,
  appearanceWindowLayout: Monitor,
  appearanceChatDisplay: MessageCircle,
  appearancePet: PawPrint,
  appearanceGeneral: Settings2,
  modelMain: Box,
  modelAuxiliary: Cpu,
  modelMoa: Users,
  modelFallbacks: Box,
  chatBehavior: MessageCircle,
  chatAttachments: FileImage,
  workspaceProjects: FolderOpen,
  workspaceShell: Terminal,
  workspaceFiles: FileText,
  safetyApprovals: ShieldLock,
  safetyPrivacy: Lock,
  safetyCheckpoints: Archive,
  browserProfile: Globe,
  browserNetwork: Network,
  memoryPersistent: Brain,
  memoryContext: FileText,
  voiceConversation: Mic,
  voiceTranscription: FileText,
  voiceSpeech: Volume2,
  advancedRuntime: Cpu,
  advancedTools: Wrench,
  advancedTerminal: Terminal,
  advancedOutput: FileText,
  advancedDelegation: Users,
  advancedDesktop: Monitor,
  gatewayConnection: Monitor,
  gatewayDevices: Network,
  gatewayManagedUpdates: Download,
  keyboardShortcuts: Keyboard,
  hudGesture: Keyboard,
  screenCapture: FileImage,
  notificationAlerts: Bell,
  notificationSounds: Volume2,
  archivedSessions: Archive,
  defaultDirectory: FolderOpen,
  vaultCredentials: KeyRound,
  vaultSources: Lock
}

export function settingsSubpageIcon(page: SettingsSubpage, fallback: IconComponent): IconComponent {
  return SUBPAGE_ICONS[page.labelKey] ?? fallback
}

export function settingsSubpages(view: SettingsView, developerMode = true): readonly SettingsSubpage[] {
  if (view === 'config:appearance') {
    return developerMode ? APPEARANCE_SUBPAGES : APPEARANCE_SUBPAGES.filter(page => page.id !== 'pet')
  }

  if (view.startsWith('config:')) {
    const pages = CONFIG_SUBPAGES[view.slice('config:'.length)] ?? []

    if (view === 'config:safety' && !developerMode) {
      return pages.filter(page => page.id === 'approvals')
    }

    return view === 'config:chat' && !developerMode ? pages.filter(page => page.id !== 'attachments') : pages
  }

  if (view === 'notifications' && !developerMode) {
    return OTHER_SUBPAGES[view].filter(page => page.id !== 'sounds')
  }

  return OTHER_SUBPAGES[view] ?? []
}

/** The child pages that get their own nav entry — in-page anchors do not. */
export function settingsNavSubpages(view: SettingsView, developerMode = true): readonly SettingsSubpage[] {
  return settingsSubpages(view, developerMode).filter(page => !page.anchor)
}

/** Shared by search serialization and saved links that predate subpages. */
export function settingsSubpageForTarget(view: SettingsView, field?: string, setting?: string): string | undefined {
  if (setting) {
    return settingDefinition(view, setting)?.subpage
  }

  if (view.startsWith('config:') && field) {
    return configSubpageForField(view.slice('config:'.length), field)
  }

  return undefined
}

const LEGACY_SUBPAGE_TARGETS: Record<string, { params: string[]; page: string }> = {
  'config:model': { params: ['aux'], page: 'auxiliary' },
  sessions: { params: ['session'], page: 'archived' },
  vault: { params: ['kind', 'label', 'origin'], page: 'credentials' }
}

export function settingsSubpageForLegacyLink(view: SettingsView, params: URLSearchParams): string | undefined {
  const target = LEGACY_SUBPAGE_TARGETS[view]

  return target?.params.some(param => params.get(param))
    ? target.page
    : settingsSubpageForTarget(view, params.get('field') ?? undefined, params.get('setting') ?? undefined)
}

export function resolveSettingsSubpage(
  view: SettingsView,
  params: URLSearchParams,
  developerMode = true
): string | undefined {
  const pages = settingsSubpages(view, developerMode)
  const requested = settingsSubpageForLegacyLink(view, params) ?? params.get('page')
  const match = pages.find(page => page.id === requested)

  // An in-page anchor stays resolved so a merged page can scroll to that
  // section; everything else falls back to the first navigable child — none for
  // a page made only of anchors (About), which opens as one page.
  return match?.id ?? settingsNavSubpages(view, developerMode)[0]?.id
}
