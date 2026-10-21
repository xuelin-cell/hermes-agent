import { cpSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { isMain } from '../../../scripts/build/frontend-common.mjs'

/** Build one complete discovery root; never assemble plugins inside an account home. */
export function stagePythonPlugins({ source, out }) {
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
  return destination
}

if (isMain(import.meta.url)) {
  const { values } = parseArgs({ options: { source: { type: 'string' }, out: { type: 'string' } } })
  if (!values.source || !values.out) throw new Error('--source and --out are required')
  stagePythonPlugins(values)
}
