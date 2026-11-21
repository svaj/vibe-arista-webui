/**
 * #87 (route-map slice): the pure rules behind `#/routing/routemaps`. Every staged-line expectation
 * below is byte-for-byte the sequence the CLIENT's own verb sends, cited to the `routemaps.test.ts`
 * pin it mirrors (the send-only mirroring convention, SPEC-routemap-editor.md assumption 3) — a
 * client composition regression must fail here on the same byte the client suite guards.
 *
 * No React, no fetches, no device handles: line builders, the validators that mirror the client's
 * refusals, the picker's right-parse, the three reference arms, and the confirm/risk copy pins
 * (the container-only 67 ms / 6170 ms proxy quoted exactly, DR-043).
 */
import { describe, expect, it } from 'vitest'
import type { OspfState, RoutemapEntryAttrs } from '@devhax-heavy-industries/arista-eapi'

import {
  parseRoutemapClauseDraft,
  parseRoutemapClauseTarget,
  parseRoutemapStatementList,
  routemapClauseAttrs,
  routemapClauseHeaderLine,
  routemapClauseTarget,
  routemapCreateLines,
  routemapDeleteConfirmation,
  routemapDeleteFacts,
  routemapDeleteLines,
  routemapDeleteRisks,
  routemapDescriptionLines,
  routemapEditConfirmation,
  routemapEditRisks,
  routemapManagerRows,
  routemapReadBack,
  routemapReferencedFacts,
  routemapReference,
  routemapReferencingProtocols,
  routemapReplaceLines,
  routemapSetContinueLines,
  routemapUnsetContinueLines,
  ROUTEMAP_UNREFERENCED_FACTS,
  ROUTEMAP_UNKNOWN_REFERENCE_FACTS,
  validateRoutemapAction,
  validateRoutemapContinueValue,
  validateRoutemapDescription,
  validateRoutemapName,
  validateRoutemapSeqno,
  validateRoutemapStatement,
  validateRoutemapStatementList,
} from './routemap-rules'
import type { RoutemapClauses, RoutemapClauseRef } from './routemap-rules'

const clause: RoutemapClauseRef = { name: 'LAB-UNBLOCK', action: 'permit', seqno: '10' }

const ospfWith = (redistributions: readonly { protocol: string; routeMap?: string }[]): OspfState => ({
  ospfProcessId: 1,
  vrf: 'default',
  networks: [],
  redistributions,
  shutdown: false,
})

describe('clause line builders — the client verb text, byte-for-byte', () => {
  it('the header line is the client clauseHeader shape', () => {
    expect(routemapClauseHeaderLine(clause)).toBe('route-map LAB-UNBLOCK permit 10')
  })

  it('create is ONE bare header line (routemaps.ts:403-406)', () => {
    expect(routemapCreateLines(clause)).toEqual(['route-map LAB-UNBLOCK permit 10'])
  })

  it('delete is one top-level `no` line (routemaps.ts:414-417, the client pin `no route-map new permit 100`)', () => {
    expect(routemapDeleteLines({ name: 'new', action: 'permit', seqno: '100' })).toEqual(['no route-map new permit 100'])
  })

  it('description is the clear-then-set PAIR, header before each line (setDescription, upstream pin test_api_routemaps.py:134-139)', () => {
    expect(routemapDescriptionLines(clause, 'gw')).toEqual([
      'route-map LAB-UNBLOCK permit 10',
      'no description',
      'route-map LAB-UNBLOCK permit 10',
      'description gw',
    ])
  })

  it('continue set/unset are header + the one line (setContinue :527-535 / unsetContinue :538-540)', () => {
    expect(routemapSetContinueLines(clause, '20')).toEqual(['route-map LAB-UNBLOCK permit 10', 'continue 20'])
    expect(routemapUnsetContinueLines(clause)).toEqual(['route-map LAB-UNBLOCK permit 10', 'no continue'])
  })
})

describe('routemapReplaceLines — the replaceStatements diff sequence (routemaps.ts:465-502)', () => {
  it('removals FIRST in current order, additions SECOND in input order, header before EVERY body line', () => {
    const lines = routemapReplaceLines(
      clause,
      'set',
      ['community 65000:1', 'local-preference 200', 'metric 300'],
      ['local-preference 200', 'community 65001:2', 'weight 400'],
    )
    expect(lines).toEqual([
      'route-map LAB-UNBLOCK permit 10',
      'no set community 65000:1',
      'route-map LAB-UNBLOCK permit 10',
      'no set metric 300',
      'route-map LAB-UNBLOCK permit 10',
      'set community 65001:2',
      'route-map LAB-UNBLOCK permit 10',
      'set weight 400',
    ])
  })

  it('pure additions keep input order under repeated headers', () => {
    expect(routemapReplaceLines(clause, 'match', [], ['ip address prefix-list PL1', 'interface Vlan70'])).toEqual([
      'route-map LAB-UNBLOCK permit 10',
      'match ip address prefix-list PL1',
      'route-map LAB-UNBLOCK permit 10',
      'match interface Vlan70',
    ])
  })

  it('pure removals keep CURRENT order', () => {
    expect(routemapReplaceLines(clause, 'match', ['ip address prefix-list PL1', 'interface Vlan70'], [])).toEqual([
      'route-map LAB-UNBLOCK permit 10',
      'no match ip address prefix-list PL1',
      'route-map LAB-UNBLOCK permit 10',
      'no match interface Vlan70',
    ])
  })

  it('an empty diff sends NOTHING (the client answers [] at :501)', () => {
    expect(routemapReplaceLines(clause, 'set', ['community 65000:1'], ['community 65000:1'])).toEqual([])
    expect(routemapReplaceLines(clause, 'set', [], [])).toEqual([])
  })

  it('reordering alone is a no-op diff — the client compares sets, not order (DR-113)', () => {
    expect(routemapReplaceLines(clause, 'set', ['community 65000:1', 'weight 5'], ['weight 5', 'community 65000:1'])).toEqual([])
  })
})

describe('validators mirror the client refusals (grammar, not device bounds — DR-120)', () => {
  it('name: required, one token, no config-marker prefix', () => {
    expect(validateRoutemapName('')).toMatch(/route-map name is required/u)
    expect(validateRoutemapName('LAB UNBLOCK')).toMatch(/carries whitespace/u)
    // Whitespace is checked first (the client's own order), so the marker arm needs a space-free name.
    expect(validateRoutemapName('route-map-sneaky')).toMatch(/begins with a config marker/u)
    expect(validateRoutemapName('!bang')).toMatch(/begins with a config marker/u)
    expect(validateRoutemapName('LAB-UNBLOCK')).toBeUndefined()
  })

  it('action: the documented pair only (DR-032)', () => {
    expect(validateRoutemapAction('permit')).toBeUndefined()
    expect(validateRoutemapAction('deny')).toBeUndefined()
    expect(validateRoutemapAction('permit ')).toMatch(/not `permit` or `deny`/u)
    expect(validateRoutemapAction('')).toMatch(/not `permit` or `deny`/u)
  })

  it('seqno: digits only (the reader captures (\\d+), routemaps.py:103, :112)', () => {
    expect(validateRoutemapSeqno('10')).toBeUndefined()
    expect(validateRoutemapSeqno('')).toMatch(/required/u)
    expect(validateRoutemapSeqno('10a')).toMatch(/not digits/u)
    expect(validateRoutemapSeqno('-10')).toMatch(/not digits/u)
  })

  it('continue: a positive integer (upstream routemaps.py:316-318)', () => {
    expect(validateRoutemapContinueValue('20')).toBeUndefined()
    expect(validateRoutemapContinueValue('0')).toMatch(/positive integer/u)
    expect(validateRoutemapContinueValue('abc')).toMatch(/positive integer/u)
  })

  it('statement: non-empty, single line, no control characters (assertStatement)', () => {
    expect(validateRoutemapStatement('community 65000:1', 'set')).toBeUndefined()
    expect(validateRoutemapStatement('  ', 'set')).toMatch(/composes `set `/u)
    expect(validateRoutemapStatement('community 1\nweight 2', 'set')).toMatch(/single line/u)
    expect(validateRoutemapStatement('match\u0000x', 'match')).toMatch(/control character/u)
  })

  it('description: non-empty, single line', () => {
    expect(validateRoutemapDescription('gw')).toBeUndefined()
    expect(validateRoutemapDescription('')).toMatch(/needs a value/u)
    expect(validateRoutemapDescription('a\nb')).toMatch(/line boundary/u)
  })

  it('parseRoutemapClauseDraft refuses in name → action → seqno order', () => {
    const refusalOf = (draft: { name: string; action: string; seqno: string }): string => {
      const outcome = parseRoutemapClauseDraft(draft)
      if ('refusal' in outcome) return outcome.refusal
      throw new Error(`expected a refusal, got clause ${JSON.stringify(outcome.clause)}`)
    }
    expect(refusalOf({ name: '', action: 'permit', seqno: '10' })).toMatch(/required/u)
    expect(refusalOf({ name: 'A', action: 'maybe', seqno: '10' })).toMatch(/not `permit` or `deny`/u)
    expect(refusalOf({ name: 'A', action: 'permit', seqno: 'x' })).toMatch(/not digits/u)
    expect(parseRoutemapClauseDraft({ name: 'A', action: 'deny', seqno: '10' })).toEqual({
      clause: { name: 'A', action: 'deny', seqno: '10' },
    })
  })
})

describe('the picker target: names may carry `/`, so parse from the RIGHT', () => {
  it('round-trips a plain clause', () => {
    const target = routemapClauseTarget(clause)
    expect(target).toBe('LAB-UNBLOCK/permit/10')
    expect(parseRoutemapClauseTarget(target)).toEqual(clause)
  })

  it('a name carrying `/` keeps the whole name', () => {
    expect(parseRoutemapClauseTarget('LAB/OUT/deny/100')).toEqual({ name: 'LAB/OUT', action: 'deny', seqno: '100' })
  })

  it('anything else is undefined', () => {
    expect(parseRoutemapClauseTarget('')).toBeUndefined()
    expect(parseRoutemapClauseTarget('LAB/maybe/10')).toBeUndefined()
    expect(parseRoutemapClauseTarget('LAB/permit/1o')).toBeUndefined()
  })
})

describe('statement-list parsing (the textarea)', () => {
  it('splits on newlines, trims, drops empty lines', () => {
    expect(parseRoutemapStatementList('community 65000:1\n\n  weight 5  \n')).toEqual(['community 65000:1', 'weight 5'])
    expect(parseRoutemapStatementList('')).toEqual([])
  })

  it('validateRoutemapStatementList answers the first refusal', () => {
    expect(validateRoutemapStatementList(['community 65000:1', 'weight 5'], 'set')).toBeUndefined()
    expect(validateRoutemapStatementList(['community 65000:1', 'a\nb'], 'set')).toMatch(/single line/u)
  })
})

describe('reads → rows and clause lookup', () => {
  const attrs = (over: Partial<RoutemapEntryAttrs> = {}): RoutemapEntryAttrs => ({ match: [], set: [], ...over })
  const table = new Map<string, RoutemapClauses>([
    ['LAB-UNBLOCK', new Map([['permit', new Map([[10, attrs({ match: ['ip address prefix-list PL1'], set: ['community 65000:1'], description: 'gw' })], [20, attrs({ continue: 30 })]])]])],
  ])

  it('rows flatten name → action → seqno in device order, statements joined, absence as (none)', () => {
    const rows = routemapManagerRows(table)
    expect(rows.map((row) => `${row.name}/${row.action}/${row.seqno}`)).toEqual(['LAB-UNBLOCK/permit/10', 'LAB-UNBLOCK/permit/20'])
    expect(rows[0]).toEqual({
      name: 'LAB-UNBLOCK',
      action: 'permit',
      seqno: '10',
      matchStatements: 'ip address prefix-list PL1',
      setStatements: 'community 65000:1',
      continueValue: '(none)',
      description: 'gw',
    })
    expect(rows[1]?.continueValue).toBe('30')
    expect(rows[1]?.matchStatements).toBe('(none)')
  })

  it('routemapClauseAttrs indexes the NUMBER-keyed seqno map from the string ref', () => {
    expect(routemapClauseAttrs(table, clause)?.description).toBe('gw')
    expect(routemapClauseAttrs(table, { name: 'LAB-UNBLOCK', action: 'deny', seqno: '10' })).toBeUndefined()
    expect(routemapClauseAttrs(new Map(), clause)).toBeUndefined()
  })
})

describe('the three reference arms (routemapReference)', () => {
  it('a redistribute naming the map → referenced with its protocols', () => {
    const ospf = ospfWith([{ protocol: 'connected', routeMap: 'LAB-UNBLOCK' }, { protocol: 'static', routeMap: 'OTHER' }, { protocol: 'bgp' }])
    expect(routemapReference('LAB-UNBLOCK', ospf, false)).toEqual({ status: 'referenced', protocols: ['connected'] })
    expect(routemapReferencingProtocols(ospf, 'LAB-UNBLOCK')).toEqual(['connected'])
  })

  it('no naming redistribute → unreferenced; no OSPF process (a normal undefined) → unreferenced', () => {
    expect(routemapReference('LAB-UNBLOCK', ospfWith([{ protocol: 'connected', routeMap: 'OTHER' }]), false)).toEqual({ status: 'unreferenced' })
    expect(routemapReference('LAB-UNBLOCK', undefined, false)).toEqual({ status: 'unreferenced' })
  })

  it('a FAILED reference read → unknown, whatever else the state says', () => {
    expect(routemapReference('LAB-UNBLOCK', undefined, true)).toEqual({ status: 'unknown' })
    expect(routemapReference('LAB-UNBLOCK', ospfWith([{ protocol: 'connected', routeMap: 'LAB-UNBLOCK' }]), true)).toEqual({ status: 'unknown' })
  })
})

describe('risk / confirm copy — facts, not adjectives (DR-149), container-only proxy (DR-043)', () => {
  it('readBack restates every staged line and names the mirroring', () => {
    const text = routemapReadBack(['route-map LAB-UNBLOCK permit 10', 'set community 65000:1'])
    expect(text).toContain('`route-map LAB-UNBLOCK permit 10` + `set community 65000:1`')
    expect(text).toMatch(/byte-for-byte the line sequence the client's own routemaps verbs compose/u)
  })

  it('the referenced arm quotes the two-node proxy EXACTLY as measured and says it was NOT a route-map edit', () => {
    const text = routemapReferencedFacts('LAB-UNBLOCK', ['connected'])
    expect(text).toContain('redistribute connected route-map LAB-UNBLOCK')
    expect(text).toContain('67 ms')
    expect(text).toContain('6170 ms')
    expect(text).toMatch(/NOT a route-map edit/u)
    expect(text).toMatch(/container evidence, not measured on this unit \(DR-043\)/u)
  })

  it('the unreferenced arm keeps the inference an inference', () => {
    expect(ROUTEMAP_UNREFERENCED_FACTS).toMatch(/inferred inert/u)
    expect(ROUTEMAP_UNREFERENCED_FACTS).toMatch(/that inference is not measured/u)
  })

  it('the unknown arm tells the operator to treat the map as referenced', () => {
    expect(ROUTEMAP_UNKNOWN_REFERENCE_FACTS).toMatch(/did not answer/u)
    expect(ROUTEMAP_UNKNOWN_REFERENCE_FACTS).toMatch(/Treat it as referenced/u)
  })

  it('delete facts carry the last-clause-deletes-the-name semantics and DR-024', () => {
    const text = routemapDeleteFacts(clause)
    expect(text).toContain('`route-map LAB-UNBLOCK permit 10`')
    expect(text).toMatch(/deletes the name/u)
    expect(text).toMatch(/startup-config/u)
    expect(text).toMatch(/DR-024/u)
  })

  it('edit risks are readBack + reference arm + the far-end note', () => {
    const risks = routemapEditRisks(routemapCreateLines(clause), { status: 'unreferenced' }, 'LAB-UNBLOCK')
    expect(risks).toHaveLength(3)
    expect(risks[0]).toMatch(/staged lines/u)
    expect(risks[1]).toBe(ROUTEMAP_UNREFERENCED_FACTS)
    expect(risks[2]).toMatch(/interface-attached policies/u)
  })

  it('delete risks add the whole-clause loss facts', () => {
    const risks = routemapDeleteRisks(routemapDeleteLines(clause), { status: 'unknown' }, clause)
    expect(risks).toHaveLength(4)
    expect(risks[1]).toBe(ROUTEMAP_UNKNOWN_REFERENCE_FACTS)
    expect(risks[2]).toMatch(/LAST clause/u)
  })

  it('the edit confirmation titles/subjects name the clause; the body is the reference arm', () => {
    const confirmation = routemapEditConfirmation('clause', clause, { status: 'referenced', protocols: ['connected'] })
    expect(confirmation.title).toBe('Second confirm: route-map clause LAB-UNBLOCK permit 10')
    expect(confirmation.subject).toBe('route-map LAB-UNBLOCK permit 10')
    expect(confirmation.label).toMatch(/route-policy blast/u)
    expect(confirmation.body).toContain('redistribute connected route-map LAB-UNBLOCK')
  })

  it('the delete confirmation subject carries the `no` form and the body both facts', () => {
    const confirmation = routemapDeleteConfirmation(clause, { status: 'unreferenced' })
    expect(confirmation.title).toBe('Second confirm: delete route-map LAB-UNBLOCK permit 10')
    expect(confirmation.subject).toBe('no route-map LAB-UNBLOCK permit 10')
    expect(confirmation.body).toContain(ROUTEMAP_UNREFERENCED_FACTS)
    expect(confirmation.body).toMatch(/deletes the name/u)
  })
})
