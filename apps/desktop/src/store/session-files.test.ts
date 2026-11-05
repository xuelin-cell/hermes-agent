import { expect, it } from 'vitest'

import { $sessionsWithFiles, noteSessionFile } from './session-files'

it('marks only sessions with file cards and keeps one marker for multiple files', () => {
  $sessionsWithFiles.set([])
  noteSessionFile(null)
  expect($sessionsWithFiles.get()).toEqual([])
  noteSessionFile('with-files')
  noteSessionFile('with-files')
  expect($sessionsWithFiles.get()).toEqual(['with-files'])
})
