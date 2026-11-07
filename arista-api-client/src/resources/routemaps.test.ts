/**
 * `RoutemapsResource` — W3b (#50), the route-map resource on the M7 framework.
 * `node.routemaps` over `MockTransport`: every read answer is a hand-authored config text and every
 * write answer is an exact joined command script (docs/TESTING.md §3, DR-083). Config is inline,
 * **hand-authored**: reduced from pyeapi's own `test/fixtures/running_config.routemaps` (TEST `:1-18`,
 * FOO `:20-24`, FOO-BAR `:37-52`), with the doubled `route-map FOOBAR permit 20` header (`:26`,`:32`)
 * reproduced and the two bodies edited to DIFFER (`as 1111`/`continue 200` then `as 2222`/`continue 300`)
 * so `_merge_entries`' LAST-wins collapse (`:130-138`) is observable — the upstream fixture keeps those
 * two blocks identical, so its own suite cannot see which one wins. NEVER captured from a device.
 *
 * ## Upstream port ledger (the 18 methods in `test_api_routemaps.py`, 6816d9e, re-verified 2026-11-06)
 * `test_instance` (`:51-53`) is the registry/accessor identity — a **wiring pin (round 2)**, declared
 * skipped here rather than duplicated. The other 17 are ported below:
 *  - `test_get` (`:55-58`) — `get('TEST')` keys `deny`/`permit`; the clause attribute keys
 *    continue/match/set (description only when a `description` line exists, `:155-158`), match a list,
 *    continue coerced to a number. Ported as the getAll/get clause-shape cases.
 *  - `test_get_not_configured` (`:60-61`) — `get('blah')` is `undefined` (upstream `None`).
 *  - `test_getall` (`:63-68`) — `len(keys())==4`; the doubled FOOBAR is ONE name and ONE clause.
 *  - `test_routemaps_functions` (`:70-79`) — create/delete/default with `('new','permit',100)` compose
 *    the bare / `no` / `default` `route-map` lines verbatim (loop bodies at `:71-77`).
 *  - `test_set_set_statement_clean` (`:81-85`) → `['route-map new permit 100','set weight 100']`;
 *  - `test_set_set_statement_remove_extraneous` (`:87-94`) →
 *    `['route-map TEST permit 10','no set tag 50','route-map TEST permit 10','set weight 100']`;
 *  - `test_set_match_statement_clean` (`:96-100`) → `['route-map new permit 200','match as 100']` (the
 *    seqno here is 200, pinned as-sent);
 *  - `test_set_match_statement_remove_extraneous` (`:102-109`) →
 *    `['route-map TEST permit 10','no match interface Ethernet1','route-map TEST permit 10','match as 1000']`.
 *    These four drive {@link setMatch}/{@link setSet}: both are **replace** verbs, and the
 *    `_remove_extraneous` pair is the "a statement omitted from the list is removed" pin (divergence 3).
 *  - `test_set_continue` (`:111-114`), `test_set_continue_to_default` (`:124-127` → `default continue`),
 *    `test_negate_continue` (`:129-132` → `no continue`); `test_set_continue_with_invalid_integer`
 *    (`:116-118`, `-1`) and `test_set_continue_with_invalid_string` (`:120-122`, `'invalid'`) both
 *    `raise ValueError` — here they are a `NotSupportedError` **refusal with upstream's exact guard
 *    message kept verbatim**, including its "seqno" mislabel (`routemaps.py:316-318`).
 *  - `test_set_description_with_value` (`:134-139`, the single `random_string()` slot at `:135`) →
 *    clears first: `['route-map TEST permit 10','no description','description <value>']`;
 *  - `test_negate_description` (`:141-144`) → `['route-map TEST permit 10','no description']`;
 *  - `test_set_description_with_default` (`:146-149`) → `['route-map TEST permit 10','default description']`;
 *  - `test_set_description_with_invalid_value` (`:151-159`) — upstream pins the EMPTY-VALUE fall-through
 *    composes `['…','no description']` with a pre-armed commented-out ValueError arm ("flip when
 *    command_builder fails on None"). This port implements the FUTURE arm: empty is a refusal, clearing
 *    is `unsetDescription`/`defaultDescription` (DR-037). Ported as a refusal pin.
 *
 * `get(name)`/`setMatch`/`setSet` also carry the name guards (where upstream interpolates the name into a
 * REGEX, `:96`/`:112-113`): a whitespace-bearing query like `'TEST permit 10'` is now a refusal, and a
 * regex-like name (`'RM.X'`) is a clean table miss rather than a widened match — divergence 1.
 */

import { describe, expect, it } from 'vitest'

import { Node } from '../command-layer'
import { NotSupportedError } from '../errors'
import { mockTransport, type MockTransport } from '../testing/mock-transport'
import type { RoutemapEntry, RoutemapEntryAttrs } from './routemaps'

/** Join lines into config text so the 3-space body indent survives as pyeapi wrote it. */
const textOf = (lines: readonly string[]): string => lines.join('\n')

/**
 * pyeapi's `running_config.routemaps` reduced for this suite — same clause names, same TEST/FOO/FOO-BAR
 * bodies, the doubled `route-map FOOBAR permit 20` header kept, with the two FOOBAR bodies made
 * DIFFERENT (the only deliberate edit) so the `_merge_entries` LAST-wins has an observable winner.
 */
const ROUTEMAPS_FIXTURE = textOf([
  'route-map TEST permit 10',
  '   set tag 50',
  '   match interface Ethernet1',
  '   continue 100',
  '!',
  'route-map TEST permit 20',
  '   match as 2000',
  '   match source-protocol ospf',
  '   match interface Ethernet2',
  '   continue 200',
  '!',
  'route-map TEST deny 30',
  '   match as 2000',
  '   match source-protocol ospf',
  '   match interface Ethernet2',
  '   continue 200',
  '!',
  'route-map FOO deny 20',
  '   match as 2000',
  '   match source-protocol ospf',
  '   match interface Ethernet2',
  '   continue 200',
  '!',
  'route-map FOOBAR permit 20',
  '   match as 1111',
  '   continue 200',
  '!',
  'route-map FOOBAR permit 20',
  '   match as 2222',
  '   continue 300',
  '!',
  'route-map FOO-BAR permit 10',
  '   match as 2000',
  '   match source-protocol ospf',
  '   match interface Ethernet2',
  '   continue 200',
  '!',
  'route-map FOO-BAR deny 20',
  '   match as 2000',
  '   match source-protocol ospf',
  '   match interface Ethernet2',
  '   continue 200',
  '!',
])

function nodeFor(config: string): { node: Node; transport: MockTransport } {
  const transport = mockTransport().replies('enable\nshow running-config all', [{}, { output: config }])
  return { node: new Node(transport), transport }
}
const writeKey = (cmds: readonly string[]): string => ['enable', 'configure terminal', ...cmds].join('\n')
const sentScripts = (transport: MockTransport): string[][] => transport.sent().map((cmds) => cmds.map(String))
/** Only the scripts that entered configuration mode — drop the `show running-config` reads a diff verb
 *  performs to find a clause's current statements. */
const writeScripts = (transport: MockTransport): string[][] =>
  sentScripts(transport).filter((cmds) => cmds[1] === 'configure terminal')

function outcome(fn: () => Promise<unknown>): Promise<unknown> {
  return fn().then(() => 'resolved' as const, (thrown: unknown) => thrown)
}
async function expectError(fn: () => Promise<unknown>, message: RegExp): Promise<void> {
  const thrown = await outcome(fn)
  expect(thrown, 'expected a rejection').toBeInstanceOf(Error)
  expect((thrown as Error).message).toMatch(message)
}
/** Pull one clause's attrs out of an entry; throws loudly if the SHAPE assertion is what is wrong. */
function attrsOf(entry: RoutemapEntry | undefined, action: string, seqno: number): RoutemapEntryAttrs {
  const attrs = entry?.get(action)?.get(seqno)
  if (attrs === undefined) throw new Error(`no clause ${action} ${String(seqno)} in the entry`)
  return attrs
}

describe('routemaps reads — getAll / get (port :55-68)', () => {
  it('getAll() lists the four names in config order, clause actions first-seen, seqnos ascending, on ONE read (port test_getall :63-68)', async () => {
    const { node, transport } = nodeFor(ROUTE_MAPS_FIXTURE)
    const table = await node.routemaps.getAll()
    // TEST, FOO, FOOBAR, FOO-BAR — the doubled FOOBAR header is ONE name.
    expect([...table.keys()]).toEqual(['TEST', 'FOO', 'FOOBAR', 'FOO-BAR'])
    expect([...table.get('TEST')?.keys() ?? []]).toEqual(['permit', 'deny'])
    expect([...(table.get('TEST')?.get('permit')?.keys() ?? [])]).toEqual([10, 20])
    // upstream re-runs the whole get per name inside getall (`:105-108`); the chunk memo means one read.
    expect(transport.callCount()).toBe(1)
  })

  it('get(name) is undefined for an unset name (port test_get_not_configured :60-61)', async () => {
    const { node, transport } = nodeFor(ROUTE_MAPS_FIXTURE)
    expect(await node.routemaps.get('doesnotexist')).toBeUndefined()
    expect(transport.callCount()).toBe(1)
  })

  it('a clause carries continue/match/set and NO description key when no description line exists (pin _parse_description None → absence, :155-158 / divergence 4)', async () => {
    const { node } = nodeFor(ROUTE_MAPS_FIXTURE)
    const a10 = attrsOf(await node.routemaps.get('TEST'), 'permit', 10)
    expect(Object.keys(a10).sort()).toEqual(['continue', 'match', 'set'])
    expect(a10).toEqual({ continue: 100, match: ['interface Ethernet1'], set: ['tag 50'] })
  })

  it('a `description` line becomes the description field, FIRST match only (asymmetry vs findAll, :155-158)', async () => {
    const { node } = nodeFor(textOf([
      'route-map D permit 10',
      '   description first one',
      '   description second one',
      '   match as 1',
      '!',
    ]))
    const d = attrsOf(await node.routemaps.get('D'), 'permit', 10)
    expect(d.description).toBe('first one')
    expect(d.match).toEqual(['as 1'])
  })

  it('a `no description`/`no continue` body line contributes nothing — negation is absence (divergence 4)', async () => {
    const { node } = nodeFor(textOf(['route-map N permit 10', '   no description', '   no continue', '   match as 1', '!']))
    const n = attrsOf(await node.routemaps.get('N'), 'permit', 10)
    expect(n).toEqual({ match: ['as 1'], set: [] })
  })

  it('match reads EVERY `match` line in order, set is [] when none; a deny clause parses identically (port get :55-58)', async () => {
    const { node } = nodeFor(ROUTE_MAPS_FIXTURE)
    const deny30 = attrsOf(await node.routemaps.get('TEST'), 'deny', 30)
    expect(deny30.match).toEqual(['as 2000', 'source-protocol ospf', 'interface Ethernet2'])
    expect(deny30.set).toEqual([])
    expect(deny30.continue).toBe(200)
  })

  it('the doubled `route-map FOOBAR permit 20` collapses to ONE clause, LAST-wins, seqno an int key (pin _merge_entries :130-138 — the delicate rule)', async () => {
    const { node } = nodeFor(ROUTE_MAPS_FIXTURE)
    const foobar = await node.routemaps.get('FOOBAR')
    expect(foobar?.get('permit')?.size).toBe(1)
    const collapsed = attrsOf(foobar, 'permit', 20)
    // upstream stores `e['attr']` AT `response[action][int(seqno)]` (`:137-138`), so a later same
    // (name, action, seqno) clause REPLACES the earlier one's whole attr dict → the second FOOBAR wins.
    expect(collapsed).toEqual({ continue: 300, match: ['as 2222'], set: [] })
  })

  it('the same seqno under a DIFFERENT action stays separate (only name+action+seqno all-equal merges, the triple identity)', async () => {
    const { node } = nodeFor(textOf(['route-map T permit 10', '   match as 1', '!', 'route-map T deny 10', '   match as 2', '!']))
    const t = await node.routemaps.get('T')
    expect(attrsOf(t, 'permit', 10).match).toEqual(['as 1'])
    expect(attrsOf(t, 'deny', 10).match).toEqual(['as 2'])
  })

  it('a column-0 `route-map` line in a banner body, or an INDENTED one in another section, does not vote (chunk rule, divergence 2)', async () => {
    const { node, transport } = nodeFor(textOf([
      'banner motd',
      'this line mentions route-map FAKE permit 9 inside the body',
      'EOF',
      'route-map NOTACLAUSE',
      '!',
      'interface Ethernet1',
      '   route-map NOTREAL permit 9',
      '!',
      'route-map REAL permit 10',
      '   match as 1',
      '!',
    ]))
    const table = await node.routemaps.getAll()
    expect([...table.keys()]).toEqual(['REAL'])
    expect(transport.callCount()).toBe(1)
  })

  it('a bare clause (header only, no body) answers match/set [] with no continue/description', async () => {
    const { node } = nodeFor(textOf(['route-map BARE permit 10', '!']))
    expect(attrsOf(await node.routemaps.get('BARE'), 'permit', 10)).toEqual({ match: [], set: [] })
  })

  it('a FOO-BAR hyphen name is ONE `\S+` name and reads back (getall name grammar, :103)', async () => {
    const { node } = nodeFor(ROUTE_MAPS_FIXTURE)
    expect(attrsOf(await node.routemaps.get('FOO-BAR'), 'deny', 20).continue).toBe(200)
  })
})

describe('routemaps create / delete / setDefault (port test_routemaps_functions :70-79)', () => {
  it('create composes `route-map NAME ACTION SEQNO`, one line, no pre-read (port :71-73)', async () => {
    const { node, transport } = nodeFor('')
    transport.replies(writeKey(['route-map new permit 100']), [{}, {}, {}])
    await node.routemaps.create('new', { action: 'permit', seqno: 100 })
    expect(sentScripts(transport)).toEqual([['enable', 'configure terminal', 'route-map new permit 100']])
    expect(transport.callCount()).toBe(1)
  })

  it('delete composes `no route-map NAME ACTION SEQNO` (port :74-75)', async () => {
    const { node, transport } = nodeFor('')
    transport.replies(writeKey(['no route-map new permit 100']), [{}, {}, {}])
    await node.routemaps.delete('new', { action: 'permit', seqno: 100 })
    expect(sentScripts(transport)).toEqual([['enable', 'configure terminal', 'no route-map new permit 100']])
  })

  it('setDefault composes `default route-map NAME ACTION SEQNO` — row 77 rename of pyeapi `default` (port :76-79)', async () => {
    const { node, transport } = nodeFor('')
    transport.replies(writeKey(['default route-map new permit 100']), [{}, {}, {}])
    await node.routemaps.setDefault('new', { action: 'permit', seqno: 100 })
    expect(sentScripts(transport)).toEqual([['enable', 'configure terminal', 'default route-map new permit 100']])
  })

  it('a presence verb missing action OR seqno refuses before anything is read (the single-key framework bag cannot name a clause)', async () => {
    const { node, transport } = nodeFor('')
    await expectError(() => node.routemaps.create('new', { action: 'permit' } as never), /needs BOTH `action` and `seqno`/)
    await expectError(() => node.routemaps.create('new', { seqno: 100 } as never), /needs BOTH `action` and `seqno`/)
    await expectError(() => node.routemaps.delete('new', {} as never), /needs BOTH `action` and `seqno`/)
    expect(transport.sent()).toEqual([])
  })

  it('a bad action / seqno on create refuses before any read (guards run first; divergence 5)', async () => {
    const { node, transport } = nodeFor('')
    await expectError(() => node.routemaps.create('x', { action: 'reject', seqno: 1 } as never), /route-map action/)
    await expectError(() => node.routemaps.create('x', { action: 'permit', seqno: -1 } as never), /route-map seqno/)
    await expectError(() => node.routemaps.create('x', { action: 'permit', seqno: 1.5 } as never), /route-map seqno/)
    await expectError(() => node.routemaps.create('x', { action: 'permit', seqno: '1a' } as never), /route-map seqno/)
    expect(transport.sent()).toEqual([])
  })
})

describe('routemaps setMatch / setSet — the REPLACE verbs (port :81-109, divergence 3)', () => {
  it('setMatch with no current match adds every statement, opening the clause header before EACH (port clean match :96-100)', async () => {
    const { node, transport } = nodeFor(ROUTE_MAPS_FIXTURE)
    const key = writeKey(['route-map new permit 200', 'match as 100'])
    transport.replies(key, [{}, {}, {}, {}, {}])
    // `new permit 200` is not in the fixture, so the diff reads current=[] and adds each statement.
    await node.routemaps.setMatch('new', 'permit', 200, ['as 100'])
    expect(writeScripts(transport)).toContainEqual(['enable', 'configure terminal', 'route-map new permit 200', 'match as 100'])
  })

  it('setMatch removes the CURRENT statement omitted from the list, then adds — removals first (port remove_extraneous :102-109)', async () => {
    const { node, transport } = nodeFor(ROUTE_MAPS_FIXTURE)
    // TEST permit 10 currently has exactly `match interface Ethernet1`; new list drops it, adds as 1000.
    const key = writeKey([
      'route-map TEST permit 10', 'no match interface Ethernet1',
      'route-map TEST permit 10', 'match as 1000',
    ])
    transport.replies(key, [{}, {}, {}, {}, {}, {}])
    await node.routemaps.setMatch('TEST', 'permit', 10, ['as 1000'])
    expect(writeScripts(transport)).toContainEqual([
      'enable', 'configure terminal',
      'route-map TEST permit 10', 'no match interface Ethernet1',
      'route-map TEST permit 10', 'match as 1000',
    ])
  })

  it("setMatch against the clause's own current list writes NOTHING (upstream `configure(commands) if commands else True` :252)", async () => {
    const { node, transport } = nodeFor(ROUTE_MAPS_FIXTURE)
    await node.routemaps.setMatch('TEST', 'permit', 10, ['interface Ethernet1'])
    expect(writeScripts(transport)).toEqual([])
    // it still performed the one config read for the diff — upstream's `self.get` does the same (`:236`).
    expect(transport.callCount()).toBe(1)
  })

  it('setMatch keeps a statement present in both lists, touching only what actually changed (the multiset of upstream, divergence 3)', async () => {
    const { node, transport } = nodeFor(ROUTE_MAPS_FIXTURE)
    // TEST permit 20 currently: as 2000, source-protocol ospf, interface Ethernet2.
    // New list: keep `as 2000`, drop `source-protocol ospf` and `interface Ethernet2`, add `as 3000`.
    const key = writeKey([
      'route-map TEST permit 20', 'no match source-protocol ospf',
      'route-map TEST permit 20', 'no match interface Ethernet2',
      'route-map TEST permit 20', 'match as 3000',
    ])
    transport.replies(key, [{}, {}, {}, {}, {}, {}, {}, {}])
    await node.routemaps.setMatch('TEST', 'permit', 20, ['as 2000', 'as 3000'])
    expect(writeScripts(transport)).toEqual([
      ['enable', 'configure terminal', ...key.split('\n').slice(2)],
    ])
  })

  it('setSet removes the current set statement omitted from the new list (port set remove_extraneous :87-94)', async () => {
    const { node, transport } = nodeFor(ROUTE_MAPS_FIXTURE)
    // TEST permit 10 currently has `set tag 50`.
    const key = writeKey([
      'route-map TEST permit 10', 'no set tag 50',
      'route-map TEST permit 10', 'set weight 100',
    ])
    transport.replies(key, [{}, {}, {}, {}, {}, {}])
    await node.routemaps.setSet('TEST', 'permit', 10, ['weight 100'])
    expect(writeScripts(transport)).toContainEqual([
      'enable', 'configure terminal',
      'route-map TEST permit 10', 'no set tag 50',
      'route-map TEST permit 10', 'set weight 100',
    ])
  })

  it('setSet with no current set just adds, header per line (port set clean :81-85)', async () => {
    const { node, transport } = nodeFor(ROUTE_MAPS_FIXTURE)
    const key = writeKey(['route-map new permit 100', 'set weight 100'])
    transport.replies(key, [{}, {}, {}, {}])
    await node.routemaps.setSet('new', 'permit', 100, ['weight 100'])
    expect(writeScripts(transport)).toContainEqual(['enable', 'configure terminal', 'route-map new permit 100', 'set weight 100'])
  })

  it('setSet against its own current set list writes nothing (the same `else True` arm)', async () => {
    const { node, transport } = nodeFor(ROUTE_MAPS_FIXTURE)
    await node.routemaps.setSet('TEST', 'permit', 10, ['tag 50'])
    expect(writeScripts(transport)).toEqual([])
  })

  it('a clause that does not exist at all diffs against an empty current → pure additions (upstream `except → []`, :235-238)', async () => {
    const { node, transport } = nodeFor(ROUTE_MAPS_FIXTURE)
    const key = writeKey(['route-map ABSENT permit 5', 'set metric 10'])
    transport.replies(key, [{}, {}, {}, {}])
    await node.routemaps.setSet('ABSENT', 'permit', 5, ['metric 10'])
    expect(writeScripts(transport)).toContainEqual(['enable', 'configure terminal', 'route-map ABSENT permit 5', 'set metric 10'])
  })

  it('statement inputs are validated before the diff: empty / embedded-newline / non-array / bad name all refuse and write nothing', async () => {
    const { node, transport } = nodeFor(ROUTE_MAPS_FIXTURE)
    await expectError(() => node.routemaps.setMatch('X', 'permit', 10, ['']), /empty match statement/)
    await expectError(() => node.routemaps.setMatch('X', 'permit', 10, ['a\nb']), /single line/)
    await expectError(() => node.routemaps.setSet('X', 'permit', 10, 'not-an-array' as never), /expected an array of statements/)
    await expectError(() => node.routemaps.setSet('a b', 'permit', 10, ['x']), /route-map name/)
    expect(writeScripts(transport)).toEqual([])
  })
})

describe('routemaps setContinue / unsetContinue / defaultContinue (port :111-132)', () => {
  const GUARD = 'seqno must be a positive integer unless default or disable is specified'

  it('setContinue opens the clause then emits `continue N` (port test_set_continue :111-114)', async () => {
    const { node, transport } = nodeFor('')
    transport.replies(writeKey(['route-map TEST permit 10', 'continue 100']), [{}, {}, {}])
    await node.routemaps.setContinue('TEST', 'permit', 10, 100)
    expect(sentScripts(transport)).toEqual([['enable', 'configure terminal', 'route-map TEST permit 10', 'continue 100']])
  })

  it("setContinue with -1 refuses — upstream's integer guard — with its EXACT message incl. the \"seqno\" mislabel (port invalid_integer :116-118)", async () => {
    const { node, transport } = nodeFor('')
    const thrown = await outcome(() => node.routemaps.setContinue('TEST', 'permit', 10, -1))
    expect(thrown).toBeInstanceOf(NotSupportedError)
    expect((thrown as Error).message).toContain(GUARD)
    expect(transport.sent()).toEqual([])
  })

  it('setContinue with a non-digit string refuses on the same guard message (port invalid_string :120-122)', async () => {
    const { node, transport } = nodeFor('')
    const thrown = await outcome(() => node.routemaps.setContinue('TEST', 'permit', 10, 'invalid'))
    expect(thrown).toBeInstanceOf(NotSupportedError)
    expect((thrown as Error).message).toContain(GUARD)
    expect(transport.sent()).toEqual([])
  })

  it('unsetContinue emits header + `no continue` (port test_negate_continue :129-132)', async () => {
    const { node, transport } = nodeFor('')
    transport.replies(writeKey(['route-map TEST permit 10', 'no continue']), [{}, {}, {}])
    await node.routemaps.unsetContinue('TEST', 'permit', 10)
    expect(sentScripts(transport)).toEqual([['enable', 'configure terminal', 'route-map TEST permit 10', 'no continue']])
  })

  it('defaultContinue emits header + `default continue` (port test_set_continue_to_default :124-127)', async () => {
    const { node, transport } = nodeFor('')
    transport.replies(writeKey(['route-map TEST permit 10', 'default continue']), [{}, {}, {}])
    await node.routemaps.defaultContinue('TEST', 'permit', 10)
    expect(sentScripts(transport)).toEqual([['enable', 'configure terminal', 'route-map TEST permit 10', 'default continue']])
  })

  it('unsetContinue/defaultContinue guards a bad action / seqno BEFORE writing (coord guards still run)', async () => {
    const { node, transport } = nodeFor('')
    await expectError(() => node.routemaps.unsetContinue('x', 'reject', 10), /route-map action/)
    await expectError(() => node.routemaps.defaultContinue('x', 'permit', -3), /route-map seqno/)
    expect(transport.sent()).toEqual([])
  })
})

describe('routemaps setDescription / unsetDescription / defaultDescription (port :134-159)', () => {
  it('setDescription clears existing FIRST (`no description`), then writes the value (port with-value :134-139)', async () => {
    const { node, transport } = nodeFor('')
    // the single `random_string()` slot (`:135`) → a fixed multi-word description, pinning the `description
    // %s` remainder, the header-first ordering AND the clear-before-set line (the upstream test value is
    // random; this one is deterministic per docs/TESTING.md §6).
    transport.replies(writeKey(['route-map TEST permit 10', 'no description', 'description BGP import filter']), [{}, {}, {}, {}])
    await node.routemaps.setDescription('TEST', 'permit', 10, 'BGP import filter')
    expect(sentScripts(transport)).toEqual([
      'enable', 'configure terminal',
      'route-map TEST permit 10', 'no description', 'description BGP import filter',
    ])
  })

  it('unsetDescription emits header + `no description` (port test_negate_description :141-144)', async () => {
    const { node, transport } = nodeFor('')
    transport.replies(writeKey(['route-map TEST permit 10', 'no description']), [{}, {}, {}])
    await node.routemaps.unsetDescription('TEST', 'permit', 10)
    expect(sentScripts(transport)).toEqual([['enable', 'configure terminal', 'route-map TEST permit 10', 'no description']])
  })

  it('defaultDescription emits header + `default description` (port :146-149)', async () => {
    const { node, transport } = nodeFor('')
    transport.replies(writeKey(['route-map TEST permit 10', 'default description']), [{}, {}, {}])
    await node.routemaps.defaultDescription('TEST', 'permit', 10)
    expect(sentScripts(transport)).toEqual([['enable', 'configure terminal', 'route-map TEST permit 10', 'default description']])
  })

  it('an EMPTY description refuses (upstream pins the deprecated fall-through `no <bare>`; this port makes it a refusal + named clears — divergence, :151-159)', async () => {
    // Upstream: `set_description(…, value=None)` sends header then command_builder('description', None)
    // which falls through to `'no %s'`; its test comments show the ValueError arm is disabled pending the
    // builder refusing None. DR-037 makes that fall-through THROW, so here empty is a refusal (row 73 /
    // DR-037 in command-builder.ts), NOT a silent `no description`.
    const { node, transport } = nodeFor('')
    await expectError(() => node.routemaps.setDescription('TEST', 'permit', 10, ''), /route-map description/)
    await expectError(() => node.routemaps.setDescription('TEST', 'permit', 10, '   '), /empty description/)
    expect(transport.sent()).toEqual([])
  })

  it('description with CR/LF, leading/trailing whitespace, or a DEL/control char refuses before any write', async () => {
    const { node, transport } = nodeFor('')
    await expectError(() => node.routemaps.setDescription('TEST', 'permit', 10, 'a\nb'), /one line/)
    await expectError(() => node.routemaps.setDescription('TEST', 'permit', 10, ' pad'), /leading or trailing whitespace/)
    await expectError(() => node.routemaps.setDescription('TEST', 'permit', 10, 'pad '), /leading or trailing whitespace/)
    await expectError(() => node.routemaps.setDescription('TEST', 'permit', 10, 'p\u0001q'), /control character/)
    expect(transport.sent()).toEqual([])
  })
})

describe('routemaps name guard (where upstream has none — divergence 1/5)', () => {
  it('a regex-like name does NOT widen the match: it is a clean table miss, not another name (pyeapi `%%s % name` interpolation, :96/:112-113)', async () => {
    const { node } = nodeFor(ROUTE_MAPS_FIXTURE)
    // pyeapi interpolates the name into a REGEX pattern, so `get('RM.X')`/`get('TEST permit 1')`-style
    // queries can drift onto unintended clauses. Here every lookup is an exact name → `undefined`.
    expect(await node.routemaps.get('RM.X')).toBeUndefined()
  })

  it('a name with whitespace is refused by the guard (so it can never be read back as a different triple)', async () => {
    const { node, transport } = nodeFor(ROUTE_MAPS_FIXTURE)
    await expectError(() => node.routemaps.get('TEST permit 10'), /route-map name/)
    await expectError(() => node.routemaps.get(''), /route-map name/)
    expect(transport.sent()).toEqual([])
  })

  it('the name guard runs first on every verb, so a refused clause costs ZERO round trips', async () => {
    const { node, transport } = nodeFor(ROUTE_MAPS_FIXTURE)
    await expectError(() => node.routemaps.get('has space'), /route-map name/)
    await expectError(() => node.routemaps.create('bad name', { action: 'permit', seqno: 1 }), /route-map name/)
    await expectError(() => node.routemaps.unsetContinue('bad name', 'permit', 1), /route-map name/)
    expect(transport.callCount()).toBe(0)
  })

  it('a name colliding with the indent-0 section namespace (`!` or a leading keyword) is refused (the guard keeps the reader\'s key space unambiguous)', async () => {
    const { node, transport } = nodeFor(ROUTE_MAPS_FIXTURE)
    await expectError(() => node.routemaps.get('!'), /route-map name/)
    await expectError(() => node.routemaps.create('route-map sneaky', { action: 'permit', seqno: 1 }), /route-map name/)
    expect(transport.sent()).toEqual([])
  })
})
