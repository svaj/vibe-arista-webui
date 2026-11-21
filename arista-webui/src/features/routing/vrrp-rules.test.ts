/**
 * #87 (VRRP slice): the pure rules behind `#/routing/vrrp` (SPEC-vrrp-editor.md, "Testing
 * strategy"). Offline, no fakes beyond a hand-built setter stub for the composition helpers —
 * the stubs return the SAME pinned modern-family strings the client's own tests pin
 * (`vrrp.test.ts`), so a composition-order regression here fails the same byte the client pins.
 */
import { describe, expect, it, vi } from 'vitest'

import {
  composeVrrpCreateLines,
  composeVrrpEditLine,
  parseVrrpCreateDraft,
  parseVrrpEditDraft,
  parseVrrpGroupTarget,
  vrrpCandidateInterfaces,
  vrrpCreateRisks,
  vrrpDeleteConfirmation,
  vrrpDeleteFacts,
  vrrpDeleteLine,
  vrrpDeleteRisks,
  vrrpEditAlreadySays,
  vrrpEditForcesConfirm,
  vrrpEditRisks,
  vrrpFailoverConfirmation,
  vrrpFailoverFacts,
  vrrpManagerRows,
  vrrpReadBack,
  validateVrrpAddress,
  validateVrrpAdvertiseInterval,
  validateVrrpDescription,
  validateVrrpId,
  validateVrrpPriority,
  VRRP_CREATE_IP_ROUTING_NOTE,
} from './vrrp-rules'
import type { VrrpCreateDraft, VrrpSetterSeam } from './vrrp-rules'
import type { Vrrp } from '@devhax-heavy-industries/arista-eapi'

/** A configured VRRP record with the client's guaranteed-default fields filled in. */
const vrrpFixture = (over: Partial<Vrrp> = {}): Vrrp => ({
  enable: true,
  description: '',
  secondaryIp: [],
  preempt: true,
  track: [],
  bfdIp: '',
  ...over,
})

describe('vrrp-rules — validators mirror the client grammar', () => {
  it('VRID: the client assertVrrpId grammar (non-negative integer) accepts 0 and rejects the rest', () => {
    expect(validateVrrpId('0')).toBeUndefined()
    expect(validateVrrpId('42')).toBeUndefined()
    expect(validateVrrpId('')).toMatch(/required/u)
    expect(validateVrrpId('  ')).toMatch(/required/u)
    expect(validateVrrpId('-1')).toMatch(/non-negative integer/u)
    expect(validateVrrpId('1.5')).toMatch(/non-negative integer/u)
    expect(validateVrrpId('v1')).toMatch(/non-negative integer/u)
  })

  it('primary IPv4: the client IPV4_GRAMMAR dotted-quad only', () => {
    expect(validateVrrpAddress('Primary IPv4 address', '169.254.90.7')).toBeUndefined()
    expect(validateVrrpAddress('Primary IPv4 address', '10.10.70.50')).toBeUndefined()
    expect(validateVrrpAddress('Primary IPv4 address', '')).toMatch(/required/u)
    expect(validateVrrpAddress('Primary IPv4 address', '10.10.70')).toMatch(/dotted-quad/u)
    expect(validateVrrpAddress('Primary IPv4 address', '10.10.70.50/24')).toMatch(/dotted-quad/u)
    expect(validateVrrpAddress('Primary IPv4 address', 'fe80::1')).toMatch(/dotted-quad/u)
  })

  it('priority: the client assertIntRange 1-254', () => {
    expect(validateVrrpPriority('1')).toBeUndefined()
    expect(validateVrrpPriority('254')).toBeUndefined()
    expect(validateVrrpPriority('0')).toMatch(/outside 1-254/u)
    expect(validateVrrpPriority('255')).toMatch(/outside 1-254/u)
    expect(validateVrrpPriority('high')).toMatch(/whole number/u)
  })

  it('advertisement interval: the client assertIntRange 1-255', () => {
    expect(validateVrrpAdvertiseInterval('1')).toBeUndefined()
    expect(validateVrrpAdvertiseInterval('255')).toBeUndefined()
    expect(validateVrrpAdvertiseInterval('0')).toMatch(/outside 1-255/u)
    expect(validateVrrpAdvertiseInterval('256')).toMatch(/outside 1-255/u)
  })

  it('description: non-empty, no line boundary (DR-015/DR-037 grammar)', () => {
    expect(validateVrrpDescription('gateway for VLAN 70')).toBeUndefined()
    expect(validateVrrpDescription('')).toMatch(/needs a value/u)
    expect(validateVrrpDescription('   ')).toMatch(/needs a value/u)
    expect(validateVrrpDescription('two\nlines')).toMatch(/line boundary/u)
  })
})

describe('vrrp-rules — create plan parsing', () => {
  const draft = (over: Partial<VrrpCreateDraft> = {}): VrrpCreateDraft => ({
    interfaceName: 'Vlan70',
    vrid: '10',
    primaryIp: '10.10.70.50',
    priority: '',
    description: '',
    preempt: '',
    startState: 'disabled',
    ...over,
  })

  it('a minimal draft plans the enable line + the IP line only', () => {
    const outcome = parseVrrpCreateDraft(draft())
    expect(outcome).toEqual({ plan: { interfaceName: 'Vlan70', vrid: 10, enable: false, primaryIp: '10.10.70.50' } })
  })

  it('the optional fields ride the plan only when filled', () => {
    const outcome = parseVrrpCreateDraft(draft({ priority: '150', description: 'gw', preempt: 'yes', startState: 'enabled' }))
    expect(outcome).toEqual({ plan: { interfaceName: 'Vlan70', vrid: 10, enable: true, primaryIp: '10.10.70.50', priority: 150, description: 'gw', preempt: true } })
  })

  it('out-of-grammar values are refused with the client-guard citation', () => {
    expect(parseVrrpCreateDraft(draft({ priority: '300' }))).toEqual({ refusal: expect.stringContaining('1-254') })
    expect(parseVrrpCreateDraft(draft({ primaryIp: '10.0.0' }))).toEqual({ refusal: expect.stringContaining('dotted-quad') })
    expect(parseVrrpCreateDraft(draft({ interfaceName: '' }))).toEqual({ refusal: expect.stringContaining('never guesses') })
  })
})

describe('vrrp-rules — create composition (client dry-run seam, _vrrp_set order)', () => {
  /** The stub answers with the SAME modern-family strings the client's own tests pin. */
  function setterStub() {
    return {
      setEnable: vi.fn(async (_n: string, vrid: number, value: boolean) => (value ? `no vrrp ${String(vrid)} disabled` : `vrrp ${String(vrid)} disabled`)),
      setPrimaryIp: vi.fn(async (_n: string, vrid: number) => `vrrp ${String(vrid)} ipv4 10.10.70.50`),
      setPriority: vi.fn(async (_n: string, vrid: number) => `vrrp ${String(vrid)} priority-level 150`),
      setDescription: vi.fn(async (_n: string, vrid: number) => `vrrp ${String(vrid)} session description gw`),
      setPreempt: vi.fn(async (_n: string, vrid: number, options: { value?: boolean }) => (options.value === true ? `vrrp ${String(vrid)} preempt` : `no vrrp ${String(vrid)} preempt`)),
      setTimersAdvertise: vi.fn(async (_n: string, vrid: number) => `vrrp ${String(vrid)} advertisement interval 5`),
    } satisfies VrrpSetterSeam
  }

  it('enable line FIRST, then IP, priority, description, preempt — every call { run: false }', async () => {
    const stub = setterStub()
    const lines = await composeVrrpCreateLines(stub, {
      interfaceName: 'Vlan70',
      vrid: 10,
      enable: false,
      primaryIp: '10.10.70.50',
      priority: 150,
      description: 'gw',
      preempt: true,
    })
    expect(lines).toEqual([
      'vrrp 10 disabled',
      'vrrp 10 ipv4 10.10.70.50',
      'vrrp 10 priority-level 150',
      'vrrp 10 session description gw',
      'vrrp 10 preempt',
    ])
    for (const call of [...stub.setEnable.mock.calls, ...stub.setPrimaryIp.mock.calls, ...stub.setPriority.mock.calls, ...stub.setDescription.mock.calls, ...stub.setPreempt.mock.calls]) {
      const options = call[call.length - 1] as { run?: boolean }
      expect(options.run).toBe(false)
    }
    expect(stub.setTimersAdvertise).not.toHaveBeenCalled()
  })

  it('the enabled arm composes the negated enable line (no vrrp N disabled)', async () => {
    const stub = setterStub()
    const lines = await composeVrrpCreateLines(stub, { interfaceName: 'Vlan70', vrid: 10, enable: true, primaryIp: '10.10.70.50' })
    expect(lines).toEqual(['no vrrp 10 disabled', 'vrrp 10 ipv4 10.10.70.50'])
  })
})

describe('vrrp-rules — edit parsing, composition, already-says guard', () => {
  it('parseVrrpGroupTarget splits <interface>/<vrid> and refuses junk', () => {
    expect(parseVrrpGroupTarget('Vlan70/10')).toEqual({ interfaceName: 'Vlan70', vrid: 10 })
    expect(parseVrrpGroupTarget('Ethernet1/0')).toEqual({ interfaceName: 'Ethernet1', vrid: 0 })
    expect(parseVrrpGroupTarget('')).toBeUndefined()
    expect(parseVrrpGroupTarget('Vlan70')).toBeUndefined()
    expect(parseVrrpGroupTarget('Vlan70/x')).toBeUndefined()
  })

  it('a boolean edit parses to a real boolean; an unknown field is refused', () => {
    expect(parseVrrpEditDraft({ target: 'Vlan70/10', field: 'preempt', value: 'false' })).toEqual({ plan: { interfaceName: 'Vlan70', vrid: 10, field: 'preempt', value: false } })
    expect(parseVrrpEditDraft({ target: 'Vlan70/10', field: 'track', value: 'x' })).toEqual({ refusal: expect.stringContaining('single field') })
  })

  it('the edit composition calls the matching setter with { run: false }', async () => {
    const stub = {
      setEnable: vi.fn(async () => 'vrrp 10 disabled'),
      setPrimaryIp: vi.fn(async () => 'unused'),
      setPriority: vi.fn(async () => 'vrrp 10 priority-level 200'),
      setDescription: vi.fn(async () => 'unused'),
      setPreempt: vi.fn(async () => 'unused'),
      setTimersAdvertise: vi.fn(async () => 'unused'),
    } satisfies VrrpSetterSeam
    const line = await composeVrrpEditLine(stub, { interfaceName: 'Vlan70', vrid: 10, field: 'priority', value: 200 })
    expect(line).toBe('vrrp 10 priority-level 200')
    expect(stub.setPriority).toHaveBeenCalledWith('Vlan70', 10, { value: 200, run: false })
  })

  it('already-says compares against the parsed record; an absent line never matches', () => {
    expect(vrrpEditAlreadySays(vrrpFixture({ priority: 150 }), { interfaceName: 'Vlan70', vrid: 10, field: 'priority', value: 150 })).toBe(true)
    expect(vrrpEditAlreadySays(vrrpFixture({ priority: 150 }), { interfaceName: 'Vlan70', vrid: 10, field: 'priority', value: 200 })).toBe(false)
    expect(vrrpEditAlreadySays(vrrpFixture({}), { interfaceName: 'Vlan70', vrid: 10, field: 'priority', value: 100 })).toBe(false)
    expect(vrrpEditAlreadySays(vrrpFixture({ enable: false }), { interfaceName: 'Vlan70', vrid: 10, field: 'enable', value: false })).toBe(true)
    expect(vrrpEditAlreadySays(undefined, { interfaceName: 'Vlan70', vrid: 10, field: 'enable', value: true })).toBe(false)
  })

  it('enable/priority/preempt force the second confirm; description/timersAdvertise do not', () => {
    expect(vrrpEditForcesConfirm('enable')).toBe(true)
    expect(vrrpEditForcesConfirm('priority')).toBe(true)
    expect(vrrpEditForcesConfirm('preempt')).toBe(true)
    expect(vrrpEditForcesConfirm('description')).toBe(false)
    expect(vrrpEditForcesConfirm('timersAdvertise')).toBe(false)
  })
})

describe('vrrp-rules — delete line (the ONE client-pinned literal)', () => {
  it('no vrrp <vrid> — the client era-free literal (vrrp.ts:588 / vrrp.test.ts:508)', () => {
    expect(vrrpDeleteLine(10)).toBe('no vrrp 10')
    expect(vrrpDeleteLine(0)).toBe('no vrrp 0')
  })
})

describe('vrrp-rules — candidate list', () => {
  it('union with table names first, L3-only names after, no duplicates', () => {
    expect(vrrpCandidateInterfaces(['Vlan70'], ['Vlan70', 'Vlan80', 'Ethernet1'])).toEqual(['Vlan70', 'Vlan80', 'Ethernet1'])
  })

  it('a FAILED soft read narrows to the table names only', () => {
    expect(vrrpCandidateInterfaces(['Vlan70'], undefined)).toEqual(['Vlan70'])
  })
})

describe('vrrp-rules — row mapping', () => {
  it('flattens (interface, vrid) pairs; absent fields render stated, never guessed', () => {
    const table = new Map<string, ReadonlyMap<number, Vrrp>>([
      ['Vlan70', new Map<number, Vrrp>([[10, vrrpFixture({ primaryIp: '10.10.70.50', priority: 150, description: 'gw', secondaryIp: ['10.10.70.51'], timersAdvertise: 5, track: [{ name: '1', action: 'decrement', amount: 40 }], bfdIp: null })]])],
    ])
    const [row] = vrrpManagerRows(table)
    expect(row).toEqual({
      interfaceName: 'Vlan70',
      vrid: 10,
      enabled: 'enabled',
      priority: '150',
      preempt: 'yes',
      primaryIp: '10.10.70.50',
      description: 'gw',
      secondaryIps: '10.10.70.51',
      advertiseInterval: '5 s',
      macAdvInterval: '(none)',
      ipVersion: '(none)',
      tracks: '1 decrement 40',
      bfdIp: '(bare bfd ip line)',
      delays: '(none)',
    })
  })

  it('the client defaults (no priority line, empty description, empty bfdIp) render as stated literals', () => {
    const table = new Map<string, ReadonlyMap<number, Vrrp>>([['Vlan80', new Map<number, Vrrp>([[1, vrrpFixture({ enable: false })]])]])
    const [row] = vrrpManagerRows(table)
    expect(row.priority).toBe('(no priority line)')
    expect(row.enabled).toBe('disabled')
    expect(row.description).toBe('(none)')
    expect(row.bfdIp).toBe('(none)')
  })
})

describe('vrrp-rules — risk/confirm copy (honest unmeasured, owner decision 2026-11-21)', () => {
  it('the failover facts name the interface, state the mechanism, and refuse to fabricate timing', () => {
    const facts = vrrpFailoverFacts('Vlan70')
    expect(facts).toContain("Vlan70's default-gateway traffic")
    expect(facts).toMatch(/NOT measured on any target/u)
    expect(facts).toMatch(/no fabricated number/u)
    expect(facts).toMatch(/DR-043/u)
  })

  it('the delete facts name the whole-group loss and the DR-024 startup boundary', () => {
    const facts = vrrpDeleteFacts('Vlan70', 10)
    expect(facts).toContain('`vrrp 10`')
    expect(facts).toContain('Vlan70')
    expect(facts).toMatch(/deletes the whole group/u)
    expect(facts).toMatch(/DR-024/u)
  })

  it('create risks carry the read-back, the failover facts, and the captured no-ip-routing note', () => {
    const risks = vrrpCreateRisks(['interface Vlan70', 'vrrp 10 disabled', 'vrrp 10 ipv4 10.10.70.50'], 'Vlan70')
    expect(risks[0]).toBe(vrrpReadBack(['interface Vlan70', 'vrrp 10 disabled', 'vrrp 10 ipv4 10.10.70.50']))
    expect(risks.some((r) => r.includes('VRRP master switchover'))).toBe(true)
    expect(risks).toContain(VRRP_CREATE_IP_ROUTING_NOTE)
    expect(VRRP_CREATE_IP_ROUTING_NOTE).toMatch(/no ip routing/u)
    expect(VRRP_CREATE_IP_ROUTING_NOTE).toMatch(/never touches `ip routing`/u)
  })

  it('a timersAdvertise edit risks the mechanism without a second-confirm trigger; enable does trigger', () => {
    const timers = vrrpEditRisks(['interface Vlan70', 'vrrp 10 advertisement interval 5'], 'Vlan70', 'timersAdvertise')
    expect(timers.some((r) => /advertisement interval changes how quickly/u.test(r))).toBe(true)
    expect(timers.some((r) => r.includes('VRRP master switchover'))).toBe(false)
    const enable = vrrpEditRisks(['interface Vlan70', 'vrrp 10 disabled'], 'Vlan70', 'enable')
    expect(enable.some((r) => r.includes('VRRP master switchover'))).toBe(true)
  })

  it('the delete risks carry read-back, failover, AND the whole-group sentence', () => {
    const risks = vrrpDeleteRisks(['interface Vlan70', 'no vrrp 10'], 'Vlan70', 10)
    expect(risks[0]).toBe(vrrpReadBack(['interface Vlan70', 'no vrrp 10']))
    expect(risks.some((r) => r.includes('VRRP master switchover'))).toBe(true)
    expect(risks.some((r) => /deletes the whole group/u.test(r))).toBe(true)
  })

  it('the delete confirmation body carries BOTH the failover and the whole-group sentences', () => {
    const confirm = vrrpDeleteConfirmation('Vlan70', 10)
    expect(confirm.title).toBe('Second confirm: delete vrrp 10 on Vlan70')
    expect(confirm.body).toMatch(/VRRP master switchover/u)
    expect(confirm.body).toMatch(/deletes the whole group/u)
    expect(confirm.subject).toBe('no vrrp 10 on Vlan70')
  })

  it('the failover confirmation names the (interface, vrid) subject', () => {
    const confirm = vrrpFailoverConfirmation('Vlan70', 10, 'priority')
    expect(confirm.title).toBe('Second confirm: VRRP priority on Vlan70 (vrid 10)')
    expect(confirm.subject).toBe('vrrp 10 on Vlan70')
  })

  it('the read-back restates every staged line in backticks (the S15 pattern)', () => {
    expect(vrrpReadBack(['interface Vlan70', 'no vrrp 10'])).toBe("The staged lines: `interface Vlan70` + `no vrrp 10` — byte-for-byte the text the client's own dry-run setters composed with { run: false }; the device diff, not this screen, decides what running-config actually keeps.")
  })
})
