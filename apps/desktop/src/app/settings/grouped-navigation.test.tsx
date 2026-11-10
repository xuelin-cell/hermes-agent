import { fireEvent, render, screen } from '@testing-library/react'
import { expect, it } from 'vitest'
import { Info } from '@/lib/icons'
import { GroupedSettingsNavigation } from './grouped-navigation'
import { settingsViewVisible } from './visibility'

it('keeps every visible entry in exactly one of the four sections and excludes developer entries in standard mode', () => {
  const entries = [
    'general',
    'models',
    'messaging',
    'sessions',
    'config:safety',
    'help',
    'about',
    'config:advanced',
    'providers'
  ]
  const visible = entries.filter(id => settingsViewVisible(id, false))
  const view = render(
    <GroupedSettingsNavigation
      groups={visible.map(id => ({ id, label: id, icon: Info, active: false, onSelect: () => undefined }))}
    />
  )
  expect(screen.getAllByRole('heading', { level: 2 })).toHaveLength(4)
  for (const id of visible) expect(screen.getAllByRole('button', { name: id })).toHaveLength(1)
  expect(screen.queryByRole('button', { name: 'config:advanced' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'providers' })).toBeNull()
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'language' } })
  expect(screen.getAllByRole('button')).toHaveLength(1)
  expect(screen.getByRole('button', { name: 'general' })).toBeTruthy()
  view.unmount()
})

it('keeps data management and security as single entries even when active', () => {
  const groups = ['sessions', 'config:safety'].map(id => ({
    id,
    label: id,
    icon: Info,
    active: true,
    onSelect: () => undefined,
    children: ['archived', 'default-directory', 'approvals'].map(child => ({
      id: child,
      label: child,
      icon: Info,
      active: true,
      onSelect: () => undefined
    }))
  }))
  const view = render(<GroupedSettingsNavigation groups={groups} />)
  expect(screen.getAllByRole('button')).toHaveLength(2)
  for (const label of ['archived', 'default-directory', 'approvals'])
    expect(screen.queryByRole('button', { name: label })).toBeNull()
  view.unmount()
})
