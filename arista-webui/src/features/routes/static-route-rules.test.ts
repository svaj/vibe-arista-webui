/**
 * S10 (#80): pins for the mirrored static-route rules.
 *
 * The point of this file is the equivalence claim in `./static-route-rules.ts`: the screen stages
 * command text it composes itself (it has to — the resource verbs write immediately and cannot live
 * inside a preview session), so every line below is compared against what the **real**
 * `StaticRouteResource` sends over the client's own `mockTransport`, using the client spec's fixture
 * values wherever they exist. Command strings are copied from
 * `arista-api-client/src/resources/staticroute.test.ts`, never invented here; the refusals are
 * compared the same way, against the message the client's own guard throws.
 *
 * Nothing here contacts a device or a proxy (CAP-TESTING), and no test claims what the
 * DCS-7050TX-64 accepts — the fixtures are hand-authored config-shaped text, exactly as the client's
 * own staticroute spec declares.
 */
import { describe, expect, it } from 'vitest'
import { Node, NotSupportedError } from '@devhax-heavy-industries/arista-eapi'
import { mockTransport } from '@devhax-heavy-industries/arista-eapi/testing'

import {
  addDefaultGuard,
  DEFAULT_PREFIX,
  EMPTY_ROUTE_FIELDS,
  gatewayCandidates,
  ipDestRefusal,
  lineOfRow,
  nextHopRefusal,
  READ_SCOPE_NOTE,
  removalLineOf,
  replacementLineOf,
  routeGuard,
  routeKey,
  routeLabel,
  routeNameRefusal,
  stageRoute,
  unsignedSegmentRefusal,
} from './static-route-rules'
import type { RouteFields, RouteRow } from './static-route-rules'

const row = (over: Partial<RouteRow> & { ipDest: string, nextHop: string, distance: number }): RouteRow => ({ ...over })

/** The client's own write framing (`enable`, `configure terminal`, then the line under test). */
const writeKey = (cmds: readonly string[]): string => ['enable', 'configure terminal', ...cmds].join('\n')

/** Run one client verb and report the exact `cmd` text it put on the wire LAST. */
async function clientSends(verb: (node: Node) => Promise<unknown>, cmds: readonly string[]): Promise<string> {
  // `enable`, `configure terminal`, then the line(s) under test — one reply slot per command, the
  // client spec's own framing.
  const transport = mockTransport().replies(writeKey(cmds), [{}, {}, ...cmds.map(() => ({}))])
  await verb(new Node(transport))
  const last = transport.sent().at(-1)?.map((entry) => String(entry))
  if (last === undefined) throw new Error('the client sent nothing')
  return last.at(-1) as string
}

/** The message the client's own guard throws for a write it refuses. */
async function clientRefusal(verb: (node: Node) => Promise<unknown>): Promise<string> {
  const transport = mockTransport()
  try {
    await verb(new Node(transport))
  } catch (thrown: unknown) {
    expect(thrown, 'the client guard is expected to throw').toBeInstanceOf(NotSupportedError)
    return (thrown as Error).message
  }
  throw new Error('expected the client guard to refuse')
}

const fieldsOf = (over: Partial<RouteFields>): RouteFields => ({ ...EMPTY_ROUTE_FIELDS, ...over })

describe('stageRoute composition equals the real StaticRouteResource, character for character', () => {
  it('add-route sends the client\u2019s fixed segment order (its create pin, minus the v4 next-hop-ip slot #80 omits)', async () => {
    const staged = stageRoute(fieldsOf({ action: 'add-route', prefix: '11.111.11.0/24', nextHop: 'Ethernet2', distance: '5', tag: '42', routeName: 'netB' }), [])
    if ('refusal' in staged) throw new Error(staged.refusal)
    const line = 'ip route 11.111.11.0/24 Ethernet2 5 tag 42 name netB'
    expect(staged.intent.command).toBe(line)
    const sentByClient = await clientSends((node) => node.staticroute.create('11.111.11.0/24', { nextHop: 'Ethernet2', distance: 5, tag: 42, routeName: 'netB' }), [line])
    expect(sentByClient).toBe(line)
  })

  it('0 is a value on both sides (client divergence 3) — the client\u2019s own pin line', async () => {
    const staged = stageRoute(fieldsOf({ action: 'add-route', prefix: '0.0.0.0/0', nextHop: '192.68.1.254', distance: '0', tag: '0' }), [])
    if ('refusal' in staged) throw new Error(staged.refusal)
    const line = 'ip route 0.0.0.0/0 192.68.1.254 0 tag 0'
    expect(staged.intent.command).toBe(line)
    expect(lineOfRow({ ipDest: '0.0.0.0/0', nextHop: '192.68.1.254', distance: 0, tag: 0 })).toBe(line)
    expect(await clientSends((node) => node.staticroute.create('0.0.0.0/0', { nextHop: '192.68.1.254', distance: 0, tag: 0 }), [line])).toBe(line)
    // The default-route add still composes; the guard only decides how it confirms.
    expect(staged.intent.guard?.kind).toBe('default-route')
  })

  it('a digit-string tag spelling composes the digits given, as the client\u2019s `010` pin does', async () => {
    const staged = stageRoute(fieldsOf({ action: 'add-route', prefix: '1.2.3.0/24', nextHop: 'Ethernet1', distance: '0', tag: '010' }), [])
    if ('refusal' in staged) throw new Error(staged.refusal)
    const line = 'ip route 1.2.3.0/24 Ethernet1 0 tag 010'
    expect(staged.intent.command).toBe(line)
    expect(await clientSends((node) => node.staticroute.create('1.2.3.0/24', { nextHop: 'Ethernet1', distance: 0, tag: '010' }), [line])).toBe(line)
  })

  it('remove-route prefixes the WHOLE read line with no, matching the client delete pin', async () => {
    const target = row({ ipDest: '33.34.35.0/24', nextHop: '44.44.44.0', distance: 20, tag: 1, routeName: 'test1' })
    const staged = stageRoute(fieldsOf({ action: 'remove-route', routeKey: routeKey(target) }), [target])
    if ('refusal' in staged) throw new Error(staged.refusal)
    const line = 'no ip route 33.34.35.0/24 44.44.44.0 20 tag 1 name test1'
    expect(staged.intent.command).toBe(line)
    expect(removalLineOf(target)).toBe(line)
    expect(await clientSends((node) => node.staticroute.delete('33.34.35.0/24', { nextHop: '44.44.44.0', distance: 20, tag: 1, routeName: 'test1' }), [line])).toBe(line)
  })

  it('the default route\u2019s removal line is the exact-match negation of its read line', async () => {
    const target = row({ ipDest: DEFAULT_PREFIX, nextHop: '192.68.1.254', distance: 1, tag: 0 })
    const staged = stageRoute(fieldsOf({ action: 'remove-route', routeKey: routeKey(target) }), [target])
    if ('refusal' in staged) throw new Error(staged.refusal)
    const line = 'no ip route 0.0.0.0/0 192.68.1.254 1 tag 0'
    expect(staged.intent.command).toBe(line)
    expect(await clientSends((node) => node.staticroute.delete(DEFAULT_PREFIX, { nextHop: '192.68.1.254', distance: 1, tag: 0 }), [line])).toBe(line)
    expect(staged.intent.guard).toBeDefined()
  })

  it('a row with a next-hop address keeps that segment on the removal line (exact match, not a prefix of it)', async () => {
    const target = row({ ipDest: '1.2.3.0/24', nextHop: 'Ethernet1', nextHopIp: '1.1.1.1', distance: 1, tag: 1, routeName: 'test1' })
    const line = 'no ip route 1.2.3.0/24 Ethernet1 1.1.1.1 1 tag 1 name test1'
    expect(removalLineOf(target)).toBe(line)
    expect(await clientSends((node) => node.staticroute.delete('1.2.3.0/24', { nextHop: 'Ethernet1', nextHopIp: '1.1.1.1', distance: 1, tag: 1, routeName: 'test1' }), [line])).toBe(line)
  })

  it('set-tag on a row with no tag/name of its own equals the client set_tag pin', async () => {
    const target = row({ ipDest: '1.2.3.0/24', nextHop: 'Ethernet1', nextHopIp: '1.1.1.1', distance: 10 })
    const staged = stageRoute(fieldsOf({ action: 'set-tag', routeKey: routeKey(target), tag: '99' }), [target])
    if ('refusal' in staged) throw new Error(staged.refusal)
    const line = 'ip route 1.2.3.0/24 Ethernet1 1.1.1.1 10 tag 99'
    expect(staged.intent.command).toBe(line)
    expect(await clientSends((node) => node.staticroute.setTag('1.2.3.0/24', 'Ethernet1', { nextHopIp: '1.1.1.1', distance: 10, tag: '99' }), [line])).toBe(line)
  })

  it('set-name on a row with no other leaf data equals the client set_route_name pin', async () => {
    const target = row({ ipDest: '1.2.3.0/24', nextHop: 'Ethernet1', nextHopIp: '1.1.1.1', distance: 10 })
    const staged = stageRoute(fieldsOf({ action: 'set-name', routeKey: routeKey(target), routeName: 'test99' }), [target])
    if ('refusal' in staged) throw new Error(staged.refusal)
    const line = 'ip route 1.2.3.0/24 Ethernet1 1.1.1.1 10 name test99'
    expect(staged.intent.command).toBe(line)
    expect(await clientSends((node) => node.staticroute.setRouteName('1.2.3.0/24', 'Ethernet1', { nextHopIp: '1.1.1.1', distance: 10, routeName: 'test99' }), [line])).toBe(line)
  })

  it('the deliberate divergence: a replacement restates the fields the client would let EOS reset', async () => {
    // Upstream's own warning (staticroute.py:262-264, mirrored in the client's docstring): a set_tag
    // that does not re-pass route_name loses it. The client's spec pins the SPARSE line
    // (`ip route 1.2.3.0/24 Ethernet1 3 tag 1`); this screen stages the restated one instead, and the
    // text is still a line the client composes verbatim through its `set` path.
    const target = row({ ipDest: '1.2.3.0/24', nextHop: 'Ethernet1', distance: 3, tag: 1, routeName: 'keepme' })
    const staged = stageRoute(fieldsOf({ action: 'set-tag', routeKey: routeKey(target), tag: '7' }), [target])
    if ('refusal' in staged) throw new Error(staged.refusal)
    const line = 'ip route 1.2.3.0/24 Ethernet1 3 tag 7 name keepme'
    expect(staged.intent.command).toBe(line)
    expect(replacementLineOf(target, { tag: '7' })).toBe(line)
    expect(await clientSends((node) => node.staticroute.create('1.2.3.0/24', { nextHop: 'Ethernet1', distance: 3, tag: 7, routeName: 'keepme' }), [line])).toBe(line)
    // And the mirror: set-name restates the tag.
    expect(replacementLineOf(target, { routeName: 'renamed' })).toBe('ip route 1.2.3.0/24 Ethernet1 3 tag 1 name renamed')
  })
})

describe('the mirrored field refusals say what the client\u2019s own guards say', () => {
  const mirror = [
    {
      label: 'destination without a mask',
      fields: fieldsOf({ action: 'add-route', prefix: '10.0.0.0', nextHop: 'Ethernet1', distance: '5' }),
      clientCall: (node: Node) => node.staticroute.create('10.0.0.0', { nextHop: 'Ethernet1', distance: 5 }),
      pattern: /invalid static-route destination|dotted A\.B\.C\.D\/E shape/u,
    },
    {
      label: 'IPv6 destination',
      fields: fieldsOf({ action: 'add-route', prefix: '2001:db8::/32', nextHop: 'Ethernet1', distance: '5' }),
      clientCall: (node: Node) => node.staticroute.create('2001:db8::/32', { nextHop: 'Ethernet1', distance: 5 }),
      pattern: /IPv6 static routes are outside this module/u,
    },
    {
      label: 'next hop with inner whitespace',
      fields: fieldsOf({ action: 'add-route', prefix: '10.0.0.0/8', nextHop: 'has space', distance: '5' }),
      clientCall: (node: Node) => node.staticroute.create('10.0.0.0/8', { nextHop: 'has space', distance: 5 }),
      pattern: /splits the line|one \\S\+ token/u,
    },
    {
      label: 'empty next hop',
      fields: fieldsOf({ action: 'add-route', prefix: '10.0.0.0/8', nextHop: '', distance: '5' }),
      clientCall: (node: Node) => node.staticroute.create('10.0.0.0/8', { nextHop: '', distance: 5 }),
      pattern: /empty next hop/u,
    },
    {
      label: 'negative distance',
      fields: fieldsOf({ action: 'add-route', prefix: '10.0.0.0/8', nextHop: 'Ethernet1', distance: '-1' }),
      clientCall: (node: Node) => node.staticroute.create('10.0.0.0/8', { nextHop: 'Ethernet1', distance: -1 }),
      pattern: /unsigned integer/u,
    },
    {
      label: 'fractional tag',
      fields: fieldsOf({ action: 'add-route', prefix: '10.0.0.0/8', nextHop: 'Ethernet1', distance: '5', tag: '1.5' }),
      clientCall: (node: Node) => node.staticroute.create('10.0.0.0/8', { nextHop: 'Ethernet1', distance: 5, tag: 1.5 }),
      pattern: /unsigned integer/u,
    },
    {
      label: 'route name with two words',
      fields: fieldsOf({ action: 'add-route', prefix: '10.0.0.0/8', nextHop: 'Ethernet1', distance: '5', routeName: 'two words' }),
      clientCall: (node: Node) => node.staticroute.create('10.0.0.0/8', { nextHop: 'Ethernet1', distance: 5, routeName: 'two words' }),
      pattern: /one \\S\+ token|inner whitespace/u,
    },
  ] as const

  for (const scenario of mirror) {
    it(`both refuse: ${scenario.label}`, async () => {
      const staged = stageRoute(scenario.fields, [])
      if (!('refusal' in staged)) throw new Error(`the rule accepted ${scenario.label}`)
      expect(staged.refusal).toMatch(scenario.pattern)
      const clientMessage = await clientRefusal(scenario.clientCall)
      expect(clientMessage).toMatch(scenario.pattern)
    })
  }

  it('the segment helpers are reusable and label-first, mirroring assertUnsignedSegment/assertRouteName', () => {
    expect(unsignedSegmentRefusal('distance', '5')).toBeUndefined()
    expect(unsignedSegmentRefusal('tag', '0')).toBeUndefined()
    expect(unsignedSegmentRefusal('tag', '')).toBeUndefined()
    expect(unsignedSegmentRefusal('distance', '9'.repeat(20))).toMatch(/unsigned integer/u)
    expect(routeNameRefusal('LAB-A')).toBeUndefined()
    expect(routeNameRefusal('bel\u0007name')).toMatch(/control characters|single config line/u)
    expect(nextHopRefusal('Vlan100')).toBeUndefined()
    expect(ipDestRefusal('10.0.0.0/8')).toBeUndefined()
  })

  it('row-74 characters in a next hop or a name refuse with the client\u2019s one-config-line reason', () => {
    expect(nextHopRefusal('Eth\u0007ernet1')).toMatch(/control characters and line boundaries have no place in a single config line/u)
    expect(nextHopRefusal('Ethernet\u00001')).toMatch(/single config line/u)
    expect(ipDestRefusal('   ')).toMatch(/empty static-route destination/u)
    expect(nextHopRefusal('   ')).toMatch(/empty static-route next hop/u)
  })
})

describe('the screen-only refusals name themselves as the screen\u2019s rule', () => {
  it('a distance-less add is refused here although the client would compose the bare line', () => {
    const staged = stageRoute(fieldsOf({ action: 'add-route', prefix: '222.22.222.0/24', nextHop: 'Null0' }), [])
    if (!('refusal' in staged)) throw new Error('the guard is expected to refuse')
    expect(staged.refusal).toMatch(/This screen requires a distance/u)
    expect(staged.refusal).toMatch(/invisible to every later read|divergence 6/u)
    expect(staged.refusal).toMatch(/client itself would compose the bare line/u)
  })

  it('an IPv6-shaped next hop is refused although the client\u2019s token guard accepts it', () => {
    const problem = nextHopRefusal('2001:db8::1')
    expect(problem).toMatch(/This screen refuses the IPv6-shaped next hop/u)
    expect(problem).toMatch(/client's token guard would let the token ride/u)
    const staged = stageRoute(fieldsOf({ action: 'add-route', prefix: '10.0.0.0/8', nextHop: '2001:db8::1', distance: '5' }), [])
    expect('refusal' in staged).toBe(true)
  })

  it('octet and prefix arithmetic refusals are labelled DR-032, not EOS claims', () => {
    expect(ipDestRefusal('999.0.0.0/8')).toMatch(/outside 0\.\.255/u)
    expect(ipDestRefusal('999.0.0.0/8')).toMatch(/client call would compose/u)
    expect(ipDestRefusal('10.0.0.0/33')).toMatch(/outside 0\.\.32/u)
    expect(ipDestRefusal('vrf red 10.0.0.0/8')).toMatch(/VRF-scoped static routes are outside/u)
    expect(ipDestRefusal('/24')).toMatch(/dotted A\.B\.C\.D\/E shape/u)
  })

  it('a row the client\u2019s write guards could not reproduce is listed but never written (DR-059 posture)', () => {
    const odd = row({ ipDest: '10.0.0.0/8', nextHop: 'Eth\u0007ernet1', distance: 5 })
    const staged = stageRoute(fieldsOf({ action: 'remove-route', routeKey: routeKey(odd) }), [odd])
    if (!('refusal' in staged)) throw new Error('the row guard is expected to refuse')
    expect(staged.refusal).toMatch(/this client’s own write guards refuse|stay listed for display/u)
  })
})

describe('no-op and unresolved selections cost nothing', () => {
  const rows: readonly RouteRow[] = [
    row({ ipDest: '10.10.0.0/16', nextHop: 'Ethernet2', distance: 10, tag: 1, routeName: 'agg' }),
    row({ ipDest: '10.20.0.0/16', nextHop: '192.168.1.1', distance: 5 }),
  ]

  it('staging the identical line the read already answered is refused with the multi-next-hop caveat', () => {
    const staged = stageRoute(fieldsOf({ action: 'add-route', prefix: '10.10.0.0/16', nextHop: 'Ethernet2', distance: '10', tag: '1', routeName: 'agg' }), rows)
    if (!('refusal' in staged)) throw new Error('the duplicate guard is expected to refuse')
    expect(staged.refusal).toMatch(/already one of the lines this read answered/u)
    expect(staged.refusal).toMatch(/second next hop for the same destination is a different line/u)
    // The same destination through a different next hop is a different line, and is offered.
    const added = stageRoute(fieldsOf({ action: 'add-route', prefix: '10.10.0.0/16', nextHop: 'Ethernet3', distance: '10' }), rows)
    expect('intent' in added).toBe(true)
  })

  it('a tag or name that already matches is refused numerically/verbatim as the client would read it', () => {
    const tagStaged = stageRoute(fieldsOf({ action: 'set-tag', routeKey: routeKey(rows[0]), tag: '01' }), rows)
    if ('intent' in tagStaged) throw new Error('expected the no-op tag refusal')
    expect(tagStaged.refusal).toMatch(/already carries tag 1/u)
    const nameStaged = stageRoute(fieldsOf({ action: 'set-name', routeKey: routeKey(rows[0]), routeName: 'agg' }), rows)
    if ('intent' in nameStaged) throw new Error('expected the no-op name refusal')
    expect(nameStaged.refusal).toMatch(/already carries name agg/u)
  })

  it('an empty value for tag or name is refused with the no-clearing-verb reason', () => {
    const tag = stageRoute(fieldsOf({ action: 'set-tag', routeKey: routeKey(rows[1]) }), rows)
    if ('intent' in tag) throw new Error('expected the tag refusal')
    expect(tag.refusal).toMatch(/no verb that clears a route tag/u)
    const name = stageRoute(fieldsOf({ action: 'set-name', routeKey: routeKey(rows[1]) }), rows)
    if ('intent' in name) throw new Error('expected the name refusal')
    expect(name.refusal).toMatch(/composes no name negation/u)
  })

  it('a selection the read did not answer is refused for every row-targeted action', () => {
    for (const action of ['remove-route', 'set-tag', 'set-name'] as const) {
      const staged = stageRoute(fieldsOf({ action, routeKey: 'nope|nope|0', tag: '3', routeName: 'x' }), rows)
      if (!('refusal' in staged)) throw new Error(`${action} accepted an unseen route`)
      expect(staged.refusal).toMatch(/does not match a route the device answered/u)
    }
  })
})

describe('the removal guards, derived only from the read table', () => {
  const table: readonly RouteRow[] = [
    row({ ipDest: DEFAULT_PREFIX, nextHop: '192.68.1.254', distance: 1, tag: 0 }),
    row({ ipDest: '10.9.0.0/16', nextHop: '192.68.1.254', distance: 20 }),
    row({ ipDest: '10.10.0.0/16', nextHop: 'Ethernet2', nextHopIp: '2.2.2.2', distance: 10 }),
    row({ ipDest: '10.11.0.0/16', nextHop: 'Ethernet2', distance: 10, routeName: 'interface-hop' }),
  ]

  it('the candidate set is exactly what the default-route rows spell', () => {
    expect([...gatewayCandidates(table)]).toEqual(['192.68.1.254'])
    expect([...gatewayCandidates(table.filter((entry) => entry.ipDest !== DEFAULT_PREFIX))]).toEqual([])
    // An interface exit on the default route makes the interface name a candidate too.
    const ifaceDefault = [row({ ipDest: DEFAULT_PREFIX, nextHop: 'Ethernet2', nextHopIp: '2.2.2.2', distance: 1 })]
    expect([...gatewayCandidates(ifaceDefault)]).toEqual(['Ethernet2', '2.2.2.2'])
  })

  it('the default-route row itself and every row sharing its next hop trip a guard; others do not', () => {
    const candidates = gatewayCandidates(table)
    expect(routeGuard(table[0], candidates)?.kind).toBe('default-route')
    expect(routeGuard(table[1], candidates)?.kind).toBe('shared-gateway')
    // An interface exit the DEFAULT route does not use is not a candidate, and neither is a row whose
    // own next-hop address happens to differ from the default's — the set is derived, not guessed.
    expect(routeGuard(table[2], candidates)).toBeUndefined()
    expect(routeGuard(table[3], candidates)).toBeUndefined()
    const noDefault = table.slice(1)
    expect(routeGuard(noDefault[0], gatewayCandidates(noDefault))).toBeUndefined()
    // With an interface-spelled default route, that interface and its address both become candidates.
    const ifaceCandidates = gatewayCandidates([row({ ipDest: DEFAULT_PREFIX, nextHop: 'Ethernet2', nextHopIp: '2.2.2.2', distance: 1 })])
    expect(routeGuard(table[2], ifaceCandidates)?.kind).toBe('shared-gateway')
  })

  it('the guard notes state what the screen cannot see instead of claiming the management path', () => {
    const candidates = gatewayCandidates(table)
    const defaultNote = routeGuard(table[0], candidates)?.note ?? ''
    expect(defaultNote).toMatch(/cannot see|has no interface table|no routing table/u)
    expect(defaultNote).toMatch(/show ip interface brief|management api http-commands/u)
    const sharedNote = routeGuard(table[1], candidates)?.note ?? ''
    expect(sharedNote).toMatch(/192\.68\.1\.254/u)
    expect(sharedNote).toMatch(/spells behind its own|same value this device/u)
    expect(sharedNote).toMatch(/not a claim about where eAPI is served/u)
  })

  it('an added default route carries the same risk, and a non-default add carries none', () => {
    expect(addDefaultGuard(DEFAULT_PREFIX)?.kind).toBe('default-route')
    expect(addDefaultGuard('10.0.0.0/8')).toBeUndefined()
    const staged = stageRoute(fieldsOf({ action: 'add-route', prefix: DEFAULT_PREFIX, nextHop: '192.68.1.9', distance: '5' }), table)
    if ('refusal' in staged) throw new Error(staged.refusal)
    expect(staged.intent.command).toBe('ip route 0.0.0.0/0 192.68.1.9 5')
    expect(staged.intent.guard?.kind).toBe('default-route')
    expect(staged.intent.guard?.note).toMatch(/line changes which next hop/u)
  })
})

describe('labels, keys and the scope note', () => {
  const target = row({ ipDest: '1.2.3.0/24', nextHop: 'Ethernet1', nextHopIp: '1.1.1.1', distance: 10, tag: 7, routeName: 'test1' })

  it('routeKey is the client identity 4-tuple, so tag/name changes never fork the row', () => {
    expect(routeKey(target)).toBe('1.2.3.0/24|Ethernet1|1.1.1.1|10')
    expect(routeKey({ ...target, tag: 99, routeName: 'other' })).toBe(routeKey(target))
    expect(routeKey({ ...target, nextHopIp: undefined })).toBe('1.2.3.0/24|Ethernet1||10')
  })

  it('routeLabel spells every segment the read answered, in one line', () => {
    expect(routeLabel(target)).toBe('1.2.3.0/24 via Ethernet1 · next-hop 1.1.1.1 · distance 10 · tag 7 · name test1')
    expect(routeLabel({ ipDest: '10.0.0.0/8', nextHop: 'Null0', distance: 5 })).toBe('10.0.0.0/8 via Null0 · distance 5')
  })

  it('the scope note names the config-not-RIB limit and the reader\u2019s blind spots', () => {
    expect(READ_SCOPE_NOTE).toMatch(/not the active RIB/u)
    expect(READ_SCOPE_NOTE).toMatch(/show ip route/u)
    expect(READ_SCOPE_NOTE).toMatch(/ipv6 route|vrf/u)
    expect(READ_SCOPE_NOTE).toMatch(/none this client can read/u)
  })
})
