import amap from '@/assets/connectors-mt/amap.png'
import aminer from '@/assets/connectors-mt/aminer.png'
import eastmoney from '@/assets/connectors-mt/eastmoney.svg'
import ifind from '@/assets/connectors-mt/ifind.svg'
import ima from '@/assets/connectors-mt/ima.png'
import netease from '@/assets/connectors-mt/netease-mail.svg'
import qcc from '@/assets/connectors-mt/qcc.svg'
import qq from '@/assets/connectors-mt/qq-mail.png'
import wecom from '@/assets/connectors-mt/wecom.png'
import wps from '@/assets/connectors-mt/wps.png'
import youdao from '@/assets/connectors-mt/youdao-note.png'

// 与 HexAgent 推荐目录顺序一致；这里只保存展示资源，不声明连接或授权状态。
export const RECOMMENDED_CONNECTORS = [
  { id: 'qq_mail', icon: qq },
  { id: 'netease_mail', icon: netease },
  { id: 'amap', icon: amap },
  { id: 'wps_mcp', icon: wps },
  { id: 'youdao_note', icon: youdao },
  { id: 'ima', icon: ima },
  { id: 'qcc_mcp', icon: qcc },
  { id: 'eastmoney_mcp', icon: eastmoney },
  { id: 'ifind_mcp', icon: ifind },
  { id: 'aminer', icon: aminer },
  { id: 'wecom_bot', icon: wecom }
] as const
