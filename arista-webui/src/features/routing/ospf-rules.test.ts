/**
 * #87 (OSPF slice): the pure rules behind `#/routing/ospf`. Every staged-line expectation below is
 * byte-for-byte the sequence the CLIENT's own verb sends, cited to the `ospf.test.ts` `sentScripts`
 * pin it mirrors (the DR-153 send-only mirroring convention, SPEC-ospf-editor.md) — a client
 * composition regression must fail here on the same byte the client suite guards.
 *
 * No React, no fetches, no device handles: line builders (the process header appears ONCE per
 * batch — the submodeCommands shape, NOT the route-map per-statement shape), the validators that
 * mirror the client guards, the network-target round-trip, and the confirm/risk copy pins: the
 * 67 ms / 6170 ms route blast quoted with its `no network` mechanism, the 32636 ms / 12279 ms
 * adjacency blast scoped to what actually produced it, and the DR-043 container scoping.
 */
import { describe, expect, it } from 'vitest'
import type { OspfState } from '@devhax-heavy-industries/arista-eapi'

import {
  OSPF_ADJACENCY_BLAST_FACT,
  OSPF_AREA_ASYMMETRY_NOTE,
  OSPF_CREATE_POSTURE,
  OSPF_REDISTRIBUTION_PROTOCOLS,
  OSPF_ROUTE_BLAST_FACT,
  OSPF_ROUTER_ID_MECHANISM,
  OSPF_SINGLE_PROCESS_NOTE,
  ospfAddNetworkLines,
  ospfAddRedistributionLines,
  ospfBareNegationFact,
  ospfCreateConfirmation,
  ospfCreateLines,
  ospfDeleteProcessConfirmation,
  ospfDeleteProcessLines,
  ospfEditRisks,
  ospfNetworkAddConfirmation,
  ospfNetworkPresent,
  ospfNetworkRemoveConfirmation,
  ospfNetworkRows,
  ospfReadBack,
  ospfRedistributionAddConfirmation,
  ospfRedistributionPresent,
  ospfRedistributionRemoveConfirmation,
  ospfRedistributionRows,
  ospfRemoveNetworkLines,
  ospfRemoveRedistributionLines,
  ospfRouterIdConfirmation,
  ospfRouterIdLines,
  ospfShutdownConfirmation,
  ospfShutdownLines,
  ospfNoShutdownLines,
  ospfUnsetRouterIdLines,
  parseOspfNetworkTarget,
  validateOspfArea,
  validateOspfMaskLen,
  validateOspfProcessId,
  validateOspfProtocol,
  validateOspfToken,
  validateOspfVrfName,
} from './ospf-rules'

const state = (over: Partial<OspfState> = {}): OspfState => ({
  ospfProcessId: 65000,
  vrf: 'default',
  networks: [],
  redistributions: [],
  shutdown: false,
  ...over,
})

describe('process line builders — the client verb text, byte-for-byte', () => {
  it('create is ONE line, no submode (ospf.ts create, zero reads; pin `router ospf 65000`)', () => {
    expect(ospfCreateLines('65000')).toEqual(['router ospf 65000'])
  })

  it('create with a vrf appends the vrf arm verbatim (pin `router ospf 65000 vrf test`)', () => {
    expect(ospfCreateLines('65000', 'test')).toEqual(['router ospf 65000 vrf test'])
    expect(ospfCreateLines('65000', '')).toEqual(['router ospf 65000'])
  })

  it('delete-process is one top-level `no` line (pin `no router ospf 65000`)', () => {
    expect(ospfDeleteProcessLines('65000')).toEqual(['no router ospf 65000'])
  })

  it('router-id set/clear are header + one line (pin `router ospf 65000`,`router-id 1.1.1.1` / `no router-id`)', () => {
    expect(ospfRouterIdLines('65000', '1.1.1.1')).toEqual(['router ospf 65000', 'router-id 1.1.1.1'])
    expect(ospfUnsetRouterIdLines('65000')).toEqual(['router ospf 65000', 'no router-id'])
  })

  it('shutdown/no-shutdown are header + the plain command (pin `shutdown` / `no shutdown`)', () => {
    expect(ospfShutdownLines('65000')).toEqual(['router ospf 65000', 'shutdown'])
    expect(ospfNoShutdownLines('65000')).toEqual(['router ospf 65000', 'no shutdown'])
  })

  it('network add/remove mirror addNetwork/removeNetwork (pin `network 172.16.10.0/24 area 0` — the bare-area spelling composes as written)', () => {
    expect(ospfAddNetworkLines('65000', '172.16.10.0', '24', '0')).toEqual(['router ospf 65000', 'network 172.16.10.0/24 area 0'])
    expect(ospfAddNetworkLines('65000', '172.16.10.0', '24', '0.0.0.0')).toEqual(['router ospf 65000', 'network 172.16.10.0/24 area 0.0.0.0'])
    expect(ospfRemoveNetworkLines('65000', '172.16.10.0', '24', '0.0.0.0')).toEqual(['router ospf 65000', 'no network 172.16.10.0/24 area 0.0.0.0'])
  })

  it('redistribution add/remove mirror the client (pin `redistribute bgp route-map RM-IN`; the BARE negation, divergence 10)', () => {
    expect(ospfAddRedistributionLines('65000', 'bgp', 'RM-IN')).toEqual(['router ospf 65000', 'redistribute bgp route-map RM-IN'])
    expect(ospfAddRedistributionLines('65000', 'static')).toEqual(['router ospf 65000', 'redistribute static'])
    expect(ospfAddRedistributionLines('65000', 'connected', '')).toEqual(['router ospf 65000', 'redistribute connected'])
    expect(ospfRemoveRedistributionLines('65000', 'bgp')).toEqual(['router ospf 65000', 'no redistribute bgp'])
  })

  it('the process header appears ONCE per batch — the submodeCommands shape, not the route-map shape', () => {
    for (const lines of [
      ospfRouterIdLines('1', '9.9.9.9'),
      ospfAddNetworkLines('1', '10.0.0.0', '24', '0.0.0.0'),
      ospfAddRedistributionLines('1', 'connected', 'RM'),
    ]) {
      expect(lines.filter((line) => line === 'router ospf 1')).toHaveLength(1)
      expect(lines[0]).toBe('router ospf 1')
    }
  })
})

describe('validators mirror the client guards (grammar, not device bounds — DR-120)', () => {
  it('process id: digits and pyeapi\'s own 1..65535 bound (DR-032: the image\'s range is the device\'s)', () => {
    expect(validateOspfProcessId('1')).toBeUndefined()
    expect(validateOspfProcessId('65535')).toBeUndefined()
    expect(validateOspfProcessId('')).toMatch(/required/u)
    expect(validateOspfProcessId('1o')).toMatch(/not digits/u)
    expect(validateOspfProcessId('0')).toMatch(/outside 1-65535/u)
    expect(validateOspfProcessId('65536')).toMatch(/outside 1-65535/u)
  })

  it('vrf name: blank = default, else the reader\'s \\w+ (divergence 9\'s write side)', () => {
    expect(validateOspfVrfName('')).toBeUndefined()
    expect(validateOspfVrfName('mgmt_1')).toBeUndefined()
    expect(validateOspfVrfName('mid-dash')).toMatch(/outside the reader grammar/u)
    expect(validateOspfVrfName('two words')).toMatch(/outside the reader grammar/u)
  })

  it('token: non-empty, one token, no control characters (assertToken)', () => {
    expect(validateOspfToken('router-id', '1.1.1.1')).toBeUndefined()
    expect(validateOspfToken('router-id', '  ')).toMatch(/required/u)
    expect(validateOspfToken('router-id', 'two words')).toMatch(/splits the command line/u)
    expect(validateOspfToken('router-id', 'bad\u0007id')).toMatch(/control character/u)
  })

  it('mask length: digits (the (\\d+) of ospf.py:141)', () => {
    expect(validateOspfMaskLen('24')).toBeUndefined()
    expect(validateOspfMaskLen('')).toMatch(/required/u)
    expect(validateOspfMaskLen('2x')).toMatch(/not digits/u)
  })

  it('area: bare digits OR a dotted quad — the write shape and the read shape (divergence 4)', () => {
    expect(validateOspfArea('0')).toBeUndefined()
    expect(validateOspfArea('0.0.0.0')).toBeUndefined()
    expect(validateOspfArea('0.0')).toMatch(/neither bare digits nor a dotted quad/u)
    expect(validateOspfArea('backbone')).toMatch(/neither bare digits nor a dotted quad/u)
  })

  it('protocol: the client\'s four-protocol allow-list (ospf.py:323/:347, DR-032)', () => {
    for (const protocol of OSPF_REDISTRIBUTION_PROTOCOLS) {
      expect(validateOspfProtocol(protocol)).toBeUndefined()
    }
    expect(OSPF_REDISTRIBUTION_PROTOCOLS).toEqual(['bgp', 'rip', 'static', 'connected'])
    expect(validateOspfProtocol('isis')).toMatch(/outside the client's redistribution allow-list/u)
    expect(validateOspfProtocol('')).toMatch(/outside the client's redistribution allow-list/u)
  })
})

describe('network target round-trip (the remove picker)', () => {
  it('round-trips a dotted-quad triple', () => {
    expect(parseOspfNetworkTarget('172.16.10.0/24@0.0.0.0')).toEqual({ network: '172.16.10.0', netmask: '24', area: '0.0.0.0' })
  })

  it('also parses a bare-digit area (a hand-built value), though the reader never produces one', () => {
    expect(parseOspfNetworkTarget('10.0.0.0/8@0')).toEqual({ network: '10.0.0.0', netmask: '8', area: '0' })
  })

  it('anything else is undefined', () => {
    expect(parseOspfNetworkTarget('')).toBeUndefined()
    expect(parseOspfNetworkTarget('172.16.10.0/24')).toBeUndefined()
    expect(parseOspfNetworkTarget('172.16.10.0/two@0.0.0.0')).toBeUndefined()
  })
})

describe('reads → rows and duplicate predicates', () => {
  const populated = state({
    routerId: '10.156.0.1',
    networks: [{ network: '172.16.10.0', netmask: '24', area: '0.0.0.0' }, { network: '172.17.0.0', netmask: '16', area: '0.0.0.0' }],
    redistributions: [{ protocol: 'bgp', routeMap: 'RM-IN' }, { protocol: 'static' }],
  })

  it('network rows carry the picker target; redistribution rows state absence as (none)', () => {
    expect(ospfNetworkRows(populated).map((row) => row.target)).toEqual(['172.16.10.0/24@0.0.0.0', '172.17.0.0/16@0.0.0.0'])
    expect(ospfRedistributionRows(populated)).toEqual([
      { protocol: 'bgp', routeMap: 'RM-IN', target: 'bgp/RM-IN' },
      { protocol: 'static', routeMap: '(none)', target: 'static' },
    ])
  })

  it('ospfNetworkPresent matches the exact triple only', () => {
    expect(ospfNetworkPresent(populated, '172.16.10.0', '24', '0.0.0.0')).toBe(true)
    expect(ospfNetworkPresent(populated, '172.16.10.0', '24', '0')).toBe(false)
    expect(ospfNetworkPresent(populated, '10.0.0.0', '8', '0.0.0.0')).toBe(false)
  })

  it('ospfRedistributionPresent: a bare protocol draft matches any line for that protocol; a named map must match', () => {
    expect(ospfRedistributionPresent(populated, 'bgp')).toBe(true)
    expect(ospfRedistributionPresent(populated, 'bgp', 'RM-IN')).toBe(true)
    expect(ospfRedistributionPresent(populated, 'bgp', 'RM-OTHER')).toBe(false)
    expect(ospfRedistributionPresent(populated, 'connected')).toBe(false)
  })
})

describe('risk / confirm copy — facts, not adjectives (DR-149), container-only proxies (DR-043)', () => {
  it('readBack restates every staged line and names the mirroring + the once-per-batch header', () => {
    const text = ospfReadBack(['router ospf 1', 'shutdown'])
    expect(text).toContain('`router ospf 1` + `shutdown`')
    expect(text).toMatch(/byte-for-byte the line sequence the client's own ospf verbs compose/u)
    expect(text).toMatch(/opens the submode once/u)
  })

  it('the route blast is quoted with its EXACT mechanism', () => {
    expect(OSPF_ROUTE_BLAST_FACT).toContain('67 ms')
    expect(OSPF_ROUTE_BLAST_FACT).toContain('6170 ms')
    expect(OSPF_ROUTE_BLAST_FACT).toMatch(/no network <net>\/<mask> area <area>/u)
    expect(OSPF_ROUTE_BLAST_FACT).toMatch(/[Cc]ontainer evidence, not measured on this unit \(DR-043\)/u)
  })

  it('the adjacency blast names its producer and says NOT the staged command', () => {
    expect(OSPF_ADJACENCY_BLAST_FACT).toContain('32636 ms')
    expect(OSPF_ADJACENCY_BLAST_FACT).toContain('12279 ms')
    expect(OSPF_ADJACENCY_BLAST_FACT).toMatch(/NOT by the command being staged here/u)
    expect(OSPF_ADJACENCY_BLAST_FACT).toMatch(/DR-043/u)
  })

  it('the router-id mechanism is honestly unmeasured', () => {
    expect(OSPF_ROUTER_ID_MECHANISM).toMatch(/NOT measured for this verb/u)
    expect(OSPF_ROUTER_ID_MECHANISM).toMatch(/no number is claimed/u)
  })

  it('the create posture states the captured box (no ip routing, zero processes) and the Do-Not-Do', () => {
    expect(OSPF_CREATE_POSTURE).toMatch(/no ip routing/u)
    expect(OSPF_CREATE_POSTURE).toMatch(/zero `router ospf` sections/u)
    expect(OSPF_CREATE_POSTURE).toMatch(/never touches `ip routing`/u)
  })

  it('the single-process note names divergence 7', () => {
    expect(OSPF_SINGLE_PROCESS_NOTE).toMatch(/FIRST `router ospf …` section/u)
    expect(OSPF_SINGLE_PROCESS_NOTE).toMatch(/divergence 7/u)
  })

  it('the area note states divergence 4 and the 0.0.0.0 default rationale', () => {
    expect(OSPF_AREA_ASYMMETRY_NOTE).toMatch(/bare `area 0` never appears/u)
    expect(OSPF_AREA_ASYMMETRY_NOTE).toMatch(/round-trips into the table/u)
  })

  it('the bare-negation fact names divergence 10 and the qualified-line count', () => {
    const fact = ospfBareNegationFact('bgp', 2)
    expect(fact).toMatch(/no redistribute bgp/u)
    expect(fact).toMatch(/divergence 10/u)
    expect(fact).toMatch(/2 line\(s\) for `bgp`/u)
  })

  it('edit risks are readBack + blast facts + the far-end note', () => {
    const risks = ospfEditRisks(['router ospf 1', 'shutdown'], [OSPF_ADJACENCY_BLAST_FACT])
    expect(risks).toHaveLength(3)
    expect(risks[0]).toMatch(/staged lines/u)
    expect(risks[1]).toBe(OSPF_ADJACENCY_BLAST_FACT)
    expect(risks[2]).toMatch(/cannot see the peer side/u)
  })

  it('the create confirmation subject carries the vrf arm and the body is the posture', () => {
    const confirmation = ospfCreateConfirmation('1', 'mgmt')
    expect(confirmation.title).toBe('Second confirm: OSPF create router ospf 1 vrf mgmt')
    expect(confirmation.subject).toBe('router ospf 1 vrf mgmt')
    expect(confirmation.body).toBe(OSPF_CREATE_POSTURE)
  })

  it('the delete-process confirmation is the whole-process loss with the adjacency blast and DR-024', () => {
    const confirmation = ospfDeleteProcessConfirmation('65000')
    expect(confirmation.title).toBe('Second confirm: OSPF delete process router ospf 65000')
    expect(confirmation.subject).toBe('no router ospf 65000')
    expect(confirmation.body).toMatch(/WHOLE process/u)
    expect(confirmation.body).toContain(OSPF_ADJACENCY_BLAST_FACT)
    expect(confirmation.body).toMatch(/DR-024/u)
  })

  it('the network-add confirmation says it ADVERTISES and carries the route blast fact', () => {
    const confirmation = ospfNetworkAddConfirmation('1', '172.16.10.0', '24', '0.0.0.0')
    expect(confirmation.subject).toBe('router ospf 1')
    expect(confirmation.body).toMatch(/ADVERTISES the prefix into the area/u)
    expect(confirmation.body).toContain(OSPF_ROUTE_BLAST_FACT)
  })

  it('the network-remove confirmation quotes the exact measured mechanism', () => {
    const confirmation = ospfNetworkRemoveConfirmation('1', '10.156.0.2', '32', '0')
    expect(confirmation.subject).toBe('router ospf 1')
    expect(confirmation.body).toMatch(/WITHDRAWS the prefix/u)
    expect(confirmation.body).toMatch(/no network <net>\/<mask> area <area>` removal withdrew a route in 67 ms/u)
  })

  it('the redistribution-add confirmation carries the dangling-map annotation when given one', () => {
    const confirmation = ospfRedistributionAddConfirmation('1', 'bgp', 'RM-GONE', ['The running-config read does not name route-map `RM-GONE`.'])
    expect(confirmation.body).toMatch(/injects routes from another source/u)
    expect(confirmation.body).toContain('RM-GONE')
    expect(confirmation.body).toContain('67 ms')
  })

  it('the redistribution-remove confirmation carries the bare-negation divergence', () => {
    const confirmation = ospfRedistributionRemoveConfirmation('1', 'bgp', 2)
    expect(confirmation.subject).toBe('router ospf 1')
    expect(confirmation.body).toMatch(/divergence 10/u)
  })

  it('the shutdown confirmation arms on the direction and keeps the adjacency scoping', () => {
    expect(ospfShutdownConfirmation('1', true).body).toMatch(/tears down every adjacency/u)
    expect(ospfShutdownConfirmation('1', false).body).toMatch(/starts forming adjacencies/u)
    expect(ospfShutdownConfirmation('1', true).body).toContain(OSPF_ADJACENCY_BLAST_FACT)
  })

  it('the router-id confirmation carries the unmeasured mechanism AND the scoped adjacency proxy', () => {
    const confirmation = ospfRouterIdConfirmation('1', 'set')
    expect(confirmation.body).toContain(OSPF_ROUTER_ID_MECHANISM)
    expect(confirmation.body).toContain(OSPF_ADJACENCY_BLAST_FACT)
  })
})
