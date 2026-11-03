/**
 * 召唤东方财富专家、而通用助手还没连上东方财富连接器时弹出的提示 — 数字员工 EastmoneyConnectorPrompt。
 * 「稍后」关掉弹窗，问题照常能发；「去连接」打开连接器页里东方财富那张卡片，连上后自动回到这位专家。
 */

import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  usePluginI18n,
  useValue
} from '@hermes/plugin-sdk'

import { $connectorLoginPrompt, dismissConnectorLogin, goToConnector } from './connector-login'
import { summonExpert } from './summon'

/** 连接器登录提示框；没有要问的时候什么都不显示。 */
export function ConnectorLoginDialog() {
  const t = usePluginI18n('uniwork-kits')
  const prompt = useValue($connectorLoginPrompt)

  return (
    <Dialog onOpenChange={open => !open && dismissConnectorLogin()} open={Boolean(prompt)}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('connectorLoginTitle')}</DialogTitle>
          <DialogDescription>
            {prompt?.expert.display_name ?? ''}
            {t(window.hermesDesktop?.cloudKits && window.hermesDesktop?.cloudConnectorIds ? 'cloudConnectorLoginBody' : 'connectorLoginBody')}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button onClick={() => dismissConnectorLogin()} size="sm" variant="secondary">
            {t('connectorLoginLater')}
          </Button>
          <Button onClick={() => goToConnector(summonExpert)} size="sm">
            {t('connectorLoginConfirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
