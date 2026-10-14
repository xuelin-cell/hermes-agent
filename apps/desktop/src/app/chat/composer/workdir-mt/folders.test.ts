import { describe, expect, it } from 'vitest'

import { NO_PROJECT_ID } from '@/app/chat/sidebar/projects/workspace-groups'

import { isBlockedWorkdir, RECENT_WORKDIR_LIMIT, recentWorkdirs, sameWorkdir, workdirName } from './folders'
import { draftWorkdir } from './workdir-picker'

describe('isBlockedWorkdir', () => {
  it('refuses drive roots, system folders, and bare home folders like UniWork', () => {
    for (const path of [
      '',
      'C:\\',
      'D:',
      'c:/Windows',
      'C:\\Program Files\\',
      'C:\\Program Files (x86)',
      'C:\\ProgramData',
      'C:\\Users',
      'C:\\Users\\stan',
      '/',
      '/usr',
      '/Users/stan',
      '/home/stan'
    ]) {
      expect(isBlockedWorkdir(path), path).toBe(true)
    }
  })

  it('allows concrete subfolders, including ones under the home folder', () => {
    for (const path of ['C:\\Users\\stan\\Desktop', 'D:\\work\\project', 'C:\\Windows-tools', '/home/stan/code']) {
      expect(isBlockedWorkdir(path), path).toBe(false)
    }
  })
})

describe('recentWorkdirs', () => {
  it('orders by last activity, folds case and separators, and skips the default workspace', () => {
    const sessions = [
      { cwd: 'D:\\a', last_active: 1 },
      { cwd: 'd:/A/', last_active: 5 },
      { cwd: 'C:\\acct\\workspace', last_active: 9 },
      { cwd: null, last_active: 8 },
      { cwd: 'E:\\b', last_active: 3 }
    ]

    expect(recentWorkdirs(sessions, ['C:/acct/workspace'])).toEqual(['d:/A/', 'E:\\b'])
  })

  it('keeps at most the recent limit', () => {
    const sessions = Array.from({ length: RECENT_WORKDIR_LIMIT + 3 }, (_, i) => ({ cwd: `D:\\p${i}`, last_active: i }))

    expect(recentWorkdirs(sessions)).toHaveLength(RECENT_WORKDIR_LIMIT)
  })
})

describe('path helpers', () => {
  it('names a folder by its last segment and compares paths loosely', () => {
    expect(workdirName('D:\\work\\project\\')).toBe('project')
    expect(sameWorkdir('D:\\Work\\', 'd:/work')).toBe(true)
    expect(sameWorkdir('', '')).toBe(false)
  })
})

describe('draftWorkdir', () => {
  it('follows the same precedence the new-session create uses', () => {
    expect(draftWorkdir(null, 'any', 'D:\\live')).toBe('')
    expect(draftWorkdir(undefined, NO_PROJECT_ID, 'D:\\live')).toBe('')
    expect(draftWorkdir(' D:\\picked ', NO_PROJECT_ID, 'D:\\live')).toBe('D:\\picked')
    expect(draftWorkdir(undefined, 'project-1', 'D:\\live')).toBe('D:\\live')
  })
})
