/**
 * `*.live.test.ts` port of `pyeapi/test/system/test_api_stp.py` @ `6816d9e` — the spanning-tree interface
 * half of the **D2 full-write** lane (#14, DR-126). The file's upstream class is `TestApiStpInterfaces`
 * (`:40`): only per-interface STP state, which is why every write here still lands on the declared
 * `EAPI_SCRATCH_INTERFACE` — the full-write consent is what lets the lane `default interface <scratch>` at
 * all, and `buildFullWriteNode` keeps the self-lockout fence on the seam.
 *
 * ## Gate (DR-034 / DR-126 / DR-035(b))
 * `liveFullWriteReadiness(process.env)` gates the file; the twelve write cases additionally require
 * `requireScratchInterface` (`live-guard.ts:601-614`) and skip loudly without it. Upstream's port choice is
 * `random_interface(dut)` — imported at `:38` and used at `:58`, `:66`, `:75`, `:84`, `:93`, `:101`, `:110`,
 * `:119`, `:128`, `:136` — i.e. the mutated port is inferred from `show interfaces`, which DR-035(b) has
 * refused since M12a (`live-switchports.live.test.ts` says the same about its file). The two read cases use
 * the port **names the device already publishes**, so they need no scratch declaration.
 *
 * | upstream (verified line @6816d9e) | ported? | here / why |
 * |---|---|---|
 * | `test_get` (`:42`) | ✅ (read half, staging dropped) | upstream first writes `default interface Ethernet1` (`:44`) — a fixture port in this lab (harness-owned: `scripts/ceos-lab.mjs:1151-1157` puts the access config on the observed ethA) — then compares the record's **key set** to `['portfast','portfast_type','bpduguard']` (`:45`, `:47-48`) with no value asserted. So the portable content is exactly that: pick a name the target already publishes from `getAll()` and assert this client's four keys (`interfaceName` joins them — row 96's self-naming entry) and the three value types. `stp.interfaces.get(…)` is a table lookup here (`stp.ts:528`), not a second read |
 * | `test_getall` (`:50`) | ✅ (read half, staging dropped) | staging is `default interface Et1-4` (`:52`) — a port-range write over fixture ports, and the only assertion is `assertIsInstance(result, dict)` (`:54`). Ours asserts the `Map` shape, that every entry self-names its key, and that `get(key)` agrees with the table entry (this client's own one-read consistency claim, row 15/DR-030) |
 * | `test_set_bpduguard_to_true` (`:56`) | ✅ write (scratch) | `default interface <intf>` (`:59`) then `set_bpduguard(intf, True)` (`:61`), `assertTrue` (`:62`). Ours also reads back: `bpduguard` is the presence of the exact line `spanning-tree bpduguard enable` (`stp.ts:327`, inside `stpInterfaceFieldsFrom` at `:326-334`), so the affirmative word is asserted on the record, not just accepted by the CLI |
 * | `test_set_bpdugard_to_false` (`:64`) | ✅ write (scratch) | staging `interface <intf>` + `spanning-tree bpduguard enable` (`:67-68`), `set_bpduguard(intf, False)` (`:70`). Upstream asserts success only; here the staged-then-cleared read is asserted (`false`), which is the read-back pyeapi's own docstring promises and its test never performs |
 * | `test_set_bpdugard_to_default` (`:73`) | ✅ write (scratch), device default reported | staging as above (`:76-77`), `set_bpduguard(intf, default=True)` (`:79`) → `defaultBpduguard` (`stp.ts:634`). What the EOS default *is* on this image is the device's answer: the case asserts the write resolves and prints the record's `bpduguard`, since this client's rule is "the enable line is present or it is not" (`stp.ts:327`) and both `disable` and no line read `false` |
 * | `test_set_bpdugard_to_no` (`:82`) | ✅ write (scratch) | staging (`:85-86`), `set_bpduguard(intf, disable=True)` (`:88`) → `unsetBpduguard`, i.e. `no spanning-tree bpduguard` (`stp.ts:629`) — a command pyeapi spells and upstream's system test only asserts True for. Read-back asserted `false` |
 * | `test_set_portfast_to_true` (`:91`) | ✅ write (scratch), with the default-on caveat printed | `default interface <intf>` (`:94`) then `set_portfast(intf, True)` (`:96`) → `setPortfast`. Our reader's rule is upstream's (`:218`): `portfast` is true unless the block carries the exact line `no spanning-tree portfast` — so a bare `spanning-tree portfast` is **indistinguishable from the default** in the record. The case asserts the write resolves and `portfast === true`, and says out loud that this is the default-on reading (row 170), not evidence the device stored our line |
 * | `test_set_portfast_to_false` (`:99`) | ✅ write (scratch) | staging `interface <intf>` + `spanning-tree portfast` (`:102-103`), `set_portfast(intf, False)` (`:105`). pyeapi folds `value=False` into `disable=True` (`stp.py:307-308`; the `no` text comes out of `command_builder` at `stp.py:310-311`) → the one verb `unsetPortfast` (`stp.ts:608`). Here the read is the assert: the block must now carry `no spanning-tree portfast`, so `portfast` flips to `false` |
 * | `test_set_portfast_to_default` (`:108`) | ✅ write (scratch), device default reported | staging (`:111-112`), `set_portfast(intf, default=True)` (`:114`) → `defaultPortfast` (`stp.ts:613`). The record's `portfast` after a default is the container's answer about its own default, printed; the case asserts the write resolves and the vocabulary stayed in range (`portfastType` a string, `portfast` a boolean) |
 * | `test_set_portfast_to_no` (`:117`) | ✅ write (scratch) | staging (`:120-121`), `set_portfast(intf, disable=True)` (`:123`) → **the same** `unsetPortfast` as the `:99` case: upstream has two spellings of one command, and this client names the intent instead (DR-037, one verb at `stp.ts:608`). Both slots are kept so the upstream method map stays auditable |
 * | `test_set_portfast_to_edge` (`:126`) | ✅ write (scratch) | `default interface <intf>` (`:129`) then `set_portfast_type(intf, 'edge')` (`:131`) → `spanning-tree portfast edge` **plus** `spanning-tree portfast auto` (`stp.ts:587-591`, upstream's own two-line pair at `stp.py:277-279`). Read-back asserts `portfastType === 'edge'` (the first `spanning-tree portfast <token>` line wins, `stp.ts:329`) |
 * | `test_set_portfast_to_network` (`:134`) | ✅ write (scratch) — the case, not its label | staging `interface <intf>` + `spanning-tree portfast` (`:137-138`), then `set_portfast_type(intf, 'normal')` (`:140`): despite the method name, upstream writes `normal`, and this client requires the caller to name it (`stp.ts:581-585` — upstream's own `value='normal'` default at `stp.py:255` is refused, DR-037/row 170). Read-back asserts `portfastType === 'normal'`; the `network` spelling is exercised only as a grammar check (see the guard note below) |
 *
 * Upstream asserts `assertTrue(result, 'dut=%s' % dut)` on **ten** of its twelve methods (the writes):
 * pyeapi's `configure` answers `True`/`False`, and here a refused write **throws** `CommandError` with the
 * device's code instead (DR-005) — so each case asserts the awaited verb resolves, then asserts our own
 * record, which is more than upstream's own system suite claims. Of the refusal half of the taxonomy, only
 * one part gets a live slot: the STP **port-name** `ValueError` family (`test/unit/test_api_stp.py:121-124`/
 * `:153-156`/`:181-184`, from the two-character gate at `pyeapi/api/stp.py:346-363`) stays offline against
 * `assertStpPortName` (`stp.ts:268-280`), because this lane only ever passes a guard-approved `Ethernet…`
 * name and re-testing the guard against a device would claim nothing. The **portfast-type** grammar
 * (`stp.ts:290-297`, which also refuses upstream's `None` arm) gets one flagged slot at the end, not as an
 * upstream method but as the pre-wire proof that a bad value never reaches the port — the record is read
 * before and after, and must not have moved.
 *
 * Every write case ends by `default interface <scratch>` in a `finally`, which is also how the **next** live
 * file in the same container (the switchports lane, and any later suite) finds the port: config sessions
 * here never persist (`runGuardedLiveWriteSession`, DR-035(c)), so the container's running config is exactly
 * what the last committed session left.
 */

import { beforeAll, describe, expect, it } from 'vitest'

import { NotSupportedError } from './errors'
import { buildFullWriteNode, liveFullWriteReadiness } from './testing/live-full-write'
import { describeLiveTarget, matchesDeviceIdentity, requireScratchInterface, unwrapLiveTarget, type LiveTarget } from './testing/live-guard'
import { runGuardedLiveWriteSession } from './testing/live-session-policy'
import type { Node } from './command-layer'

const gate = liveFullWriteReadiness(process.env)
if (!gate.runnable) {
  console.warn(`live-stp: SKIPPED (DR-034/DR-126) — ${gate.skipReason ?? 'reason unavailable'}`)
}

/** All twelve STP writes target this port; without it the write cases skip loudly, mirroring live-switchports. */
const scratch: { ok: boolean; name?: string; reason?: string } = gate.runnable
  ? (() => {
      const req = requireScratchInterface(unwrapLiveTarget(gate.resolution))
      return req.ok ? { ok: true, name: req.name } : { ok: false, reason: req.reason }
    })()
  : { ok: false, reason: 'live target not accepted' }
if (gate.runnable && !scratch.ok) {
  console.warn(`live-stp: write cases SKIPPED (DR-035b) — ${scratch.reason ?? ''}`)
}
const writeReady = gate.runnable && scratch.ok

async function readyNode(label: string): Promise<Node> {
  const target: LiveTarget = unwrapLiveTarget(gate.resolution)
  console.log(`${label}: target = ${describeLiveTarget(target)}`)
  const node = buildFullWriteNode(target)
  const reported = await node.getVersion()
  const mismatch = matchesDeviceIdentity(target, { version: reported.version, modelName: reported.modelName })
  // Only the cEOS build-suffix mismatch is tolerated; model/train/TLS identity belong to the probe (DR-066).
  if (mismatch !== undefined && mismatch.code !== 'EAPI_VERSION_MISMATCH') throw new Error(`${label} readiness: ${mismatch.reason}`)
  if (mismatch?.code === 'EAPI_VERSION_MISMATCH') {
    console.warn(`${label}: reported version "${reported.version}" vs pin "${target.allowVersion}" (base-level enforced by the probe, DR-066)`)
  }
  return node
}

/** Upstream's normalising staging (`:44`, `:59`, `:94`, `:129`): it is a write, so it rides a named session here. */
async function defaultPort(node: Node, intf: string, tag: string): Promise<void> {
  await runGuardedLiveWriteSession(node, { name: `d2-stp-${tag}-default-${intf}`, commands: [`default interface ${intf}`] })
}

/** Upstream's second staging idiom (`:67-68` and five siblings): enter the interface, then write the field line. */
async function stageField(node: Node, intf: string, tag: string, fieldLines: readonly string[]): Promise<void> {
  await runGuardedLiveWriteSession(node, { name: `d2-stp-${tag}-stage-${intf}`, commands: [`interface ${intf}`, ...fieldLines] })
}

describe.skipIf(!gate.runnable)('live read: pyeapi test_api_stp.py (test_getall, :50 and test_get, :42)', () => {
  let node: Node
  beforeAll(async () => {
    node = await readyNode('live-stp')
  })

  it('stp.interfaces.getAll() is a keyed table of records that self-name (test_getall, :50 — the assertIsInstance half at :54)', async () => {
    const all = await node.stp.interfaces.getAll()
    expect(typeof all.has).toBe('function')
    for (const [name, entry] of all) {
      expect(typeof name).toBe('string')
      expect(entry.interfaceName).toBe(name)
      expect(typeof entry.portfast).toBe('boolean')
      expect(typeof entry.portfastType).toBe('string')
      expect(typeof entry.bpduguard).toBe('boolean')
    }
    // Upstream's only assertion is the container type (`:54`) after `default interface Et1-4` (`:52`) — a
    // fixture-port range write this lane will not make. The table this run can see is whatever the target
    // publishes; when it is empty the case reports that instead of claiming coverage (DR-034).
    if (all.size === 0) {
      console.warn('live-stp: getAll() reported 0 spanning-tree interface sections on this target — membership/consistency halves NOT exercised')
      return
    }
    const first = all.keys().next().value as string
    const single = await node.stp.interfaces.get(first)
    expect(single).toBeDefined()
    expect(single?.portfast).toBe(all.get(first)?.portfast)
    expect(single?.bpduguard).toBe(all.get(first)?.bpduguard)
    expect(single?.portfastType).toBe(all.get(first)?.portfastType)
    console.log(`live-stp: ${String(all.size)} spanning-tree sections; ${first} = ${JSON.stringify(all.get(first))}`)
  })

  it('one published port answers this client\'s four record keys, types and all (test_get, :42 — the key-set compare at :45/:47-48)', async () => {
    const all = await node.stp.interfaces.getAll()
    const name = [...all.keys()].find((key) => /^(?:Ethernet|Port-Channel)/u.test(key))
    if (name === undefined) {
      console.warn('live-stp: the target publishes no Ethernet/Port-Channel spanning-tree section, so :42\'s record read is NOT exercised here (its staging, `default interface Ethernet1` at :44, is a fixture-port write this lane refuses)')
      return
    }
    const entry = await node.stp.interfaces.get(name)
    expect(entry).toBeDefined()
    if (entry === undefined) return
    // pyeapi's record has three keys (`:45`); this client added the entry's own name (row 96) and renamed the
    // snake_case fields (MIGRATION.md §4), which is the honest version of upstream's key-set assertion.
    expect(Object.keys(entry).sort()).toEqual(['bpduguard', 'interfaceName', 'portfast', 'portfastType'])
    expect(entry.interfaceName).toBe(name)
    expect(typeof entry.portfast).toBe('boolean')
    expect(typeof entry.bpduguard).toBe('boolean')
    if (entry.portfastType !== '') expect(typeof entry.portfastType).toBe('string')
  })
})

describe.skipIf(!writeReady)('live full-write on the scratch port: pyeapi test_api_stp.py (bpduguard :56/:64/:73/:82, portfast :91/:99/:108/:117, portfast_type :126/:134)', () => {
  let node: Node
  let intf: string
  beforeAll(async () => {
    intf = scratch.name ?? ''
    node = await readyNode('live-stp/write')
  })

  it('setBpduguard(name,true) writes the enable word and the record sees it (test_set_bpduguard_to_true, :56 — :59/:61)', async () => {
    await defaultPort(node, intf, 'bg-on')
    try {
      await node.stp.interfaces.setBpduguard(intf, true)
      const after = await node.stp.interfaces.get(intf)
      expect(after).toBeDefined()
      expect(after?.bpduguard).toBe(true)
    } finally {
      await defaultPort(node, intf, 'bg-on-restore')
    }
  })

  it('clearing bpduguard from an enabled port reads false (test_set_bpdugard_to_false, :64 — staging :67-68, :70)', async () => {
    await defaultPort(node, intf, 'bg-off')
    try {
      await stageField(node, intf, 'bg-off', ['spanning-tree bpduguard enable'])
      expect((await node.stp.interfaces.get(intf))?.bpduguard).toBe(true)
      await node.stp.interfaces.setBpduguard(intf, false)
      expect((await node.stp.interfaces.get(intf))?.bpduguard).toBe(false)
    } finally {
      await defaultPort(node, intf, 'bg-off-restore')
    }
  })

  it('defaulting bpduguard is accepted and the container states its own default (test_set_bpdugard_to_default, :73 — staging :76-77, :79)', async () => {
    await defaultPort(node, intf, 'bg-dflt')
    try {
      await stageField(node, intf, 'bg-dflt', ['spanning-tree bpduguard enable'])
      expect((await node.stp.interfaces.get(intf))?.bpduguard).toBe(true)
      await node.stp.interfaces.defaultBpduguard(intf)
      const after = await node.stp.interfaces.get(intf)
      expect(after).toBeDefined()
      expect(typeof after?.bpduguard).toBe('boolean')
      // Upstream asserts only that the command worked (`:80`). What "default" left behind is the device's,
      // and this is the first time this repo looks at it on 4.28.14M.
      console.log(`live-stp: after \`default spanning-tree bpduguard\` on ${intf}, bpduguard = ${String(after?.bpduguard)} (${JSON.stringify(after)})`)
    } finally {
      await defaultPort(node, intf, 'bg-dflt-restore')
    }
  })

  it('negating bpduguard reads false whether or not the device keeps a line (test_set_bpdugard_to_no, :82 — staging :85-86, :88)', async () => {
    await defaultPort(node, intf, 'bg-no')
    try {
      await stageField(node, intf, 'bg-no', ['spanning-tree bpduguard enable'])
      expect((await node.stp.interfaces.get(intf))?.bpduguard).toBe(true)
      await node.stp.interfaces.unsetBpduguard(intf)
      const after = await node.stp.interfaces.get(intf)
      expect(after?.bpduguard).toBe(false)
      if (after !== undefined && after.bpduguard === false) {
        console.log(`live-stp: \`no spanning-tree bpduguard\` on ${intf} left ${JSON.stringify(after)} — false is this client's "no enable line" answer, not a stored disable word (row 170)`)
      }
    } finally {
      await defaultPort(node, intf, 'bg-no-restore')
    }
  })

  it('setPortfast writes the bare line; the record reads true, and that is the default-on rule talking (test_set_portfast_to_true, :91 — :94/:96)', async () => {
    await defaultPort(node, intf, 'pf-on')
    try {
      const before = await node.stp.interfaces.get(intf)
      console.log(`live-stp: ${intf} before setPortfast = ${JSON.stringify({ portfast: before?.portfast, portfastType: before?.portfastType })} — pyeapi's reader is default-on (\`stp.py:218\`), so true here is not proof of a stored line`)
      await node.stp.interfaces.setPortfast(intf)
      const after = await node.stp.interfaces.get(intf)
      expect(after?.portfast).toBe(true)
    } finally {
      await defaultPort(node, intf, 'pf-on-restore')
    }
  })

  it('the value=False half of pyeapi\'s portfast negation flips the record to false (test_set_portfast_to_false, :99 — staging :102-103, :105)', async () => {
    await defaultPort(node, intf, 'pf-off')
    try {
      await stageField(node, intf, 'pf-off', ['spanning-tree portfast'])
      await node.stp.interfaces.unsetPortfast(intf)
      const after = await node.stp.interfaces.get(intf)
      expect(after).toBeDefined()
      expect(after?.portfast).toBe(false)
    } finally {
      await defaultPort(node, intf, 'pf-off-restore')
    }
  })

  it('defaultPortfast is accepted and the container answers its own portfast default (test_set_portfast_to_default, :108 — staging :111-112, :114)', async () => {
    await defaultPort(node, intf, 'pf-dflt')
    try {
      await stageField(node, intf, 'pf-dflt', ['spanning-tree portfast'])
      await node.stp.interfaces.defaultPortfast(intf)
      const after = await node.stp.interfaces.get(intf)
      expect(after).toBeDefined()
      expect(typeof after?.portfast).toBe('boolean')
      expect(typeof after?.portfastType).toBe('string')
      console.log(`live-stp: after \`default spanning-tree portfast\` on ${intf}: ${JSON.stringify(after)}`)
    } finally {
      await defaultPort(node, intf, 'pf-dflt-restore')
    }
  })

  it('the disable=True half of pyeapi\'s portfast negation is the same single verb (test_set_portfast_to_no, :117 — staging :120-121, :123; DR-037)', async () => {
    await defaultPort(node, intf, 'pf-no')
    try {
      await stageField(node, intf, 'pf-no', ['spanning-tree portfast'])
      expect((await node.stp.interfaces.get(intf))?.portfast).toBe(true)
      // Upstream: `value=False` (`stp.py:307-308`) and the `disable` kwarg (`stp.py:282`) reach one line
      // through `command_builder` (`stp.py:310-311`). This client owns
      // one verb, `unsetPortfast`, so the two upstream slots deliberately land on it twice.
      await node.stp.interfaces.unsetPortfast(intf)
      expect((await node.stp.interfaces.get(intf))?.portfast).toBe(false)
      await node.stp.interfaces.setPortfast(intf)
      await node.stp.interfaces.unsetPortfast(intf)
      expect((await node.stp.interfaces.get(intf))?.portfast).toBe(false)
    } finally {
      await defaultPort(node, intf, 'pf-no-restore')
    }
  })

  it('portfast edge writes upstream\'s two-line pair and the record names edge (test_set_portfast_to_edge, :126 — :129/:131)', async () => {
    await defaultPort(node, intf, 'pf-edge')
    try {
      await node.stp.interfaces.setPortfastType(intf, 'edge')
      const after = await node.stp.interfaces.get(intf)
      expect(after).toBeDefined()
      expect(after?.portfastType).toBe('edge')
      console.log(`live-stp: after \`spanning-tree portfast edge\` + \`auto\` on ${intf}: ${JSON.stringify(after)} (the pair is pyeapi's, \`stp.py:277-279\`)`)
    } finally {
      await defaultPort(node, intf, 'pf-edge-restore')
    }
  })

  it('the "to_network" method actually writes normal, and that is what the record reports (test_set_portfast_to_network, :134 — staging :137-138, :140)', async () => {
    await defaultPort(node, intf, 'pf-normal')
    try {
      await stageField(node, intf, 'pf-normal', ['spanning-tree portfast'])
      // Upstream's method name says network, its argument says `'normal'` (`:140`); this client makes the
      // caller name the value instead of inheriting pyeapi's `value='normal'` default (`stp.ts:581-585`).
      await node.stp.interfaces.setPortfastType(intf, 'normal')
      const after = await node.stp.interfaces.get(intf)
      expect(after?.portfastType).toBe('normal')
    } finally {
      await defaultPort(node, intf, 'pf-normal-restore')
    }
  })

  it('the portfast-type grammar is exact, and a live write never needs it — so this is the zero-request proof (guard note, not an upstream method)', async () => {
    // `stp.ts:290-297` refuses a type outside edge/network/normal, and it refuses upstream's `None` arm
    // (`stp.py:274` interpolates the literal word `None` — probe, row 170). The case also proves the refusal
    // is pre-wire: the verb composes nothing, so the port's record cannot have moved.
    const untouched = await node.stp.interfaces.get(intf)
    await expect(node.stp.interfaces.setPortfastType(intf, 'disabled' as unknown as 'edge')).rejects.toBeInstanceOf(NotSupportedError)
    const after = await node.stp.interfaces.get(intf)
    expect(after?.portfastType).toBe(untouched?.portfastType)
    expect(after?.bpduguard).toBe(untouched?.bpduguard)
    await expect(node.stp.interfaces.setPortfastType(intf, undefined as unknown as 'edge')).rejects.toBeInstanceOf(NotSupportedError)
  })
})
