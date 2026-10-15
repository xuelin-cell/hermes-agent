import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { CloudDriveTab } from './cloud-drive-tab'

vi.mock('./cloud-library', () => ({ CloudLibrary: () => <p>cloud library</p> }))

afterEach(() => {
  cleanup()
  delete window.document.documentElement.dataset.hermesBrowser
})

describe('CloudDriveTab', () => {
  it('is the cloud library on the desktop', () => {
    render(<CloudDriveTab />)

    expect(screen.getByText('cloud library')).toBeTruthy()
  })

  it('says the cloud drive is in development in the browser build, without loading it', () => {
    window.document.documentElement.dataset.hermesBrowser = 'production'

    render(<CloudDriveTab />)

    expect(screen.getByText('功能开发中')).toBeTruthy()
    expect(screen.queryByText('cloud library')).toBeNull()
  })
})
