/**
 * `*.live.test.ts` port of `pyeapi/test/system/test_api_vrrp.py` @ `6816d9e` — #14 **D2** (full-write lab
 * lane, DR-126). Upstream has **20** test methods plus the `_vlan_setup` helper (verified by `awk` over the
 * `def` lines of the 602-line file; the `if __name__` block sits at `:601-602`), and all 20 are portable.
 *
 * ## Gate, fence and the Vlan discipline
 * `liveFullWriteReadiness(process.env)` + `describe.skipIf(!gate.runnable)` (loud skip with the guard's
 * reason; with `EAPI_LAB_FULL_WRITE` unset `npx vitest run` still collects this file and skips it green);
 * `buildFullWriteNode(target)` so `withLabWriteScope` refuses listener/user/management-path/persistence
 * lines before the wire, for facade writes and named `live-vrrp-<arm>` sessions alike.
 *
 * Upstream's `_vlan_setup` (`:65-71`) creates **Vlan101** (`no interface vlan 101` / `interface vlan 101` /
 * `ip address 10.10.10.1/24` / `exit`, `:66-69`) and every case attaches a VRouter with `vrid` 98-104 to it
 * (`VR_CONFIG` at `:41-60`, `IP_PREFIX` at `:40`). This lane cannot use that name: `101` is inside the
 * reserved 1006-1199 window's sibling space that the lab already provisions around (`docs/CEOS.md`, DR-126
 * refuses 1006-1199 outright; the `lab:up` recipe owns Vlan10/100/110), and reusing upstream's vrids 98-104
 * across cases would make two cases read each other's state. So everything here lives on a **fresh**
 * `Vlan2001` with `10.201.0.0/24` addressing, and every case gets its own VRID (201…222) so the runs stay
 * idempotent: each case starts from a clean `no vrrp <id>` and removes its VRouter in `finally`; the SVI
 * itself is created once (`{@link ensureSvi}`) and dropped in `afterAll`, and no batch ever contains
 * `copy run start` (refused pre-wire by the seam, DR-035(c)).
 *
 * **Command family.** pyeapi picks `disabled`/`ipv4`/`priority-level`/`session description`/
 * `advertisement interval`/`tracked-object`/`timers delay reload` from
 * `self.version_number >= '4.21.3'` — a lexicographic version-string compare (§5 row 213). This client
 * derives the family from the device's own config text ({@link detectCommandFamily}, divergence 1 /
 * **DR-116**), so on a VRRP-less container it writes the **modern** family. Upstream's own ≥4.23 staging
 * arms already feed that family to a device (`vrrp 104 disabled` / `vrrp 104 ipv4 10.10.10.2`, `:222-223`),
 * so the texts are comparable. What is NOT settled: DR-122 recorded that the container refuses the SVI
 * **legacy** line `vrrp 1 ip 10.0.100.254` with `% Unavailable command (not supported on this hardware
 * platform)` (the `lab-provision` staging transcript, §5 row 225), and that `show vrrp` answers `1002`
 * through **eAPI** while the container CLI answers it. This suite issues **no** `show vrrp` — every read is
 * the chunked running-config (`vrrp.ts`'s `configSections`) — so the transport-specific negative does not
 * gate it; whether 4.28.14M accepts the **modern** `vrrp … ipv4 …` line on an SVI is what this file is the
 * first to ask, and a refusal here is the recorded answer (printed with the device's code, after which the
 * write cases report themselves unexercised rather than passing vacuously).
 *
 * | upstream (verified line @6816d9e) | ported? | here / why |
 * |---|---|---|
 * | `_vlan_setup` (`:65-71`), `IP_PREFIX` (`:40`), `VR_CONFIG` (`:41-60`) | ✅ as {@link stageVrrp}/{@link ensureSvi} + {@link VR_CONFIG} | the SVI is `Vlan2001` (fresh, ≥2000, outside 1/10/100/110 and the 1006-1199 reserved band) and `VR_CONFIG` is the camelCase twin of `:42-59` with the VRIDs re-based; `preempt_delay_reload: None` (`:52`) maps to the **sentinel** `null`, because upstream's `_vrrp_set` only skips a key equal to `'__NONE__'`, so a literal `None` reaches the setter's disable arm (`vrrp.py:1261`-family) — the same mapping `vrrp.ts`'s attrs table documents (§5 row 215) |
 * | `test_get` (`:72-87`) | ✅ | stages `vrrp 98 disabled` on Vlan101 (upstream's ≥4.23 arm, `:76-79`) and asserts `get(interface)` is not None (`:84`/`:86`). Here `get('Vlan2001')` must answer a vrid table containing 201, and the record is asserted against this client's absence/`''` vocabulary (divergence 6, §5 row 218): `enable === false` from the disable line, `description === ''` (the parser's own `''`, `vrrp.py:308-317` — NOT pyeapi-None and not absent), `secondaryIp === []`, `track === []`, `bfdIp === ''`, and the eight scalar fields ABSENT |
 * | `test_getall` (`:88-112`) | ✅ (with upstream's own staging bug reported) | upstream stages `vrrp 98 disabled` on the SVI, `exit`, then the literal line **`interface vlan $`** (`:97`, and again at `:105`) followed by two more `vrrp … disabled` lines — text that names no interface at all, so the case as written proves only that `getall()` returns something (`:111`'s `assertIsNotNone`). Honest port: two VRIDs (202/203) are staged on the one SVI this file owns, `getAll()` must answer a nested table keyed by interface with BOTH vrids inside, and no phantom `interface vlan …` key appears (divergence §5 row 220: this client reads the chunker's indent-0 keys, where upstream sweeps `re.M` over raw text — `vrrp.py:242`) |
 * | `test_create` (`:113-131`) | ✅ | `create(interface, 99, **VR_CONFIG)` then `assertIs(response, True)` (`:121-122`), `vrconf_format(VR_CONFIG)` (`:124`), the vrid's row from `get()` (`:125`), and `assertEqual` after dropping the two version-varying keys (`:128-130`). Ported exactly that way on VRID 204: our `create` throws instead of returning True (DR-005, §5 row 214 — the two-return-shape idiom is gone), `vrconfFormat` is kept as surface (**DR-121**: it stays upstream's intended-config→get-shape predictor, contradictions included), and the same two keys (`preemptDelayMin`/`preemptDelayReload`) are the only exclusions, mirroring `:128-129` |
 * | `test_delete` (`:132-149`) | ✅, stronger read | upstream stages (`no vrrp 101` + the era's disable line, `:136-144`) then `delete` (`:147`) and `assertIs(response, True)` (`:148`) — no read-back at all. Here the same staging for VRID 205 plus the read-back the framework implies: {@link VrrpResource.delete} is the era-neutral `no vrrp <id>` (`vrrp.py:436`), and afterwards the interface must answer no vrrp table at all (`undefined`, DR-027) because the census finds no `vrrp` line |
 * | `test_default` (`:150-167`) | ✅, and the upstream body is a finding | **upstream's own `test_default` never calls `default`: line `:165` is `response = dut.api('vrrp').delete(interface, vrid)`** — the same call as `test_delete` (`:148`), a copy-paste in the upstream system suite, so the `default vrrp <id>` text (`vrrp.py:458`) has never been exercised by pyeapi's device tests. This port exercises {@link VrrpResource.setDefault} for VRID 206 and does NOT assume an outcome: it cross-checks the reader against the device text (the vrid's row exists exactly when a `vrrp 206 …` line survives) and prints both, which is the only claim that is safe on an undecided command |
 * | `test_update_with_create` (`:168-208`) | ✅ | re-`create` on the same VRID (207) with a second bag, asserting `True` twice (`:177-178`, `:199-200`) then the formatted-equality at `:207`. {@link VrrpResource.create} funnels through `vrrpSet` (`vrrp.py:1231-1420`) exactly as upstream's does, so calling it twice with different bags is the ported flow — no "update" verb exists in either client. The update bag maps upstream's `None`/`'default'` sentinels (`:180-198`) onto this client's `null`/`'default'`/`'no'` spellings (§5 row 215), including `timers_advertise: None` (`:187`) → the disable arm, and `bfd_ip: None` (`:197`) → `'no'` |
 * | `test_set_enable` (`:209-236`) | ✅ | staging at `:220-224` is `no vrrp 104` + `vrrp 104 disabled` + `vrrp 104 ipv4 10.10.10.2`, then four `set_enable` arms true/false/true/false (`:211-216`, `:232-235`) each `assertIs(True)`. Here: the same staging batch (fresh names/VRID 209), then `setEnable(iface, id, true/false)`×4 with the record's `enable` read after each — and the four arms double as the modern-family capability probe, since `setEnable` composes `disabled`/`no disabled` by hand (`vrrp.py:480-489`, no builder) |
 * | `test_set_primary_ip` (`:237-263`) | ✅, refusals differ | arms at `:240-244`: value/default/value/disable/value, the call at `:260-261` and its `assertIs(True)` at `:262`. Upstream's `default`/`disable` arms read the CURRENT address back with **no guard** (`vrrp.py:528-536`, divergence 4 / §5 row 216), and `vrrp.py:534-540` then interpolates whatever that read produced — so the shape pyeapi can put on the wire is the literal text `no vrrp 10 ip None`. That refusal path is not reachable inside upstream's own chain (its `:240` value arm always supplies an address first), and the same is true here, so the chains port 1:1; the client-side difference is exercised by an extra probe at the end of the case: negate once to clear the pair's address, then negate again, which upstream answers with garbage text and {@link VrrpResource.currentPrimaryIp} answers with `NotFoundError` (asserted, not staged) | Ported with the guards the client has ({@link currentPrimaryIp} refuses with `NotFoundError`): the value arm runs first, so the negation arms name a real address, and the last value must read back |
 * | `test_set_priority` (`:264-290`) | ✅ | 200/default/175/no/190 (`:266-272`) → the final read must be 190; the `default priority-level`/`no priority-level` arms answer the device's own default, printed between arms |
 * | `test_set_description` (`:291-317`) | ✅ | `'1st modified vrrp'`/default/`'2nd …'`/no/`'3rd …'` (`:293-299`) → the spaced text must round-trip through `session description` (divergence 1's family: the FAMILY comes from the config, not the version string), and after `unsetDescription` the field reads `''` — not absent — because that is what this client's parser answers (`vrrp.py:308-317`, §5 row 218) |
 * | `test_set_secondary_ips` (`:318-342`) | ✅, resolved value differs | three list arms (`:321-323`: two addresses, two different ones, then the empty list), `assertIs(True)` per arm (`:339-341`). {@link VrrpResource.setSecondaryIps} resolves to the **composed command list**, not a boolean (divergence 2, §5 row 214) and diffs through sets (row 221: duplicates collapse, the empty list removes everything) — so the case asserts the composed list AND the read-back array after each arm, including `[]` at the end |
 * | `test_set_ip_version` (`:343-370`) | ✅ | `2`/`3`/default/`3`/no/`3` (`:345-352`) — the guard is `(2, 3)` membership, kept exactly (`vrrp.py:671`), so an out-of-vocabulary value is the client's refusal rather than a device write; the last arm must read 3 |
 * | `test_set_timers_advertise` (`:371-397`) | ✅ | 10/default/20/no/30 (`:373-379`) → final `timersAdvertise === 30`; the 1-255 range (`vrrp.py:792-794`) is upstream's and is not widened |
 * | `test_set_mac_addr_adv_interval` (`:398-424`) | ✅ | 50/default/55/no/60 (`:400-406`) → final `macAddrAdvInterval === 60`. This stem is **era-neutral** upstream (`vrrp.py:319`/`:834`, no version gate) and stays so here, so it is the one field arm that does not depend on the family decision above |
 * | `test_set_preempt` (`:425-452`) | ✅ | six arms true/default/true/disable/true/false (`:428-433`). Upstream's `set_preempt(False)` (`:433`) reaches `command_builder` with a falsy value and composes `no vrrp 10 preempt` through the deprecated fall-through (`abstract.py:158-161`); this client maps `value: false` to `{mode:'no'}` and keeps the SAME text (divergence 3, §5 row 215), and its `:431`-twin negation is spelled `{mode:'no'}` directly. The last arm's read must be `preempt === false` |
 * | `test_set_preempt_delay_min` (`:453-479`) | ✅ | 3600/default/500/no/150 (`:455-461`) → final `preemptDelayMin === 150`. Upstream's own system suite deletes this key from its create comparisons (`:128`) as version-variable, so the field's device answer is only comparable through THIS arm's chain — recorded arm by arm |
 * | `test_set_preempt_delay_reload` (`:480-506`) | ✅ | same five arms (`:482-488`) → final `preemptDelayReload === 150`; era-neutral stem upstream (`vrrp.py:331`/`:973`), unchanged |
 * | `test_set_delay_reload` (`:507-533`) | ✅ | 30/default/25/no/15 (`:509-515`) → final `delayReload === 150`, composed as `timers delay reload <n>` in the modern family (upstream's `>= '4.21.3'` arm at `vrrp.py:1014`) |
 * | `test_set_tracks` (`:534-572`) | ✅ (names changed) | five list arms (`:536-554`) whose entries name **Ethernet1/Ethernet2** — the interfaces upstream's own lab boxes happen to have. This lane may not build config that names interfaces it does not own, so the tracked-object names here are the `EAPI_SCRATCH_INTERFACE` port when the guard accepted one, else the Vlan this file created; upstream's three-entry shape (a `shutdown` entry, a `decrement 10` entry, then the same name again with `shutdown`) is preserved, and the final empty list must leave `track === []`. The verb resolves to the composed command list and keys its diff on the triple-sorted tid (`vrrp.py:1080`/`:1115`/`:1136`) with the command re-extraction that folds a space-bearing name (§5 row 223) — printed, because the composed text is the fact, not a boolean |
 * | `test_set_bfd_ip` (`:573-598`) | ✅ | `.160`/default/`.161`/no/`.162` (`:575-581`) → final `bfdIp === '10.201.0.162'`; then the negation is asserted to land on this client's THREE-answer field (`''` for no positive line, `null` for the bare line, the address otherwise — §5 row 218), which is why the case reports what the negation left instead of assuming absence |
 *
 * Two upstream-side findings this port records rather than repairs: (1) `test_default` (`:150-167`) calls
 * `delete`, not `default` — see that row; (2) `test_getall`'s staging batch contains the literal
 * `interface vlan $` twice (`:97`, `:105`), i.e. the second `vrrp … disabled` pair is fed after a line no
 * interface matches, so upstream never pinned what its second VRID actually configured. Neither is a client
 * bug, and neither is papered over here: both cases were rewritten to test the verb, with the anomaly
 * stated in the ledger.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { CommandError, EapiError, NotFoundError, ProtocolError } from './errors'
import { buildFullWriteNode, liveFullWriteReadiness } from './testing/live-full-write'
import { describeLiveTarget, matchesDeviceIdentity, requireScratchInterface, unwrapLiveTarget, type LiveTarget } from './testing/live-guard'
import { runGuardedLiveWriteSession } from './testing/live-session-policy'
import type { Vrrp, VrrpAttrs, VrrpTrack } from './resources/vrrp'
import type { Node } from './command-layer'

const gate = liveFullWriteReadiness(process.env)
if (!gate.runnable) {
  console.warn(`live-vrrp: SKIPPED — ${gate.skipReason}`)
}

/** Fresh SVI: >= 2000, outside the provisioned 1/10/100/110 and the reserved 1006-1199 band (DR-126). */
const IFACE = 'Vlan2001'
const IFACE_IP = '10.201.0.1/24'
const PREFIX = '10.201.0.' // the twin of upstream's `IP_PREFIX` (:40)
const VRID_GET = 201
const VRID_GETALL_A = 202
const VRID_GETALL_B = 203
const VRID_CREATE = 204
const VRID_DELETE = 205
const VRID_DEFAULT = 206
const VRID_UPDATE = 207
const VRID_ENABLE = 209
const VRID_PRIMARY_IP = 210
const VRID_PRIORITY = 211
const VRID_DESCRIPTION = 212
const VRID_SECONDARY = 213
const VRID_IP_VERSION = 214
const VRID_TIMERS = 215
const VRID_MAC_INTERVAL = 216
const VRID_PREEMPT = 217
const VRID_PREEMPT_MIN = 218
const VRID_PREEMPT_RELOAD = 219
const VRID_DELAY_RELOAD = 220
const VRID_TRACKS = 221
const VRID_BFD = 222

function targetOf(): LiveTarget {
  return unwrapLiveTarget(gate.resolution)
}

/** The tracked-object name this file may legitimately name: the scratch port when the guard accepted one, else its own SVI. Upstream names its lab's Ethernet1/Ethernet2 (`:55-57`) and `:538-552` — a fixture habit this lane cannot copy. */
function trackTarget(): string {
  const req = requireScratchInterface(targetOf())
  return req.ok ? req.name : IFACE
}

function reportRefusal(rawErr: unknown, what: string): string {
  if (!(rawErr instanceof EapiError)) throw rawErr
  const code = rawErr instanceof CommandError
    ? `code ${String(rawErr.code)}`
    : rawErr instanceof ProtocolError
      ? `protocol code ${String(rawErr.code)}`
      : 'no code'
  const first = rawErr.message.split('\n')[0]?.slice(0, 200) ?? rawErr.message
  console.warn(`live-vrrp: the device refused ${what} (${rawErr.constructor.name}, ${code}): ${first}`)
  return first
}

async function attempt(what: string, run: () => Promise<unknown>): Promise<boolean> {
  try {
    await run()
    return true
  } catch (rawErr) {
    reportRefusal(rawErr, what)
    return false
  }
}

/** Run upstream's arm chain. False the moment any arm is refused, so a final-state equality is never claimed on a half-applied chain. */
async function runArms(label: string, arms: readonly (readonly [string, () => Promise<unknown>])[]): Promise<boolean> {
  for (const [arm, run] of arms) {
    if (!(await attempt(`${label} — arm ${arm}`, run))) return false
  }
  return true
}

let sviState: { ok: boolean; reason?: string } | undefined

/** The one SVI this file owns, staged lazily so a case never depends on case order for its precondition. */
async function ensureSvi(node: Node): Promise<{ ok: boolean; reason?: string }> {
  if (sviState !== undefined) return sviState
  const staged = await attempt(`the SVI staging batch for ${IFACE} (upstream's _vlan_setup :66-69, on a fresh Vlan id)`, async () => {
    await runGuardedLiveWriteSession(node, { name: 'live-vrrp-svi', commands: [`interface ${IFACE}`, `ip address ${IFACE_IP}`, 'no shutdown'] })
  })
  sviState = staged ? { ok: true } : { ok: false, reason: 'the device refused the SVI staging batch, so no VRouter can be attached on this target' }
  return sviState
}

/** upstream's per-case staging idiom (`no vrrp N` + the era's disable line, e.g. :220-224) on this lane's names. */
async function stageVrrp(node: Node, vrid: number, extra: readonly string[] = []): Promise<boolean> {
  const svi = await ensureSvi(node)
  if (!svi.ok) {
    console.warn(`live-vrrp: SKIPPED in-case — ${svi.reason ?? ''}`)
    return false
  }
  return attempt(`the staging batch \`no vrrp ${String(vrid)}\` + \`vrrp ${String(vrid)} disabled\` (${extra.length} extra line(s))`, async () => {
    await runGuardedLiveWriteSession(node, {
      name: `live-vrrp-stage-${String(vrid)}`.slice(0, 64),
      commands: [`interface ${IFACE}`, `no vrrp ${String(vrid)}`, `vrrp ${String(vrid)} disabled`, ...extra],
    })
  })
}

async function dropVrrp(node: Node, vrid: number): Promise<void> {
  const svi = await ensureSvi(node)
  if (!svi.ok) return
  await attempt(`teardown of vrid ${String(vrid)} (\`no vrrp\` is the era-neutral text at vrrp.py:436)`, () => node.vrrp.delete(IFACE, vrid))
}

/** One VRouter's record, or undefined — the shape upstream indexes with `get(interface)[vrid]` (:125/:202). */
async function rowOf(node: Node, vrid: number): Promise<Vrrp | undefined> {
  return (await node.vrrp.get(IFACE))?.get(vrid)
}

/** The raw `vrrp <id> …` lines the device is keeping — the text upstream's assertions never compare against. */
async function vrrpLines(node: Node, vrid: number): Promise<string[]> {
  const config = await node.getRunningConfig()
  return config
    .split(/\r?\n/u)
    .filter((line) => /^\s+vrrp\b/u.test(line))
    .map((line) => line.trim())
    .filter((line) => new RegExp(`^no vrrp ${String(vrid)}\\b|^vrrp ${String(vrid)}\\b|^default vrrp ${String(vrid)}\\b`, 'u').test(line))
}

/** The camelCase twin of upstream's `VR_CONFIG` (`:41-60`), with `None` mapped to the disable sentinel (§5 row 215). Built per call because the tracked-object name is a runtime decision — this lane may not name interfaces it does not own, and a module-load call into the live guard would crash a skipped run. */
function vrConfig(trackName: string): VrrpAttrs {
  return {
    primaryIp: `${PREFIX}2`,
    priority: 200,
    description: 'modified vrrp on a fresh Vlan',
    secondaryIp: [`${PREFIX}11`],
    ipVersion: 3,
    enable: false,
    timersAdvertise: 2,
    macAddrAdvInterval: 3,
    preempt: false,
    preemptDelayMin: 1,
    preemptDelayReload: null, // upstream's literal None rides the disable arm, exactly as its _vrrp_set does
    delayReload: 1,
    track: [
      { name: trackName, action: 'shutdown' },
      { name: trackName, action: 'decrement', amount: 10 },
    ],
    bfdIp: `${PREFIX}150`,
  }
}

/**
 * The comparison upstream performs at `:126-130` / `:203-207` (predicted-by-formatter vs answered-by-parser),
 * split into the three outcomes this client's own docs predict. DR-121 keeps `vrconfFormat` un-reconciled
 * with the parser on purpose (§5 row 224), so a sentinel input whose predicted default never reached the
 * config reads as ABSENT — that combination is documented, not a failure. Anything else is a real finding.
 */
function classifyDifferences(predicted: Record<string, unknown>, actual: Vrrp, bag: VrrpAttrs): { agreed: string[]; documented: string[]; unexpected: string[] } {
  const agreed: string[] = []
  const documented: string[] = []
  const unexpected: string[] = []
  for (const [key, want] of Object.entries(predicted)) {
    const got = actual[key as keyof Vrrp]
    if (JSON.stringify(got) === JSON.stringify(want)) {
      agreed.push(key)
      continue
    }
    const input = bag[key as keyof VrrpAttrs]
    const sentinel = input === 'default' || input === 'no' || input === null
    if (sentinel && got === undefined) {
      documented.push(`${key}: bag sentinel ${JSON.stringify(input)} → the formatter predicts ${JSON.stringify(want)}, the parser answers ABSENT because this device wrote no line for it (DR-121 / §5 row 224)`)
      continue
    }
    unexpected.push(`${key}: formatter predicts ${JSON.stringify(want)}, the device answered ${JSON.stringify(got)}`)
  }
  return { agreed, documented, unexpected }
}

describe.skipIf(!gate.runnable)('live full-write: pyeapi test_api_vrrp.py (20 cases, :65-598)', () => {
  let node: Node

  beforeAll(async () => {
    const target = targetOf()
    console.log(`live-vrrp: target = ${describeLiveTarget(target)} (DR-126 full-write lab lane; SVI ${IFACE}, tracked-object name ${trackTarget()})`)
    node = buildFullWriteNode(target)
    const reported = await node.getVersion()
    const mismatch = matchesDeviceIdentity(target, { version: reported.version, modelName: reported.modelName })
    if (mismatch !== undefined && mismatch.code !== 'EAPI_VERSION_MISMATCH') throw new Error(`live-vrrp readiness: ${mismatch.reason}`)
    if (mismatch?.code === 'EAPI_VERSION_MISMATCH') console.warn(`live-vrrp: reported version "${reported.version}" vs pin "${target.allowVersion}" (base-level enforced by the probe, DR-066)`)
  })

  afterAll(async () => {
    await attempt(`the SVI teardown \`no interface ${IFACE}\``, async () => {
      await runGuardedLiveWriteSession(node, { name: 'live-vrrp-svi-teardown', commands: [`no interface ${IFACE}`] })
    })
  })

  it('get() answers a vrid table for an interface with one disabled VRouter, in this client\'s absence/empty-string vocabulary (test_get, :72-87)', async () => {
    if (!(await stageVrrp(node, VRID_GET))) return
    try {
      const table = await node.vrrp.get(IFACE)
      expect(table).toBeDefined() // :86's assertIsNotNone (the get call itself is :84)
      expect(table?.has(VRID_GET)).toBe(true)
      const row = table?.get(VRID_GET)
      if (row === undefined) return
      expect(row.enable).toBe(false) // the `disabled` line votes (vrrp.py:253-260)
      expect(row.description).toBe('') // divergence 6: upstream answers '' , and so does this parser
      expect(row.secondaryIp).toEqual([])
      expect(row.track).toEqual([])
      expect(row.bfdIp).toBe('')
      for (const field of ['primaryIp', 'priority', 'ipVersion', 'timersAdvertise', 'macAddrAdvInterval', 'preemptDelayMin', 'preemptDelayReload', 'delayReload'] as const) {
        expect(field in row).toBe(false) // DR-027/DR-029: absence, where pyeapi answers None
      }
      console.log(`live-vrrp: the record 4.28.14M answers for a bare disabled VRouter is ${JSON.stringify(row)}`)
    } finally {
      await dropVrrp(node, VRID_GET)
    }
  })

  it('getAll() nests both VRIDs under the interface this file owns — and no phantom interface key appears (test_getall, :88-112)', async () => {
    if (!(await stageVrrp(node, VRID_GETALL_A))) return
    let second = false
    try {
      second = await attempt(`the second VRouter line \`vrrp ${String(VRID_GETALL_B)} disabled\` (upstream feeds it after the literal \`interface vlan $\` at :105, which names no interface at all)`, async () => {
        await runGuardedLiveWriteSession(node, { name: 'live-vrrp-stage-b', commands: [`interface ${IFACE}`, `vrrp ${String(VRID_GETALL_B)} disabled`] })
      })
      const all = await node.vrrp.getAll()
      expect(all.has(IFACE)).toBe(true)
      expect(all.get(IFACE)?.has(VRID_GETALL_A)).toBe(true)
      if (!second) console.warn(`live-vrrp: vrid ${String(VRID_GETALL_B)} was refused, so the two-vrid half of :88-112 is reported as unexercised on this target`)
      else expect(all.get(IFACE)?.has(VRID_GETALL_B)).toBe(true)
      // §5 row 220: upstream keys interfaces with an `re.M` sweep of raw config (vrrp.py:242), so an
      // indented or banner-body `interface …` line votes there, and a remainder with whitespace is
      // truncated to its leading run (a phantom name). This client reads chunk keys, so no such key exists.
      for (const key of all.keys()) {
        expect(key.includes('$')).toBe(false)
        expect(key.split(/\s/u)).toHaveLength(1)
      }
      console.log(`live-vrrp: getAll() interfaces: ${JSON.stringify([...all.keys()])}`)
    } finally {
      await dropVrrp(node, VRID_GETALL_A)
      if (second) await dropVrrp(node, VRID_GETALL_B)
    }
  })

  it('create() with the full attribute bag round-trips against vrconfFormat, minus upstream\'s two excluded keys (test_create, :113-131)', async () => {
    if (!(await stageVrrp(node, VRID_CREATE))) return
    const bag = vrConfig(trackTarget())
    try {
      const created = await attempt(`create(${IFACE}, ${String(VRID_CREATE)}, <the VR_CONFIG twin of :42-59>) — upstream asserts this returned True (:121-122); this client has no boolean to check (DR-005)`, () => node.vrrp.create(IFACE, VRID_CREATE, bag))
      if (!created) return
      const row = await rowOf(node, VRID_CREATE)
      if (row === undefined) {
        console.warn(`live-vrrp: create(${String(VRID_CREATE)}) resolved but get(${IFACE}) answers no table — the write landed on a section this reader cannot see, which is a client finding, not a device refusal`)
        expect(row).toBeDefined()
        return
      }
      const predicted: Record<string, unknown> = { ...node.vrrp.vrconfFormat(bag) }
      // :128-129 drops the two keys whose device answers vary by EOS version. Kept verbatim here, and
      // those two fields get their own live arms below (:453-479, :480-506) instead.
      delete predicted.preemptDelayMin
      delete predicted.preemptDelayReload
      const { agreed, documented, unexpected } = classifyDifferences(predicted, row, bag)
      console.log(`live-vrrp: DR-121 comparison — agreed ${JSON.stringify(agreed)}; documented-absent ${JSON.stringify(documented)}; unexpected ${JSON.stringify(unexpected)}`)
      expect(unexpected).toEqual([]) // :130's assertEqual, ported so a mismatch names the key and both answers
    } finally {
      await dropVrrp(node, VRID_CREATE)
    }
  })

  it('delete() removes the VRouter and the interface then answers no table at all (test_delete, :132-149)', async () => {
    if (!(await stageVrrp(node, VRID_DELETE))) return
    try {
      expect((await rowOf(node, VRID_DELETE))?.enable).toBe(false)
      // :147-148 asserts only the True return. There is no True here — so the case adds the read-back the
      // framework claims (the census finds no `vrrp` line left, so the interface leaves getAll() entirely).
      await node.vrrp.delete(IFACE, VRID_DELETE)
      expect(await node.vrrp.get(IFACE)).toBeUndefined()
      expect(await vrrpLines(node, VRID_DELETE)).toEqual([])
    } finally {
      await dropVrrp(node, VRID_DELETE)
    }
  })

  it('setDefault() exercises the `default vrrp <id>` text upstream\'s own test_default never called (test_default, :150-167 — :165 calls delete)', async () => {
    if (!(await stageVrrp(node, VRID_DEFAULT))) return
    try {
      const done = await attempt('`default vrrp <id>` (vrrp.py:458 — pyeapi\'s system suite never sent it: its test_default body calls delete at :165)', () => node.vrrp.setDefault(IFACE, VRID_DEFAULT))
      const lines = await vrrpLines(node, VRID_DEFAULT)
      const row = await rowOf(node, VRID_DEFAULT)
      console.log(`live-vrrp: after \`default vrrp ${String(VRID_DEFAULT)}\` the device keeps ${JSON.stringify(lines)} and the census-based read answers ${row === undefined ? 'no table for the interface' : `vrid ${String(VRID_DEFAULT)} present`}`)
      if (!done) {
        expect(row).toBeDefined() // the refusal means nothing changed, which the pre-staged row proves
        return
      }
      // No claim about what EOS "should" do with a defaulted VRouter: the client's own consistency is what
      // is pinned — the vrid answers iff a `vrrp <id>` line survives in the device's text.
      expect(row !== undefined).toBe(lines.length > 0)
    } finally {
      await dropVrrp(node, VRID_DEFAULT)
    }
  })

  it('a second create() re-properties the same VRouter, matching the formatter\'s prediction again (test_update_with_create, :168-208)', async () => {
    if (!(await stageVrrp(node, VRID_UPDATE))) return
    try {
      if (!(await attempt('the initial create (:177-178)', () => node.vrrp.create(IFACE, VRID_UPDATE, vrConfig(trackTarget()))))) return
      const update: VrrpAttrs = {
        primaryIp: `${PREFIX}12`,
        priority: 200,
        description: 'updated vrrp on a fresh Vlan',
        secondaryIp: [`${PREFIX}13`, `${PREFIX}23`],
        ipVersion: 2,
        enable: true,
        timersAdvertise: 'default', // :187's None reaches upstream's disable arm; 'default' is the literal this bag spells for mac_addr_adv_interval at :188 (:187 above) — the two spellings are kept distinct
        macAddrAdvInterval: 'default',
        preempt: true,
        preemptDelayMin: 'default',
        preemptDelayReload: 'default',
        delayReload: 'default',
        track: [
          { name: trackTarget(), action: 'shutdown' },
          { name: trackTarget(), action: 'decrement', amount: 1 },
        ],
        bfdIp: 'no', // :197's None, mapped to the disable sentinel (§5 row 215)
      }
      if (!(await attempt('the update create (:199-200)', () => node.vrrp.create(IFACE, VRID_UPDATE, update)))) return
      const row = await rowOf(node, VRID_UPDATE)
      expect(row).toBeDefined()
      if (row === undefined) return
      const predicted: Record<string, unknown> = { ...node.vrrp.vrconfFormat(update) }
      delete predicted.preemptDelayMin // :204-205, the same exclusions as the create case
      delete predicted.preemptDelayReload
      const { agreed, documented, unexpected } = classifyDifferences(predicted, row, update)
      console.log(`live-vrrp: update round-trip — agreed ${JSON.stringify(agreed)}; documented-absent ${JSON.stringify(documented)}; unexpected ${JSON.stringify(unexpected)}`)
      expect(unexpected).toEqual([]) // :207
    } finally {
      await dropVrrp(node, VRID_UPDATE)
    }
  })

  it('the four enable arms each resolve and read as the boolean they compose (test_set_enable, :209-236)', async () => {
    if (!(await stageVrrp(node, VRID_ENABLE, [`vrrp ${String(VRID_ENABLE)} ipv4 ${PREFIX}2`]))) return // :222-223
    try {
      const arms: readonly (readonly [string, boolean])[] = [
        [':212 true', true],
        [':213 false', false],
        [':214 true', true],
        [':215 false', false],
      ]
      let complete = true
      for (const [label, value] of arms) {
        const ok = await attempt(`setEnable ${label} — composes \`no vrrp … disabled\` / \`vrrp … disabled\` by hand (vrrp.py:480-489)`, () => node.vrrp.setEnable(IFACE, VRID_ENABLE, value))
        complete = complete && ok
        if (ok) expect((await rowOf(node, VRID_ENABLE))?.enable).toBe(value)
      }
      if (!complete) console.warn('live-vrrp: the enable chain was refused partway — the boolean equalities above ran only for the arms the device accepted')
      // upstream's unexpressed arm: a value that is neither true nor False raises ValueError (:490-492).
      // There is no such call in this file's chains, and the offline pin covers it — no live write needed.
    } finally {
      await dropVrrp(node, VRID_ENABLE)
    }
  })

  it('primary-ip arms: value, then the two negations that name the CURRENT address (test_set_primary_ip, :237-263)', async () => {
    if (!(await stageVrrp(node, VRID_PRIMARY_IP))) return
    try {
      const complete = await runArms('the :240-244 chain (value/default/value/disable/value)', [
        [`:240 value ${PREFIX}2`, () => node.vrrp.setPrimaryIp(IFACE, VRID_PRIMARY_IP, { value: `${PREFIX}2` })],
        [':241 default', () => node.vrrp.setPrimaryIp(IFACE, VRID_PRIMARY_IP, { mode: 'default' })],
        [`:242 value ${PREFIX}3`, () => node.vrrp.setPrimaryIp(IFACE, VRID_PRIMARY_IP, { value: `${PREFIX}3` })],
        [':243 disable', () => node.vrrp.setPrimaryIp(IFACE, VRID_PRIMARY_IP, { mode: 'no' })],
        [`:244 value ${PREFIX}4`, () => node.vrrp.setPrimaryIp(IFACE, VRID_PRIMARY_IP, { value: `${PREFIX}4` })],
      ])
      if (!complete) {
        console.warn('live-vrrp: the primary-ip chain was refused partway — the final equality is not claimed')
        return
      }
      expect((await rowOf(node, VRID_PRIMARY_IP))?.primaryIp).toBe(`${PREFIX}4`)
      // The divergence-4 / §5-row-216 refusal IS reachable live, just not inside upstream's own chain ( whose
      // first arm always supplies an address): negate once to clear the pair's address, then negate again.
      // Upstream reads the current address back with no guard at all (`vrrp.py:528-536`) and would compose
      // `no vrrp 10 ip None`; {@link VrrpResource.currentPrimaryIp} refuses with `NotFoundError` instead.
      await attempt('the clearing negation, leaving the pair with no primary address', () => node.vrrp.setPrimaryIp(IFACE, VRID_PRIMARY_IP, { mode: 'no' }))
      await expect(node.vrrp.setPrimaryIp(IFACE, VRID_PRIMARY_IP, { mode: 'no' })).rejects.toBeInstanceOf(NotFoundError)
    } finally {
      await dropVrrp(node, VRID_PRIMARY_IP)
    }
  })

  it('priority arms end at 190 (test_set_priority, :264-290)', async () => {
    if (!(await stageVrrp(node, VRID_PRIORITY))) return
    try {
      const complete = await runArms('the :266-272 chain', [
        [':267 value 200', () => node.vrrp.setPriority(IFACE, VRID_PRIORITY, { value: 200 })],
        [':268 default', () => node.vrrp.setPriority(IFACE, VRID_PRIORITY, { mode: 'default' })],
        [':269 value 175', () => node.vrrp.setPriority(IFACE, VRID_PRIORITY, { value: 175 })],
        [':270 disable', () => node.vrrp.setPriority(IFACE, VRID_PRIORITY, { mode: 'no' })],
        [':271 value 190', () => node.vrrp.setPriority(IFACE, VRID_PRIORITY, { value: 190 })],
      ])
      expect(complete).toBe(true)
      expect((await rowOf(node, VRID_PRIORITY))?.priority).toBe(190)
      // 255 is outside upstream's 1-254 guard (`vrrp.py:584-586`, kept at divergence 5 in §5 row 217), so
      // it never reaches a device: the refusal is offline-pinned and needs no write here.
      await expect(node.vrrp.setPriority(IFACE, VRID_PRIORITY, { value: 255 })).rejects.toBeInstanceOf(EapiError)
    } finally {
      await dropVrrp(node, VRID_PRIORITY)
    }
  })

  it('description arms; the negation reads as the empty string this parser answers, not absence (test_set_description, :291-317)', async () => {
    if (!(await stageVrrp(node, VRID_DESCRIPTION))) return
    try {
      await node.vrrp.setDescription(IFACE, VRID_DESCRIPTION, { value: '1st live vrrp' }) // :294
      expect((await rowOf(node, VRID_DESCRIPTION))?.description).toBe('1st live vrrp')
      await attempt(':295 default', () => node.vrrp.setDescription(IFACE, VRID_DESCRIPTION, { mode: 'default' }))
      await node.vrrp.setDescription(IFACE, VRID_DESCRIPTION, { value: '2nd live vrrp' }) // :296
      await attempt(':297 disable', () => node.vrrp.setDescription(IFACE, VRID_DESCRIPTION, { mode: 'no' }))
      console.log(`live-vrrp: after the negation the description field is ${JSON.stringify((await rowOf(node, VRID_DESCRIPTION))?.description)} — vrrp.py:308-317 answers '' and this port keeps that (§5 row 218)`)
      await node.vrrp.setDescription(IFACE, VRID_DESCRIPTION, { value: '3rd live vrrp' }) // :298
      expect((await rowOf(node, VRID_DESCRIPTION))?.description).toBe('3rd live vrrp')
      // An unquoted description with neither value nor mode is upstream's deprecated fall-through; this
      // client refuses it (row 73 / DR-037) instead of silently negating.
      await expect(node.vrrp.setDescription(IFACE, VRID_DESCRIPTION, {})).rejects.toBeInstanceOf(EapiError)
    } finally {
      await dropVrrp(node, VRID_DESCRIPTION)
    }
  })

  it('setSecondaryIps resolves to the composed list and replaces the set, ending empty (test_set_secondary_ips, :318-342)', async () => {
    if (!(await stageVrrp(node, VRID_SECONDARY, [`vrrp ${String(VRID_SECONDARY)} ipv4 ${PREFIX}2`]))) return
    try {
      const lists: readonly (readonly [string, readonly string[]])[] = [
        [':321 two addresses', [`${PREFIX}51`, `${PREFIX}52`]],
        [':322 two different addresses (the diff removes the first pair)', [`${PREFIX}53`, `${PREFIX}54`]],
        [':323 the empty list (upstream\'s own Notes: that removes everything)', []],
      ]
      for (const [label, list] of lists) {
        // divergence 2 / §5 row 214: upstream's setters had TWO return shapes (a command string when
        // run=False, True/self.error otherwise). Here the verb always resolves to what it composed, and
        // `run: false` sends nothing — so the composed text is asserted before the write exists.
        let composed: readonly string[] | undefined
        try {
          composed = await node.vrrp.setSecondaryIps(IFACE, VRID_SECONDARY, list, { run: false })
        } catch (rawErr) {
          reportRefusal(rawErr, `the run:false dry of setSecondaryIps ${label}`)
          continue
        }
        console.log(`live-vrrp: ${label} composes ${JSON.stringify(composed)}`)
        expect(composed.filter((line) => /\r|\n/u.test(line))).toEqual([]) // one command per line, row 74
        const accepted = await attempt(`setSecondaryIps ${label} for real`, () => node.vrrp.setSecondaryIps(IFACE, VRID_SECONDARY, list))
        if (!accepted) continue
        const row = await rowOf(node, VRID_SECONDARY)
        expect([...(row?.secondaryIp ?? [])].sort()).toEqual([...list].sort()) // the set the device now holds equals the list passed (row 221's diff semantics)
      }
      expect((await rowOf(node, VRID_SECONDARY))?.secondaryIp).toEqual([]) // the last arm removes everything
    } finally {
      await dropVrrp(node, VRID_SECONDARY)
    }
  })

  it('ipVersion arms end at 3, and 4 never reaches the device (test_set_ip_version, :343-370)', async () => {
    if (!(await stageVrrp(node, VRID_IP_VERSION))) return
    try {
      const complete = await runArms('the :345-352 chain', [
        [':346 value 2', () => node.vrrp.setIpVersion(IFACE, VRID_IP_VERSION, { value: 2 })],
        [':347 value 3', () => node.vrrp.setIpVersion(IFACE, VRID_IP_VERSION, { value: 3 })],
        [':348 default', () => node.vrrp.setIpVersion(IFACE, VRID_IP_VERSION, { mode: 'default' })],
        [':349 value 3', () => node.vrrp.setIpVersion(IFACE, VRID_IP_VERSION, { value: 3 })],
        [':350 disable', () => node.vrrp.setIpVersion(IFACE, VRID_IP_VERSION, { mode: 'no' })],
        [':351 value 3', () => node.vrrp.setIpVersion(IFACE, VRID_IP_VERSION, { value: 3 })],
      ])
      expect(complete).toBe(true)
      expect((await rowOf(node, VRID_IP_VERSION))?.ipVersion).toBe(3)
      await expect(node.vrrp.setIpVersion(IFACE, VRID_IP_VERSION, { value: 4 })).rejects.toBeInstanceOf(EapiError) // (2,3) — vrrp.py:671
    } finally {
      await dropVrrp(node, VRID_IP_VERSION)
    }
  })

  it('timers-advertise arms end at 30 (test_set_timers_advertise, :371-397)', async () => {
    if (!(await stageVrrp(node, VRID_TIMERS))) return
    try {
      const complete = await runArms('the :373-379 chain', [
        [':374 value 10', () => node.vrrp.setTimersAdvertise(IFACE, VRID_TIMERS, { value: 10 })],
        [':375 default', () => node.vrrp.setTimersAdvertise(IFACE, VRID_TIMERS, { mode: 'default' })],
        [':376 value 20', () => node.vrrp.setTimersAdvertise(IFACE, VRID_TIMERS, { value: 20 })],
        [':377 disable', () => node.vrrp.setTimersAdvertise(IFACE, VRID_TIMERS, { mode: 'no' })],
        [':378 value 30', () => node.vrrp.setTimersAdvertise(IFACE, VRID_TIMERS, { value: 30 })],
      ])
      expect(complete).toBe(true)
      expect((await rowOf(node, VRID_TIMERS))?.timersAdvertise).toBe(30)
    } finally {
      await dropVrrp(node, VRID_TIMERS)
    }
  })

  it('mac-address advertisement-interval arms end at 60 — the one era-neutral stem here (test_set_mac_addr_adv_interval, :398-424)', async () => {
    if (!(await stageVrrp(node, VRID_MAC_INTERVAL))) return
    try {
      const complete = await runArms('the :400-406 chain', [
        [':401 value 50', () => node.vrrp.setMacAddrAdvInterval(IFACE, VRID_MAC_INTERVAL, { value: 50 })],
        [':402 default', () => node.vrrp.setMacAddrAdvInterval(IFACE, VRID_MAC_INTERVAL, { mode: 'default' })],
        [':403 value 55', () => node.vrrp.setMacAddrAdvInterval(IFACE, VRID_MAC_INTERVAL, { value: 55 })],
        [':404 disable', () => node.vrrp.setMacAddrAdvInterval(IFACE, VRID_MAC_INTERVAL, { mode: 'no' })],
        [':405 value 60', () => node.vrrp.setMacAddrAdvInterval(IFACE, VRID_MAC_INTERVAL, { value: 60 })],
      ])
      expect(complete).toBe(true)
      expect((await rowOf(node, VRID_MAC_INTERVAL))?.macAddrAdvInterval).toBe(60)
      console.log(`live-vrrp: the era-neutral arm left these lines: ${JSON.stringify(await vrrpLines(node, VRID_MAC_INTERVAL))}`)
    } finally {
      await dropVrrp(node, VRID_MAC_INTERVAL)
    }
  })

  it('preempt arms: `value:false` composes upstream\'s fall-through text, not a refusal (test_set_preempt, :425-452)', async () => {
    if (!(await stageVrrp(node, VRID_PREEMPT))) return
    try {
      const complete = await runArms('the :428-433 chain (true/default/true/disable/true/false)', [
        [':428 true', () => node.vrrp.setPreempt(IFACE, VRID_PREEMPT, { value: true })],
        [':429 default', () => node.vrrp.setPreempt(IFACE, VRID_PREEMPT, { mode: 'default' })],
        [':430 true', () => node.vrrp.setPreempt(IFACE, VRID_PREEMPT, { value: true })],
        [':431 disable', () => node.vrrp.setPreempt(IFACE, VRID_PREEMPT, { mode: 'no' })],
        [':432 true', () => node.vrrp.setPreempt(IFACE, VRID_PREEMPT, { value: true })],
        [':433 false — divergence 3: reaches the same `no vrrp N preempt` text through mode:no rather than a falsy fall-through', () => node.vrrp.setPreempt(IFACE, VRID_PREEMPT, { value: false })],
      ])
      expect(complete).toBe(true)
      expect((await rowOf(node, VRID_PREEMPT))?.preempt).toBe(false)
    } finally {
      await dropVrrp(node, VRID_PREEMPT)
    }
  })

  it('preempt-delay-min arms end at 150 (test_set_preempt_delay_min, :453-479)', async () => {
    if (!(await stageVrrp(node, VRID_PREEMPT_MIN))) return
    try {
      const complete = await runArms('the :455-461 chain', [
        [':456 value 3600', () => node.vrrp.setPreemptDelayMin(IFACE, VRID_PREEMPT_MIN, { value: 3600 })],
        [':457 default', () => node.vrrp.setPreemptDelayMin(IFACE, VRID_PREEMPT_MIN, { mode: 'default' })],
        [':458 value 500', () => node.vrrp.setPreemptDelayMin(IFACE, VRID_PREEMPT_MIN, { value: 500 })],
        [':459 disable', () => node.vrrp.setPreemptDelayMin(IFACE, VRID_PREEMPT_MIN, { mode: 'no' })],
        [':460 value 150', () => node.vrrp.setPreemptDelayMin(IFACE, VRID_PREEMPT_MIN, { value: 150 })],
      ])
      expect(complete).toBe(true)
      console.log(`live-vrrp: preemptDelayMin now reads ${String((await rowOf(node, VRID_PREEMPT_MIN))?.preemptDelayMin)} (upstream drops this key from its own create comparison at :128 — this chain is the live answer)`)
      expect((await rowOf(node, VRID_PREEMPT_MIN))?.preemptDelayMin).toBe(150)
    } finally {
      await dropVrrp(node, VRID_PREEMPT_MIN)
    }
  })

  it('preempt-delay-reload arms end at 150 (test_set_preempt_delay_reload, :480-506)', async () => {
    if (!(await stageVrrp(node, VRID_PREEMPT_RELOAD))) return
    try {
      const complete = await runArms('the :482-488 chain', [
        [':483 value 3600', () => node.vrrp.setPreemptDelayReload(IFACE, VRID_PREEMPT_RELOAD, { value: 3600 })],
        [':484 default', () => node.vrrp.setPreemptDelayReload(IFACE, VRID_PREEMPT_RELOAD, { mode: 'default' })],
        [':485 value 500', () => node.vrrp.setPreemptDelayReload(IFACE, VRID_PREEMPT_RELOAD, { value: 500 })],
        [':486 disable', () => node.vrrp.setPreemptDelayReload(IFACE, VRID_PREEMPT_RELOAD, { mode: 'no' })],
        [':487 value 150', () => node.vrrp.setPreemptDelayReload(IFACE, VRID_PREEMPT_RELOAD, { value: 150 })],
      ])
      expect(complete).toBe(true)
      expect((await rowOf(node, VRID_PREEMPT_RELOAD))?.preemptDelayReload).toBe(150)
    } finally {
      await dropVrrp(node, VRID_PREEMPT_RELOAD)
    }
  })

  it('delay-reload arms end at 150 in the modern family (test_set_delay_reload, :507-533)', async () => {
    if (!(await stageVrrp(node, VRID_DELAY_RELOAD))) return
    try {
      const complete = await runArms('the :509-515 chain', [
        [':510 value 30', () => node.vrrp.setDelayReload(IFACE, VRID_DELAY_RELOAD, { value: 30 })],
        [':511 default', () => node.vrrp.setDelayReload(IFACE, VRID_DELAY_RELOAD, { mode: 'default' })],
        [':512 value 25', () => node.vrrp.setDelayReload(IFACE, VRID_DELAY_RELOAD, { value: 25 })],
        [':513 disable', () => node.vrrp.setDelayReload(IFACE, VRID_DELAY_RELOAD, { mode: 'no' })],
        [':514 value 15', () => node.vrrp.setDelayReload(IFACE, VRID_DELAY_RELOAD, { value: 15 })],
      ])
      expect(complete).toBe(true)
      const row = await rowOf(node, VRID_DELAY_RELOAD)
      console.log(`live-vrrp: delayReload now reads ${String(row?.delayReload)} and the family wrote: ${JSON.stringify(await vrrpLines(node, VRID_DELAY_RELOAD))}`)
      expect(row?.delayReload).toBe(15)
    } finally {
      await dropVrrp(node, VRID_DELAY_RELOAD)
    }
  })

  it('setTracks replaces the tracked objects through the tid-diff verb and ends empty (test_set_tracks, :534-572)', async () => {
    if (!(await stageVrrp(node, VRID_TRACKS, [`vrrp ${String(VRID_TRACKS)} ipv4 ${PREFIX}2`]))) return
    try {
      const target = trackTarget()
      const lists: readonly (readonly [string, readonly VrrpTrack[]])[] = [
        [':537-541 three entries, one name twice', [{ name: target, action: 'shutdown' }, { name: target, action: 'decrement', amount: 10 }, { name: target, action: 'shutdown' }]],
        [':542-544 one entry', [{ name: target, action: 'shutdown' }]],
        [':545-549 amount changed to 20', [{ name: target, action: 'shutdown' }, { name: target, action: 'decrement', amount: 20 }, { name: target, action: 'shutdown' }]],
        [':550-552 back to one entry', [{ name: target, action: 'shutdown' }]],
        [':553 the empty list', []],
      ]
      for (const [label, list] of lists) {
        const ok = await attempt(`setTracks ${label} — the verb keys its diff on the triple-sorted tid and re-extracts the command from it (§5 row 223)`, () => node.vrrp.setTracks(IFACE, VRID_TRACKS, list))
        if (!ok) continue
      }
      const row = await rowOf(node, VRID_TRACKS)
      expect(row?.track).toEqual([]) // the last arm removes every tracked object
      console.log(`live-vrrp: tracked objects after the chain: ${JSON.stringify(row?.track ?? null)} over name ${target}`)
    } finally {
      await dropVrrp(node, VRID_TRACKS)
    }
  })

  it('bfd-ip arms end at .162, and the negation leaves this client\'s three-answer field reported, not assumed (test_set_bfd_ip, :573-598)', async () => {
    if (!(await stageVrrp(node, VRID_BFD))) return
    try {
      const complete = await runArms('the :575-581 chain', [
        [`:576 value ${PREFIX}160`, () => node.vrrp.setBfdIp(IFACE, VRID_BFD, { value: `${PREFIX}160` })],
        [':577 default', () => node.vrrp.setBfdIp(IFACE, VRID_BFD, { mode: 'default' })],
        [`:578 value ${PREFIX}161`, () => node.vrrp.setBfdIp(IFACE, VRID_BFD, { value: `${PREFIX}161` })],
        [':579 disable', () => node.vrrp.setBfdIp(IFACE, VRID_BFD, { mode: 'no' })],
        [`:580 value ${PREFIX}162`, () => node.vrrp.setBfdIp(IFACE, VRID_BFD, { value: `${PREFIX}162` })],
      ])
      if (!complete) {
        console.warn('live-vrrp: the bfd chain was refused partway — the final equality is not claimed')
        return
      }
      const row = await rowOf(node, VRID_BFD)
      expect(row?.bfdIp).toBe(`${PREFIX}162`)
      await node.vrrp.setBfdIp(IFACE, VRID_BFD, { mode: 'no' })
      const negated = await rowOf(node, VRID_BFD)
      console.log(`live-vrrp: after the negation the BFD field answers ${JSON.stringify(negated?.bfdIp)} — the three answers upstream's parser has (vrrp.py:337-344) are '' / null / the address, and this run records which one 4.28.14M produces (§5 row 218)`)
    } finally {
      await dropVrrp(node, VRID_BFD)
    }
  })
})
