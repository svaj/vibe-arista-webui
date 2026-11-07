import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { ConfigDiff } from './ConfigDiff'

// The mocked device diff `App.test.tsx` stages through the review panel today.
const DIFF = '+interface Ethernet1\n+ switchport mode access\n+ switchport access vlan 20'

const diffBlock = (text: string | RegExp) => screen.getByText(text, { selector: 'pre' })

describe('ConfigDiff', () => {
  it('shows the staging copy while the diff has not come back', () => {
    render(<ConfigDiff />)

    expect(screen.getByText('The change is staged or its outcome is uncertain. A diff is required before commit.')).toBeInTheDocument()
    expect(screen.queryByText(/No configuration differences returned\./u)).not.toBeInTheDocument()
    expect(screen.queryByText(/switchport/u)).not.toBeInTheDocument()
  })

  it('separates "the device reported no differences" from "the diff is still unread"', () => {
    render(<ConfigDiff diff="" />)

    // The empty-diff arm is diff text itself, so it stays inside the diff block rather than becoming
    // a notice. The staging copy above must never look like an empty diff.
    const block = diffBlock('No configuration differences returned.')
    expect(block).toHaveClass('diff-output')
    expect(block).toHaveAttribute('aria-label', 'Configuration diff')
    expect(screen.queryByText('The change is staged or its outcome is uncertain. A diff is required before commit.')).not.toBeInTheDocument()
  })

  it('renders the device diff verbatim in the labelled diff block', () => {
    render(<ConfigDiff diff={DIFF} />)

    const block = diffBlock(/switchport access vlan 20/u)
    expect(block).toHaveClass('diff-output')
    expect(block).toHaveAttribute('aria-label', 'Configuration diff')
    // Text queries normalise whitespace, so the byte-for-byte comparison is made on the node.
    expect(block.textContent).toBe(DIFF)
  })

  it('keeps the element and accessible name SwitchManager renders today', () => {
    // A JSX attribute string would keep `\n` literally, so the newline arrives as an expression.
    render(<ConfigDiff diff={'! empty session\n'} />)

    const block = diffBlock('! empty session')
    expect(block.tagName).toBe('PRE')
    expect(block).toHaveAttribute('aria-label', 'Configuration diff')
    expect(block.textContent).toBe('! empty session\n')
  })

  it('offers no commit, abort, or confirmation control of its own', () => {
    render(<ConfigDiff diff={DIFF} />)

    // Commit-enablement (`session.hasDiffBeenRead()`) and the buttons belong to the container (F6).
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})
