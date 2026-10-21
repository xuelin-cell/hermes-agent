import { cpSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { isMain } from '../../../scripts/build/frontend-common.mjs'

/** Build one complete discovery root; never assemble plugins inside an account home. */
export function stagePythonPlugins({ source, out, bundledKits = null }) {
  source = resolve(source)
  const destination = join(resolve(out), 'python-plugins')
  const official = join(source, 'plugins')
  const personal = join(source, 'apps/desktop/assets/uniagentgate-plugin')
  for (const input of [official, personal]) {
    const rel = relative(input, destination)
    const reverse = relative(destination, input)
    if (!rel || (!rel.startsWith('..') && !isAbsolute(rel)) ||
        (!reverse.startsWith('..') && !isAbsolute(reverse))) {
      throw new Error('Plugin output must be outside plugin sources')
    }
  }
  if (!statSync(join(personal, 'plugin.yaml')).isFile() || !statSync(official).isDirectory()) {
    throw new Error('Desktop Python plugin inputs are incomplete')
  }
  const filter = file => basename(file) !== '__pycache__' && !file.endsWith('.pyc')
  rmSync(destination, { recursive: true, force: true })
  mkdirSync(destination, { recursive: true })
  cpSync(official, destination, { recursive: true, dereference: true, filter })
  cpSync(personal, join(destination, 'uniagentgate'), { recursive: true, dereference: true, filter })
  if (bundledKits) {
    // desktop-mt: 内置套件和专家打包时才从 GitCode 拉进 agent-payload 快照，源码 plugins/ 里没有；
    // 安装版后端从这里发现插件，autoseed 在 uniwork-kits/bundled 下找包，所以一起放进来。
    if (!statSync(bundledKits).isDirectory()) {
      throw new Error('Bundled kits directory is missing')
    }
    cpSync(bundledKits, join(destination, 'uniwork-kits', 'bundled'), { recursive: true, dereference: true })
  }
  return destination
}

/** desktop-mt: 完整包里内置套件的位置（scripts/bundles/uniwork_bundled.py 的 TARGET 的上一层）。
 *  agent-payload 和构建信息放在同一目录（write-build-stamp.mjs）；不是完整包、或这次没带内置套件时返回 null。 */
export function payloadBundledKits(stamp, metadata) {
  if (metadata?.payload !== 'bundled' || !metadata.runtime?.repoDir) {
    return null
  }
  const kits = join(dirname(resolve(stamp)), 'agent-payload', metadata.runtime.repoDir, 'plugins', 'uniwork-kits', 'bundled')
  return existsSync(join(kits, 'uniwork-bundled', 'plugins')) ? kits : null
}

if (isMain(import.meta.url)) {
  const { values } = parseArgs({ options: {
    source: { type: 'string' }, out: { type: 'string' }, 'bundled-kits': { type: 'string' },
  } })
  if (!values.source || !values.out) throw new Error('--source and --out are required')
  stagePythonPlugins({ source: values.source, out: values.out, bundledKits: values['bundled-kits'] ?? null })
}
