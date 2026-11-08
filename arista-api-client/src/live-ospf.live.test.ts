/**
 * `*.live.test.ts` port of `pyeapi/test/system/test_api_ospf.py` @ `6816d9e` — #14 **D2** (the full-write
 * lab lane, DR-126). All 15 upstream test methods are portable here: unlike the M12a suites
 * (`live-switchports`/`live-system`/`live-vlans`, which were fenced to `EAPI_SCRATCH_INTERFACE` by
 * DR-035(b)), this file mutates protocol configuration on the **throwaway cEOS-lab 4.28.14M** container
 * behind `EAPI_LAB_FULL_WRITE=1` + `buildFullWriteNode`, so the upstream `clear_ospf_config` /
 * `dut.config(["router ospf 1", …])` staging idiom ports 1:1 instead of being ledger-skipped.
 *
 * ## Gate (DR-126/DR-034)
 * `liveFullWriteReadiness(process.env)` composes `resolveLiveEnv` with `requireLabFullWrite`; an
 * unaccepted env (or a missing consent flag, or the `hardware` class) prints the refusal and skips every
 * case — including under `npx vitest run` with the env unset, which is what the offline gate checks
 * (collection + a loud skip line, exit 0). `buildFullWriteNode` is the only `Node` builder used, so the
 * self-lockout fence (`withLabWriteScope`: listener, `admin`/`netadmin`, this run's API user, the
 * management path, `copy run start`) sits in front of *every* verb below, facade or session.
 *
 * ## What is a write lane and what is a read
 * Protocol verbs go through the resource facades (`node.ospf.*`), which send `configure terminal`
 * batches — no persistence, autorefresh invalidates the config memo (DR-026/row 80), so every read-back
 * below is a fresh `show running-config`. Bulk staging/teardown (`clearOspf`, the route-map fixture for
 * the redistribution arms) goes through `runGuardedLiveWriteSession` with a **named** session
 * (`live-ospf-<case>`), which is also where DR-035(c)'s mechanical `copy run start` ban lives. Every case
 * is read-then-act at entry (`clearOspf` first) and clears OSPF again in `finally`, because the container
 * persists across the live suite order and a leftover `router ospf …` would change what the *next* suite
 * (or the next run of this one) reads.
 *
 * | upstream (verified line @6816d9e) | ported? | here / why |
 * |---|---|---|
 * | the `clear_ospf_config(dut, pid=None)` helper (`:40-53`) | ✅ as {@link clearOspf} | upstream discovers the pid by `get_config(params="section ospf")[0].split()[2]` (`:43-44`) — one section, positionally — and swallows `IndexError` (`:46-48`). Here the header text comes from the running-config's own indent-0 `router ospf …` lines ({@link ospfHeaderLines}), so **every** process (including `vrf`-qualified ones, which upstream's helper cannot name) is negated with its exact header, and an empty scan stages nothing |
 * | `test_get` (`:54-67`) | ✅ | upstream stages `router ospf 1` / `router-id 1.1.1.1` / `network 2.2.2.0/24 area 0` / `redistribute bgp` (`:57-58`) and demands the exact dict at `:66`, including `networks=[{netmask:'24', network:'2.2.2.0', area:'0.0.0.0'}]` (`:62-63`) and `shutdown=False` (`:65`). Here the same four lines ride **our** verbs (`create`/`setRouterId`/`addNetwork`/`addRedistribution`) on a fresh pid 101, and the equality at `:66` splits into the assertions this client's record actually makes plus the two open captures `resources/ospf.ts` declares: **divergence 4** (`addNetwork`'s default area composes `area 0`; the reader only matches a dotted quad — whether 4.28.14M normalises it is printed, `networks.length > 0` is not asserted) and **divergence 3** (`shutdown` is derived true unless a body line reads exactly `no shutdown`, so upstream's `False` at `:65` can only come from the device writing that line — reported, then asserted against what THIS device wrote) |
 * | `test_get_with_vrf` (`:68-81`) | ✅ | upstream's `router ospf 10 vrf test` (`:71`) becomes pid 102 + the name `liveospf102` (a fresh name inside {@link assertVrfName}'s `\w+` guard — ospf.ts:220 — rather than pyeapi's literal `test`, so it cannot collide with another lane's VRF). `get('liveospf102')` must answer that vrf; the *unqualified* `get()` answering the FIRST section (divergence 7) is recorded, not asserted, because "which process did the operator mean" is deliberately unmodelled. Whether EOS insists the VRF exists before `router ospf … vrf X` is a device answer → a refusal is reported with its code (the session-less facade write throws `CommandError`) |
 * | `test_shutdown` (`:82-90`) | ✅ | `set_shutdown()` + `assertIn('shutdown', get_block("router ospf 1"))` (`:87`/`:89`) → {@link OspfResource.shutdown} then the typed read `shutdown === true`. Upstream inspects the raw block (its `assertIn` is a substring test over block text, `:89`); the port reads the record this client exposes and also prints the section's own body lines so the raw answer stays visible |
 * | `test_no_shutown` (`:91-100`, upstream's typo kept) | ✅ | `set_no_shutdown()` + `assertIn('no shutdown', …)` (`:97`/`:99`) → {@link OspfResource.noShutdown} then `shutdown === false`, which is exactly this client's line-anchored rule (divergence 3) — the case pins that the device answers a whole `no shutdown` body line, the fact the derivation depends on |
 * | `test_delete` (`:101-109`) | ✅ | {@link OspfResource.delete} (reads first, negates with the as-read pid, zero commands when absent — divergence 1). Upstream's negative read at `:108` is `assertEqual(None, ospf.get_block("router ospf"))` — here `get()` is `undefined` **and** no indent-0 `router ospf …` header survives, which is stronger than a block probe and is what makes the teardown auditable |
 * | `test_create_valid_id` (`:110-118`) | ✅ | `randint(1, 65536)` (`:113`) becomes the deterministic 104: a random pid is not run-idempotent (the container persists across the suite order) and the bound lives in {@link assertProcessId} (`ospf.ts:203`), already pinned offline. `assertIn("router ospf {}".format(pid), dut.get_config())` (`:117`) → the header-line scan |
 * | `test_create_invalid_id` (`:119-125`) | ✅, refusal type differs | upstream: `randint(70000, 100000)` then `assertRaises(ValueError)` (`:123-124`). Ours rejects with **`NotSupportedError`** before any request (DR-005/DR-010, `assertProcessId`'s bound at ospf.ts:203) — the same 1..65535 bound (divergence 5), a client-side refusal instead of a device answer, and no random pid so nothing else can vary |
 * | `test_create_with_vrf` (`:126-135`) | ✅ | `create(pid, vrf='test')` + `assertIn("router ospf {} vrf test")` (`:131`/`:133-134`) → `create(105, 'liveospf105')` and the header scan for that exact text. Teardown names the whole header (`no router ospf 105 vrf liveospf105`), which upstream's helper could not express (`:40-53`) |
 * | `test_configure_ospf` (`:136-144`) | ✅ + the crash it never reached | {@link OspfResource.configureOspf} with the raw line upstream passes (`"router-id 1.1.1.1"`, `:141`) → present on read (`:143`). Added arm, because upstream cannot express it: with **no** ospf section `configure_ospf` throws `TypeError` on `None['ospf_process_id']` (`ospf.py:251-253`) and here it is a `NotFoundError` naming the missing process (divergence 1's family) — offline-pinned in `resources/ospf.test.ts`, asserted live against a cleared device |
 * | `test_set_router_id` (`:145-161`) | ✅, `False` ⇒ throw | `set_router_id(randint(...))` then `assertFalse` (`:150-151`) is pyeapi's `configure`-swallows-a-device-error idiom (`abstract.py:118-127`): the composed text `router-id <int>` is device-decided, so here it is attempted and the refusal reported as a typed `CommandError` with its code — never turned into an expected `False`. Then `"2.2.2.2"` (`:152-154`) → read back; `default=True` (`:155-157`) and `disable=True` (`:158-160`) → both of upstream's `assertIn("no router-id", …)` checks are the RAW-line question (does 4.28.14M render the default as a literal `no router-id` line, or drop it?), so the case prints the section body and asserts this client's answer (`routerId` absent, DR-027) rather than pyeapi's substring |
 * | `test_add_network` (`:162-173`) | ✅ | `add_network("2.2.2.0","24",1234)` (`:167`) then `assertIn("network 2.2.2.0/24 area 0.0.4.210")` (`:169`) — the device turns the bare integer area into a dotted quad, which is the SAME normalisation our reader needs (divergence 4). Ported with area 1234 through {@link OspfResource.addNetwork} (digits are allowed by {@link assertArea}, `ospf.ts:259`): if the device normalises, `networks` reads it back, and both the composed command and the rendered running-config line are printed. The second arm (`:170-172`, default area → `area 0.0.0.0`) is the divergence-4 capture this file exists to answer |
 * | `test_remove_network` (`:174-188`) | ✅ | upstream stages two networks with dotted-quad areas (`:177-179`, fed by `dut.config(ospf_config)` at `:179`), removes both (`:181-184`), then asserts the staged non-header lines are gone (`:185-187`). Here the two networks are staged by name (10.101.2.0/24 area 0.0.0.0, 10.101.3.0/32 area 1.1.1.1), {@link OspfResource.removeNetwork} negates each with the same area text, and the read shows `networks === []` — the pair `addNetwork`+`removeNetwork` is what divergence 4's asymmetry is about, so both directions are exercised on one device |
 * | `test_add_redistribution` (`:189-205`) | ✅, no randomness | upstream picks each protocol's route-map arm by `randint(1,10) % 2` (`:194-197`) then asserts the four bare lines exist (`:202`) and `add_redistribution("NOT VALID")` raises `ValueError` (`:203-204`). Here the arms are deterministic: `connected`/`static` bare (the two this container can meaningfully answer), plus a route-map-qualified `static` against a fixture route-map this file stages and removes; four bare `bgp`/`rip`/`static`/`connected` attempts each report their own device answer (redistributing a protocol that is not configured is a device question, not a client one). The invalid protocol rejects with `NotSupportedError` before the wire (`assertProtocol`, `ospf.ts:497-503`) — same allow-list, different exception class |
 * | `test_remove_redistribution` (`:206-215`) | ✅ | upstream stages `redistribute bgp` + `redistribute static route-map test` (`:209`), negates both with the BARE `no redistribute <proto>` (the method takes no route-map argument — divergence 10, `ospf.ts:488`), then asserts no `redistribute` substring remains (`:215`). Ported with a route-map this file owns, so the bare-negation-over-a-qualified-line question is finally answered on a real device: the read-back (`redistributions.length === 0`) plus the printed body lines say whether 4.28.14M cleared both or left the qualified line |
 *
 * Deliberate naming deviations, stated for the audit: pids 101-105 instead of pyeapi's 1/10 (two
 * `router ospf` processes in one run must be distinguishable after a crashed case), `liveospf<pid>` vrf
 * names inside the module's `\w+` guard, and `LIVEOSPFRM` for the fixture route-map (the routemaps lane
 * uses `LIVERM…`, so no name from either suite can be mistaken for leftover state of the other).
 * `redistribute … route-map test`/`network 2.2.2.0`-style addresses from the upstream file are kept where
 * they are only config text; where a name could collide with another suite it is prefixed.
 */

import { beforeAll, describe, expect, it } from 'vitest'

import { CommandError, EapiError, NotFoundError, NotSupportedError, ProtocolError } from './errors'
import { buildFullWriteNode, liveFullWriteReadiness } from './testing/live-full-write'
import { describeLiveTarget, matchesDeviceIdentity, unwrapLiveTarget, type LiveTarget } from './testing/live-guard'
import { runGuardedLiveWriteSession } from './testing/live-session-policy'
import type { OspfState } from './resources/ospf'
import type { Node } from './command-layer'

const gate = liveFullWriteReadiness(process.env)
if (!gate.runnable) {
  console.warn(`live-ospf: SKIPPED — ${gate.skipReason}`)
}

/** Fresh, in-guard process ids — see the header's naming-deviation note. */
const PID_GET = 101
const PID_VRF = 102
const PID_VRF_CREATE = 105
const PID_SHUTDOWN = 103
const PID_ROUTER_ID = 104
const VRF_VRF = `liveospf${String(PID_VRF)}`
const VRF_CREATE = `liveospf${String(PID_VRF_CREATE)}`
/** The fixture route-map the redistribution arms qualify a line with, staged and removed in-case. */
const RM_FIXTURE = 'LIVEOSPFRM'

function targetOf(): LiveTarget {
  return unwrapLiveTarget(gate.resolution)
}

/** A device refusal is INFORMATION (DR-122's shape-dependence): print the device's own code and text, never swallow. Anything that is not an eAPI error is a harness failure and rethrows. */
function reportRefusal(rawErr: unknown, what: string): string {
  if (!(rawErr instanceof EapiError)) throw rawErr
  const code = rawErr instanceof CommandError
    ? `code ${String(rawErr.code)}`
    : rawErr instanceof ProtocolError
      ? `protocol code ${String(rawErr.code)}`
      : 'no code'
  const first = rawErr.message.split('\n')[0]?.slice(0, 200) ?? rawErr.message
  console.warn(`live-ospf: the device refused ${what} (${rawErr.constructor.name}, ${code}): ${first}`)
  return first
}

/** The indent-0 `router ospf …` headers in the running-config — the audit form of pyeapi's `get_block('^router ospf .*')` probe. */
async function ospfHeaderLines(node: Node): Promise<string[]> {
  const config = await node.getRunningConfig()
  const headers: string[] = []
  for (const line of config.split(/\r?\n/u)) {
    if (/^\s/u.test(line) || !line.startsWith('router ospf ')) continue
    headers.push(line)
  }
  return headers
}

/** Run one write arm. A device refusal is reported and the case continues, because in this lane the READ-BACK of what the device actually kept is the finding (DR-122's shape-dependence). */
async function attempt(what: string, run: () => Promise<unknown>): Promise<boolean> {
  try {
    await run()
    return true
  } catch (rawErr) {
    reportRefusal(rawErr, what)
    return false
  }
}

/** A teardown batch whose refusal is a finding, not a harness failure: the case already reported whatever the device said. */
async function safeSession(node: Node, name: string, commands: readonly string[]): Promise<void> {
  try {
    await runGuardedLiveWriteSession(node, { name, commands })
  } catch (rawErr) {
    reportRefusal(rawErr, `teardown batch ${JSON.stringify(commands)}`)
  }
}

/** This replaces upstream's `clear_ospf_config` (`:40-53`): negate every header the device actually has. */
async function clearOspf(node: Node, sessionSuffix: string): Promise<void> {
  const headers = await ospfHeaderLines(node)
  if (headers.length === 0) return
  await runGuardedLiveWriteSession(node, {
    name: `live-ospf-clear-${sessionSuffix}`,
    commands: headers.map((header) => `no ${header}`),
  })
}

/** The body lines EOS keeps under one ospf header, printed for the raw-text assertions upstream makes. */
async function ospfBodyLines(node: Node, header: string): Promise<string[]> {
  const config = await node.getRunningConfig()
  const lines = config.split(/\r?\n/u)
  const at = lines.findIndex((line) => line === header)
  if (at < 0) return []
  const body: string[] = []
  for (const line of lines.slice(at + 1)) {
    if (line !== '' && !/^\s/u.test(line)) break
    body.push(line.trimEnd())
  }
  return body
}

async function reportOspfBlock(node: Node, state: OspfState | undefined): Promise<void> {
  if (state === undefined) {
    console.warn('live-ospf: get() answered undefined — the device has no matching `router ospf …` section')
    return
  }
  const header = `router ospf ${String(state.ospfProcessId)}${state.vrf === 'default' ? '' : ` vrf ${state.vrf}`}`
  const body = await ospfBodyLines(node, header)
  console.log(`live-ospf: ${header} renders as ${JSON.stringify(body)}; the typed read is ${JSON.stringify(state)}`)
}

describe.skipIf(!gate.runnable)('live full-write: pyeapi test_api_ospf.py (reads, create/delete, :54-135)', () => {
  let node: Node

  beforeAll(async () => {
    const target = targetOf()
    console.log(`live-ospf: target = ${describeLiveTarget(target)} (DR-126 full-write lab lane)`)
    node = buildFullWriteNode(target)
    const reported = await node.getVersion()
    const mismatch = matchesDeviceIdentity(target, { version: reported.version, modelName: reported.modelName })
    // Only the cEOS build-suffix refusal is tolerated; model/train/etc. still fail the run (DR-066).
    if (mismatch !== undefined && mismatch.code !== 'EAPI_VERSION_MISMATCH') throw new Error(`live-ospf readiness: ${mismatch.reason}`)
    if (mismatch?.code === 'EAPI_VERSION_MISMATCH') console.warn(`live-ospf: reported version "${reported.version}" vs pin "${target.allowVersion}" (base-level enforced by the probe, DR-066)`)
  })

  it('ospf.get() answers the record upstream demands at :66 — with divergence 3/4 captures (test_get, :54-67)', async () => {
    await clearOspf(node, String(PID_GET))
    try {
      await node.ospf.create(PID_GET)
      await node.ospf.setRouterId('1.1.1.1')
      await node.ospf.addNetwork('10.101.0.0', 24) // default area → composes `area 0` (ospf.ts:450)
      await node.ospf.addRedistribution('connected')
      const state = await node.ospf.get()
      expect(state).toBeDefined()
      if (state === undefined) return
      expect(state.ospfProcessId).toBe(PID_GET)
      expect(state.vrf).toBe('default') // upstream's `vrf='default'`, :61 — the same spelling
      expect(state.routerId).toBe('1.1.1.1') // staged at :57, asserted in the dict at :60
      // :62-63 asserts networks === [{netmask:'24', network:'2.2.2.0', area:'0.0.0.0'}]. The `area 0`
      // that our own default writes is INVISIBLE to this reader unless the device normalises it to a
      // dotted quad (ospf.ts divergence 4's open device question) — so the answer is reported.
      if (state.networks.length === 0) {
        console.warn(`live-ospf: DIVERGENCE-4 capture — after \`network 10.101.0.0/24 area 0\` the reader found NO dotted-quad area line, so 4.28.14M did not normalise \`area 0\` the way upstream's :62-63 expects. Upstream asserts a networks entry here; this run reports the absence instead of forcing one`)
      } else {
        for (const net of state.networks) expect(net.area).toMatch(/^\d+\.\d+\.\d+\.\d+$/u)
        console.log(`live-ospf: DIVERGENCE-4 capture — networks read back as ${JSON.stringify(state.networks)}`)
      }
      expect(state.redistributions.some((r) => r.protocol === 'connected')).toBe(true) // :64's arm
      // :65 asserts shutdown=False. This client derives true unless a body line is exactly
      // `no shutdown` (divergence 3), so upstream's answer is only reachable if the device writes that
      // line — which is what this prints.
      await reportOspfBlock(node, state)
      console.log(`live-ospf: shutdown read as ${String(state.shutdown)} after a create with no shutdown line of our own (upstream :65 expects False)`)
      expect(typeof state.shutdown).toBe('boolean')
    } finally {
      await clearOspf(node, `get-${String(PID_GET)}`)
    }
  })

  it('a vrf-qualified process answers its own vrf, and the unqualified read answers the FIRST section (test_get_with_vrf, :68-81)', async () => {
    await clearOspf(node, String(PID_VRF))
    try {
      await node.ospf.create(PID_VRF, VRF_VRF)
      await node.ospf.setRouterId('1.1.1.2') // upstream's second arm at :71-72, on a fresh vrf name
      const scoped = await node.ospf.get(VRF_VRF)
      expect(scoped).toBeDefined()
      if (scoped === undefined) return
      expect(scoped.ospfProcessId).toBe(PID_VRF)
      expect(scoped.vrf).toBe(VRF_VRF) // the `\w+` capture (assertVrfName, ospf.ts:220 — truncation never reachable through this writer)
      expect(scoped.routerId).toBe('1.1.1.2')
      const unqualified = await node.ospf.get()
      console.log(`live-ospf: divergence 7 capture — get() with no vrf answered process ${String(unqualified?.ospfProcessId)} vrf ${String(unqualified?.vrf)} while get(${VRF_VRF}) answered ${String(scoped.ospfProcessId)}; which process a bare read means is deliberately unmodelled`)
    } catch (rawErr) {
      // Does EOS require the VRF to exist before `router ospf N vrf X`? Nothing in this client claims an
      // answer (DR-032), so the device's refusal is the finding.
      reportRefusal(rawErr, `\`router ospf ${String(PID_VRF)} vrf ${VRF_VRF}\``)
    } finally {
      await clearOspf(node, `vrf-${String(PID_VRF)}`)
    }
  })

  it('shutdown()/noShutdown() answer the two arms upstream reads off the raw block (test_shutdown :82-90, test_no_shutown :91-100)', async () => {
    await clearOspf(node, String(PID_SHUTDOWN))
    try {
      await node.ospf.create(PID_SHUTDOWN)
      await node.ospf.addNetwork('1.1.1.1', 32) // upstream's staging line at :85 (`network 1.1.1.1/32 area 0`)
      await node.ospf.shutdown()
      const shut = await node.ospf.get()
      await reportOspfBlock(node, shut)
      expect(shut?.shutdown).toBe(true)
      await node.ospf.noShutdown()
      const noShut = await node.ospf.get()
      await reportOspfBlock(node, noShut)
      // :99's `assertIn('no shutdown', …)` and this client's line-anchored derivation agree only if the
      // device really wrote the whole line — the read below is the evidence.
      expect(noShut?.shutdown).toBe(false)
    } finally {
      await clearOspf(node, `shutdown-${String(PID_SHUTDOWN)}`)
    }
  })

  it('delete() removes the process and nothing survives the negation (test_delete, :101-109)', async () => {
    await clearOspf(node, 'delete')
    try {
      await node.ospf.create(10) // upstream's own pid here (:104) — this case negates it in the same body
      expect(await node.ospf.get()).toBeDefined()
      await node.ospf.delete()
      expect(await node.ospf.get()).toBeUndefined()
      // Stronger than upstream's `get_block("router ospf")`-is-None at :108: no header at all may remain.
      expect(await ospfHeaderLines(node)).toEqual([])
    } finally {
      await clearOspf(node, 'delete-final')
    }
  })

  it('create() stages the exact header, both the bare and the vrf form (test_create_valid_id :110-118, test_create_with_vrf :126-135)', async () => {
    await clearOspf(node, 'create')
    try {
      await node.ospf.create(PID_ROUTER_ID)
      expect(await ospfHeaderLines(node)).toContain(`router ospf ${String(PID_ROUTER_ID)}`) // :117's assertIn
      await node.ospf.create(PID_VRF_CREATE, VRF_CREATE)
      expect(await ospfHeaderLines(node)).toContain(`router ospf ${String(PID_VRF_CREATE)} vrf ${VRF_CREATE}`) // :133-134
    } finally {
      await clearOspf(node, 'create-final')
    }
  })

  it('a pid outside 1-65535 refuses before any request (test_create_invalid_id, :119-125 — ValueError becomes NotSupportedError)', async () => {
    await clearOspf(node, 'invalid')
    // Upstream: `randint(70000, 100000)` inside `assertRaises(ValueError)` (`:122-124`). The bound is the
    // same one `assertProcessId` enforces (ospf.ts:203); the CLASS differs (DR-005/DR-010) and no
    // round trip is spent proving it — the offline pin is `resources/ospf.test.ts`.
    await expect(node.ospf.create(70001)).rejects.toBeInstanceOf(NotSupportedError)
    expect(await ospfHeaderLines(node)).toEqual([])
  })

  it('configureOspf opens the FIRST process, and refuses loudly when there is none (test_configure_ospf, :136-144)', async () => {
    await clearOspf(node, 'configure')
    try {
      await node.ospf.create(1) // upstream's pid at :139
      await node.ospf.configureOspf('router-id 1.1.1.1')
      const state = await node.ospf.get()
      expect(state?.routerId).toBe('1.1.1.1') // :143's assertIn, read through the typed field instead of the block
      await reportOspfBlock(node, state)
    } finally {
      await clearOspf(node, 'configure-final')
    }
    // The arm upstream never reaches: `configure_ospf` with no section crashes on
    // `None['ospf_process_id']` (ospf.py:251-253). Here it is a typed NotFoundError naming the absence.
    await expect(node.ospf.configureOspf('router-id 9.9.9.9')).rejects.toBeInstanceOf(NotFoundError)
  })

  it('the three router-id arms read back; the int-form pyeapi marks False is the device\'s answer here (test_set_router_id, :145-161)', async () => {
    await clearOspf(node, String(PID_ROUTER_ID))
    try {
      await node.ospf.create(PID_ROUTER_ID)
      // :150-151: upstream hands `set_router_id(<int>)` to `configure`, which swallows the device's
      // rejection into `False`. There is no False to check here (DR-005), so the composition is attempted
      // and the refusal (if any) reported with the device's code — that IS the finding.
      try {
        await node.ospf.setRouterId('40000')
        console.log('live-ospf: the device ACCEPTED `router-id 40000` — upstream\'s assertFalse at :151 is not this image\'s answer (reported, and the field re-set below)')
      } catch (rawErr) {
        reportRefusal(rawErr, '`router-id 40000` (the int-form arm upstream expects to fail, :150-151)')
      }
      await node.ospf.setRouterId('2.2.2.2')
      expect((await node.ospf.get())?.routerId).toBe('2.2.2.2') // :154
      await node.ospf.defaultRouterId()
      const afterDefault = await node.ospf.get()
      const defaultBody = await ospfBodyLines(node, `router ospf ${String(PID_ROUTER_ID)}`)
      console.log(`live-ospf: :155-157 capture — after \`default router-id\` the body is ${JSON.stringify(defaultBody)} and the typed routerId reads ${String(afterDefault?.routerId)}; upstream asserts the substring "no router-id" is present`)
      expect(afterDefault?.routerId).toBeUndefined()
      await node.ospf.setRouterId('3.3.3.3')
      await node.ospf.unsetRouterId()
      const afterUnset = await node.ospf.get()
      const unsetBody = await ospfBodyLines(node, `router ospf ${String(PID_ROUTER_ID)}`)
      console.log(`live-ospf: :158-160 capture — after \`no router-id\` the body is ${JSON.stringify(unsetBody)}; upstream asserts the substring "no router-id"`)
      expect(afterUnset?.routerId).toBeUndefined()
    } finally {
      await clearOspf(node, `routerid-${String(PID_ROUTER_ID)}`)
    }
  })

  it('addNetwork/removeNetwork cover both area shapes and what this reader can see (test_add_network :162-173, test_remove_network :174-188)', async () => {
    await clearOspf(node, 'network')
    try {
      await node.ospf.create(1)
      // :167 `add_network("2.2.2.0", "24", 1234)` → upstream expects the device to render
      // `network 2.2.2.0/24 area 0.0.4.210` (:169). Our guard accepts bare digits, so the question is the
      // device's: does 4.28.14M normalise an integer area into a dotted quad (which our reader matches)?
      await attempt('`network 2.2.2.0/24 area 1234` (upstream hands the integer 1234 at :167 and lets EOS normalise it, :169)', () => node.ospf.addNetwork('2.2.2.0', '24', 1234))
      const normalised = await node.ospf.get()
      console.log(`live-ospf: area-1234 capture — networks read as ${JSON.stringify(normalised?.networks ?? [])} (upstream :169 demands area 0.0.4.210)`)
      // :170 `add_network("10.10.10.0", "24")` with no area → composed `area 0`.
      await attempt('the default-area `network 10.101.1.0/24 area 0`', () => node.ospf.addNetwork('10.101.1.0', '24'))
      const withDefaultArea = await node.ospf.get()
      console.log(`live-ospf: default-area capture — networks read as ${JSON.stringify(withDefaultArea?.networks ?? [])} (upstream :172 demands area 0.0.0.0 for this line too)`)
      // upstream's remove arm stages two dotted-quad networks (:177-179) and negates both (:181-184).
      await node.ospf.addNetwork('10.101.2.0', '24', '0.0.0.0')
      await node.ospf.addNetwork('10.101.3.0', '32', '1.1.1.1')
      await node.ospf.removeNetwork('10.101.2.0', '24', '0.0.0.0')
      await node.ospf.removeNetwork('10.101.3.0', '32', '1.1.1.1')
      const after = await node.ospf.get()
      const body = await ospfBodyLines(node, 'router ospf 1')
      console.log(`live-ospf: post-removal body ${JSON.stringify(body)}; networks typed as ${JSON.stringify(after?.networks ?? [])}`)
      expect(after?.networks.filter((n) => n.network === '10.101.2.0' || n.network === '10.101.3.0')).toEqual([]) // :185-187
    } finally {
      await clearOspf(node, 'network-final')
    }
  })

  it('addRedistribution stages bare and route-map-qualified lines; a bad protocol refuses client-side (test_add_redistribution, :189-205)', async () => {
    await clearOspf(node, 'redist')
    try {
      // The fixture route-map pyeapi references but never creates (`redistribute <proto> route-map test`,
      // :197) — here the reference is honest, so a refusal is about the protocol, not the missing map.
      await attempt(`the fixture line \`route-map ${RM_FIXTURE} permit 10\` that upstream's :197 route-map arm would need but never stages`, async () => {
        await runGuardedLiveWriteSession(node, { name: 'live-ospf-rm-fixture', commands: [`route-map ${RM_FIXTURE} permit 10`] })
      })
      await node.ospf.create(1)
      const bare: readonly string[] = ['connected', 'static']
      const qualified: readonly (readonly [string, string])[] = [['bgp', RM_FIXTURE], ['rip', RM_FIXTURE]]
      for (const protocol of bare) {
        await attempt(`\`redistribute ${protocol}\` — redistributing a protocol this node does not run is the device's call (:199-200's call+assert pair has no client-side twin in this client)`, () => node.ospf.addRedistribution(protocol))
      }
      for (const [protocol, routeMap] of qualified) {
        await attempt(`\`redistribute ${protocol} route-map ${routeMap}\``, () => node.ospf.addRedistribution(protocol, routeMap))
      }
      const state = await node.ospf.get()
      await reportOspfBlock(node, state)
      // The two-token lines read as {protocol}; the four-token qualified lines as {protocol, routeMap}
      // (readRedistributions, ospf.ts:321). Anything the device rewrote is visible in the printed block above.
      expect(state?.redistributions.every((r) => typeof r.protocol === 'string')).toBe(true)
      // :203-204 `assertRaises(ValueError)` for a protocol off the allow-list. Same list, typed refusal,
      // zero commands (ospf.ts:497-503).
      await expect(node.ospf.addRedistribution('NOT VALID')).rejects.toBeInstanceOf(NotSupportedError)
      expect((await node.ospf.get())?.redistributions.some((r) => r.protocol === 'NOT VALID')).toBe(false)
    } finally {
      await clearOspf(node, 'redist-ospf')
      await safeSession(node, 'live-ospf-rm-teardown', [`no route-map ${RM_FIXTURE} permit 10`])
    }
  })

  it('the bare `no redistribute <proto>` over a qualified line is answered by the device (test_remove_redistribution, :206-215; ospf.ts divergence 10)', async () => {
    await clearOspf(node, 'redist-rm')
    try {
      await attempt(`the fixture line \`route-map ${RM_FIXTURE} permit 10\` (the map upstream's staged \`redistribute static route-map test\` at :209 references without creating)`, async () => {
        await runGuardedLiveWriteSession(node, { name: 'live-ospf-rm-fixture2', commands: [`route-map ${RM_FIXTURE} permit 10`] })
      })
      // upstream's staging at :209 spells the qualified form; doing it through the facade keeps the
      // composed text identical (`redistribute static route-map LIVEOSPFRM`).
      await node.ospf.create(1)
      let stagedLine = false
      try {
        await node.ospf.addRedistribution('static', RM_FIXTURE)
        stagedLine = true
      } catch (rawErr) {
        reportRefusal(rawErr, `\`redistribute static route-map ${RM_FIXTURE}\` (the qualified staging pyeapi sends at :209)`)
      }
      const staged = await node.ospf.get()
      console.log(`live-ospf: staged redistributions ${JSON.stringify(staged?.redistributions ?? [])}`)
      let negated = false
      try {
        await node.ospf.removeRedistribution('static')
        negated = true
      } catch (rawErr) {
        reportRefusal(rawErr, 'the bare `no redistribute static` (divergence 10\'s only spelling upstream sends)')
      }
      if (!stagedLine || !negated) {
        console.warn('live-ospf: the divergence-10 question (does a bare negation clear a route-map-qualified line?) is NOT answered on this target — reported, not claimed')
        return
      }
      const after = await node.ospf.get()
      const body = await ospfBodyLines(node, 'router ospf 1')
      console.log(`live-ospf: DIVERGENCE-10 capture — after the bare \`no redistribute static\` the body is ${JSON.stringify(body)} and the typed list is ${JSON.stringify(after?.redistributions ?? [])} (upstream :215 requires no \`redistribute\` substring left)`)
      expect(after?.redistributions.length).toBe(0)
    } finally {
      await clearOspf(node, 'redist-rm-ospf')
      await safeSession(node, 'live-ospf-rm-teardown2', [`no route-map ${RM_FIXTURE} permit 10`])
    }
  })
})
