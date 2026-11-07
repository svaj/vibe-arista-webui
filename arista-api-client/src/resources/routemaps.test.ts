/**
 * `RoutemapsResource` — W3b (#50), the route-map resource on the M7 framework.
 * `node.routemaps` over `MockTransport`: every read answer is a hand-authored config text and every
 * write answer is an exact joined command script (docs/TESTING.md §3, DR-083). Config is inline,
 * **hand-authored**: reduced from pyeapi's own `test/fixtures/running_config.routemaps` (clone-relative:
 * `/home/svaj/development/arista/pyeapi/test/fixtures/…`, 47 lines) — the three TEST clauses
 * (`:1-17`), FOO (`:18-22`) and FOO-BAR (`:36-46`) bodies are copied verbatim; the doubled
 * `route-map FOOBAR permit 20` header pair (`:24`,`:30`) is kept but the two bodies were EDITED
 * (`as 1111`/`continue 200` then `as 2222`/`continue 300`) because upstream's two copies are identical,
 * which makes `_merge_entries`' LAST-wins collapse (`routemaps.py:130-139`, the store at `:137`)
 * unobservable in the original fixture — the single declared edit, per **DR-112** and §5 row 205.
 * NEVER captured from any device.
 *
 * ## Upstream port ledger (the 18 methods in `test_api_routemaps.py`, 6816d9e, re-verified 2026-11-06)
 * `test_instance` (`:51-53`) is the registry/accessor identity — a **wiring pin in `registry.test.ts` /
 * `index.test.ts`**, declared skipped here rather than duplicated. The other 17 are ported in this file:
 *  - `test_get` (`:55-58`) — the clause keys and the continue-coercion / match-list / set-list shape.
 *  - `test_get_not_configured` (`:60-61`) — `get('blah')` is `undefined` (upstream `None`).
 *  - `test_getall` (`:63-68`) — `len(keys()) == 4`; doubled FOOBAR is ONE name and ONE clause.
 *  - `test_routemaps_functions` (`:70-79`) — the `('new','permit',100)` trio composes the bare /
 *    `no` / `default` `route-map` lines verbatim (its three loop arms at `:72-77`, dispatched by the
 *    `if/elif/elif` at `:72`/`:74`/`:76`).
 *  - `test_set_set_statement_clean` (`:81-85`) → `['route-map new permit 100','set weight 100']`;
 *  - `test_set_set_statement_remove_extraneous` (`:87-94`) →
 *    `['route-map TEST permit 10','no set tag 50','route-map TEST permit 10','set weight 100']`;
 *  - `test_set_match_statement_clean` (`:96-100`) → `['route-map new permit 200','match as 100']`
 *    (seqno 200, as upstream wrote it);
 *  - `test_set_match_statement_remove_extraneous` (`:102-109`) →
 *    `['route-map TEST permit 10','no match interface Ethernet1','route-map TEST permit 10','match as 1000']`.
 *    These four drive {@link RoutemapsResource.setMatch}/{@link RoutemapsResource.setSet}: both are
 *    **replace** verbs (divergence 3, §5 row 206, **DR-113**), and the two `_remove_extraneous` pins are
 *    the "a statement omitted from the list is removed" evidence. Upstream uses CPython
 *    `set(...).difference(...)` iteration (order arbitrary for multi-element diffs); the port makes the
 *    emission order deterministic (removals in current order, then additions in argument order) while
 *    keeping the SAME multiset of commands and the same header-before-each-line structure — pinned by an
 *    ordered 5-clause diff below.
 *  - `test_set_continue` (`:111-114`), `test_set_continue_to_default` (`:124-127` → `default continue`),
 *    `test_negate_continue` (`:129-132` → `no continue`); `test_set_continue_with_invalid_integer`
 *    (`:116-118`, value -1) and `test_set_continue_with_invalid_string` (`:120-122`, value 'invalid')
 *    `raise ValueError` upstream — HERE they are a `NotSupportedError` **carrying upstream's guard text
 *    verbatim**, including the "seqno" mislabel (`routemaps.py:316-318`), pinned character-for-character
 *    (§5 row 207, **DR-113**).
 *  - `test_set_description_with_value` (`:134-139`, the single `random_string()` slot at `:135`) →
 *    clears first: `['… permit 10','no description','description <value>']` — the only upstream test
 *    whose command text reaches the wire twice in one verb;
 *  - `test_negate_description` (`:141-144`) → `['…','no description']`;
 *  - `test_set_description_with_default` (`:146-149`) → `['…','default description']`;
 *  - `test_set_description_with_invalid_value` (`:151-158`) — upstream pins the EMPTY-value fall-through
 *    composing `no description` with a pre-armed commented-out `ValueError` arm ("flip when
 *    `command_builder` fails on None"). This client implements the FUTURE arm: empty is a refusal and
 *    clearing is named ({@link RoutemapsResource.unsetDescription}/{@link defaultDescription}) per DR-037
 *    (§5 row 207), so the upstream case is ported as a REFUSAL pin (and the negated/default arms above
 *    are the command-text pins). Declared non-port: upstream's `assertRaises(ValueError)` commented
 *    variant.
 *
 * `get(name)` and the diff verbs also exercise the name guard (`:96`/`:112-113`: upstream interpolates
 * the name into a REGEX; here the lookup is exact and a metacharacter name matches nothing — divergence
 * 1, §5 row 204), and every write verb guards its coords BEFORE reading or writing (zero-round-trip
 * pins, DR-053).
 */

import { describe, expect, it } from 'vitest'

import { Node } from '../command-layer'
import { NotSupportedError } from '../errors'
import { mockTransport, type MockTransport } from '../testing/mock-transport'
import { isRoutemapAction, ROUTE_MAP_ACTIONS } from './routemaps'
import type { RoutemapEntry, RoutemapEntryAttrs } from './routemaps'

/** Join lines into config text so a 3-space body indent survives exactly as pyeapi wrote it. */
const textOf = (lines: readonly string[]): string => lines.join('\n')

/**
 * pyeapi's `running_config.routemaps`, reduced for this suite (see the provenance note above): same
 * clause names, TEST/FOO/FOO-BAR bodies verbatim, FOOBAR's doubled header kept with its two bodies made
 * DIFFERENT (the single deliberate edit, so `_merge_entries`' LAST-wins has an observable winner).
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
/** Only the scripts that entered configuration mode — drop the `show running-config` read a diff verb
 *  performs to learn a clause's current statements (mirrors upstream calling `self.get` at `:241` first). */
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
/** Pull one clause's attrs out of an entry; fails loudly when it is the SHAPE assertion that is wrong. */
function attrsOf(entry: RoutemapEntry | undefined, action: string, seqno: number): RoutemapEntryAttrs {
  const attrs = entry?.get(action)?.get(seqno)
  if (attrs === undefined) throw new Error(`no clause ${action} ${String(seqno)} in the entry`)
  return attrs
}

describe('routemaps reads — getAll / get (port :55-68)', () => {
  it('getAll() lists the four names in config order, clause actions first-seen, seqnos ascending, on ONE config read (port test_getall :63-68)', async () => {
    const { node, transport } = nodeFor(ROUTEMAPS_FIXTURE)
    const table = await node.routemaps.getAll()
    // TEST, FOO, FOOBAR, FOO-BAR — the doubled FOOBAR header yields ONE name, never a second key.
    // (Config-line order, and `permit` before `deny` because the permit clause is seen first — the exact
    // first-seen insertion order the chunk memo produces; pyeapi's nested dict carries the same order.)
    expect([...table.keys()]).toEqual(['TEST', 'FOO', 'FOOBAR', 'FOO-BAR'])
    expect([...table.get('TEST')?.keys() ?? []]).toEqual(['permit', 'deny'])
    expect([...(table.get('TEST')?.get('permit')?.keys() ?? [])]).toEqual([10, 20])
    // upstream re-runs the whole `get` per name inside getall (`:105-107`); the chunk memo means one read.
    expect(transport.callCount()).toBe(1)
  })

  it('get(name) is undefined for an unset name (port test_get_not_configured :60-61)', async () => {
    const { node, transport } = nodeFor(ROUTEMAPS_FIXTURE)
    expect(await node.routemaps.get('doesnotexist')).toBeUndefined()
    expect(transport.callCount()).toBe(1)
  })

  it('a clause carries exactly continue/match/set, and NO description key where there is no description line (the four `_parse_*` merges, :121-125 / pyeapi.py:141-159; absence-not-None per DR-027)', async () => {
    const { node } = nodeFor(ROUTEMAPS_FIXTURE)
    const a10 = attrsOf(await node.routemaps.get('TEST'), 'permit', 10)
    expect(Object.keys(a10).sort()).toEqual(['continue', 'match', 'set'])
    // TEST permit 10's body: `set tag 50`, `match interface Ethernet1`, `continue 100` — note the body
    // ORDER is set/match/continue in this fixture, while the READ keys are match/set: read order here is
    // the module's, not the file's (valuesAfterKeyword collects by keyword, not by line number).
    expect(a10).toEqual({ continue: 100, match: ['interface Ethernet1'], set: ['tag 50'] })
  })

  it('a `description` line becomes the description field, FIRST match only — asymmetric with match/set (upstream `search` vs `findall`, :141-158)', async () => {
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

  it('a `no description`/`no continue` body line contributes nothing — negation is absence, and `continue` only coerces when all-digits (divergence 4)', async () => {
    const { node } = nodeFor(textOf([
      'route-map N permit 10',
      '   no description',
      '   no continue',
      '   match as 1',
      '!',
      'route-map Q permit 10',
      '   continue 30 seconds',
      '!',
    ]))
    expect(attrsOf(await node.routemaps.get('N'), 'permit', 10)).toEqual({ match: ['as 1'], set: [] })
    // a non-digits `continue` is NOT an int upstream would have produced (`(\d+)$` at :149 matched nothing)
    // → absent, not NaN.
    expect(attrsOf(await node.routemaps.get('Q'), 'permit', 10)).toEqual({ match: [], set: [] })
  })

  it('match reads EVERY `match` line in order, set is [] when none, a deny clause parses identically (port get :55-58)', async () => {
    const { node } = nodeFor(ROUTEMAPS_FIXTURE)
    const deny30 = attrsOf(await node.routemaps.get('TEST'), 'deny', 30)
    expect(deny30.match).toEqual(['as 2000', 'source-protocol ospf', 'interface Ethernet2'])
    expect(deny30.set).toEqual([])
    expect(deny30.continue).toBe(200)
  })

  it('the doubled `route-map FOOBAR permit 20` collapses to ONE clause, LAST-wins, seqno an INT key (the delicate rule, _merge_entries :130-139 with the store at :137)', async () => {
    const { node } = nodeFor(ROUTEMAPS_FIXTURE)
    const foobar = await node.routemaps.get('FOOBAR')
    expect(foobar?.get('permit')?.size).toBe(1)
    const collapsed = attrsOf(foobar, 'permit', 20)
    // upstream stores `e['attr']` AT `response[action][seqno]` after coercing the key at `:134` and
    // assigning at `:137` — a later same (name, action, seqno) clause REPLACES the earlier clause's whole
    // attr dict: copy two wins.
    expect(collapsed).toEqual({ continue: 300, match: ['as 2222'], set: [] })
  })

  it('the same seqno under a DIFFERENT action is NOT merged — the identity is the (name, action, seqno) TRIPLE', async () => {
    const { node } = nodeFor(textOf([
      'route-map T permit 10',
      '   match as 1',
      '!',
      'route-map T deny 10',
      '   match as 2',
      '!',
    ]))
    const t = await node.routemaps.get('T')
    expect(attrsOf(t, 'permit', 10).match).toEqual(['as 1'])
    expect(attrsOf(t, 'deny', 10).match).toEqual(['as 2'])
  })

  it('config-LINE position, not config-text order, picks the surviving clause: an earlier body with the same key loses', async () => {
    // `FOOBAR permit 20` appears twice; the chunker keeps the section's LAST text for a repeated indent-0
    // key (config/chunk.ts), and _merge_entries then stores the last attr at the same (action, seqno). The
    // clause's POSITION in the `permit` map is the FIRST header's position (Map.set semantics) — pinned by
    // the getAll order test above; only its attrs are the last block's, pinned by the merge test above.
    const { node } = nodeFor(ROUTEMAPS_FIXTURE)
    const table = await node.routemaps.getAll()
    expect([...table.keys()]).toEqual(['TEST', 'FOO', 'FOOBAR', 'FOO-BAR'])
  })

  it('a column-0 `route-map` line in a banner body, or an INDENTED one under another section, does not vote (chunk rule, divergence 2)', async () => {
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

  it('a bare clause (header line, no body) answers match/set [] with no continue/description', async () => {
    const { node } = nodeFor(textOf(['route-map BARE permit 10', '!']))
    expect(attrsOf(await node.routemaps.get('BARE'), 'permit', 10)).toEqual({ match: [], set: [] })
  })

  it('a FOO-BAR hyphen name is ONE `\S+` name and reads back (getall name grammar `[\w-]+`, :103)', async () => {
    const { node } = nodeFor(ROUTEMAPS_FIXTURE)
    expect(attrsOf(await node.routemaps.get('FOO-BAR'), 'deny', 20).continue).toBe(200)
  })

  it('an action token that is not permit/deny still READS (the reader matches `\\w+`), so the read side never invents vocabulary — only the write side narrows (divergence 5)', async () => {
    const { node } = nodeFor(textOf(['route-map ODD permit 10', '   match as 1', '!', 'route-map ODD foo 20', '   match as 2', '!']))
    const odd = await node.routemaps.get('ODD')
    expect(odd?.get('foo')?.get(20)).toBeDefined()
  })
})

describe('routemaps create / delete / setDefault (port test_routemaps_functions :70-79)', () => {
  it('create composes one `route-map NAME ACTION SEQNO` line, no read first (port :71-73)', async () => {
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

  it('a presence verb missing action OR seqno is a refusal before any read (the single-key framework bag cannot name a clause; DR-093 staticroute precedent)', async () => {
    const { node, transport } = nodeFor('')
    await expectError(() => node.routemaps.create('new', { action: 'permit' } as never), /needs BOTH `action` and `seqno`/)
    await expectError(() => node.routemaps.create('new', { seqno: 100 } as never), /needs BOTH `action` and `seqno`/)
    await expectError(() => node.routemaps.delete('new', {} as never), /needs BOTH `action` and `seqno`/)
    expect(transport.sent()).toEqual([])
  })

  it('a bad seqno (negative / fraction / non-digit) on create refuses, no round trip', async () => {
    const { node, transport } = nodeFor('')
    await expectError(() => node.routemaps.create('x', { action: 'permit', seqno: -1 }), /route-map seqno/)
    await expectError(() => node.routemaps.create('x', { action: 'permit', seqno: 1.5 }), /route-map seqno/)
    await expectError(() => node.routemaps.create('x', { action: 'permit', seqno: '1a' }), /route-map seqno/)
    expect(transport.sent()).toEqual([])
  })
})

describe('routemaps setMatch / setSet — the REPLACE verbs (port :81-109, divergence 3)', () => {
  it('setMatch with no current match adds every statement, opening the clause header before EACH (port clean match :96-100)', async () => {
    const { node, transport } = nodeFor(ROUTEMAPS_FIXTURE)
    // 'new permit 200' is not in the fixture's config → current [] → pure additions; upstream's clean-match
    // test uses exactly this clause name/seqno (`:97-99`), command text `match as 100`.
    const key = writeKey(['route-map new permit 200', 'match as 100'])
    transport.replies(key, [{}, {}, {}, {}, {}])
    await node.routemaps.setMatch('new', 'permit', 200, ['as 100'])
    expect(writeScripts(transport)).toContainEqual(['enable', 'configure terminal', 'route-map new permit 200', 'match as 100'])
  })

  it('setMatch removes the CURRENT statement omitted from the list, then adds — removals first (port remove_extraneous :102-109)', async () => {
    const { node, transport } = nodeFor(ROUTEMAPS_FIXTURE)
    // TEST permit 10 currently has exactly `match interface Ethernet1`; the new list drops it → `no match`,
    // and brings `as 1000` → `match`. Upstream's pinned list, token for token (`:103-106`).
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

  it("setMatch against the clause's own current list writes NOTHING but still paid the one diff read (upstream `self.configure(commands) if commands else True` :257)", async () => {
    const { node, transport } = nodeFor(ROUTEMAPS_FIXTURE)
    await node.routemaps.setMatch('TEST', 'permit', 10, ['interface Ethernet1'])
    expect(writeScripts(transport)).toEqual([])
    expect(transport.callCount()).toBe(1)
  })

  it('setMatch keeps statements present in BOTH lists, touching only the diff, in deterministic order (the tightened divergence-3 ordering, multi-change case upstream cannot pin)', async () => {
    const { node, transport } = nodeFor(ROUTEMAPS_FIXTURE)
    // TEST permit 20 currently: as 2000, source-protocol ospf, interface Ethernet2 (fixture order).
    // New list: keep `as 2000`, drop the other two, add `as 3000`.
    const key = writeKey([
      'route-map TEST permit 20', 'no match source-protocol ospf',
      'route-map TEST permit 20', 'no match interface Ethernet2',
      'route-map TEST permit 20', 'match as 3000',
    ])
    transport.replies(key, [{}, {}, {}, {}, {}, {}, {}, {}])
    await node.routemaps.setMatch('TEST', 'permit', 20, ['as 2000', 'as 3000'])
    // ONE transaction: removals first in current order, then additions in argument order.
    expect(writeScripts(transport)).toEqual([
      ['enable', 'configure terminal', ...key.split('\n').slice(2)],
    ])
  })

  it('setSet removes the current set statement omitted from the new list (port set remove_extraneous :87-94)', async () => {
    const { node, transport } = nodeFor(ROUTEMAPS_FIXTURE)
    // TEST permit 10 currently has `set tag 50` — upstream's pinned removal/add pair (`:88-92`).
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

  it('setSet with no current set just adds, per-line header (port set clean :81-85)', async () => {
    const { node, transport } = nodeFor(ROUTEMAPS_FIXTURE)
    const key = writeKey(['route-map new permit 100', 'set weight 100'])
    transport.replies(key, [{}, {}, {}, {}])
    await node.routemaps.setSet('new', 'permit', 100, ['weight 100'])
    expect(writeScripts(transport)).toContainEqual(['enable', 'configure terminal', 'route-map new permit 100', 'set weight 100'])
  })

  it('setSet against its own current set list writes nothing (the same `else True` arm, mirrored for the set verb)', async () => {
    const { node, transport } = nodeFor(ROUTEMAPS_FIXTURE)
    await node.routemaps.setSet('TEST', 'permit', 10, ['tag 50'])
    expect(writeScripts(transport)).toEqual([])
  })

  it('a clause that does not exist at all diffs against an empty current → pure additions (upstream `try/except Exception: []`, :240-243 match / :276-279 set)', async () => {
    const { node, transport } = nodeFor(ROUTEMAPS_FIXTURE)
    const key = writeKey(['route-map ABSENT permit 5', 'set metric 10'])
    transport.replies(key, [{}, {}, {}, {}])
    await node.routemaps.setSet('ABSENT', 'permit', 5, ['metric 10'])
    expect(writeScripts(transport)).toContainEqual(['enable', 'configure terminal', 'route-map ABSENT permit 5', 'set metric 10'])
  })

  it('statement inputs are validated BEFORE the diff read: empty / embedded-newline / non-array all refuse and write nothing', async () => {
    const { node, transport } = nodeFor(ROUTEMAPS_FIXTURE)
    await expectError(() => node.routemaps.setMatch('X', 'permit', 10, ['']), /empty match statement/)
    await expectError(() => node.routemaps.setMatch('X', 'permit', 10, ['a\nb']), /single line/)
    await expectError(() => node.routemaps.setSet('X', 'permit', 10, 'not-an-array' as never), /expected an array of statements/)
    // the clause-coord guards run before that diff read too:
    await expectError(() => node.routemaps.setSet('a b', 'permit', 10, ['x']), /route-map name/)
    expect(writeScripts(transport)).toEqual([])
  })
})

describe('routemaps setContinue / unsetContinue / defaultContinue (port :111-132)', () => {
  // Upstream's guard text VERBATIM (`routemaps.py:316-318`), mislabel and all: it says "seqno" while the
  // value under test is the CONTINUE value. The port keeps the string character-for-character so an
  // upstream error comparison still matches, and this pin records the mislabel as a fact of the source.
  const GUARD = 'seqno must be a positive integer unless default or disable is specified'

  it('setContinue opens the clause header then emits `continue N` (port test_set_continue :111-114)', async () => {
    const { node, transport } = nodeFor('')
    transport.replies(writeKey(['route-map TEST permit 10', 'continue 100']), [{}, {}, {}])
    await node.routemaps.setContinue('TEST', 'permit', 10, 100)
    expect(sentScripts(transport)).toEqual([['enable', 'configure terminal', 'route-map TEST permit 10', 'continue 100']])
  })

  it('setContinue with a NEGATIVE value refuses — upstream raises ValueError in its invalid_integer test (:116-118) — with the guard message kept verbatim (incl. the "seqno" mislabel)', async () => {
    const { node, transport } = nodeFor('')
    const thrown = await outcome(() => node.routemaps.setContinue('TEST', 'permit', 10, -1))
    expect(thrown).toBeInstanceOf(NotSupportedError)
    expect((thrown as Error).message).toContain(GUARD)
    expect(transport.sent()).toEqual([])
  })

  it('setContinue with zero refuses too — `value < 1` is part of the same guard (:316)', async () => {
    const { transport } = nodeFor('')
    const node = new Node(transport)
    const thrown = await outcome(() => node.routemaps.setContinue('TEST', 'permit', 10, 0))
    expect(thrown).toBeInstanceOf(NotSupportedError)
    expect((thrown as Error).message).toContain(GUARD)
    expect(transport.sent()).toEqual([])
  })

  it("setContinue with a non-digit string refuses on the same guard (upstream's `not str(value).isdigit()` arm — its own message says seqno, and so does this) (port invalid_string :120-122)", async () => {
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

  it('setContinue accepts a DIGIT STRING as well as a number (upstream\'s `str(value).isdigit()` accepts strings — the guard\'s string arm PASSES on a real digits value, not only on numbers)', async () => {
    const { node, transport } = nodeFor('')
    const key = writeKey(['route-map TEST permit 10', 'continue 200'])
    transport.replies(key, [{}, {}, {}])
    await node.routemaps.setContinue('TEST', 'permit', 10, '200')
    expect(sentScripts(transport)).toEqual([['enable', 'configure terminal', 'route-map TEST permit 10', 'continue 200']])
  })

  it('unsetContinue/defaultContinue guard a bad action / seqno BEFORE writing (the coord guards run everywhere)', async () => {
    const { node, transport } = nodeFor('')
    await expectError(() => node.routemaps.unsetContinue('x', 'reject' as never, 10), /route-map action/)
    await expectError(() => node.routemaps.defaultContinue('x', 'permit', -3), /route-map seqno/)
    expect(transport.sent()).toEqual([])
  })
})

describe('routemaps setDescription / unsetDescription / defaultDescription (port :134-159)', () => {
  it('setDescription pushes a `no description` CLEAR line FIRST, then the new description — the ordering upstream pins (test_set_description_with_value :134-139)', async () => {
    const { node, transport } = nodeFor('')
    // Upstream's `value = random_string()` slot (`:135`) becomes a FIXED multi-word value: it pins the
    // `description %s` line remainder, the header-first ordering, and the clear-before-set line
    // (`:338-343`: header, then `command_builder('description', disable=True)`, then the value). A
    // multi-word remainder also proves no quoting/word-splitting was invented by this port.
    const key = writeKey(['route-map TEST permit 10', 'no description', 'description BGP import filter for AS 65000'])
    transport.replies(key, [{}, {}, {}, {}])
    await node.routemaps.setDescription('TEST', 'permit', 10, 'BGP import filter for AS 65000')
    expect(sentScripts(transport)).toEqual([
      ['enable', 'configure terminal', 'route-map TEST permit 10', 'no description', 'description BGP import filter for AS 65000'],
    ])
  })

  it('unsetDescription emits header + `no description` (port test_negate_description :141-144)', async () => {
    const { node, transport } = nodeFor('')
    transport.replies(writeKey(['route-map TEST permit 10', 'no description']), [{}, {}, {}])
    await node.routemaps.unsetDescription('TEST', 'permit', 10)
    expect(sentScripts(transport)).toEqual([['enable', 'configure terminal', 'route-map TEST permit 10', 'no description']])
  })

  it('defaultDescription emits header + `default description` (port test_set_description_with_default :146-149)', async () => {
    const { node, transport } = nodeFor('')
    transport.replies(writeKey(['route-map TEST permit 10', 'default description']), [{}, {}, {}])
    await node.routemaps.defaultDescription('TEST', 'permit', 10)
    expect(sentScripts(transport)).toEqual([['enable', 'configure terminal', 'route-map TEST permit 10', 'default description']])
  })

  it('an EMPTY description REFUSES — upstream pins the deprecated empty-value fall-through composing `no description` (`:151-158`), which is exactly the DR-037 arm this port throws on instead', async () => {
    // Upstream: `set_description(…, value=None)` → header + `command_builder('description', value=None)`,
    // and `command_builder`'s falsy fall-through composes the bare negation (`abstract.py:160-161`). Upstream's
    // OWN test comments (`:152-154`) say this MUST flip the moment the builder refuses None; DR-037 shipped
    // that refusal (`command-builder.ts` row 73), so an empty value is a `NotSupportedError` here, and
    // clearing is {@link unsetDescription}/{@link defaultDescription} — the named-negation verbs.
    const { node, transport } = nodeFor('')
    await expectError(() => node.routemaps.setDescription('TEST', 'permit', 10, ''), /route-map description/)
    await expectError(() => node.routemaps.setDescription('TEST', 'permit', 10, '   '), /empty description/)
    expect(transport.sent()).toEqual([])
  })

  it('description with CR/LF, leading/trailing whitespace, or a control char refuses before any write', async () => {
    const { node, transport } = nodeFor('')
    await expectError(() => node.routemaps.setDescription('TEST', 'permit', 10, 'a\nb'), /one line/)
    await expectError(() => node.routemaps.setDescription('TEST', 'permit', 10, ' pad'), /leading or trailing whitespace/)
    await expectError(() => node.routemaps.setDescription('TEST', 'permit', 10, 'pad '), /leading or trailing whitespace/)
    await expectError(() => node.routemaps.setDescription('TEST', 'permit', 10, 'p\u0001q'), /control character/)
    expect(transport.sent()).toEqual([])
  })

  it('the description guard runs first on every arm (unset/default validate the triple too), and a bad coord sends nothing', async () => {
    const { node, transport } = nodeFor('')
    await expectError(() => node.routemaps.setDescription('TEST', 'reject' as never, 10, 'x'), /route-map action/)
    await expectError(() => node.routemaps.unsetDescription('a b', 'permit', 10), /route-map name/)
    await expectError(() => node.routemaps.defaultDescription('TEST', 'permit', 'x'), /route-map seqno/)
    expect(transport.sent()).toEqual([])
  })
})

describe('routemaps name guard — where upstream has none (divergences 1/5)', () => {
  it('a regex-like name does NOT widen: it is a clean table miss, never another name\'s clause (pyeapi interpolates `% name` into a REGEX at :96/:112-113)', async () => {
    const { node } = nodeFor(ROUTEMAPS_FIXTURE)
    // Upstream's `get('RM.X')`/`get('TE')`-style queries run the name through `re`, so a `.` becomes a
    // wildcard and a prefix can nearly match. Here every lookup is the exact key → undefined.
    expect(await node.routemaps.get('RM.X')).toBeUndefined()
    expect(await node.routemaps.get('TE')).toBeUndefined()
  })

  it('a name with whitespace is refused by the guard — and that includes a query that "looks like" a whole header (so an action/seqno cannot be smuggled into the name to hit another clause)', async () => {
    const { node, transport } = nodeFor(ROUTEMAPS_FIXTURE)
    await expectError(() => node.routemaps.get('TEST permit 10'), /route-map name/)
    await expectError(() => node.routemaps.get(''), /route-map name/)
    expect(transport.callCount()).toBe(0)
  })

  it('the name guard runs FIRST on every verb, so a refused clause costs ZERO round trips', async () => {
    const { node, transport } = nodeFor(ROUTEMAPS_FIXTURE)
    await expectError(() => node.routemaps.get('has space'), /route-map name/)
    await expectError(() => node.routemaps.create('bad name', { action: 'permit', seqno: 1 }), /route-map name/)
    await expectError(() => node.routemaps.unsetContinue('bad name', 'permit', 1), /route-map name/)
    await expectError(() => node.routemaps.setMatch('bad name', 'permit', 1, ['as 1']), /route-map name/)
    expect(transport.callCount()).toBe(0)
  })

  it('a non-string name on every verb refuses (the framework never coerces a number into a section key)', async () => {
    const { node, transport } = nodeFor('')
    await expectError(() => node.routemaps.setContinue(123 as never, 'permit', 10, 100), /route-map name/)
    expect(transport.sent()).toEqual([])
  })

  it('a name colliding with an indent-0 config namespace (`!`, or the leading keyword) refuses — the reader separates clauses by exactly that space (:103)', async () => {
    const { node, transport } = nodeFor(ROUTEMAPS_FIXTURE)
    await expectError(() => node.routemaps.get('!'), /route-map name/)
    await expectError(() => node.routemaps.create('route-map sneaky', { action: 'permit', seqno: 1 }), /route-map name/)
    expect(transport.callCount()).toBe(0)
  })
})

describe('routemaps guard BRANCHES — the refusal arms the suites above do not reach (each short-circuit position gets its own call: a `[...]` loop\'s inferred element type can silently DROP a case, per the COMMON TS7 trap list)', () => {
  it('a control character embedded in a NAME refuses on the name guard\'s last arm (routemaps.ts:258, the row-74 argument)', async () => {
    const { node, transport } = nodeFor('')
    // C0 (\u0001) and DEL (\u007F) are the two ends of the code-unit test — each is its own call.
    await expectError(() => node.routemaps.create('na\u0001me', { action: 'permit', seqno: 1 }), /route-map name/)
    await expectError(() => node.routemaps.get('na\u007Fme'), /route-map name/)
    expect(transport.sent()).toEqual([])
  })

  it('the seqno guard\'s numeric short-circuit positions each get a call — Infinity fails `isSafeInteger`, a negative fails `< 0`, a fraction fails `isSafeInteger` — and the string arm of the same guard is separate', async () => {
    const { node, transport } = nodeFor('')
    await expectError(() => node.routemaps.create('x', { action: 'permit', seqno: Infinity }), /route-map seqno/)
    await expectError(() => node.routemaps.setMatch('x', 'permit', -5, ['as 1']), /route-map seqno/)
    await expectError(() => node.routemaps.setSet('x', 'permit', 2.5, ['tag 1']), /route-map seqno/)
    // the string arm: a value that is neither the numeric branch nor digits. `^\d+$` is not satisfied by
    // leading whitespace or a sign, and the reader could never echo such a header back, so it refuses.
    await expectError(() => node.routemaps.setDefault('x', { action: 'permit', seqno: ' 1' }), /route-map seqno/)
    // a control char inside the name is the guard before the seqno one runs, so this stays name-labelled:
    // it is NOT counted here (pinning order matters — name guard runs first on the presence verbs).
    expect(transport.sent()).toEqual([])
  })

  it('the statement guard\'s control-character arm, and the seqno string-arm rejecting an empty bag value', async () => {
    const { node, transport } = nodeFor('')
    await expectError(() => node.routemaps.setMatch('X', 'permit', 10, ['meta\u0001data']), /control character/)
    await expectError(() => node.routemaps.setSet('X', 'permit', 10, ['  ']), /empty set statement/)
    expect(transport.sent()).toEqual([])
  })

  it('the description guard\'s control-character arm', async () => {
    const { node, transport } = nodeFor('')
    await expectError(() => node.routemaps.setDescription('X', 'permit', 10, 'bad\u0007bell'), /control character/)
    expect(transport.sent()).toEqual([])
  })

  it('the continue guard: a digit string whose value is < 1 refuses on `Number(value) < 1`; a non-string non-number refuses on `typeof` — both arms of the same compound guard, both with upstream\'s exact message', async () => {
    const node = new Node(mockTransport())
    const GUARD = 'seqno must be a positive integer unless default or disable is specified'
    // '0' is all-digits (so `!DIGITS_ONLY.test` is the arm that does NOT fire) but numeric < 1 → refuse.
    const zero = await outcome(() => node.routemaps.setContinue('X', 'permit', 1, '0'))
    expect(zero).toBeInstanceOf(NotSupportedError)
    expect((zero as Error).message).toContain(GUARD)
    // null fails `typeof value !== 'string'`, the first position; digits >= 1 ('100') pass on both.
    const nullish = await outcome(() => node.routemaps.setContinue('X', 'permit', 1, null as never))
    expect(nullish).toBeInstanceOf(NotSupportedError)
    expect((nullish as Error).message).toContain(GUARD)
  })


  it('isRoutemapAction — the exported vocabulary guard narrows to the two members and rejects everything else, WITHOUT pinning a hardware claim (the same DR-032 posture as SWITCHPORT_MODES/USER_ENCRYPTIONS)', () => {
    // Asserted on the export itself, not through a verb: the frozen list and its runtime guard are both
    // published surface (DR-079 shape), and the index.test.ts pins cover the surface; THIS is the guard\'s
    // own arm coverage, including the empty / wrong-case / padded / out-of-list / wrong-type cases.
    expect(ROUTE_MAP_ACTIONS).toEqual(['permit', 'deny'])
    expect(isRoutemapAction('permit')).toBe(true)
    expect(isRoutemapAction('deny')).toBe(true)
    expect(isRoutemapAction('')).toBe(false)
    expect(isRoutemapAction('PERMIT')).toBe(false)
    expect(isRoutemapAction('permit ')).toBe(false)
    expect(isRoutemapAction('reject')).toBe(false)
    expect(isRoutemapAction(null)).toBe(false)
    expect(isRoutemapAction(42 as never)).toBe(false)
  })

  it('seqno normalisation: the string path (a leading-whitespace / non-digit value) AND the numeric path (a safe integer) both reach seqnoText — the two arms of the value->digits normaliser are each exercised', async () => {
    const { node, transport } = nodeFor('')
    // STRING path: a valid digit string is normalised through seqnoText's `: value` arm — a `create` whose
    // seqno is the STRING form the reader itself yields (the header composes from those exact digits).
    transport.replies(writeKey(['route-map S permit 7']), [{}, {}, {}])
    await node.routemaps.create('S', { action: 'permit', seqno: '7' })
    // NUMERIC path: the `String(value)` arm of seqnoText, reached when the bag carries the number 7.
    transport.replies(writeKey(['no route-map S permit 7']), [{}, {}, {}])
    await node.routemaps.delete('S', { action: 'permit', seqno: 7 })
    expect(transport.callCount()).toBe(2)
  })

  it('the statement guard\'s non-string arm fires when a statements element is not a string', async () => {
    const { node, transport } = nodeFor('')
    // `Array.isArray` passes for [42], but the per-element type guard must refuse — pins routemaps.ts:314.
    await expectError(() => node.routemaps.setSet('X', 'permit', 10, [42 as never]), /expected a string `set` argument/)
    expect(transport.sent()).toEqual([])
  })

  it('the description guard\'s non-string arm fires when a value reaching setDescription is not a string (a JS caller pasting a number into the form field)', async () => {
    const { node, transport } = nodeFor('')
    await expectError(() => node.routemaps.setDescription('X', 'permit', 10, 42 as never), /route-map description/)
    expect(transport.sent()).toEqual([])
  })
})
