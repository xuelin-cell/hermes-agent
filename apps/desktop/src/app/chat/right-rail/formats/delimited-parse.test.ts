import { describe, expect, it } from 'vitest'

import { delimiterForPath, parseDelimited } from './delimited-parse'

describe('delimited parser', () => {
  it.each([
    ['csv', 'name,note\n张三,"中文,说明"', ',', ['name', 'note'], [['张三', '中文,说明']]],
    ['quoted newline', 'name,note\r\n甲,"第一行\r\n第二行"\r\n', ',', ['name', 'note'], [['甲', '第一行\r\n第二行']]],
    ['escaped quote', 'name,note\n甲,"他说""你好"""', ',', ['name', 'note'], [['甲', '他说"你好"']]],
    ['tsv', 'name\tnote\n甲\t"内嵌\t制表符"', '\t', ['name', 'note'], [['甲', '内嵌\t制表符']]],
    ['empty fields', '\uFEFFname,note\n,\n\n乙,\n', ',', ['name', 'note'], [['', ''], [''], ['乙', '']]]
  ])('preserves %s records and cells', (_name, text, delimiter, headers, rows) => {
    expect(parseDelimited(text as string, delimiter as string)).toEqual({ headers, rows, limited: false })
  })

  it('handles empty files and does not add a phantom row for a final newline', () => {
    expect(parseDelimited('', ',')).toEqual({ headers: [], rows: [], limited: false })
    expect(parseDelimited('head\nvalue\n', ',').rows).toEqual([['value']])
  })

  it('bounds displayed data rows and distinguishes exactly-full content', () => {
    expect(parseDelimited('head\none\ntwo', ',', 2)).toEqual({
      headers: ['head'],
      rows: [['one'], ['two']],
      limited: false
    })
    expect(parseDelimited('head\none\ntwo\nthree', ',', 2)).toEqual({
      headers: ['head'],
      rows: [['one'], ['two']],
      limited: true
    })
  })

  it('discards a partially read final record instead of displaying broken cells', () => {
    expect(parseDelimited('a,b\n1,2\n3,"cut', ',', 500, true)).toEqual({
      headers: ['a', 'b'],
      rows: [['1', '2']],
      limited: false
    })
    expect(parseDelimited('a,b\n1,2\n3,partial', ',', 500, true).rows).toEqual([['1', '2']])
  })

  it.each(['a,b\n1,"unclosed', 'a,b\n1,wrong"quote', 'a,b\n1,"closed"tail'])('rejects malformed quoting', text => {
    expect(() => parseDelimited(text, ',')).toThrow()
  })

  it('selects TSV by extension while handling uppercase and revisions', () => {
    expect(delimiterForPath('/files/table.TSV?revision=2')).toBe('\t')
    expect(delimiterForPath('/files/table.csv')).toBe(',')
  })
})
