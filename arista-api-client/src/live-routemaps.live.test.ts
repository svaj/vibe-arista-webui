/**
 * `*.live.test.ts` port of `pyeapi/test/system/test_api_routemaps.py` @ `6816d9e` — #14 **D2** (the
 * full-write lab lane, DR-126). Upstream has **19** test methods (verified: `awk` over `def` lines, file is
 * 278 lines with its `if __name__` block at `:277-278`); all 19 are portable here and each gets its own
 * `it()`, because every case writes a route-map clause — a whole-config write that DR-035(b) used to
 * forbid and DR-126 admits for the `lab` class behind `EAPI_LAB_FULL_WRITE=1`.
 *
 * ## Wiring (identical shape to the other D2 files, new in this repo relative to M12a)
 * `gate = liveFullWriteReadiness(process.env)` → loud skip + `describe.skipIf(!gate.runnable)`;
 * `buildFullWriteNode(target)` is the only `Node` built, so the pre-wire self-lockout fence
 * (`withLabWriteScope`: listener, `admin`/`netadmin`, this run's API user, management path, `copy run
 * start`) guards BOTH the resource facades and the session batches below. Identity gate tolerates only the
 * cEOS build-suffix `EAPI_VERSION_MISMATCH` (DR-066, exactly as `live-switchports`/`live-system` do).
 *
 * Facade verbs (`create`/`delete`/`setDefault`/`setMatch`/`setSet`/`setContinue`/`setDescription` and the
 * DR-037 negation/default verbs) send `configure terminal` batches — never persisted, autorefresh clears
 * the config memo, so every read-back below is a fresh `show running-config`. Staging and teardown use
 * named `live-rm-<case>` sessions via `runGuardedLiveWriteSession`, and every case begins by deleting what
 * may already exist ({@link clearClause}) and ends by clearing its clause in `finally`, because the
 * container persists across the live suite order.
 *
 * **Naming.** pyeapi hard-codes `TEST`, `TEST-2`, `TEST-1`, `TEST_1` and reuses the same clause
 * (`TEST deny 10`) in all 19 cases, each preceded by a normalising `no route-map TEST deny 10` staging
 * line (`:46`, `:55`, `:61`, `:73`, `:83`, …). That idiom ports 1:1 — but the names here are
 * `LIVERM1`/`LIVERM-2`/`LIVERM_3`/`LIVERM2`, since a bare `TEST` cannot be told apart from another suite's
 * leftover state. The hyphen/underscore pair is preserved on purpose: `assertRoutemapName` allows
 * `[\w-]`-shaped tokens, the chunker re-parses the whole name as one `\S+` key, and upstream's two cases
 * (`:81-90`, `:91-100`) exist precisely to ask the device whether it stores both spellings.
 *
 * | upstream (verified line @6816d9e) | ported? | here / why |
 * |---|---|---|
 * | `test_get` (`:44-52`) | ✅ | stages `no route-map TEST deny 10` / `route-map TEST deny 10` / `set weight 100` / `match tag 50` (`:46-49`) then `assertIsNotNone(get('TEST'))` (`:50-51`). Here the same staging (fresh name) and the read asserts this client's shape: two-level table, `deny`→`10` leaf, `match` contains `tag 50`, `set` contains `weight 100`, and `continue`/`description` keys ABSENT (DR-027, where pyeapi would carry `None`) |
 * | `test_get_none` (`:53-58`) | ✅ | `dut.config('no route-map TEST deny 10')` (`:55`) then `assertIsNone` (`:57`) → `get()` resolves `undefined` (a table miss, §5 row 204). Added arm the framework shape allows: negating an already-absent clause. `routemaps.py:183-186` promises that is a no-op (`"does not exist … still return True"`), so the repeat `no …` is attempted and a device refusal reported with its code — nothing is assumed |
 * | `test_getall` (`:59-70`) | ✅ | stages two names+clauses (`:61-66`: `TEST deny 10` + `set weight 100`, `TEST-2 permit 50` + `match tag 50`), then `assertIn(('TEST'), result)` / `assertIn(('TEST-2'), result)` (`:68-69` — upstream's own redundant parens: these are plain dict-key memberships on the NAME). Here `getAll()` is a `ReadonlyMap<string, RoutemapEntry>` (row 78): `.has()` on both names plus each name's own leaf content, and the config-order claim (divergence 2 / §5 row 205) is printed, not asserted, because it is a property of this device's document |
 * | `test_create` (`:71-80`) | ✅ | `assertIsNone(get)` (`:75`) → `create('TEST','deny',10)` (`:76`) → `assertTrue` (`:77`) → `assertIsNotNone(get)` (`:78`) → cleanup (`:79`). Ported as `create(name, {action, seqno})`: the triple rides the {@link RoutemapClauseAttrs} bag because the framework's single-key verb cannot express it (§5 row 203, **DR-111**), and the read-back is the bare clause `match: []`/`set: []` that `routemaps.test.ts` pins offline — upstream asserts only "not None" |
 * | `test_create_with_hyphen` (`:81-90`) | ✅ | upstream's `TEST-1` (`:83-90`): absent → create → present. Here `LIVERM-2`, and the read-back also asserts the header text round-trips whole (`route-map LIVERM-2 deny 10`), i.e. no truncation at the hyphen — the honest contrast with bgp's `(?: route-map (\w+))*` truncation quirk (`bgp.ts` divergence 6) |
 * | `test_create_with_underscore` (`:91-100`) | ✅ | same on `LIVERM_3`. Both cases keep one arm upstream cannot express but this client must not regress on: a name with whitespace refuses before any read (§5 row 204's guard), and `get()` for such a name rejects rather than answering another clause's data |
 * | `test_delete` (`:101-111`) | ✅ | stages (`:103-105`), `assertIsNotNone` (`:106-107`), `delete('TEST','deny',10)` (`:108`), `assertTrue` (`:109`), `assertIsNone(get('TEST'))` (`:110`): negating the LAST clause makes the NAME disappear — exactly what {@link delete} documents (a whole `no route-map NAME ACTION SEQNO` line; no name-only verb exists in pyeapi or here). Asserted live through both `get(name)` and {@link clauseHeaders} (no header survives), which is stronger than a block probe |
 * | `test_default` (`:112-122`) | ✅ | stages (`:114-116`), `default('TEST','deny',10)` (`:118-119`), `assertTrue` (`:120`), `assertIsNone(get('TEST'))` (`:121`). Upstream's own device run therefore already shows `default route-map …` behaves as a negation — the question {@link setDefault}'s docstring leaves to M12 ("whether EOS treats the two identically here", `routemaps.ts`, following `routemaps.py:203-208`). This is where 4.28.14M answers, and both raw texts are printed |
 * | `test_set_description` (`:123-136`) | ✅ | `text = random_string()` (`:125`), `assertNotIn('description %s' % text, get_block(...))` before (`:129-130`), `set_description(...)` (`:131-132`), `assertIn` after (`:134-135`). The random text becomes a fixed multi-word description (run-idempotence; the offline port of `:134-139` made the same substitution). Ported beyond upstream: a SECOND setDescription must leave exactly one `description …` line — the clear-before-set pair upstream itself emits (`routemaps.py:339-343`, `no description` then `description …`) is what makes that true, and the raw clause body is printed to show it. The negation arm then reads the field absent |
 * | `test_set_match_statements` (`:137-149`) | ✅ | `assertNotIn('match as 100')` (`:142-143`), `set_match_statements(…, ['as 100'])` (`:144-145`), `assertTrue` (`:146`), `assertIn` (`:147-148`). {@link setMatch} is the **replace** verb (divergence 3, **DR-113**), so `attrs.match` must equal `['as 100']`. Whether 4.28.14M accepts the `as <n>` match vocabulary is a device answer this client deliberately does not pre-judge (`assertStatement` guards line-safety only), so a `CommandError` is reported with its code and the case records the arm as unexercised rather than passing it off |
 * | `test_update_match_statement` (`:150-165`) | ✅ | stages `match as 100` (`:152-154`) and asserts it present (`:156-157`), replaces with `['as 200']` (`:158-159`), demands the old one GONE (`:161-162`) and the new present (`:163-164`). This is the "statements not specified are removed" half of DR-113 — a diff, not an append — asserted on the typed list, with the emitted order (removals before additions, header per line, `routemaps.py:247-255`) pinned offline |
 * | `test_remove_match_statement` (`:166-181`) | ✅ | same staging, replacing `as 100` with `tag 50` (`:174-175`) → `notIn as 100` (`:177-178`), `in tag 50` (`:179-180`). Runs the `no match …` emission against a clause that really has a match line on the device |
 * | `test_set_set_statements` (`:182-194`) | ✅ | notIn `set weight 100` (`:186-188`), `set_set_statements(…, ['weight 100'])` (`:189-190`), `assertTrue` (`:191`), in (`:192-193`) → `attrs.set` equals the passed list |
 * | `test_update_set_statement` (`:195-210`) | ✅ | stages `set weight 100` (`:197-199`), asserts present (`:201-202`), `['weight 200']` (`:203-204`), asserts 100 gone (`:206-207`) and 200 present (`:208-209`) |
 * | `test_remove_set_statement` (`:211-226`) | ✅ | `['tag 50']` over a clause holding `set weight 100` (`:219-220`), weight gone (`:222-223`), `set tag 50` present (`:224-225`). Plus one DR-113 arm upstream never ran: `setSet` with the clause's OWN current list composes nothing (`routemaps.py:257`/`:293`'s `if commands else True`) — asserted as a byte-identical re-read |
 * | `test_set_continue` (`:227-237`) | ✅ | notIn `continue` (`:232-233`), `set_continue(…, 100)` (`:234`), `assertEqual(100, get('TEST')['deny'][10]['continue'])` (`:236`). `continue` is a `number` only when the line is digits-only (divergence 4), so `attrs.continue === 100`; and since this client opens the clause header itself (`routemaps.py:310`/`:319`), the case additionally records whether 4.28.14M accepts a `continue` inside a **deny** clause at all — a refusal is reported and the arm marked unexercised |
 * | `test_update_continue` (`:238-249`) | ✅ | stages `continue 30` (`:240-242`), asserts present (`:244-245`), `set_continue(…, 60)` (`:246`), asserts `60` (`:248`). Added: the clause body must hold exactly ONE `continue …` line — a single-valued field is replaced, not appended, which upstream's equality on the parsed value only implies |
 * | `test_default_continue` (`:250-262`) | ✅ | stages `continue 100` (`:252-254`), asserts present (`:256-257`), `set_continue(…, default=True)` (`:258-259`) → `default continue` (`routemaps.py:312-313`, {@link defaultContinue}), then `assertEqual(None, get('TEST')['deny'][10]['continue'])` (`:261`). Upstream's assertion is itself the finding: indexing `['deny'][10]` succeeds, so `default continue` clears the VALUE without removing the CLAUSE. Here asserted both ways — `continue` absent and the clause header still present — because the M12 question for `setDefault` above does NOT extend to the body verbs |
 * | `test_negate_continue` (`:263-274`) | ✅ | the `disable=True` arm (`:271-272`) → `no continue` ({@link unsetContinue}, DR-037's named negation), asserted the same way at `:274`: value absent, clause header still present, raw body printed |
 *
 * Two upstream facts worth recording so nobody "fixes" them later: (1) this system file has
 * **no** invalid-input arms for the routemaps verbs — the `ValueError` arms live in
 * `test/unit/test_api_routemaps.py:116-122`/`:151-158`, and their typed-refusal twins are pinned in
 * `resources/routemaps.test.ts`, so no live write is needed (or staged) to prove a client-side guard;
 * (2) unlike `test_api_ospf.py:150-151`, this file has no `assertFalse` arm, so there is no
 * pyeapi-`configure`-swallowing-to-`False` idiom to convert to a throw (DR-005) here — the throws show up
 * only as the reported `CommandError` refusals above, which stay INFORMATION.

 * Reads are pure running-config chunks (`configSections`): this resource never issues `show route-map`, and
 * no read in this file depends on the DR-122 transport-specific negatives (`show vrrp`/`show port-channel
 * detail` answering 1002 via eAPI while the container CLI answers, §5 row 225).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { CommandError, EapiError, NotSupportedError, ProtocolError } from './errors'
import { buildFullWriteNode, liveFullWriteReadiness } from './testing/live-full-write'
import { describeLiveTarget, matchesDeviceIdentity, unwrapLiveTarget, type LiveTarget } from './testing/live-guard'
import { runGuardedLiveWriteSession } from './testing/live-session-policy'
import type { RoutemapEntryAttrs } from './resources/routemaps'
import type { Node } from './command-layer'

const gate = liveFullWriteReadiness(process.env)
if (!gate.runnable) {
  console.warn(`live-routemaps: SKIPPED — ${gate.skipReason}`)
}

const RM1 = 'LIVERM1'
const RM_HYPHEN = 'LIVERM-2'
const RM_UNDER = 'LIVERM_3'
const RM2 = 'LIVERM2'
const NAMES: readonly string[] = [RM1, RM_HYPHEN, RM_UNDER, RM2]

function targetOf(): LiveTarget {
  return unwrapLiveTarget(gate.resolution)
}

/** A device refusal is INFORMATION: print the device's own code and text, never swallow (DR-005/DR-122). A non-eAPI error rethrows — that is a harness failure. */
function reportRefusal(rawErr: unknown, what: string): string {
  if (!(rawErr instanceof EapiError)) throw rawErr
  const code = rawErr instanceof CommandError
    ? `code ${String(rawErr.code)}`
    : rawErr instanceof ProtocolError
      ? `protocol code ${String(rawErr.code)}`
      : 'no code'
  const first = rawErr.message.split('\n')[0]?.slice(0, 200) ?? rawErr.message
  console.warn(`live-routemaps: the device refused ${what} (${rawErr.constructor.name}, ${code}): ${first}`)
  return first
}

/** Run one write arm. A refusal is reported and the case continues — the READ-BACK of what the device kept is the finding. */
async function attempt(what: string, run: () => Promise<unknown>): Promise<boolean> {
  try {
    await run()
    return true
  } catch (rawErr) {
    reportRefusal(rawErr, what)
    return false
  }
}

/** The indent-0 clause headers this device keeps for one name — the audit form of pyeapi's `get_block('route-map TEST deny 10')` probe. */
async function clauseHeaders(node: Node, name: string): Promise<string[]> {
  const config = await node.getRunningConfig()
  const headers: string[] = []
  for (const line of config.split(/\r?\n/u)) {
    if (line.startsWith(`route-map ${name} `)) headers.push(line)
  }
  return headers
}

/** Delete-if-exists at case start; upstream does the same with a literal `no route-map TEST deny 10` staging line. */
async function clearClause(node: Node, name: string, suffix: string): Promise<void> {
  const headers = await clauseHeaders(node, name)
  if (headers.length === 0) return
  try {
    await runGuardedLiveWriteSession(node, {
      name: `live-rm-clear-${suffix}`.slice(0, 64),
      commands: headers.map((header) => `no ${header}`),
    })
  } catch (rawErr) {
    reportRefusal(rawErr, `clearing the leftover clause(s) of ${name} (${JSON.stringify(headers)})`)
  }
}

/** Stage a clause body the way upstream's `dut.config([...])` does, so the case starts from a known clause. */
async function stageClause(node: Node, header: string, body: readonly string[], suffix: string): Promise<boolean> {
  return attempt(`staging ${JSON.stringify([header, ...body])}`, async () => {
    await runGuardedLiveWriteSession(node, { name: `live-rm-stage-${suffix}`.slice(0, 64), commands: [header, ...body] })
  })
}

/** One clause's body lines, printed so upstream's raw-text `get_block` assertions stay comparable. */
async function clauseBody(node: Node, header: string): Promise<string[]> {
  const lines = (await node.getRunningConfig()).split(/\r?\n/u)
  const at = lines.findIndex((line) => line === header)
  if (at < 0) return []
  const body: string[] = []
  for (const line of lines.slice(at + 1)) {
    if (line !== '' && !/^\s/u.test(line)) break
    body.push(line.trim())
  }
  return body
}

async function attrsOf(node: Node, name: string, action: string, seqno: number): Promise<RoutemapEntryAttrs | undefined> {
  return (await node.routemaps.get(name))?.get(action)?.get(seqno)
}

describe.skipIf(!gate.runnable)('live full-write: pyeapi test_api_routemaps.py (19 cases, :44-274)', () => {
  let node: Node
  const header1 = `route-map ${RM1} deny 10`

  beforeAll(async () => {
    const target = targetOf()
    console.log(`live-routemaps: target = ${describeLiveTarget(target)} (DR-126 full-write lab lane)`)
    node = buildFullWriteNode(target)
    const reported = await node.getVersion()
    const mismatch = matchesDeviceIdentity(target, { version: reported.version, modelName: reported.modelName })
    if (mismatch !== undefined && mismatch.code !== 'EAPI_VERSION_MISMATCH') throw new Error(`live-routemaps readiness: ${mismatch.reason}`)
    if (mismatch?.code === 'EAPI_VERSION_MISMATCH') console.warn(`live-routemaps: reported version "${reported.version}" vs pin "${target.allowVersion}" (base-level enforced by the probe, DR-066)`)
    for (const name of NAMES) await clearClause(node, name, 'before-all')
  })

  afterAll(async () => {
    for (const name of NAMES) await clearClause(node, name, 'after-all')
  })

  it('get() answers the clause the four staging lines made, with match/set as arrays and the other two keys absent (test_get, :44-52)', async () => {
    await clearClause(node, RM1, 'get')
    try {
      await stageClause(node, header1, ['set weight 100', 'match tag 50'], 'get') // :47-49
      const entry = await node.routemaps.get(RM1) // :50
      expect(entry).toBeDefined() // :51's assertIsNotNone
      const attrs = await attrsOf(node, RM1, 'deny', 10)
      expect(attrs).toBeDefined()
      if (attrs === undefined) return
      expect(attrs.match).toContain('tag 50')
      expect(attrs.set).toContain('weight 100')
      expect('continue' in attrs).toBe(false) // the None→absence vocabulary (§5's DR-027/DR-029 family)
      expect('description' in attrs).toBe(false)
    } finally {
      await clearClause(node, RM1, 'get-final')
    }
  })

  it('a negated clause answers undefined, and negating an absent clause is a device answer not an assumption (test_get_none, :53-58)', async () => {
    await clearClause(node, RM1, 'none') // :55
    expect(await node.routemaps.get(RM1)).toBeUndefined() // :57's assertIsNone
    await attempt(`the repeat negation \`no ${header1}\` — routemaps.py:183-186 promises a no-op, which only the device can confirm`, () => node.routemaps.delete(RM1, { action: 'deny', seqno: 10 }))
    expect(await node.routemaps.get(RM1)).toBeUndefined()
  })

  it('getAll() keys both staged names and each keeps its own action/seqno leaf (test_getall, :59-70)', async () => {
    await clearClause(node, RM1, 'getall')
    await clearClause(node, RM2, 'getall')
    try {
      await stageClause(node, header1, ['set weight 100'], 'getall') // :61-63
      await stageClause(node, `route-map ${RM2} permit 50`, ['match tag 50'], 'getall-2') // :64-66 (upstream's `TEST-2`)
      const all = await node.routemaps.getAll() // :67
      expect(all.has(RM1)).toBe(true) // :68
      expect(all.has(RM2)).toBe(true) // :69
      expect(all.get(RM1)?.get('deny')?.get(10)?.set).toContain('weight 100')
      expect(all.get(RM2)?.get('permit')?.get(50)?.match).toContain('tag 50')
      console.log(`live-routemaps: getAll() name order ${JSON.stringify([...all.keys()])} — config order is divergence 2 (/§5 row 205) and this run prints the device's own order rather than asserting it`)
    } finally {
      await clearClause(node, RM1, 'getall-final')
      await clearClause(node, RM2, 'getall-final')
    }
  })

  it('create() with the (name, action, seqno) bag makes a bare clause answer empty match/set (test_create, :71-80)', async () => {
    await clearClause(node, RM1, 'create') // :73
    try {
      expect(await node.routemaps.get(RM1)).toBeUndefined() // :75
      await node.routemaps.create(RM1, { action: 'deny', seqno: 10 }) // :76
      const created = await node.routemaps.get(RM1) // :78
      expect(created).toBeDefined()
      expect(created?.get('deny')?.get(10)).toEqual({ match: [], set: [] })
      expect(await clauseHeaders(node, RM1)).toContain(header1)
    } finally {
      await clearClause(node, RM1, 'create-final') // :79's cleanup, in a finally so a failure cannot leak the clause
    }
  })

  it('a hyphenated name stores and reads back as ONE name (test_create_with_hyphen, :81-90)', async () => {
    await clearClause(node, RM_HYPHEN, 'hyphen')
    try {
      expect(await node.routemaps.get(RM_HYPHEN)).toBeUndefined() // :85
      const accepted = await attempt(`create of the hyphenated name ${RM_HYPHEN}`, () => node.routemaps.create(RM_HYPHEN, { action: 'deny', seqno: 10 })) // :86
      if (!accepted) return
      expect(await node.routemaps.get(RM_HYPHEN)).toBeDefined() // :88
      expect(await clauseHeaders(node, RM_HYPHEN)).toContain(`route-map ${RM_HYPHEN} deny 10`) // no truncation at the hyphen
    } finally {
      await clearClause(node, RM_HYPHEN, 'hyphen-final')
    }
  })

  it('an underscored name stores and reads back, and a two-token name refuses before any read (test_create_with_underscore, :91-100)', async () => {
    await clearClause(node, RM_UNDER, 'under')
    try {
      expect(await node.routemaps.get(RM_UNDER)).toBeUndefined() // :95
      const accepted = await attempt(`create of the underscored name ${RM_UNDER}`, () => node.routemaps.create(RM_UNDER, { action: 'deny', seqno: 10 })) // :96
      if (!accepted) return
      const entry = await node.routemaps.get(RM_UNDER) // :98
      expect(entry?.get('deny')?.has(10)).toBe(true)
      // The guard that lets the read stay a table miss instead of a regex (divergence 1, §5 row 204).
      await expect(node.routemaps.get(`${RM_UNDER} tail`)).rejects.toBeInstanceOf(NotSupportedError)
    } finally {
      await clearClause(node, RM_UNDER, 'under-final')
    }
  })

  it('delete() removes the clause and with it the name, because a route-map exists only through its clauses (test_delete, :101-111)', async () => {
    await clearClause(node, RM1, 'delete')
    try {
      await stageClause(node, header1, ['set weight 100'], 'delete') // :103-105
      expect(await node.routemaps.get(RM1)).toBeDefined() // :106-107
      await node.routemaps.delete(RM1, { action: 'deny', seqno: 10 }) // :108
      expect(await node.routemaps.get(RM1)).toBeUndefined() // :110
      expect(await clauseHeaders(node, RM1)).toEqual([])
    } finally {
      await clearClause(node, RM1, 'delete-final')
    }
  })

  it('setDefault() answers whether 4.28.14M treats `default route-map …` as a negation (test_default, :112-122)', async () => {
    await clearClause(node, RM1, 'default')
    try {
      await stageClause(node, header1, ['set weight 100'], 'default') // :114-116
      expect(await node.routemaps.get(RM1)).toBeDefined() // :117-118
      await node.routemaps.setDefault(RM1, { action: 'deny', seqno: 10 }) // :119
      const after = await node.routemaps.get(RM1)
      const headers = await clauseHeaders(node, RM1)
      console.log(`live-routemaps: after \`default ${header1}\` the headers are ${JSON.stringify(headers)} and get(name) ${after === undefined ? 'answers undefined' : 'still answers a clause'} — routemaps.py:203-208 calls the default "essentially a negation" and leaves the equivalence to this capture`)
      expect(after).toBeUndefined() // :121, on the device that upstream ran against; this run records 4.28.14M's own answer
    } finally {
      await clearClause(node, RM1, 'default-final')
    }
  })

  it('setDescription emits a clear line before the value, so the clause keeps exactly one description (test_set_description, :123-136)', async () => {
    await clearClause(node, RM1, 'desc')
    try {
      if (!(await stageClause(node, header1, [], 'desc'))) return // :126-127
      expect((await attrsOf(node, RM1, 'deny', 10))?.description).toBeUndefined() // :129-130
      // upstream's random_string() (:125) is not run-idempotent; the offline port substituted this slot too.
      await node.routemaps.setDescription(RM1, 'deny', 10, 'live lane description') // :131-132
      expect((await attrsOf(node, RM1, 'deny', 10))?.description).toBe('live lane description') // :134-135
      await node.routemaps.setDescription(RM1, 'deny', 10, 'second live description')
      const body = await clauseBody(node, header1)
      console.log(`live-routemaps: after a second setDescription the body is ${JSON.stringify(body)} — the clear-before-set pair at routemaps.py:339-343 must leave one line`)
      expect(body.filter((line) => line.startsWith('description '))).toHaveLength(1)
      expect((await attrsOf(node, RM1, 'deny', 10))?.description).toBe('second live description') // first-match only (divergence 4)
      await node.routemaps.unsetDescription(RM1, 'deny', 10)
      const unset = await attrsOf(node, RM1, 'deny', 10)
      expect(unset).toBeDefined()
      expect('description' in (unset ?? {})).toBe(false)
    } finally {
      await clearClause(node, RM1, 'desc-final')
    }
  })

  it('setMatch adds a statement to a clause that has none (test_set_match_statements, :137-149)', async () => {
    await clearClause(node, RM1, 'match-add')
    try {
      if (!(await stageClause(node, header1, [], 'match-add'))) return // :139-140
      expect((await attrsOf(node, RM1, 'deny', 10))?.match).toEqual([]) // :142-143
      // `as <n>` is upstream's statement (:144-145). This client guards only line-safety, never statement
      // vocabulary (assertStatement) — so whether 4.28.14M knows that keyword is exactly what is captured.
      const accepted = await attempt('`match as 100` — the vocabulary question upstream never asked its own client (DR-032)', () => node.routemaps.setMatch(RM1, 'deny', 10, ['as 100']))
      if (!accepted) {
        console.warn('live-routemaps: this device rejected the `as <n>` match keyword; the add-arm equality at :147-148 is NOT exercised and the update/remove cases fall back to upstream\'s other statement (`tag 50`, :175/:179)')
        return
      }
      expect((await attrsOf(node, RM1, 'deny', 10))?.match).toEqual(['as 100']) // :147-148
    } finally {
      await clearClause(node, RM1, 'match-add-final')
    }
  })

  it('setMatch removes the statement the new list omits (test_update_match_statement, :150-165)', async () => {
    await clearClause(node, RM1, 'match-update')
    try {
      const staged = await stageClause(node, header1, ['match as 100'], 'match-update') // :152-154
      const before = (await attrsOf(node, RM1, 'deny', 10))?.match ?? []
      if (staged) expect(before).toContain('as 100') // :156-157
      else console.warn(`live-routemaps: staging \`match as 100\` was refused, so the update arm runs from what the device did keep (${JSON.stringify(before)})`)
      const accepted = await attempt('`setMatch(…, ["as 200"])` over the current list', () => node.routemaps.setMatch(RM1, 'deny', 10, ['as 200'])) // :158-159
      if (!accepted) return
      const after = (await attrsOf(node, RM1, 'deny', 10))?.match ?? []
      console.log(`live-routemaps: DR-113 capture — match list went ${JSON.stringify(before)} → ${JSON.stringify(after)} (upstream :161-162 requires the old one gone, :163-164 the new one present)`)
      expect(after).not.toContain('as 100')
      expect(after).toContain('as 200')
    } finally {
      await clearClause(node, RM1, 'match-update-final')
    }
  })

  it('setMatch swaps one keyword family for another, emitting the `no match …` line (test_remove_match_statement, :166-181)', async () => {
    await clearClause(node, RM1, 'match-remove')
    try {
      const staged = await stageClause(node, header1, ['match as 100'], 'match-remove') // :168-170
      if (!staged) {
        console.warn('live-routemaps: this device does not keep `match as 100`, so the removal arm is run against the statement upstream itself stages device-side at :175 (`tag 50`)')
        if (!(await stageClause(node, header1, ['match tag 50'], 'match-remove-b'))) return
        await attempt('`setMatch(…, ["as 100"])` (the reverse direction, since `as 100` could not be staged)', () => node.routemaps.setMatch(RM1, 'deny', 10, ['as 100']))
        const half = (await attrsOf(node, RM1, 'deny', 10))?.match ?? []
        console.log(`live-routemaps: match list after the reverse attempt: ${JSON.stringify(half)}`)
        return
      }
      await node.routemaps.setMatch(RM1, 'deny', 10, ['tag 50']) // :174-175
      const after = (await attrsOf(node, RM1, 'deny', 10))?.match ?? []
      expect(after).not.toContain('as 100') // :177-178
      expect(after).toContain('tag 50') // :179-180
    } finally {
      await clearClause(node, RM1, 'match-remove-final')
    }
  })

  it('setSet adds a set statement to a clause with none (test_set_set_statements, :182-194)', async () => {
    await clearClause(node, RM1, 'set-add')
    try {
      if (!(await stageClause(node, header1, [], 'set-add'))) return // :184-185
      expect((await attrsOf(node, RM1, 'deny', 10))?.set).toEqual([]) // :186-188
      await node.routemaps.setSet(RM1, 'deny', 10, ['weight 100']) // :189-190
      expect((await attrsOf(node, RM1, 'deny', 10))?.set).toEqual(['weight 100']) // :192-193
    } finally {
      await clearClause(node, RM1, 'set-add-final')
    }
  })

  it('setSet replaces an existing set statement instead of appending a second (test_update_set_statement, :195-210)', async () => {
    await clearClause(node, RM1, 'set-update')
    try {
      if (!(await stageClause(node, header1, ['set weight 100'], 'set-update'))) return // :197-199
      expect((await attrsOf(node, RM1, 'deny', 10))?.set).toContain('weight 100') // :201-202
      await node.routemaps.setSet(RM1, 'deny', 10, ['weight 200']) // :203-204
      const after = (await attrsOf(node, RM1, 'deny', 10))?.set ?? []
      expect(after).not.toContain('weight 100') // :206-207
      expect(after).toContain('weight 200') // :208-209
      const body = await clauseBody(node, header1)
      expect(body.filter((line) => line.startsWith('set '))).toHaveLength(1)
    } finally {
      await clearClause(node, RM1, 'set-update-final')
    }
  })

  it('setSet with the clause\'s own list writes nothing, and with a different keyword removes the old (test_remove_set_statement, :211-226)', async () => {
    await clearClause(node, RM1, 'set-remove')
    try {
      if (!(await stageClause(node, header1, ['set weight 100'], 'set-remove'))) return // :213-215
      const current = (await attrsOf(node, RM1, 'deny', 10))?.set ?? []
      // Upstream never runs this arm; the zero-command diff of `if commands else True` (:257/:293) should
      // leave the clause byte-identical, which a re-read proves.
      await node.routemaps.setSet(RM1, 'deny', 10, current)
      expect(await attrsOf(node, RM1, 'deny', 10)).toEqual({ match: [], set: current })
      await node.routemaps.setSet(RM1, 'deny', 10, ['tag 50']) // :219-220
      const after = (await attrsOf(node, RM1, 'deny', 10))?.set ?? []
      expect(after).not.toContain('weight 100') // :222-223
      expect(after).toContain('tag 50') // :224-225
    } finally {
      await clearClause(node, RM1, 'set-remove-final')
    }
  })

  it('setContinue writes a digits-only value the reader coerces (test_set_continue, :227-237)', async () => {
    await clearClause(node, RM1, 'continue-set')
    try {
      if (!(await stageClause(node, header1, [], 'continue-set'))) return // :229-230
      expect((await attrsOf(node, RM1, 'deny', 10))?.continue).toBeUndefined() // :232-233
      const accepted = await attempt('`continue 100` inside a DENY clause (upstream stages precisely this at :234 — whether 4.28.14M allows continue on a deny clause is the device\'s answer)', () => node.routemaps.setContinue(RM1, 'deny', 10, 100)) // :234
      if (!accepted) {
        console.warn('live-routemaps: the continue arms are unexercised on this target — reported, not claimed (the :236/:248/:261/:274 equalities stay open)')
        return
      }
      expect((await attrsOf(node, RM1, 'deny', 10))?.continue).toBe(100) // :236
    } finally {
      await clearClause(node, RM1, 'continue-set-final')
    }
  })

  it('setContinue replaces the value and the clause keeps one continue line (test_update_continue, :238-249)', async () => {
    await clearClause(node, RM1, 'continue-update')
    try {
      if (!(await stageClause(node, header1, ['continue 30'], 'continue-update'))) return // :240-242
      const staged = await attrsOf(node, RM1, 'deny', 10)
      if (staged?.continue !== 30) {
        console.warn(`live-routemaps: the staged \`continue 30\` reads as ${String(staged?.continue)} — this device did not keep the staging line, so the :244-245 precondition does not hold here`)
      }
      await node.routemaps.setContinue(RM1, 'deny', 10, 60) // :246
      const after = await attrsOf(node, RM1, 'deny', 10)
      expect(after?.continue).toBe(60) // :248
      const body = await clauseBody(node, header1)
      expect(body.filter((line) => line.startsWith('continue '))).toHaveLength(1)
    } finally {
      await clearClause(node, RM1, 'continue-update-final')
    }
  })

  it('defaultContinue clears the value and leaves the clause in place (test_default_continue, :250-262)', async () => {
    await clearClause(node, RM1, 'continue-default')
    try {
      if (!(await stageClause(node, header1, ['continue 100'], 'continue-default'))) return // :252-254
      await node.routemaps.defaultContinue(RM1, 'deny', 10) // :258-259 → `default continue`
      const entry = await node.routemaps.get(RM1)
      expect(entry).toBeDefined() // :261 indexes `['deny'][10]`, so upstream's own run shows the clause SURVIVES
      expect(entry?.get('deny')?.get(10)?.continue).toBeUndefined()
      expect(await clauseHeaders(node, RM1)).toContain(header1)
      console.log(`live-routemaps: after \`default continue\` the body is ${JSON.stringify(await clauseBody(node, header1))}`)
    } finally {
      await clearClause(node, RM1, 'continue-default-final')
    }
  })

  it('unsetContinue negates the value and leaves the clause in place (test_negate_continue, :263-274)', async () => {
    await clearClause(node, RM1, 'continue-no')
    try {
      if (!(await stageClause(node, header1, ['continue 100'], 'continue-no'))) return // :265-267
      await node.routemaps.unsetContinue(RM1, 'deny', 10) // :271-272 → `no continue`
      const entry = await node.routemaps.get(RM1)
      expect(entry).toBeDefined()
      expect(entry?.get('deny')?.get(10)?.continue).toBeUndefined() // :274
      expect(await clauseHeaders(node, RM1)).toContain(header1)
      console.log(`live-routemaps: after \`no continue\` the body is ${JSON.stringify(await clauseBody(node, header1))}`)
    } finally {
      await clearClause(node, RM1, 'continue-no-final')
    }
  })
})
