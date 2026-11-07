import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { StatePill } from './StatePill'

// Tokens below are device spellings with evidence in this repo: VLAN `state`, config-session
// `state`, switchport `mode`, and interface `status`/`protocol` values. See StatePill.tsx's docs.
const toneByToken: readonly (readonly [string, string])[] = [
  ['active', 'state-pill-positive'],
  ['connected', 'state-pill-positive'],
  ['committed', 'state-pill-positive'],
  ['pending', 'state-pill-caution'],
  ['suspend', 'state-pill-caution'],
  ['diffed', 'state-pill-caution'],
  ['notconnect', 'state-pill-risk'],
  ['errdisabled', 'state-pill-risk'],
  ['conflicted', 'state-pill-risk'],
  ['access', 'state-pill-mode'],
  ['trunk', 'state-pill-mode'],
  ['dot1q-tunnel', 'state-pill-mode'],
]

describe('StatePill', () => {
  it('renders the token as text next to its colour class, never colour alone', () => {
    render(<StatePill value="active" />)

    const pill = screen.getByText('active')
    expect(pill).toHaveClass('state-pill', 'state-pill-positive')
    expect(pill.textContent).not.toBe('')
  })

  it('tones each token this repo has evidence for', () => {
    render(<div>{toneByToken.map(([value]) => <StatePill key={value} value={value} />)}</div>)

    for (const [value, tone] of toneByToken) {
      expect(screen.getByText(value)).toHaveClass('state-pill', tone)
      expect(screen.getByText(value)).not.toHaveClass('state-pill-neutral')
    }
  })

  it('passes an unrecognised device token through verbatim with the neutral tone', () => {
    render(<div><StatePill value="banana" /><StatePill value="dynamic auto" /><StatePill value="in a two-phase state" /></div>)

    for (const value of ['banana', 'dynamic auto', 'in a two-phase state']) {
      const pill = screen.getByText(value)
      expect(pill).toHaveClass('state-pill', 'state-pill-neutral')
      expect(pill.textContent).toBe(value)
    }
  })

  it('never renames, re-cases, or rewrites the token it was given', () => {
    render(<div><StatePill value="ACTIVE" /><StatePill value="Errdisabled" /><StatePill value="Trunk" /></div>)

    // The tone lookup is case-insensitive, but the visible text is always the raw device string.
    expect(screen.getByText('ACTIVE').textContent).toBe('ACTIVE')
    expect(screen.getByText('ACTIVE')).toHaveClass('state-pill-positive')
    expect(screen.getByText('Errdisabled').textContent).toBe('Errdisabled')
    expect(screen.getByText('Errdisabled')).toHaveClass('state-pill-risk')
    expect(screen.getByText('Trunk').textContent).toBe('Trunk')
    expect(screen.getByText('Trunk')).toHaveClass('state-pill-mode')
  })

  it('renders an empty token as an empty neutral pill instead of inventing a label', () => {
    render(<StatePill value="" />)

    // An empty token has no text to query, so the matcher pins the pill element itself.
    const pill = screen.getByText((_content, element) => element?.tagName === 'SPAN')
    expect(pill).toHaveClass('state-pill', 'state-pill-neutral')
    expect(pill.textContent).toBe('')
  })
})
