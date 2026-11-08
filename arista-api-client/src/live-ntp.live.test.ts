/**
 * `*.live.test.ts` port of `pyeapi/test/system/test_api_ntp.py` @ `6816d9e` — the NTP half of the
 * **D2 full-write** lane (#14, DR-126). The server writes have no scratch-port shape at all (they are global
 * config lines), so this file runs only under `EAPI_LAB_FULL_WRITE=1` against the throwaway cEOS container,
 * with the self-lockout fence on the transport seam (`buildFullWriteNode`). The **source-interface** cases
 * are interface-bound and therefore additionally require `requireScratchInterface` (`live-guard.ts:601-614`).
 *
 * ## Gate (DR-034 / DR-126) and what is off-limits
 * `liveFullWriteReadiness(process.env)` refuses loudly when the env, the `lab` class or the consent flag is
 * missing; the file then collects and executes nothing. What the widening does **not** allow: the listener,
 * `admin`/`netadmin`, this run's `EAPI_USER`, the management path and `copy run start`
 * (`live-session-policy.ts:159-166`), none of which this file needs.
 *
 * Two container-facts shape the writes:
 * - the lab harness **provisions** `ntp server 10.20.0.2` on purpose (`scripts/ceos-lab.mjs:1174-1175`, "an
 *   unreachable server is intended — S12 reads the *shape*"), so this suite never claims the container's
 *   whole server list is empty, and the one case that calls `no ntp` snapshots the list first and restores
 *   it in a `finally` (leaked state poisons the next file in the same container).
 * - upstream normalises with `no ntp` in eight of its eleven cases (`:103`/`:105`, `:117`/`:119`,
 *   `:132`/`:134`, `:148`/`:150`, `:161-165`, `:179`/`:181`). Here that normalisation is **scoped to the
 *   addresses each case owns** (`removeServer` at case start), precisely because `no ntp`'s real scope is an
 *   EOS-side statement this client refuses to vouch for (`ntp.ts:74-76` inside divergence 4 `:67-76` —
 *   §5 row 157). The one case that ports `remove_all_servers` is where that scope gets *observed*, and it
 *   prints the before/after record instead of asserting the comment's claim.
 *
 * | upstream (verified line @6816d9e) | ported? | here / why |
 * |---|---|---|
 * | `test_get` (`:44`) | ✅ | stages `ntp local-interface Ethernet1` + `ntp server 99.99.1.1` (`:47`/`:49`) then only asserts `assertIsNotNone` (`:51`) — the staging buys nothing that the assert uses. `NtpResource` is an `Entity`, so a record is **always** the answer (row 156's absence rule) and the case is ported as a write-free read of the device's real NTP shape, printed in full: `servers` is an array of `{address, prefer}`, `sourceInterface` absent-or-string |
 * | `test_create` (`:53`) | ✅ via `setSourceInterface`, scratch port | `intf = 'Ethernet1'` (`:54`), normalising `no ntp local-interface`/`no ntp source` (`:57`/`:59`), `api.create(intf)` (`:60`), read-back `source_interface == intf` (`:63`). pyeapi's `create` is an **alias** of `set_source_interface` (`ntp.py:107-116`) and DR-090 deleted the alias (`ntp.ts:20`, `:67-76`) — the behaviour still ports, under its real name. `Ethernet1` is a provisioned fixture port, so the name comes from `EAPI_SCRATCH_INTERFACE` (DR-035(b)/#14 D2) |
 * | `test_delete` (`:65`) | ✅ | stages the source line (`:68`/`:70`), `api.delete()` (`:71`), `assertIsNone(response['source_interface'])` (`:74`). There is no presence-shaped ntp delete here (`unsetSourceInterface`, row 157/DR-090) and the absent-field vocabulary replaces the invented `None` (row 156) |
 * | `test_default` (`:76`) | ✅ | stages (`:79`/`:81`), `api.default()` (`:82`), `assertIsNone` (`:85`) and `defaultSourceInterface`, with the same absence rule |
 * | `test_set_source_interface` (`:87`) | ✅ (widened into the DR-078 arm capture) | stages `ntp local-interface Loopback0`/`ntp source Loopback0` (`:90`/`:92`) then writes `Ethernet1` (`:93`) and asserts source_interface matches (`:96`). `Loopback0` is not an addressable scratch name in this lane, so the case does what upstream's does on one interface **and** reads the raw config to report which spelling the device stored for the 4.23+ arm `ntp.ts:271-284` chose — the read side accepts either word (row 155), the write side has to pick one, and that asymmetry has never been looked at on a real 4.28 box from this repo |
 * | `test_add_server_single` (`:99`) | ✅ | `server = '10.10.10.35'` (`:100`), the `no ntp` normalisation (`:103`/`:105`), `add_server` (`:106`), then the keys-of-dicts scrape (`:109-110`) and `assertListEqual(keys, [server])` (`:111`). Ours asserts **this case's** address is present with `prefer: false` and prints the device's whole list — the equality-on-the-whole-list half of `:111` would assert against the harness's own `ntp server 10.20.0.2` |
 * | `test_add_server_multiple` (`:113`) | ✅ | `servers = ['10.10.10.37','10.10.10.36','10.10.10.34']` (`:114`), the add loop (`:120-121`), `sorted(keys)` equality (`:126`). Same narrowing: all three owned addresses asserted present, device order printed (row 156 keeps device order and duplicates) |
 * | `test_add_server_prefer` (`:128`) | ✅ (the replace-vs-duplicate question is reported) | `add_server(server, prefer=False)` (`:135`) → `servers[0][server]` is `None` (`:138`); `add_server(server, prefer=True)` (`:140`) → `== 'prefer'` (`:143`). pyeapi folds `' prefer'` into the value string (`ntp.py:170-171`) and this client reproduces that byte for byte (`ntp.ts:236-250`), so the wire line is the same. Upstream indexes `servers[0]`, which silently assumes the device **replaced** the first line; the reader here keeps every line in device order (`ntp.ts:111`), so the case asserts an entry carrying `prefer: true` exists for that address and warns with the full list if the device answered two entries — the honest version of "add or update" (`ntp.py:158`) |
 * | `test_add_server_invalid` (`:145`) | ✅ | `assertRaises(ValueError)` around `add_server(None)`, `add_server('')`, `add_server(' ')` (`:151-154`). Both sides raise **client-side** (`ntp.py:168-169`), so it ports directly: ours rejects `NotSupportedError` with the same message core ("ntp server name must be specified", `ntp.ts:165`), plus the one-token rule of D5 (`ntp.ts:78-86`) |
 * | `test_remove_server` (`:156`) | ✅ | pre-writes `server` (`:161-165`) plus the trio (`:166-167`), `remove_server` (`:168`), asserts the remaining keys equal the trio (`:171-173`) — that last half is safe here only because upstream had just run `no ntp` (`:162`/`:164`) to empty the list. Ours asserts our address is gone and our trio still present, and reports the rest of the device's list |
 * | `test_remove_all_servers` (`:175`) | ✅ (the scope claim becomes a capture) | stages `no ntp` (`:179`/`:181`) + the trio (`:182-183`), `remove_all_servers()` (`:184`), `assertEqual(response['servers'], [])` (`:187`). Ports whole-list-empty **only** as the device's answer to `no ntp`, and prints whether the `ntp local-interface`/`ntp source` line survived — `ntp.py:192-193`'s "# 'no ntp' removes all server entries." is an unverified EOS-side statement (`ntp.ts:25`, `:259-266`), and this case is where row 157's tail gets evidence. Everything present before the case is re-added in the `finally` |
 *
 * Upstream's `assertTrue(response)` idiom is this client's "the awaited verb resolves": pyeapi's
 * `configure()` returns `True`/`False` (`abstract.py`-shaped) and a refused write is a `CommandError` here
 * (DR-005), so a device refusal never degrades into a silently-ignored `False`.
 */

import { beforeAll, describe, expect, it } from 'vitest'

import { CommandError, EapiError, NotSupportedError, ProtocolError } from './errors'
import { buildFullWriteNode, liveFullWriteReadiness } from './testing/live-full-write'
import { describeLiveTarget, matchesDeviceIdentity, requireScratchInterface, unwrapLiveTarget, type LiveTarget } from './testing/live-guard'
import { runGuardedLiveWriteSession } from './testing/live-session-policy'
import type { Node } from './command-layer'
import type { NtpSettings } from './resources/ntp'

const gate = liveFullWriteReadiness(process.env)
if (!gate.runnable) {
  console.warn(`live-ntp: SKIPPED (DR-034/DR-126) — ${gate.skipReason ?? 'reason unavailable'}`)
}

/** Interface-bound cases (the source-line family) additionally need the declared scratch port, DR-035(b). */
const scratch: { ok: boolean; name?: string; reason?: string } = gate.runnable
  ? (() => {
      const req = requireScratchInterface(unwrapLiveTarget(gate.resolution))
      return req.ok ? { ok: true, name: req.name } : { ok: false, reason: req.reason }
    })()
  : { ok: false, reason: 'live target not accepted' }
if (gate.runnable && !scratch.ok) {
  console.warn(`live-ntp: source-interface cases SKIPPED (DR-035b) — ${scratch.reason ?? ''}`)
}
const sourceReady = gate.runnable && scratch.ok

/** Upstream's addresses (`test_api_ntp.py:100`, `:114`, `:157-158`, `:176`). They are not harness-owned: the container provisions `10.20.0.2` (`scripts/ceos-lab.mjs:1175`). */
const SINGLE = '10.10.10.35'
const TRIO: readonly string[] = ['10.10.10.37', '10.10.10.36', '10.10.10.34']
/** Upstream reuses `10.10.10.35` for its prefer case (`:129`); a distinct address keeps the cases independent here. */
const PREFERRED = '10.10.10.38'

function describeRefusal(rawErr: unknown): string {
  if (rawErr instanceof EapiError) {
    const code = rawErr instanceof CommandError ? String(rawErr.code) : rawErr instanceof ProtocolError ? `protocol ${String(rawErr.code)}` : 'no code'
    return `${rawErr.constructor.name} ${code}: ${rawErr.message.split('\n')[0]?.slice(0, 160) ?? ''}`
  }
  return rawErr instanceof Error ? `${rawErr.constructor.name}: ${rawErr.message.split('\n')[0]?.slice(0, 160) ?? ''}` : String(rawErr)
}

function render(record: NtpSettings): string {
  return `source=${JSON.stringify(record.sourceInterface ?? null)} servers=${JSON.stringify(record.servers.map((server) => (server.prefer ? `${server.address} prefer` : server.address)))}`
}

/** A case's own delete-if-exists pass — the narrow, address-scoped stand-in for upstream's global `no ntp` normalisation. */
async function clearOwned(node: Node, addresses: readonly string[]): Promise<void> {
  for (const address of addresses) {
    try {
      await node.ntp.removeServer(address)
    } catch (rawErr) {
      // Negating an address the switch never configured is the idempotence path, not a failure; a *typed*
      // refusal is printed so a reviewer can tell "not configured" from "the device dislikes `no ntp server`".
      console.warn(`live-ntp: pre-case \`no ntp server ${address}\` refused (${describeRefusal(rawErr)}) — assuming it was not configured`)
    }
  }
}

async function readyNode(label: string): Promise<Node> {
  const target: LiveTarget = unwrapLiveTarget(gate.resolution)
  console.log(`${label}: target = ${describeLiveTarget(target)}`)
  const node = buildFullWriteNode(target)
  const reported = await node.getVersion()
  const mismatch = matchesDeviceIdentity(target, { version: reported.version, modelName: reported.modelName })
  // Only the cEOS build-suffix refusal is tolerated; model/train/TLS identity stay enforced by the probe (DR-066).
  if (mismatch !== undefined && mismatch.code !== 'EAPI_VERSION_MISMATCH') throw new Error(`${label} readiness: ${mismatch.reason}`)
  if (mismatch?.code === 'EAPI_VERSION_MISMATCH') {
    console.warn(`${label}: reported version "${reported.version}" vs pin "${target.allowVersion}" (base-level enforced by the probe, DR-066)`)
  }
  return node
}

describe.skipIf(!gate.runnable)('live read: pyeapi test_api_ntp.py (test_get, :44)', () => {
  let node: Node
  beforeAll(async () => {
    node = await readyNode('live-ntp')
  })

  it('ntp.get() always answers a typed record — the whole NTP shape the container ships (test_get, :44 — narrowed, see the header)', async () => {
    const record = await node.ntp.get()
    // Upstream's assertion at :51 is `assertIsNotNone`; `Ntp` for a non-empty config is pyeapi's own None
    // risk (`ntp.py:69-70`), which DR-027/row 156 removes: an `Entity` always answers.
    expect(Array.isArray(record.servers)).toBe(true)
    for (const server of record.servers) {
      expect(typeof server.address).toBe('string')
      expect(server.address).not.toContain(' ')
      expect(typeof server.prefer).toBe('boolean')
    }
    if (record.sourceInterface !== undefined) expect(typeof record.sourceInterface).toBe('string')
    // Evidence for the rest of this file (and for the row-157 scope question), printed rather than asserted:
    console.log(`live-ntp: the target's current NTP record is ${render(record)}`)
  })
})

describe.skipIf(!sourceReady)('live full-write on the scratch port: pyeapi test_api_ntp.py (test_create :53, test_delete :65, test_default :76, test_set_source_interface :87)', () => {
  let node: Node
  let intf: string
  beforeAll(async () => {
    intf = scratch.name ?? ''
    node = await readyNode('live-ntp/source')
  })

  it('setSourceInterface(scratch) then reading it back is the pyeapi create() behaviour without the alias (test_create, :53 — :60/:63; DR-090)', async () => {
    await node.ntp.unsetSourceInterface().catch(() => undefined)
    try {
      // Upstream's `create(intf)` (`:60`) is `set_source_interface` (`ntp.py:116`); the alias is not ported
      // (DR-090), so this case drives the real verb and asserts the read (`:63`).
      await node.ntp.setSourceInterface(intf)
      const record = await node.ntp.get()
      expect(record.sourceInterface).toBe(intf)
    } catch (rawErr) {
      // Whether 4.28 will source NTP off a switchport-modelled scratch port is the device's call —
      // `ntp.ts:84-86` says so outright. A refusal is a typed error, printed with its code.
      expect(rawErr).toBeInstanceOf(EapiError)
      console.warn(`live-ntp: \`ntp local-interface ${intf}\` was refused by this target (${describeRefusal(rawErr)}) — the :63 read-back half is NOT claimed here`)
    } finally {
      await node.ntp.unsetSourceInterface().catch(() => undefined)
    }
  })

  it('unsetSourceInterface clears the line the run wrote (test_delete, :65 — :71/:74; the alias-shaped verb is gone, DR-090)', async () => {
    await node.ntp.setSourceInterface(intf)
    expect((await node.ntp.get()).sourceInterface).toBe(intf)
    await node.ntp.unsetSourceInterface()
    const after = await node.ntp.get()
    // pyeapi's `None` (`:74`) is this client's **absent** key (row 156, DR-076's continuation).
    expect(after.sourceInterface).toBeUndefined()
  })

  it('defaultSourceInterface answers the device default, and the read says which (test_default, :76 — :82/:85)', async () => {
    await node.ntp.setSourceInterface(intf)
    expect((await node.ntp.get()).sourceInterface).toBe(intf)
    await node.ntp.defaultSourceInterface()
    const after = await node.ntp.get()
    if (after.sourceInterface === undefined) {
      expect(after.sourceInterface).toBeUndefined()
      console.log(`live-ntp: \`default ntp local-interface\` left no source line — upstream's assertIsNone at :85 holds on this target`)
    } else {
      console.warn(`live-ntp: after \`default ntp local-interface\` the source line reads ${JSON.stringify(after.sourceInterface)} — the :85 negative half still holds for our name (the device restored/kept a line); reported for row 157`)
      expect(after.sourceInterface).not.toBe(intf)
    }
    await node.ntp.unsetSourceInterface().catch(() => undefined)
  })

  it('which spelling the device stored for the arm our version floor wrote (test_set_source_interface, :87 — :93/:96 plus the row-155 capture)', async () => {
    await node.ntp.setSourceInterface(intf)
    try {
      const record = await node.ntp.get()
      expect(record.sourceInterface).toBe(intf)
      // The read side accepts `ntp source` **or** `ntp local-interface` (`ntp.ts:119`, row 155's
      // vrf-forwarding precedent). The write side picked one by numeric floor (`ntp.ts:271-284`). This is the
      // first time this repository looks at which word a 4.28 device actually keeps.
      const config = await node.getRunningConfig()
      const stored: string[] = []
      for (const match of config.matchAll(/^ntp (?:local-interface|source) \S+$/gmu)) {
        if (match[0] !== undefined) stored.push(match[0])
      }
      console.log(`live-ntp: ntp source lines in \`show running-config all\` after our write: ${JSON.stringify(stored)} (floor at 4.23 picked \`ntp local-interface\` for ${intf})`)
      expect(stored.some((line) => line.includes(intf))).toBe(true)
    } finally {
      await node.ntp.unsetSourceInterface().catch(() => undefined)
    }
  })
})

describe.skipIf(!gate.runnable)('live full-write on owned NTP addresses: pyeapi test_api_ntp.py (add_server :99/:113/:128/:145, remove_server :156, remove_all_servers :175)', () => {
  let node: Node
  beforeAll(async () => {
    node = await readyNode('live-ntp/servers')
  })

  it('addServer(10.10.10.35) lands as one {address, prefer:false} entry (test_add_server_single, :99 — :106/:111)', async () => {
    await clearOwned(node, [SINGLE])
    try {
      await node.ntp.addServer(SINGLE)
      const record = await node.ntp.get()
      const ours = record.servers.filter((server) => server.address === SINGLE)
      expect(ours).toHaveLength(1)
      expect(ours[0]?.prefer).toBe(false)
      // :111 compares the WHOLE key list to [server]; upstream could only do that because it ran `no ntp`
      // (`:103`/`:105`), which would delete this lab's provisioned server (scripts/ceos-lab.mjs:1175).
      console.log(`live-ntp: whole server list after adding ${SINGLE}: ${render(record)}`)
    } finally {
      await clearOwned(node, [SINGLE])
    }
  })

  it('three addServer calls all land, in device order, with prefer false (test_add_server_multiple, :113 — :120-121/:126)', async () => {
    await clearOwned(node, TRIO)
    try {
      for (const address of TRIO) await node.ntp.addServer(address)
      const record = await node.ntp.get()
      const owned = record.servers.filter((server) => TRIO.includes(server.address))
      expect(owned.map((server) => server.address).sort()).toEqual([...TRIO].sort())
      for (const server of owned) expect(server.prefer).toBe(false)
      console.log(`live-ntp: device order for the trio = ${JSON.stringify(owned.map((server) => server.address))} (row 156 keeps the order the switch wrote)`)
    } finally {
      await clearOwned(node, TRIO)
    }
  })

  it('prefer:false then prefer:true on the same address — and what the device did with the second line (test_add_server_prefer, :128 — :135/:138, :140/:143)', async () => {
    await clearOwned(node, [PREFERRED])
    try {
      await node.ntp.addServer(PREFERRED)
      const plain = await node.ntp.get()
      expect(plain.servers.filter((server) => server.address === PREFERRED).map((server) => server.prefer)).toEqual([false])
      await node.ntp.addServer(PREFERRED, { prefer: true })
      const record = await node.ntp.get()
      const ours = record.servers.filter((server) => server.address === PREFERRED)
      // Upstream indexes `servers[0]` and demands `'prefer'` (`:143`), which assumes exactly one line. This
      // client keeps every server line in device order (`ntp.ts:111`), so a duplicate is reported rather than
      // hidden — that is the live answer to the "add or update" docstring at `ntp.py:158`.
      if (ours.length !== 1) {
        console.warn(`live-ntp: ${PREFERRED} reads ${JSON.stringify(ours)} after the prefer write — the device kept ${String(ours.length)} lines, and upstream's servers[0] indexing (:138/:143) cannot see that. Reported as a row-156 capture`)
      }
      expect(ours.some((server) => server.prefer)).toBe(true)
      expect(ours.filter((server) => server.prefer).every((server) => server.address === PREFERRED)).toBe(true)
    } finally {
      await clearOwned(node, [PREFERRED])
    }
  })

  it('an empty/blank/multi-token server address is refused before the wire (test_add_server_invalid, :145 — :151-154)', async () => {
    // pyeapi raises ValueError for None/''/' ' (`ntp.py:168-169`); this client raises NotSupportedError with the
    // same message core (DR-077 keeps the taxonomy at one error family), and never composes the line at all.
    await expect(node.ntp.addServer('')).rejects.toBeInstanceOf(NotSupportedError)
    await expect(node.ntp.addServer(' ')).rejects.toBeInstanceOf(NotSupportedError)
    await expect(node.ntp.addServer(undefined as unknown as string)).rejects.toBeInstanceOf(NotSupportedError)
    // Row 156's extra half: an address with a space could never read back, and would forge a preference.
    await expect(node.ntp.addServer(`${SINGLE} prefer`)).rejects.toBeInstanceOf(NotSupportedError)
    expect((await node.ntp.get()).servers.some((server) => server.address === SINGLE)).toBe(false)
  })

  it('removeServer takes one address out and leaves the others (test_remove_server, :156 — :161-167 staging, :168, :171-173)', async () => {
    await clearOwned(node, [SINGLE, ...TRIO])
    try {
      // Upstream stages with `dut.config`; the guarded session is this lane's equivalent and keeps the batch
      // all-or-nothing (DR-035), so a half-staged case cannot masquerade as a removal result.
      await runGuardedLiveWriteSession(node, {
        name: 'd2-ntp-stage-remove',
        commands: [`ntp server ${SINGLE}`, ...TRIO.map((address) => `ntp server ${address}`)],
      })
      const staged = await node.ntp.get()
      expect(staged.servers.filter((server) => server.address === SINGLE)).toHaveLength(1)
      await node.ntp.removeServer(SINGLE)
      const after = await node.ntp.get()
      expect(after.servers.some((server) => server.address === SINGLE)).toBe(false)
      const owned = after.servers.filter((server) => TRIO.includes(server.address))
      expect(owned.map((server) => server.address).sort()).toEqual([...TRIO].sort())
      console.log(`live-ntp: after removeServer(${SINGLE}) the target reports ${render(after)}`)
    } finally {
      await clearOwned(node, [SINGLE, ...TRIO])
    }
  })

  it('removeAllServers is this lane\'s only `no ntp`, and it reports what else that command took (test_remove_all_servers, :175 — :182-184, :187; row 157\'s scope claim captured live)', async () => {
    await clearOwned(node, TRIO)
    const before = await node.ntp.get()
    try {
      for (const address of TRIO) await node.ntp.addServer(address)
      const staged = await node.ntp.get()
      expect(staged.servers.filter((server) => TRIO.includes(server.address))).toHaveLength(TRIO.length)
      await node.ntp.removeAllServers()
      const after = await node.ntp.get()
      // Upstream asserts the empty list whole-model (`:187`); that holds only for the servers, and only if the
      // device honoured `no ntp`. Everything the case owned is gone:
      expect(after.servers).toHaveLength(0)
      if (before.servers.length > 0 && after.servers.length === 0) {        console.warn(`live-ntp: \`no ntp\` also removed ${String(before.servers.length)} pre-existing server line(s) this case did not write (${JSON.stringify(before.servers.map((server) => server.address))}) — the reason this suite snapshots and restores around :175`)
      }
      // `ntp.py:192-193`'s "# 'no ntp' removes all server entries" is an EOS-side statement (`ntp.ts:259-266`).
      // The device answer, printed: did the source line survive?
      if (before.sourceInterface !== undefined) {
        console.log(`live-ntp: source was ${JSON.stringify(before.sourceInterface)} before \`no ntp\` and ${JSON.stringify(after.sourceInterface ?? null)} after — row 157's scope half, observed`)
      }
    } finally {
      // Leave the container the way this file found it: the harness's own `ntp server 10.20.0.2`
      // (`scripts/ceos-lab.mjs:1175`) and any source line that was present belong to the next suite.
      for (const server of before.servers) {
        await node.ntp.addServer(server.address, { ...(server.prefer ? { prefer: true } : {}) }).catch((rawErr: unknown) => {
          console.warn(`live-ntp: could not restore \`ntp server ${server.address}\` (${describeRefusal(rawErr)}) — leaked state, reported`)
        })
      }
      if (before.sourceInterface !== undefined) {
        await node.ntp.setSourceInterface(before.sourceInterface).catch((rawErr: unknown) => {
          console.warn(`live-ntp: could not restore the source interface ${JSON.stringify(before.sourceInterface)} (${describeRefusal(rawErr)}) — leaked state, reported`)
        })
      }
    }
  })
})
