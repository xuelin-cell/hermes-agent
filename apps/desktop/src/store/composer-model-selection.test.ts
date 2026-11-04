import { expect, it } from 'vitest'

import {
  $currentModel, $currentProvider, getCurrentModelSource,
  rememberComposerModelSelection, restoreComposerModelSelection,
  setComposerSelectionOwner, setCurrentModelTransient, setCurrentProviderTransient
} from './session'

it('restores the last explicit choice instead of the previous session runtime model', () => {
  setComposerSelectionOwner('model-selection-test', 'default')
  rememberComposerModelSelection('chosen-model', 'custom:chosen')
  setCurrentModelTransient('previous-default')
  setCurrentProviderTransient('custom')
  restoreComposerModelSelection()
  expect($currentModel.get()).toBe('chosen-model')
  expect($currentProvider.get()).toBe('custom:chosen')
  expect(getCurrentModelSource()).toBe('manual')
  setComposerSelectionOwner('model-selection-test', 'other')
  expect($currentModel.get()).toBe('')
  setComposerSelectionOwner('model-selection-test', 'default')
  expect($currentModel.get()).toBe('chosen-model')
})
