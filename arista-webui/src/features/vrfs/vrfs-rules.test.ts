/**
 * S16 (#90): pins for ./vrfs-rules.ts. The rejection texts mirror `assertVrfName` /
 * `assertVrfRd` / `assertVrfDescription` (resources/vrfs.ts) and, critically, every batch builder
 * is pinned BYTE-EXACT against the composed texts `vrfs.test.ts` proves the frozen `node.vrfs`
 * verbs send — which are themselves reproductions of pyeapi's `test_api_vrf.py` pins. DR-141:
 * one invented token here would turn our bug into the device's verdict, so the strings below are
 * copied from those pins, never retyped from memory.
 */
import { describe, expect, it } from 'vitest'

import {
  bindInterfaceLines,
  createVrfLines,
  deleteVrfLines,
  interfaceVrfKeyword,
  pickDefinitionForm,
  routingLines,
  routingStem,
  setDescriptionLines,
  setRdLines,
  unbindInterfaceLines,
  unsetDescriptionLines,
  unsetRdLines,
  vrfDescriptionError,
  vrfHeader,
  vrfNameError,
  vrfRdError,
} from './vrfs-rules'

describe('vrfNameError — mirrors assertVrfName (VRF_NAME, vrfs.ts:161)', () => {
  it('accepts the whole grammar it claims: digits, letters, underscore', () => {
    expect(vrfNameError('BLUE')).toBeUndefined()
    expect(vrfNameError('mgmt_vrf9')).toBeUndefined()
    expect(vrfNameError('M')).toBeUndefined()
  })

  it('refuses empty, whitespace, punctuation, and regex metacharacters alike', () => {
    expect(vrfNameError('')).toMatch(/required/u)
    expect(vrfNameError('   ')).toMatch(/required/u)
    expect(vrfNameError('bad name')).toMatch(/numbers, letters and underscore/u)
    expect(vrfNameError('a.b')).toMatch(/numbers, letters and underscore/u)
    expect(vrfNameError('vrf+*')).toMatch(/numbers, letters and underscore/u)
  })
})

describe('vrfRdError — mirrors assertVrfRd (vrfs.ts; clearing per DR-037)', () => {
  it('accepts a single non-empty token without padding', () => {
    expect(vrfRdError('65000:1')).toBeUndefined()
    // Shape is deliberately NOT enforced: which rds the CLI accepts is the device's answer (DR-032).
    expect(vrfRdError('weird-token')).toBeUndefined()
  })

  it('refuses the empty value, pointing at the Clear action instead (DR-037)', () => {
    expect(vrfRdError('')).toMatch(/empty rd is refused/u)
    expect(vrfRdError('')).toMatch(/Clear rd/u)
    expect(vrfRdError('  ')).toMatch(/empty rd is refused/u)
  })

  it('refuses outer whitespace, inner whitespace, and control characters', () => {
    expect(vrfRdError(' 10:10')).toMatch(/leading or trailing whitespace/u)
    expect(vrfRdError('10:10 ')).toMatch(/leading or trailing whitespace/u)
    expect(vrfRdError('10: 10')).toMatch(/one token/u)
    expect(vrfRdError('10:\t10')).toMatch(/one token/u)
    // A newline is ALSO inner whitespace, so it is refused by the one-token arm first — the same
    // check order assertVrfRd runs. The control-character arm is pinned with a non-whitespace control.
    expect(vrfRdError('10:1\n0')).toMatch(/one token/u)
    expect(vrfRdError('10:1\u0001')).toMatch(/control character/u)
  })
})

describe('vrfDescriptionError — mirrors assertVrfDescription (vrfs.ts)', () => {
  it('accepts ordinary one-line text', () => {
    expect(vrfDescriptionError('campus fabric vrf')).toBeUndefined()
  })

  it('refuses empty (DR-037), padded, control-character, and quote-carrying values', () => {
    expect(vrfDescriptionError('')).toMatch(/empty description is refused/u)
    expect(vrfDescriptionError('x ')).toMatch(/leading or trailing whitespace/u)
    expect(vrfDescriptionError('a\tb')).toMatch(/control character/u)
    expect(vrfDescriptionError('say "hi"')).toMatch(/cannot round-trip/u)
    // The quote refusal names itself as CLIENT policy, never a device verdict.
    expect(vrfDescriptionError('say "hi"')).toMatch(/not a device verdict/u)
  })
})

describe('pickDefinitionForm — mirrors resolveVrfForm (DR-099) over the read table', () => {
  it('no VRF sections at all: the client convention default is `instance`, flagged as NOT device evidence', () => {
    expect(pickDefinitionForm([])).toEqual({ form: 'instance', fromDeviceConfig: false })
  })

  it('any instance section wins, even listed after a definition section (mixed configs write the modern keyword)', () => {
    expect(pickDefinitionForm([{ definitionForm: 'definition' }, { definitionForm: 'instance' }]))
      .toEqual({ form: 'instance', fromDeviceConfig: true })
    expect(pickDefinitionForm([{ definitionForm: 'instance' }]))
      .toEqual({ form: 'instance', fromDeviceConfig: true })
  })

  it('a definition-only config keeps the legacy keyword', () => {
    expect(pickDefinitionForm([{ definitionForm: 'definition' }]))
      .toEqual({ form: 'definition', fromDeviceConfig: true })
  })
})

describe('batch builders — byte-identical to the vrfs.test.ts / test_api_vrf.py pins', () => {
  it('vrfHeader and the per-form interface keyword', () => {
    expect(vrfHeader('instance', 'BLUE')).toBe('vrf instance BLUE')
    expect(vrfHeader('definition', 'BLUE')).toBe('vrf definition BLUE')
    expect(interfaceVrfKeyword('instance')).toBe('vrf')
    expect(interfaceVrfKeyword('definition')).toBe('vrf forwarding')
  })

  it('create: header alone, header+rd (the run-9 FULL composition), and header+rd+description', () => {
    expect(createVrfLines('instance', 'fresh')).toEqual(['vrf instance fresh'])
    // vrfs.test.ts pin: ['vrf instance fresh', 'rd 3:3'] — one transaction, header first.
    expect(createVrfLines('instance', 'fresh', { rd: '3:3' })).toEqual(['vrf instance fresh', 'rd 3:3'])
    // description text is the setVrfDescription composition carried in the same batch.
    expect(createVrfLines('definition', 'legacy', { rd: '1:2', description: 'keep' }))
      .toEqual(['vrf definition legacy', 'rd 1:2', 'description keep'])
  })

  it('delete / rd / description arms reproduce the negation texts exactly', () => {
    expect(deleteVrfLines('instance', 'legacy')).toEqual(['no vrf instance legacy'])
    expect(deleteVrfLines('definition', 'legacy')).toEqual(['no vrf definition legacy'])
    expect(setRdLines('instance', 'BLUE', '10:10')).toEqual(['vrf instance BLUE', 'rd 10:10'])
    expect(unsetRdLines('instance', 'BLUE')).toEqual(['vrf instance BLUE', 'no rd'])
    expect(setDescriptionLines('definition', 'OLD', 'campus')).toEqual(['vrf definition OLD', 'description campus'])
    expect(unsetDescriptionLines('definition', 'OLD')).toEqual(['vrf definition OLD', 'no description'])
  })

  it('routing verbs are TOP-level single lines; the set arm is the BARE stem (divergence 9)', () => {
    expect(routingStem('ipv4', 'BLUE')).toBe('ip routing vrf BLUE')
    expect(routingStem('ipv6', 'BLUE')).toBe('ipv6 unicast-routing vrf BLUE')
    expect(routingLines('ipv4', 'set', 'BLUE')).toEqual(['ip routing vrf BLUE'])
    expect(routingLines('ipv4', 'no', 'BLUE')).toEqual(['no ip routing vrf BLUE'])
    expect(routingLines('ipv4', 'default', 'BLUE')).toEqual(['default ip routing vrf BLUE'])
    expect(routingLines('ipv6', 'set', 'BLUE')).toEqual(['ipv6 unicast-routing vrf BLUE'])
    expect(routingLines('ipv6', 'no', 'BLUE')).toEqual(['no ipv6 unicast-routing vrf BLUE'])
    expect(routingLines('ipv6', 'default', 'BLUE')).toEqual(['default ipv6 unicast-routing vrf BLUE'])
  })

  it('interface assignment follows the instance/definition keyword pair, inside the interface stanza', () => {
    // Run-9 staged pair: 'interface Vlan20' then 'vrf UNBLOCK-VRF'.
    expect(bindInterfaceLines('instance', 'Vlan20', 'UNBLOCK-VRF')).toEqual(['interface Vlan20', 'vrf UNBLOCK-VRF'])
    // Pinned legacy pair (test_api_vrf.py, fake 4.17): 'interface Ethernet1' + 'vrf forwarding <name>'.
    expect(bindInterfaceLines('definition', 'Ethernet1', 'test')).toEqual(['interface Ethernet1', 'vrf forwarding test'])
    expect(unbindInterfaceLines('instance', 'Ethernet1')).toEqual(['interface Ethernet1', 'no vrf'])
    expect(unbindInterfaceLines('definition', 'Ethernet1')).toEqual(['interface Ethernet1', 'no vrf forwarding'])
  })
})
