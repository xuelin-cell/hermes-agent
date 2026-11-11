// 从 lucide-react 导出 PPT 常用的一批图标数据（lucide.json）。只在更新图标时手动跑：
//   node plugins/uniwork-kits/pptx_icons/make_icons.mjs
// 读的是仓库根 node_modules 里 lucide-react 每个图标文件里的 __iconNode（SVG 元素列表），不加载 React。
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const icons = join(here, '..', '..', '..', 'node_modules', 'lucide-react', 'dist', 'esm', 'icons')

// 做 PPT 常用的：通用标记、数据、商业、科技数码、教育、生活、自然、交通、人物。
const NAMES = `
check circle-check circle-x circle-alert triangle-alert info circle-help star heart thumbs-up flag bookmark tag
lightbulb sparkles zap flame target award trophy medal crown gem gift rocket compass map map-pin globe link key
lock shield shield-check eye search funnel settings wrench hammer puzzle layers layout-grid list-checks
clipboard-list calendar calendar-days clock timer hourglass history refresh-cw arrow-right arrow-up-right
trending-up trending-down chart-column chart-line chart-pie activity gauge percent dollar-sign coins wallet
credit-card banknote receipt shopping-cart shopping-bag store package truck plane car train-front bike ship
building building-2 factory landmark house school hospital users user user-check baby graduation-cap book-open
book notebook-pen pen-tool pencil palette brush camera image film clapperboard music headphones mic video tv
monitor laptop smartphone tablet keyboard mouse cpu memory-stick hard-drive server database cloud wifi bluetooth
battery-full battery-charging plug cable usb printer gamepad-2 bot brain code terminal file-text folder mail
message-circle phone send bell megaphone newspaper share-2 handshake briefcase scale stethoscope heart-pulse pill
dna flask-conical microscope atom leaf tree-pine sprout flower-2 sun moon cloud-rain snowflake droplet wind
mountain waves recycle coffee utensils apple dumbbell smile swords castle tent footprints paw-print fish bird
`.trim().split(/\s+/)

/** 读出某个图标的 __iconNode 字面量；别名文件（只转给另一个图标）跟过去读。没有这个图标返回 null。 */
function iconNode(name, depth = 0) {
  let text
  try {
    text = readFileSync(join(icons, `${name}.js`), 'utf8')
  } catch {
    return null
  }
  const body = text.match(/const __iconNode = (\[[\s\S]*?\]);\r?\n/)
  if (body) {
    return body[1]
  }
  const alias = text.match(/from '\.\/([a-z0-9-]+)\.js'/)
  return alias && depth < 3 ? iconNode(alias[1], depth + 1) : null
}

const out = {}
const missing = []
for (const name of NAMES) {
  const body = iconNode(name)
  if (!body) {
    missing.push(name)
    continue
  }
  // 图标文件里是 JS 字面量（键没加引号），按表达式求值；来源是本仓库锁定版本的依赖。
  const node = Function(`return ${body}`)()
  out[name] = node.map(([tag, attrs]) => {
    const { key: _key, ...rest } = attrs
    return [tag, rest]
  })
}
writeFileSync(join(here, 'lucide.json'), JSON.stringify(out))
console.log(`wrote ${Object.keys(out).length} icons`, missing.length ? `missing: ${missing.join(' ')}` : '')
