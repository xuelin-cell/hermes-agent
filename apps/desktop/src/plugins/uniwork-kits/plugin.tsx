/**
 * Kits & experts — the desktop side of the `uniwork-kits` Python plugin.
 *
 * A standalone page (`#/kits`, sidebar 「套件」) installs and manages kits and
 * experts. Summoning an expert lives in the composer: a 「专家」 picker beside
 * the "+" and, while the chat belongs to an expert, a welcome / name bar above
 * the input.
 */

import {
  CAPABILITY_SCOPE_AREA,
  type CapabilityScopeContribution,
  COMPOSER_AREAS,
  type HermesPlugin,
  type PluginContext,
  type RouteContribution,
  ROUTES_AREA,
  SIDEBAR_NAV_AREA,
  type SidebarNavContribution
} from '@hermes/plugin-sdk'

import { bindApi, bindOpener } from './api'
import { watchBundled } from './bundled'
import { ExpertBar } from './expert-bar'
import { $expertDirectory, loadExperts } from './experts-store'
import { KITS_LOCALES } from './i18n'
import { KitsPage } from './page'
import { summonSendGuard } from './summon'
import { SummonPicker } from './summon-picker'

/**
 * 专家是装成独立档案的，模型、密钥和连接器都从通用助手同步；在「技能与工具」里单独改它们会破坏专家
 * （例如关掉本插件、装进别的技能），所以把专家档案声明为本插件托管，不出现在「正在配置」下拉框里。名单随装卸专家更新。
 */
function hideExpertProfiles(ctx: PluginContext): void {
  let release = () => {}

  const stop = $expertDirectory.subscribe(directory => {
    release()
    release = ctx.register({
      area: CAPABILITY_SCOPE_AREA,
      data: { hideProfiles: directory.experts.map(expert => expert.profile) } satisfies CapabilityScopeContribution,
      id: 'managed-profiles'
    })
  })

  ctx.onDispose(() => {
    stop()
    release()
  })
}

const plugin: HermesPlugin = {
  id: 'uniwork-kits',
  name: '套件',
  description: '安装和管理套件与专家，在对话框里召唤专家。',
  defaultEnabled: true,
  /** 插件入口：注册语言包和后端接口，预先读一次专家名单，等后端装完内置包，再挂上套件页、侧栏入口、召唤按钮、专家栏和发送拦截。 */
  register(ctx) {
    ctx.i18n.register(KITS_LOCALES)
    bindApi(ctx.rest)
    bindOpener(url => ctx.os.openExternal(url))
    void loadExperts()
    hideExpertProfiles(ctx)
    // A new account gets the bundled kits and experts from the backend itself.
    void watchBundled()
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
      },
      {
        // 专家还没准备好时，召唤出来的新草稿不能发送。
        id: 'summon-send-guard',
        area: COMPOSER_AREAS.middleware,
        data: summonSendGuard
      }
    ])
  }
}

export default plugin
