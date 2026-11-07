import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { ShowVersionReply } from '../../eapi/show-contracts'

import { ConnectionHeader } from './ConnectionHeader'
import { identityFrom } from '../../shared/identity'

// Same verbatim DCS-7050TX-64 / 4.28.13.1M `show version` shape `App.test.tsx` mocks, resolved
// through the moved `identityFrom` so the chip test pins the real composition path.
const switchVersion: ShowVersionReply = {
  hostname: 'sw1',
  version: '4.28.13.1M',
  systemMacAddress: '00:00:00:00:00:00',
  modelName: 'DCS-7050TX-64',
  serialNumber: '0000000000',
  internalVersion: '4.28.13.1M',
  architecture: 'x86_64',
  bootupTimestamp: 0,
  uptime: 0,
}
const identity = identityFrom(switchVersion)

describe('ConnectionHeader', () => {
  it('names the connected state in text and marks it with the resting dot', () => {
    const { container } = render(<ConnectionHeader state="connected" />)

    expect(screen.getByText('Connected through local proxy')).toBeInTheDocument()
    // The dot carries colour only, so it stays decorative and must never be the whole message.
    expect(container.querySelector('.status-dot')).not.toHaveClass('is-error', 'is-pending')
    expect(container.querySelector('.status-dot')).toHaveAttribute('aria-hidden', 'true')
  })

  it('names a failed connection and marks the dot as an error', () => {
    const { container } = render(<ConnectionHeader state="error" />)

    expect(screen.getByText('Connection failed')).toBeInTheDocument()
    expect(container.querySelector('.status-dot')).toHaveClass('is-error')
  })

  it('names an in-flight read and marks the dot pending', () => {
    const { container } = render(<ConnectionHeader state="connecting" />)

    expect(screen.getByText('Connecting through local proxy')).toBeInTheDocument()
    expect(container.querySelector('.status-dot')).toHaveClass('is-pending')
  })

  it('lets a screen replace the default copy without touching the dot contract', () => {
    render(<ConnectionHeader state="connecting" connectingLabel="Reading device state…" />)

    expect(screen.getByText('Reading device state…')).toBeInTheDocument()
    expect(screen.queryByText('Connecting through local proxy')).not.toBeInTheDocument()
  })

  it('composes the identity chip from an already-read identity', () => {
    render(<ConnectionHeader state="connected" identity={identity} />)

    expect(screen.getByText('sw1 · EOS 4.28.13.1M · DCS-7050TX-64')).toBeInTheDocument()
  })

  it('omits the chip when the container has no identity, keeping the connection text intact', () => {
    // The soft-failure contract: a failed `show version` supplies no identity, so there is no chip —
    // and this primitive raises no alert of its own, which is what keeps the workspace visible.
    render(<ConnectionHeader state="connected" />)

    expect(screen.queryByText(/DCS-7050TX-64/u)).not.toBeInTheDocument()
    expect(screen.getByText('Connected through local proxy')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('renders no device controls of its own', () => {
    render(<ConnectionHeader state="error" identity={identity} />)

    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    // A container-supplied identity still composes on a failed read; the container decides to omit it.
    expect(screen.getByText('sw1 · EOS 4.28.13.1M · DCS-7050TX-64')).toBeInTheDocument()
  })
})
