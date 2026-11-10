import './settings-redesign.css'

import { useStore } from '@nanostores/react'
import { useCallback, useEffect, useMemo, useRef } from 'react'
import { Navigate, useLocation, useNavigate } from 'react-router'

import { codiconIcon } from '@/components/ui/codicon'
import { Tip } from '@/components/ui/tooltip'
import { getHermesConfigDefaults, getHermesConfigRecord, saveHermesConfig } from '@/hermes'
import { useI18n } from '@/i18n'
import { triggerHaptic } from '@/lib/haptics'
import {
  Archive,
  BarChart3,
  Bell,
  Cpu,
  Download,
  Globe,
  Info,
  Keyboard,
  KeyRound,
  RefreshCw,
  ShieldLock,
  Upload,
  Zap
} from '@/lib/icons'
import { isEditableTarget } from '@/lib/keybinds/combo'
import { typeToFocusChar } from '@/lib/keybinds/composer-focus-keys'
import { $commandPaletteOpen, openCommandPalettePage } from '@/store/command-palette'
import { confirm } from '@/store/confirm'
import { $activeConnectionId } from '@/store/connections'
import { $developerMode } from '@/store/developer-mode'
import { notifyError } from '@/store/notifications'
import { $settingsScopeProfile } from '@/store/settings-scope'

import { useRouteEnumParam } from '../hooks/use-route-enum-param'
import { MessagingView } from '../messaging'
import { OverlayIconButton } from '../overlays/overlay-chrome'
import { OverlayMain, type OverlayNavGroup, OverlaySplitLayout } from '../overlays/overlay-split-layout'
import { OverlayView } from '../overlays/overlay-view'

import { AboutSettings } from './about-settings'
import { AppearanceSettings } from './appearance-settings'
import { BILLING_VIEWS, BillingSettings, type BillingSubView } from './billing'
import { deriveBillingView, useBillingState, useSubscriptionState } from './billing/use-billing-state'
import { ConfigSettings } from './config-settings'
import { SECTIONS } from './constants'
import { GatewaySettings } from './gateway-settings'
import { GeneralSettings } from './general-settings'
import { GroupedSettingsNavigation } from './grouped-navigation'
import { HelpSettings } from './help-settings'
import { KeybindSettings } from './keybind-settings'
import { KEYS_VIEWS, KeysSettings, type KeysView } from './keys-settings'
import { useModelsCopy } from './models-mt/copy'
import { ModelsSettings } from './models-mt/models-settings'
import { movedSettingsTabRedirect } from './moved-tabs'
import { NotificationsSettings } from './notifications-settings'
import { SettingsBreadcrumbContext } from './primitives'
import { PROVIDER_VIEWS, ProvidersSettings, type ProviderView } from './providers-settings'
import { useSettingsRedesignCopy } from './redesign-copy'
import { SessionsSettings } from './sessions-settings'
import { SettingsSubpageHeader } from './subpage-navigation'
import { resolveSettingsSubpage, settingsNavSubpages, settingsSubpageIcon } from './subpages'
import type { SettingsPageProps, SettingsView as SettingsViewId } from './types'
import { vaultOwnerKey, VaultSettings } from './vault-settings'
import { settingsViewVisible } from './visibility'

const SETTINGS_VIEWS: readonly SettingsViewId[] = [
  ...SECTIONS.map(s => `config:${s.id}` as SettingsViewId),
  'general',
  'messaging',
  'help',
  'models',
  'providers',
  'gateway',
  // Legacy alias: the Connections page merged into Gateways. Kept in the enum
  // so saved `?tab=connections` deep links still resolve (redirected below).
  'connections',
  'keybinds',
  'keys',
  'vault',
  'notifications',
  'billing',
  'sessions',
  'about'
]

export function SettingsView({ onClose, onConfigSaved, onMainModelChanged }: SettingsPageProps) {
  const scopeProfile = useStore($settingsScopeProfile)
  const activeConnectionId = useStore($activeConnectionId)
  const { t } = useI18n()
  const modelsCopy = useModelsCopy()
  const redesignCopy = useSettingsRedesignCopy()
  const navigate = useNavigate()
  const developerMode = useStore($developerMode)
  const { hash, pathname, search } = useLocation()

  // MCP and Plugins moved out of Settings into Capabilities. Keep old
  // `/settings?tab=mcp|plugins` deep links working — `useRouteEnumParam` would
  // silently coerce the unknown tab to the default view otherwise.
  useEffect(() => {
    const redirect = movedSettingsTabRedirect(search)

    if (redirect) {
      navigate(redirect, { replace: true })
    }
  }, [navigate, search])

  const [requestedView] = useRouteEnumParam('tab', SETTINGS_VIEWS, 'general' as SettingsViewId)
  const activeView = settingsViewVisible(requestedView, developerMode) ? requestedView : 'general'
  const params = new URLSearchParams(search)
  const requestedSubpage = params.get('page')

  const subpage =
    activeView === 'sessions'
      ? 'archived'
      : activeView === 'config:safety'
        ? undefined
        : resolveSettingsSubpage(activeView, params, developerMode)

  const needsSubpageRedirect = Boolean(subpage && subpage !== requestedSubpage)
  const subpageSearch = new URLSearchParams(search)

  if (subpage) {
    subpageSearch.set('page', subpage)
  }

  const openSettingsPage = useCallback(
    (view: SettingsViewId, page?: string) => {
      const next = new URLSearchParams(search)

      for (const key of [
        'page',
        'field',
        'setting',
        'key',
        'aux',
        'session',
        'kind',
        'label',
        'origin',
        'pview',
        'kview',
        'bview'
      ]) {
        next.delete(key)
      }

      next.set('tab', view)

      const destination =
        view === 'sessions'
          ? 'archived'
          : view === 'config:safety'
            ? undefined
            : (page ?? settingsNavSubpages(view, developerMode)[0]?.id)

      if (destination) {
        next.set('page', destination)
      }

      navigate({ hash, pathname, search: `?${next}` }, { replace: true })
    },
    [developerMode, hash, navigate, pathname, search]
  )

  const setActiveView = useCallback((view: SettingsViewId) => openSettingsPage(view), [openSettingsPage])

  // Connections merged into the unified Gateways page: land old
  // `?tab=connections` routes/bookmarks there instead of a dead entry.
  useEffect(() => {
    if (activeView === 'connections') {
      setActiveView('gateway')
    }
  }, [activeView, setActiveView])

  // Providers subnav (Accounts vs API keys) lives in its own param so each
  // sub-view is deep-linkable and survives a refresh.
  const [providerView, setProviderView] = useRouteEnumParam<ProviderView>('pview', PROVIDER_VIEWS, 'accounts')
  const [keysView] = useRouteEnumParam<KeysView>('kview', KEYS_VIEWS, 'tools')
  const [billingView] = useRouteEnumParam<BillingSubView>('bview', BILLING_VIEWS, 'overview')
  const billingState = useBillingState()
  const subscriptionState = useSubscriptionState()
  const billingPresentation = deriveBillingView(billingState.data, subscriptionState.data)
  const canViewPlans = billingPresentation.status === 'normal' && Boolean(billingPresentation.plan?.action)

  // Jump to a section + its sub-view in one navigate. Two sequential setters
  // would each read the same stale `search` and the second would clobber the
  // first's `tab` — so the sub-view never opened on narrow screens.
  const openSubView = useCallback(
    (tab: SettingsViewId, param: string, value: string, fallback: string) => {
      const params = new URLSearchParams(search)

      for (const key of ['page', 'field', 'setting', 'key', 'aux', 'session', 'kind', 'label', 'origin']) {
        params.delete(key)
      }

      params.set('tab', tab)

      if (value === fallback) {
        params.delete(param)
      } else {
        params.set(param, value)
      }

      const qs = params.toString()
      navigate({ hash, pathname, search: qs ? `?${qs}` : '' }, { replace: true })
    },
    [hash, navigate, pathname, search]
  )

  const openProviderView = useCallback(
    (view: ProviderView) => openSubView('providers', 'pview', view, 'accounts'),
    [openSubView]
  )

  const openKeysView = useCallback((view: KeysView) => openSubView('keys', 'kview', view, 'tools'), [openSubView])

  const importInputRef = useRef<HTMLInputElement | null>(null)

  const exportConfig = async () => {
    try {
      const cfg = await getHermesConfigRecord()
      const blob = new Blob([JSON.stringify(cfg, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = 'hermes-config.json'
      a.click()
      URL.revokeObjectURL(url)
      triggerHaptic('success')
    } catch (err) {
      notifyError(err, t.settings.exportFailed)
    }
  }

  const resetConfig = async () => {
    const ok = await confirm({
      confirmLabel: t.settings.resetToDefaults,
      destructive: true,
      title: t.settings.resetConfirm
    })

    if (!ok) {
      return
    }

    try {
      await saveHermesConfig(await getHermesConfigDefaults())
      triggerHaptic('success')
      onConfigSaved?.()
    } catch (err) {
      notifyError(err, t.settings.resetFailed)
    }
  }

  const navGroups: OverlayNavGroup[] = useMemo(
    () =>
      (
        [
          {
            id: 'help',
            active: activeView === 'help',
            icon: Info,
            label: redesignCopy('help'),
            onSelect: () => setActiveView('help')
          },
          {
            id: 'general',
            active: activeView === 'general',
            icon: Info,
            label: redesignCopy('general'),
            onSelect: () => setActiveView('general')
          },
          {
            id: 'messaging',
            active: activeView === 'messaging',
            icon: Globe,
            label: redesignCopy('phone'),
            onSelect: () => setActiveView('messaging')
          },
          ...SECTIONS.flatMap(s => {
            const view = `config:${s.id}` as SettingsViewId

            const entry = {
              active: activeView === view,
              icon: s.icon,
              id: view,
              label: s.id === 'safety' ? redesignCopy('security') : (t.settings.sections[s.id] ?? s.label),
              onSelect: () => setActiveView(view)
            }

            // Credential Vault lives beside the Browser section: it feeds the
            // browser's model-blind vault fill, so the two are one mental unit.
            if (s.id === 'browser') {
              return [
                entry,
                {
                  active: activeView === 'vault',
                  icon: ShieldLock,
                  id: 'vault',
                  label: t.settings.nav.vault,
                  onSelect: () => setActiveView('vault')
                }
              ]
            }

            return [entry]
          }),
          {
            active: activeView === 'notifications',
            icon: Bell,
            id: 'notifications',
            label: t.settings.nav.notifications,
            onSelect: () => setActiveView('notifications')
          },
          {
            active: activeView === 'billing',
            children: [
              {
                active: activeView === 'billing' && (billingView === 'overview' || !canViewPlans),
                icon: BarChart3,
                id: 'bview:overview',
                label: t.settings.subpages.billingOverview,
                onSelect: () => openSubView('billing', 'bview', 'overview', 'overview')
              },
              ...(canViewPlans
                ? [
                    {
                      active: activeView === 'billing' && billingView === 'plans',
                      icon: BarChart3,
                      id: 'bview:plans',
                      label: t.settings.subpages.billingPlans,
                      onSelect: () => openSubView('billing', 'bview', 'plans', 'overview')
                    }
                  ]
                : [])
            ],
            icon: BarChart3,
            id: 'billing',
            label: t.settings.nav.billing,
            onSelect: () => setActiveView('billing')
          },
          {
            active: activeView === 'models',
            gapBefore: true,
            icon: Cpu,
            id: 'models',
            label: modelsCopy('nav'),
            onSelect: () => setActiveView('models')
          },
          {
            active: activeView === 'providers',
            children: [
              {
                active: activeView === 'providers' && providerView === 'accounts',
                icon: codiconIcon('account'),
                id: 'pview:accounts',
                label: t.settings.nav.providerAccounts,
                onSelect: () => openProviderView('accounts')
              },
              {
                active: activeView === 'providers' && providerView === 'keys',
                icon: KeyRound,
                id: 'pview:keys',
                label: t.settings.nav.providerApiKeys,
                onSelect: () => openProviderView('keys')
              },
              {
                active: activeView === 'providers' && providerView === 'custom-endpoints',
                icon: Globe,
                id: 'pview:custom-endpoints',
                label: t.settings.nav.providerCustomEndpoints,
                onSelect: () => openProviderView('custom-endpoints')
              }
            ],
            gapBefore: true,
            icon: Zap,
            id: 'providers',
            label: t.settings.nav.providers,
            onSelect: () => setActiveView('providers')
          },
          {
            active: activeView === 'gateway',
            icon: Globe,
            id: 'gateway',
            label: t.settings.nav.gateway,
            onSelect: () => setActiveView('gateway')
          },
          {
            active: activeView === 'keybinds',
            icon: Keyboard,
            id: 'keybinds',
            label: t.settings.nav.keybinds,
            onSelect: () => setActiveView('keybinds')
          },
          {
            active: activeView === 'sessions',
            icon: Archive,
            id: 'sessions',
            label: redesignCopy('management'),
            onSelect: () => setActiveView('sessions')
          },
          {
            active: activeView === 'about',
            gapBefore: true,
            icon: Info,
            id: 'about',
            label: t.settings.nav.about,
            onSelect: () => setActiveView('about')
          }
        ] as OverlayNavGroup[]
      )
        .filter(
          group => settingsViewVisible(group.id, developerMode) && (developerMode || group.id !== 'config:appearance')
        )
        .map(group => {
          const view = group.id as SettingsViewId

          // In-page anchors (About's merged sections) route but never get a nav entry.
          const children =
            view === 'sessions' || view === 'config:safety' ? [] : settingsNavSubpages(view, developerMode)

          return children.length
            ? {
                ...group,
                children: children.map(page => ({
                  active: group.active && subpage === page.id,
                  icon: settingsSubpageIcon(page, group.icon),
                  id: `${view}:${page.id}`,
                  label: t.settings.subpages[page.labelKey],
                  onSelect: () => openSettingsPage(view, page.id)
                }))
              }
            : group
        }),
    [
      activeView,
      billingView,
      canViewPlans,
      developerMode,
      providerView,
      subpage,
      t,
      modelsCopy,
      redesignCopy,
      setActiveView,
      openProviderView,
      openSettingsPage,
      openSubView
    ]
  )

  const activeGroup = navGroups.find(group => group.active)
  const activeChild = activeGroup?.children?.find(child => child.active)

  // Type-to-search: printable keystrokes on the Settings surface (outside any
  // field) open the settings-scoped palette, seeded with the character — same
  // reflex as the chat surface's type-to-focus, pointed at search instead.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ($commandPaletteOpen.get() || isEditableTarget(event.target)) {
        return
      }

      const char = typeToFocusChar(event)

      if (char === null || char === ' ') {
        return
      }

      event.preventDefault()
      openCommandPalettePage('settings', char)
    }

    window.addEventListener('keydown', onKeyDown)

    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const navFooter = (
    <>
      <Tip label={t.settings.exportConfig}>
        <OverlayIconButton onClick={() => void exportConfig()}>
          <Download />
        </OverlayIconButton>
      </Tip>
      <Tip label={t.settings.importConfig}>
        <OverlayIconButton
          onClick={() => {
            triggerHaptic('open')
            importInputRef.current?.click()
          }}
        >
          <Upload />
        </OverlayIconButton>
      </Tip>
      <Tip label={t.settings.resetToDefaults}>
        <OverlayIconButton
          className="hover:text-destructive"
          onClick={() => {
            triggerHaptic('warning')
            void resetConfig()
          }}
        >
          <RefreshCw />
        </OverlayIconButton>
      </Tip>
    </>
  )

  const activeSettingsContent =
    activeView === 'help' ? (
      <HelpSettings />
    ) : activeView === 'general' ? (
      <GeneralSettings />
    ) : activeView === 'messaging' ? (
      <MessagingView />
    ) : activeView === 'config:appearance' ? (
      <AppearanceSettings subpage={subpage} />
    ) : activeView === 'about' ? (
      <AboutSettings subpage={subpage} />
    ) : activeView === 'gateway' || activeView === 'connections' ? (
      // 'connections' renders the unified page too so the frame before
      // the alias redirect lands doesn't flash the fallback view.
      <GatewaySettings subpage={subpage} />
    ) : activeView === 'keybinds' ? (
      <KeybindSettings subpage={subpage} />
    ) : activeView.startsWith('config:') ? (
      <ConfigSettings
        activeSectionId={activeView.slice('config:'.length)}
        importInputRef={importInputRef}
        onConfigSaved={onConfigSaved}
        onMainModelChanged={onMainModelChanged}
        subpage={subpage}
      />
    ) : activeView === 'models' ? (
      <ModelsSettings key={scopeProfile} onConfigSaved={onConfigSaved} onMainModelChanged={onMainModelChanged} />
    ) : activeView === 'providers' ? (
      <ProvidersSettings
        key={scopeProfile}
        onClose={onClose}
        onConfigSaved={onConfigSaved}
        onMainModelChanged={onMainModelChanged}
        onViewChange={setProviderView}
        view={providerView}
      />
    ) : activeView === 'keys' ? (
      <KeysSettings view={keysView} />
    ) : activeView === 'notifications' ? (
      <NotificationsSettings subpage={subpage} />
    ) : activeView === 'billing' ? (
      <BillingSettings />
    ) : activeView === 'vault' ? (
      <VaultSettings key={vaultOwnerKey(activeConnectionId, scopeProfile)} subpage={subpage} />
    ) : (
      <SessionsSettings onlyArchived subpage="archived" />
    )

  return (
    <OverlayView closeLabel={t.settings.closeSettings} compact onClose={onClose} rootClassName="settings-redesign">
      <OverlaySplitLayout className="settings-redesign-layout">
        <GroupedSettingsNavigation footer={navFooter} groups={navGroups} />

        <OverlayMain className="px-0 pb-0">
          <SettingsBreadcrumbContext.Provider value>
            {activeGroup &&
              !['general', 'sessions'].includes(activeView) &&
              (activeView !== 'config:safety' || developerMode) && (
                <SettingsSubpageHeader child={activeChild} group={activeGroup} />
              )}
            {needsSubpageRedirect ? (
              <Navigate replace to={{ hash, pathname, search: `?${subpageSearch}` }} />
            ) : (
              activeSettingsContent
            )}
          </SettingsBreadcrumbContext.Provider>
        </OverlayMain>
      </OverlaySplitLayout>
    </OverlayView>
  )
}

export { SettingsView as SettingsPage }
