import { atom, computed } from 'nanostores'

import { $resolvedWelcomeCatalog } from '@/app/chat/composer/work-templates/catalog-store'
import { $interfaceMode, setInterfaceMode } from '@/store/interface-mode'

import type { WelcomeLocale, WelcomeModule } from '../../electron/uniwork-welcome/catalog'

const $selectedKeys = atom<Partial<Record<WelcomeLocale, string>>>({})

export const $selectedWorkspaceMode = atom<'work' | 'codex' | null>(null)

/** 当前是否为代码开发；页签还没选过时按界面模式推断，与页签的默认选择一致。 */
export const $codeWorkspace = computed(
  [$selectedWorkspaceMode, $interfaceMode],
  (selected, mode) => (selected ?? (mode === 'advanced' ? 'codex' : 'work')) === 'codex'
)

function selectedModule(locale: WelcomeLocale) {
  return computed([$resolvedWelcomeCatalog[locale], $interfaceMode, $selectedKeys], (catalog, mode, keys) => {
    const modules = catalog.modules
    const workspace = mode === 'advanced' ? 'codex' : 'work'

    return (
      modules.find(module => module.id === keys[locale]) ??
      modules.find(module => module.workspace === workspace) ??
      modules[0] ??
      null
    )
  })
}

export const $selectedWelcomeModules = {
  'zh-CN': selectedModule('zh-CN'),
  en: selectedModule('en')
}

export function selectWorkspaceModule(locale: WelcomeLocale, module: WelcomeModule) {
  $selectedWorkspaceMode.set(module.workspace)

  if ($selectedKeys.get()[locale] !== module.id) {
    $selectedKeys.set({ ...$selectedKeys.get(), [locale]: module.id })
  }

  const mode = module.workspace === 'codex' ? 'advanced' : 'simple'

  if ($interfaceMode.get() !== mode) {
    setInterfaceMode(mode)
  }
}
