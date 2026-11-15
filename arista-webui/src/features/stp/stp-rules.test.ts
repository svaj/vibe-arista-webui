/**
 * S15 (#85): the pure rules behind the spanning-tree screen. Every command-text assertion here is
 * copied from the `sentAsText` pins in `arista-api-client/src/resources/stp.test.ts` (minus the
 * transport's `['enable', 'configure terminal', …]` framing, plus the session-side
 * `interface <port>` parent the container composes with the client's own `submodeCommands`).
 * These are the texts the screen test then pins at `session.run`, so the two files share one
 * source of truth: the frozen client's pins, never invented CLI.
 */
import { describe, expect, it } from 'vitest'

import {
  CLIENT_PORTFAST_TYPES,
  STP_INSTANCES_NOTE,
  STP_MODE_EDIT_NOTE,
  STP_OPERATIONAL_NOTE,
  STP_WRITE_ACTIONS,
  actionIsDestructive,
  isClientPortfastType,
  portfastLoopRisk,
  stageRisks,
  stpPortRowView,
  stpWriteAction,
} from './stp-rules'
import type { StpWriteActionId } from './stp-rules'

describe('stp-rules — the ten staged batches, byte-for-byte from stp.test.ts pins', () => {
  /** `[actionId, port, expected session batch]` — parent line first, exactly as the client frames it. */
  const PINS: readonly [StpWriteActionId, string, readonly string[]][] = [
    ['bpduguard-enable', 'Ethernet1', ['interface Ethernet1', 'spanning-tree bpduguard enable']],
    ['bpduguard-disable', 'Ethernet1', ['interface Ethernet1', 'spanning-tree bpduguard disable']],
    ['bpduguard-unset', 'Ethernet1', ['interface Ethernet1', 'no spanning-tree bpduguard']],
    ['bpduguard-default', 'Ethernet1', ['interface Ethernet1', 'default spanning-tree bpduguard']],
    ['portfast-enable', 'Ethernet2', ['interface Ethernet2', 'spanning-tree portfast']],
    ['portfast-unset', 'Ethernet2', ['interface Ethernet2', 'no spanning-tree portfast']],
    ['portfast-default', 'Ethernet2', ['interface Ethernet2', 'default spanning-tree portfast']],
    ['portfast-type-edge', 'Port-Channel1', ['interface Port-Channel1', 'spanning-tree portfast edge', 'spanning-tree portfast auto']],
    ['portfast-type-network', 'Ethernet1', ['interface Ethernet1', 'spanning-tree portfast network']],
    ['portfast-type-normal', 'Ethernet1', ['interface Ethernet1', 'spanning-tree portfast normal']],
  ]

  it('covers every action exactly once, and every action is pinned', () => {
    const pinned = PINS.map(([id]) => id)
    expect(new Set(pinned).size).toBe(pinned.length)
    for (const action of STP_WRITE_ACTIONS) expect(pinned).toContain(action.id)
    for (const [id] of PINS) expect(stpWriteAction(id)).toBeDefined()
    expect(stpWriteAction('')).toBeUndefined()
    expect(stpWriteAction('spanning-tree-mode-mstp')).toBeUndefined()
  })

  for (const [id, port, batch] of PINS) {
    it(`${id} stages ${JSON.stringify(batch)}`, () => {
      const action = stpWriteAction(id)
      expect(action).toBeDefined()
      // Rules carry the lines WITHOUT the parent; the container adds the parent via submodeCommands.
      expect([`interface ${port}`, ...action!.commands]).toEqual(batch)
      expect(action!.label.length).toBeGreaterThan(0)
    })
  }

  it('the edge arm is the upstream two-line pair; every other arm is a single line', () => {
    expect(stpWriteAction('portfast-type-edge')!.commands).toEqual(['spanning-tree portfast edge', 'spanning-tree portfast auto'])
    for (const action of STP_WRITE_ACTIONS) {
      if (action.id === 'portfast-type-edge') continue
      expect(action.commands).toHaveLength(1)
    }
  })

  it('bpduguard uses the two WORDS upstream maps its boolean to (divergence 8), never a negation for disable', () => {
    expect(stpWriteAction('bpduguard-enable')!.commands).toEqual(['spanning-tree bpduguard enable'])
    expect(stpWriteAction('bpduguard-disable')!.commands).toEqual(['spanning-tree bpduguard disable'])
    // The `no` form is a SEPARATE verb — the texts must stay distinguishable (DR-037).
    expect(stpWriteAction('bpduguard-unset')!.commands).toEqual(['no spanning-tree bpduguard'])
  })
})

describe('stp-rules — confirm boundaries and destructive flags', () => {
  it('portfast-loop guards every affirmative PortFast spelling', () => {
    for (const id of ['portfast-enable', 'portfast-type-edge', 'portfast-type-network', 'portfast-type-normal'] as const) {
      expect(stpWriteAction(id)!.enablesPortfast).toBe(true)
      expect(stpWriteAction(id)!.boundary).toBe('portfast-loop')
    }
  })

  it('default verbs get the device-default boundary; guard-weakening writes get reduce-protection', () => {
    expect(stpWriteAction('bpduguard-disable')!.boundary).toBe('reduce-protection')
    expect(stpWriteAction('bpduguard-unset')!.boundary).toBe('reduce-protection')
    expect(stpWriteAction('bpduguard-default')!.boundary).toBe('device-default')
    // `default spanning-tree portfast` can leave PortFast ON (the reader counts portfast enabled
    // unless the exact negation line remains), so it is guarded as a default, not waved through.
    expect(stpWriteAction('portfast-default')!.boundary).toBe('device-default')
    expect(stpWriteAction('portfast-default')!.enablesPortfast).toBe(false)
  })

  it('only bpduguard-enable and portfast-unset skip the risky commit verb', () => {
    expect(actionIsDestructive(stpWriteAction('bpduguard-enable')!)).toBe(false)
    expect(actionIsDestructive(stpWriteAction('portfast-unset')!)).toBe(false)
    for (const action of STP_WRITE_ACTIONS) {
      if (action.id === 'bpduguard-enable' || action.id === 'portfast-unset') continue
      expect(actionIsDestructive(action)).toBe(true)
    }
  })

  it('portfastLoopRisk names the port repeatedly and admits the far end is invisible', () => {
    const risk = portfastLoopRisk('Ethernet7')
    expect(risk.match(/Ethernet7/gu)?.length).toBeGreaterThanOrEqual(3)
    expect(risk).toContain('CANNOT see what is connected on the far end of Ethernet7')
    expect(risk).toMatch(/loop the bridged network/u)
  })

  it('stageRisks always names the port and the staged lines, and picks the boundary copy', () => {
    for (const action of STP_WRITE_ACTIONS) {
      const risks = stageRisks(action, 'Ethernet9')
      expect(risks.length).toBeGreaterThanOrEqual(2)
      expect(risks[0]).toContain('Ethernet9')
      for (const command of action.commands) expect(risks[0]).toContain(command)
    }
    expect(stageRisks(stpWriteAction('portfast-enable')!, 'Ethernet9')[1]).toContain('PortFast is being set on Ethernet9')
    expect(stageRisks(stpWriteAction('bpduguard-unset')!, 'Ethernet9')[1]).toMatch(/takes BPDU guard out of Ethernet9/u)
    expect(stageRisks(stpWriteAction('portfast-default')!, 'Ethernet9')[1]).toMatch(/CANNOT predict/u)
    expect(stageRisks(stpWriteAction('portfast-unset')!, 'Ethernet9')[1]).toMatch(/no spanning-tree portfast/u)
    expect(stageRisks(stpWriteAction('bpduguard-enable')!, 'Ethernet9')[1]).toMatch(/uncaptured/u)
  })
})

describe('stp-rules — read-side display helpers and standing notes', () => {
  it('isClientPortfastType accepts the three write tokens and keeps `auto` out (row 170)', () => {
    expect(CLIENT_PORTFAST_TYPES).toEqual(['edge', 'network', 'normal'])
    for (const token of ['edge', 'network', 'normal']) expect(isClientPortfastType(token)).toBe(true)
    expect(isClientPortfastType('auto')).toBe(false)
    expect(isClientPortfastType('')).toBe(false)
  })

  it('stpPortRowView folds a parsed record without inventing or dropping fields', () => {
    const row = stpPortRowView({
      interfaceName: 'Ethernet1',
      portfast: true,
      portfastType: 'auto',
      bpduguard: false,
    })
    expect(row).toEqual({ interfaceName: 'Ethernet1', portfast: true, portfastType: 'auto', bpduguard: false })
  })

  it('the standing notes carry #85\u2019s two closures verbatim', () => {
    expect(STP_MODE_EDIT_NOTE).toMatch(/not offered/iu)
    expect(STP_MODE_EDIT_NOTE).toContain('B3 (#88)')
    expect(STP_OPERATIONAL_NOTE).toBe('operational STP state not yet observable — capture pending')
    expect(STP_INSTANCES_NOTE).toMatch(/return dict\(\)/u)
    expect(STP_INSTANCES_NOTE).toMatch(/not a claim/u)
  })
})
