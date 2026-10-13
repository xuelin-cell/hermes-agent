/**
 * UniWork kits and experts. The page is this plugin; the HTTP API is
 * `plugins/uniwork-kits/dashboard/plugin_api.py`.
 */

import {
  type HermesPlugin,
  type RouteContribution,
  ROUTES_AREA,
  SIDEBAR_NAV_AREA,
  type SidebarNavContribution
} from '@hermes/plugin-sdk'

import { BOTS_HEADER_AREA } from '../hermes-bots/header-slot'
import { bindApi, bindOpener } from './api'
import { KITS_LOCALES } from './i18n'
import { KitsPage } from './page'
import { KitsRosterLink } from './roster-link'

const plugin: HermesPlugin = {
  id: 'uniwork-kits',
  name: '套件',
  description: '安装和管理套件与专家。',
  defaultEnabled: true,
  register(ctx) {
    ctx.i18n.register(KITS_LOCALES)
    bindApi(ctx.rest)
    bindOpener(url => ctx.os.openExternal(url))
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
        id: 'bots-link',
        area: BOTS_HEADER_AREA,
        order: 10,
        render: () => <KitsRosterLink />
      }
    ])
  }
}

export default plugin
