/**
 * Kits & experts — the desktop side of the `uniwork-kits` Python plugin.
 *
 * A standalone page (`#/kits`, sidebar 「套件」) installs and manages kits and
 * experts. Summoning an expert lives in the composer: a 「专家」 picker beside
 * the "+" and, while the chat belongs to an expert, a welcome / name bar above
 * the input.
 */

import {
  COMPOSER_AREAS,
  type HermesPlugin,
  type RouteContribution,
  ROUTES_AREA,
  SIDEBAR_NAV_AREA,
  type SidebarNavContribution
} from '@hermes/plugin-sdk'

import { bindApi, bindOpener } from './api'
import { ExpertBar } from './expert-bar'
import { loadExperts } from './experts-store'
import { KITS_LOCALES } from './i18n'
import { KitsPage } from './page'
import { SummonPicker } from './summon-picker'

const plugin: HermesPlugin = {
  id: 'uniwork-kits',
  name: '套件',
  description: '安装和管理套件与专家，在对话框里召唤专家。',
  defaultEnabled: true,
  register(ctx) {
    ctx.i18n.register(KITS_LOCALES)
    bindApi(ctx.rest)
    bindOpener(url => ctx.os.openExternal(url))
    void loadExperts()
    ctx.registerMany([
      {
        id: 'page',
        area: ROUTES_AREA,
        data: { path: '/kits' } satisfies RouteContribution,
        render: () => <KitsPage />
      },
      {
        id: 'nav',
        area: SIDEBAR_NAV_AREA,
        order: 40,
        data: { codicon: 'package', label: '套件', path: '/kits' } satisfies SidebarNavContribution
      },
      {
        id: 'summon',
        area: COMPOSER_AREAS.leading,
        order: 20,
        render: () => <SummonPicker />
      },
      {
        id: 'expert-bar',
        area: COMPOSER_AREAS.top,
        order: 20,
        render: () => <ExpertBar />
      }
    ])
  }
}

export default plugin
