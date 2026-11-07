import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { EmptyState } from './EmptyState'

describe('EmptyState', () => {
  it('renders the "what is empty" copy the container supplies', () => {
    render(<EmptyState heading="The device returned no VLAN entries." />)

    expect(screen.getByText('The device returned no VLAN entries.')).toBeInTheDocument()
  })

  it('adds the "what would fill it" hint when the container has one', () => {
    render(<EmptyState heading='No writable VLANs (IDs 1–4094) are available.' hint='Create a VLAN on the switch, then refresh device state.' />)

    expect(screen.getByText('No writable VLANs (IDs 1–4094) are available.')).toBeInTheDocument()
    expect(screen.getByText('Create a VLAN on the switch, then refresh device state.')).toBeInTheDocument()
  })

  it('renders no hint element when the hint is omitted', () => {
    render(<EmptyState heading="The device returned no VLAN entries." />)

    expect(screen.getAllByRole('paragraph')).toHaveLength(1)
  })

  it('stays visually and semantically distinct from an error state', () => {
    render(<EmptyState heading="No supported Ethernet interfaces were returned." />)

    // A successful-but-empty read must not announce itself as an alert or a live update, and must
    // not pick up the `.notice-error` vocabulary — `App.test.tsx` pins that split at screen level.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(screen.getByText('No supported Ethernet interfaces were returned.').closest('div')).not.toHaveClass('notice-error')
    expect(screen.getByText('No supported Ethernet interfaces were returned.').closest('div')).toHaveClass('empty-state')
  })

  it('carries no interactive controls of its own', () => {
    render(<EmptyState heading="The device returned no VLAN entries." hint="Refresh state after creating one." />)

    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    expect(screen.queryAllByRole('paragraph')).toHaveLength(2)
  })
})
