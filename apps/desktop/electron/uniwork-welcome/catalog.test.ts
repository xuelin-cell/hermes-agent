import { expect, it } from 'vitest'

import { normalizeOfficeCatalog } from './catalog'

/** 构造完整启用模板，字段关系用于排序和过滤契约。 */
function template(id: string, sort = 10) {
  return { id, name: id, prompt: `prompt-${id}`, sort, enabled: true }
}

it('过滤停用、重复和损坏条目，稳定排序并保留完整提示词', () => {
  const tags = normalizeOfficeCatalog({
    modules: [
      {
        id: 'office',
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

  expect(tags.map(item => item.id)).toEqual(['first', 'later'])
  expect(tags[1].templates.map(item => item.prompt)).toEqual(['prompt-a', 'prompt-b'])
})

it('办公缺失或停用时不使用编程模块，坏响应必须与明确空目录区分', () => {
  const programming = {
    id: 'programming',
    enabled: true,
    tags: [{ id: 'code', name: 'Code', enabled: true, templates: [template('code')] }]
  }

  expect(normalizeOfficeCatalog({ modules: [programming] })).toEqual([])
  expect(normalizeOfficeCatalog({ modules: [{ ...programming, id: 'office', enabled: false }] })).toEqual([])
  expect(() => normalizeOfficeCatalog({})).toThrow('目录格式无效')
  expect(() => normalizeOfficeCatalog({ modules: [{ id: 'office', enabled: true, tags: null }] })).toThrow(
    '分类格式无效'
  )
})
