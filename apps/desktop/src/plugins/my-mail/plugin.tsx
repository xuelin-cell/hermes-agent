import {
  type HermesPlugin,
  ROUTES_AREA,
  SIDEBAR_NAV_AREA,
  type RouteContribution,
  type SidebarNavContribution
} from '@hermes/plugin-sdk'

import { MY_MAIL_LOCALES } from './i18n'
import { MyMailPage } from './page'

const plugin: HermesPlugin = {
  id: 'my-mail',
  name: 'My Mail',
  description: 'A dedicated Agent Mail inbox backed by the hidden Wo Mail provider.',
  defaultEnabled: true,
  register(ctx) {
    ctx.i18n.register(MY_MAIL_LOCALES)

    const registerLabels = () =>
      ctx.registerMany([
        {
          area: ROUTES_AREA,
          data: { path: '/my-mail' } satisfies RouteContribution,
          id: 'page',
          render: () => <MyMailPage />
        },
        {
          area: SIDEBAR_NAV_AREA,
          data: { codicon: 'mail', label: ctx.i18n.t('nav'), path: '/my-mail' } satisfies SidebarNavContribution,
          id: 'nav',
          order: 1
        }
      ])

    let disposeLabels = registerLabels()
    ctx.i18n.onLocaleChange(() => {
      disposeLabels()
      disposeLabels = registerLabels()
    })
  }
}

export default plugin
