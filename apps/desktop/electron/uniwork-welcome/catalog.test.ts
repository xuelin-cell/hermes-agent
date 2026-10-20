import { expect, it } from 'vitest'

import { normalizeWelcomeCatalog } from './catalog'

/** 构造完整启用模板，字段关系用于排序和过滤契约。 */
function template(id: string, sort = 10) {
  return { id, name: id, prompt: `prompt-${id}`, sort, enabled: true }
}

it('忽略enabled但过滤重复和损坏条目，稳定排序并保留完整提示词', () => {
  const modules = normalizeWelcomeCatalog({
    modules: [
      {
        id: 'office',
        name: 'Configured office',
        enabled: true,
        tags: [
          {
            id: 'later',
            name: 'Later',
            enabled: true,
            sort: 20,
            templates: [template('b', 20), template('a'), template('a'), { ...template('off'), enabled: false }]
          },
          { id: 'first', name: 'First', enabled: true, sort: 10, templates: [template('first')] },
          { id: 'first', name: 'Duplicate', enabled: true, templates: [template('wrong')] },
          { id: 'broken', name: 'Broken', enabled: true, templates: [{ id: 'bad' }] },
          { id: 'off', name: 'Off', enabled: false, templates: [template('hidden')] }
        ]
      }
    ]
  })

  const tags = modules[0].tags

  expect(tags.map(item => item.id)).toEqual(['first', 'later', 'off'])
  expect(tags[1].templates.map(item => item.prompt)).toEqual(['prompt-a', 'prompt-off', 'prompt-b'])
})

it('配置决定名称顺序和路由，重复或缺失业务ID不丢失模块，空配置不生成标签', () => {
  const modules = normalizeWelcomeCatalog({
    modules: [
      { id: 'same', name: 'Learning', sort: 30, tags: [] },
      { id: 'same', name: '  CODE   Development ', workspace: 'work', sort: 20 },
      { name: 'Office', workspace: 'work', sort: 10 },
      { name: 'Disabled', enabled: false, sort: 0 },
      { name: ' ' }
    ]
  })

  expect(modules.map(({ name, workspace }) => ({ name, workspace }))).toEqual([
    { name: 'Disabled', workspace: 'work' },
    { name: 'Office', workspace: 'work' },
    { name: '  CODE   Development ', workspace: 'codex' },
    { name: 'Learning', workspace: 'work' }
  ])
  expect(new Set(modules.map(module => module.id)).size).toBe(modules.length)
  expect(normalizeWelcomeCatalog({ modules: [{ name: 'B' }, { name: 'A' }] }).map(module => module.name)).toEqual([
    'B',
    'A'
  ])
  expect(normalizeWelcomeCatalog({ modules: [] })).toEqual([])
  expect(() => normalizeWelcomeCatalog({})).toThrow('目录格式无效')
})
