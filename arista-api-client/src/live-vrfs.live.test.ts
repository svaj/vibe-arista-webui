/**
 * `*.live.test.ts` port of `pyeapi/test/system/test_api_vrfs.py` @ `6816d9e` — #14 **D2** (the full-write lab
 * lane, DR-126). Upstream has **fourteen** methods (`:45`–`:310`); all fourteen are ported: twelve as VRF-object
 * writes and reads, two of them as client-side refusals (upstream's `assertFalse` arms — see the ledger).
 *
 * Gate: `liveFullWriteReadiness(process.env)` (`src/testing/live-full-write.ts`) → the accepted lab endpoint plus
 * the `EAPI_LAB_FULL_WRITE=1` consent, and the `Node` comes from `buildFullWriteNode(target)` so the pre-wire
 * self-lockout seam (`withLabWriteScope`) fences every write (DR-126). Loud skip without it (DR-034). The one
 * case that touches an interface is additionally gated on `requireScratchInterface` (DR-035(b)).
 *
 * ## Shape choices this suite has to state
 * * `dut.version_number >= '4.23'` gates appear **twenty-five** times in this file (`:47`, `:57`, `:80`, `:88`, `:95`,
 *   `:103`, `:110`, `:122`, `:130`, `:138`, `:145`, `:153`, `:167`, `:177`, `:188`, `:198`, `:206`, `:221`, `:228`,
 *   `:245`, `:252`, `:269`, `:276`, `:288`, `:298` — verified by grep, and the `if` lines are one below the
 *   `for dut in self.duts:` lines the ledger rows cite), and `CliVariants` (imported at `:40`) wraps the
 *   getall's stage `:64-68` and cleanup `:74-76`. All of it picks `vrf instance` vs `vrf definition` from a
 *   **string compare** of `show version`. This client detects the keyword from the
 *   device's own config text and defaults to `instance` when that text is silent (vrfs.ts divergence 1, DR-099),
 *   so the port stages `vrf instance livevrf<n>` and lets the device answer if that keyword is not its own —
 *   reported as a typed `CommandError`, never resolved by a second guessed arm.
 * * Names: `livevrf1`…`livevrf13`, all inside this client's `\w+` grammar (`assertVrfName`) and nowhere near the
 *   `lab-provision` / `lab-pending-capture` session names the harness owns (#62, DR-122). Every case deletes what
 *   it created, and each case's first batch is a delete-if-exists prelude — the container persists across suites,
 *   so a crashed earlier run must not decide this one's result.
 * * Routing: `ip routing` is refused outright on some cEOS container shapes and accepted on others (DR-122,
 *   "capability negatives kept as findings"). The suite reads `node.system.get()` first — whose `ipRouting` flag
 *   is `true` unless a literal `no ip routing` line exists (the pyeapi `_parse_iprouting` parity in
 *   `resources/system.ts`), so that read cannot settle the question — then attempts `ip routing` once inside a
 *   named session, records the answer, and lets each routing-flag case carry that recorded refusal instead of
 *   assuming routed mode (or silently re-flipping a global).
 *
 * | upstream (verified line @6816d9e) | ported? | here / why |
 * |---|---|---|
 * | `test_get` (`:45`, stage `:46-52`, `get` `:53`, expected dict `:54-55`, `assertEqual` `:56`, cleanup `:57-60`) | ✅ (flags asserted the way this client reads them) | upstream demands `rd '10:10'`, `vrf_name 'blah'`, `description 'blah desc'`, `ipv4_routing False`, `ipv6_routing False`. Here the same three lines are a guarded batch and `vrfs.get('livevrf1')` must answer `name`/`rd`/`description` exactly (camelCase per MIGRATION §4, absence per DR-027); the two flags are asserted **against the config document** — `ipv4Routing === !sections.has('no ip routing vrf livevrf1')` — which is this client's rule (divergence 5) and upstream's own (`vrfs.py:92-99`); the printed values say whether this container matches upstream's `False`/`False` |
 * | `test_getall` (`:62`, `CliVariants` stage `:63-68`, `getall` `:69`, `assertIsInstance` `:70`, `assertEqual(len, 2)` `:71`, membership `:72-73`, cleanup `:74-76`) | ✅ (the exact-count half narrowed) | upstream creates exactly two VRFs and demands `len(response) == 2`. On a container this run does not own, the honest assertion is membership of **both** fresh names plus every record's own shape (`name` echoed as the key, `definitionForm` ∈ instance/definition, both flags boolean); the device's total count is printed. Upstream's `CliVariants` double-arm is the version-compare workaround this port replaces (DR-099), and `getAll()` costs one `show running-config` for the whole table |
 * | `test_create_and_return_true` (`:78`, pre-stage `:79-83`, `create` `:84`, `assertTrue` `:85`, `show vrf` text `:86-87`, cleanup `:88-91`) | ✅ | `vrfs.create('livevrf4')` is the header line (`vrfs.py:169-172`). Upstream proves the write with `show vrf` **text**; the twin here is `node.showText('show vrf')`, asserted to name the VRF when the device answers that command and reported with its code when it refuses (the #62 runs keep per-command negatives, DR-122). The running-config read is asserted either way |
 * | `test_create_with_valid_rd` (`:93`, pre-stage `:94-98`, `create(…, rd='10:10')` `:99`, `assertTrue` `:100`, `show running-config section vrf` `:101-103`, header halves `:104-108`, `assertIn('rd 10:10')` `:109`, cleanup `:110-113`) | ✅ | `create(name, { rd })` puts `rd 10:10` in the same transaction upstream uses (`vrfs.py:171-174`). The read asserts the typed `rd` field **and** that the section block carries the line — the twin of upstream's `section vrf` text scan |
 * | `test_create_and_return_false` (`:115`, `create('a%')` `:117`, `assertFalse` `:118`) | ✅ as a client-side refusal, plus the device's own arm recorded | `vrfs.create('a%')` never reaches the wire here: `assertVrfName` refuses anything outside the `\w+` grammar the reader itself uses (divergence 6), so the awaited verb rejects with `NotSupportedError` (DR-005/DR-010). The case then sends upstream's **literal** arm as a raw guarded batch to record what 4.28.14M says about that name — pyeapi's `assertFalse` proves its DUT refused — printing the answer rather than asserting EOS's wording |
 * | `test_create_with_invalid_rd` (`:120`, pre-stage `:121-125`, `create(…, rd='192.168.1.1:99999999')` `:126`, `assertFalse` `:127`, scan `:128-135`, `assertNotIn('rd')` `:136-138`, cleanup `:139-142`) | ✅ (pre-staged from config lines; both device outcomes recorded) | upstream sends header+rd through one `configure` (`vrfs.py:169-175`) and its DUT applied the header while rejecting the rd, which is what `:131-138` asserts. Whether this container reproduces that partial outcome — or answers the batch differently — is the device's to say, and `Node.configure`/`ResourceBase.configure` (`base.ts:163-164`) document no atomicity claim of their own, so the port refuses to assume either: it pre-stages the VRF with the same config lines upstream's own `dut.config` pre-stage uses (`:123`/`:125`), then sends the identical `rd …` line as a one-command verb, and asserts only the invariant upstream actually relies on — whatever the device answered, the record carries **no invented rd**, and a refusal arrives as a typed error, never a `False` |
 * | `test_delete_and_return_true` (`:143`, stage `:144-147`, `delete` `:149`, `assertTrue` `:150`, scan `:151-153`, `assertNotIn` `:154-157`) | ✅ | `vrfs.delete(name)` composes `no vrf instance <name>` under the detected keyword (`vrfs.py:187-189`); the re-read `vrfs.get` must be `undefined` (DR-027) and the table must not carry the key |
 * | `test_delete_and_return_false` (`:160`, `delete('a%')` `:162`, `assertFalse` `:163`) | ✅ as a client-side refusal | `assertVrfName` runs before any read or write, so the awaited verb rejects with `NotSupportedError`; the case also reads the table afterwards to prove the guard gave the wire nothing to apply |
 * | `test_default` (`:165`, stage `:166-172`, `default` `:173`, `assertTrue` `:174`, scan `:175-177`, `assertNotIn` `:178-183`, cleanup `:184`) | ✅ | `vrfs.setDefault(name)` — `default vrf instance <name>` (`vrfs.py:202-204`, renamed per MIGRATION §5 row 77). Upstream's DUT removed the section; a container that keeps an empty section is reported with its fields, and either way the staged `description` must be gone |
 * | `test_set_rd` (`:186`, stage `:187-191`, `set_rd` `:192`, `assertTrue` `:193`, scan + `assertIn('blah')`/`assertIn('10:10')` `:194-197`, cleanup `:198-201`) | ✅ | `setVrfRd(name, '10:10')` enters the VRF section the way `configure_vrf` does (`vrfs.py:207-223`, builder at `:242`); read back as the typed field plus the block text |
 * | `test_set_description` (`:203`, `random_string()` `:205`, stage `:206-209`, `set_description` `:210`, `assertTrue` `:211`, scan + `assertIn` `:212-215`, `set_description(default=True)` `:216`, `assertTrue` `:217`, scan + `assertNotIn` `:218-220`, cleanup `:221-224`) | ✅ (the random string is pinned) | `setVrfDescription` then `defaultVrfDescription` — upstream's `default=True` arm composes `default description` (`abstract.py:152-153`). The negation reads back as **absence**, not `''` (divergence 4: upstream's `DESCRIPTION_RE` answered an empty value for a negated description, and `resources/vrfs.test.ts` pins that this port does not), so the case asserts `description === undefined` after the default and that the block no longer carries the text. Upstream's `random_string()` (`:205`) becomes a fixed phrase — a random description cannot be diffed against the block it just wrote |
 * | `test_set_ipv4_routing` (`:226`, stage incl. `rd 10:10` + `description test` `:227-233`, `set_ipv4_routing` `:234`, `assertTrue` `:235`, `section vrf` scan `:236-237`, `assertIn('ip routing vrf blah')` `:238-239`, `default=True` `:240`, `assertTrue` `:241`, scan `:242`, `assertIn('no ip routing vrf blah')` `:243-244`, cleanup `:245-248`) | ✅ (device-answer arm recorded) | `setIpv4Routing`/`defaultIpv4Routing` are top-level one-line writes that never enter the VRF submode (divergence 9, `vrfs.py:275-281`). The read is the flag pair, which is exactly divergence 5's negation-line probe — asserted to be `true` after the positive line and `false` with the `no …` key present. The container refusing routed mode at all (DR-122) is printed as the recorded refusal, and the case claims nothing |
 * | `test_set_ipv6_routing` (`:250`, stage `:251-257`, `set_ipv6_routing` `:258`, `assertTrue` `:259`, `show running-config all section vrf` `:260-261`, `assertIn('ipv6 unicast-routing vrf blah')` `:262-263`, `default=True` `:264`, `assertTrue` `:265`, scan `:266`, `assertIn('no ipv6 unicast-routing vrf blah')` `:267-268`, cleanup `:269-272`) | ✅ | the IPv6 trio (`vrfs.py:283-303`, builder at `:297`). Upstream had to switch to `running-config **all**` for this one because the line it looks for is a default-level write; the `Node` from `buildFullWriteNode` reads with the config defaults on (`configDefaults` default at `command-layer.ts:616`), so the same evidence is already in the document the flags were computed from |
 * | `test_set_interface` (`:274`, stage incl. `default interface Ethernet1` + `interface Ethernet1` + `no switchport` `:276-283`, `set_interface` `:284`, `assertTrue` `:285`, `show running-config interfaces Ethernet1` `:286-287`, `assertIn('vrf blah')`/`('vrf forwarding blah')` `:288-293`, `disable=True` `:294-295`, `assertTrue` `:296`, scan `:297`, `assertNotIn` `:298-305`) | ✅ (scratch port, not the provisioned Ethernet1) | upstream binds the **provisioned** `Ethernet1`; DR-035(b)/DR-126 keep that port owned by `lab-provision`, so the port here is `EAPI_SCRATCH_INTERFACE`, staged to L3 by a guarded batch with upstream's own lines (`:277-279`). `vrfs.setInterface(scratch, name)` composes `vrf <name>` — or `vrf forwarding <name>` on a definition-form device, the same detected keyword (divergence 8) — and the interface block is asserted to carry it; `unsetInterface` is upstream's `disable=True` arm and the block must then not carry it. The case ends by re-defaulting the port and deleting the VRF, and skips with a printed reason when no scratch port is declared |
 *
 * Upstream's `configure`-returned-`False` idiom (`abstract.py:117-127`, `vrfs.py`'s every-write) does not exist
 * here (DR-005): these arms assert `rejects`/a caught `EapiError` and say **which side** refused — the client
 * guard (`NotSupportedError`, before the wire) or the device (`CommandError`, with its code and `failedCommand`).
 */

import { beforeAll, describe, expect, it } from 'vitest'

import { CommandError, EapiError, NotSupportedError, SessionError } from './errors'
import { buildFullWriteNode, liveFullWriteReadiness } from './testing/live-full-write'
import { describeLiveTarget, matchesDeviceIdentity, requireScratchInterface, unwrapLiveTarget, type LiveTarget } from './testing/live-guard'
import { runGuardedLiveWriteSession } from './testing/live-session-policy'
import type { Vrf } from './resources/vrfs'
import type { Node } from './command-layer'

const SUITE = 'live-vrfs'
const gate = liveFullWriteReadiness(process.env)
const ready = gate.runnable
if (!ready) {
  console.warn(`${SUITE}: SKIPPED — ${gate.skipReason ?? 'gate refused the run'}`)
}

const scratch: { ok: boolean; name?: string; reason?: string } = ready
  ? (() => {
      const req = requireScratchInterface(unwrapLiveTarget(gate.resolution))
      return req.ok ? { ok: true, name: req.name } : { ok: false, reason: req.reason }
    })()
  : { ok: false, reason: 'live target not accepted' }
if (ready && !scratch.ok) {
  console.warn(`${SUITE}: the VRF→interface-binding case SKIPPED (DR-035b) — ${scratch.reason ?? ''}`)
}
const writeReady = ready && scratch.ok

const runId = String(Date.now()).slice(-6)

type Attempt = { readonly ok: true } | { readonly ok: false; readonly code: string; readonly text: string }

function firstLine(message: string): string {
  return message.split('\n')[0]?.slice(0, 200) ?? message
}

function describeError(rawErr: EapiError): string {
  return rawErr instanceof CommandError ? `CommandError(${String(rawErr.code)})` : String(rawErr.constructor.name)
}

/** pyeapi's `dut.config([...])` twin: a named session, abort-on-failure, never persisted (DR-035). */
async function batch(node: Node, label: string, commands: readonly string[]): Promise<Attempt> {
  try {
    await runGuardedLiveWriteSession(node, { name: `d2-${label}-r${runId}`, commands })
    return { ok: true }
  } catch (rawErr) {
    if (rawErr instanceof SessionError) throw rawErr
    if (!(rawErr instanceof EapiError)) throw rawErr
    console.warn(`${SUITE}: batch ${JSON.stringify(label)} did not apply (${describeError(rawErr)}): ${firstLine(rawErr.message)} — commands ${JSON.stringify(commands)}`)
    return { ok: false, code: describeError(rawErr), text: firstLine(rawErr.message) }
  }
}

/** pyeapi's `dut.api('vrfs').verb(...)` + `assertTrue`/`assertFalse` twin (DR-005: a refusal throws). */
async function verb(label: string, call: () => Promise<unknown>): Promise<Attempt> {
  try {
    await call()
    return { ok: true }
  } catch (rawErr) {
    if (!(rawErr instanceof EapiError)) throw rawErr
    const failed = rawErr instanceof CommandError ? ` failedCommand=${JSON.stringify(rawErr.failedCommand)}` : ''
    console.warn(`${SUITE}: ${label} — device answer ${describeError(rawErr)}: ${firstLine(rawErr.message)}${failed}`)
    return { ok: false, code: describeError(rawErr), text: firstLine(rawErr.message) }
  }
}

function requireApplied(label: string, attempt: Attempt): void {
  if (!attempt.ok) throw new Error(`${SUITE}: ${label} failed (${attempt.code}): ${attempt.text} — a VRF this run created is still on the container other suites share`)
}

/** The section header this run stages, in the keyword `vrfs.ts` picks when the config is silent (divergence 1). */
const header = (name: string): string => `vrf instance ${name}`
/** Delete-if-exists prelude: the container persists across suites (DR-126 lane), so clean before acting. */
const prelude = (name: string): string => `no ${header(name)}`

async function readVrf(node: Node, name: string): Promise<Vrf | undefined> {
  return await node.vrfs.get(name)
}

/** Teardown shared by the binding case: restore the port and drop the VRF, loudly if either fails. */
async function teardownVrfAndPort(node: Node, label: string, vrf: string, ports: readonly string[]): Promise<void> {
  requireApplied(label, await batch(node, label, [...ports.map((port) => `default interface ${port}`), prelude(vrf)]))
}

describe.skipIf(!ready)('live full-write lane: pyeapi test_api_vrfs.py (TestApiVrfs, :43)', () => {
  let node: Node
  /** The one `ip routing` attempt, recorded for the routing-flag cases to quote (DR-122). */
  let routingAttempt: Attempt | undefined

  beforeAll(async () => {
    const target: LiveTarget = unwrapLiveTarget(gate.resolution)
    console.log(`${SUITE}: target = ${describeLiveTarget(target)}`)
    node = buildFullWriteNode(target)
    const reported = await node.getVersion()
    const mismatch = matchesDeviceIdentity(target, { version: reported.version, modelName: reported.modelName })
    if (mismatch !== undefined && mismatch.code !== 'EAPI_VERSION_MISMATCH') throw new Error(`${SUITE} readiness: ${mismatch.reason}`)
    if (mismatch?.code === 'EAPI_VERSION_MISMATCH') {
      console.warn(`${SUITE}: reported version "${reported.version}" vs pin "${target.allowVersion}" (base-level enforced by the probe, DR-066)`)
    }
    const settings = await node.system.get()
    console.log(`${SUITE}: system.get() ipRouting=${String(settings.ipRouting)} — that flag only reports a literal \`no ip routing\` line, so it cannot settle routed mode (system.ts, pyeapi _parse_iprouting parity)`)
    routingAttempt = await batch(node, 'ip-routing', ['ip routing'])
    if (!routingAttempt.ok) console.warn(`${SUITE}: \`ip routing\` refused (${routingAttempt.code}): ${routingAttempt.text} — routed-mode and VRF-routing cases carry that device answer instead of assuming it (DR-122)`)
  })

  it('a staged VRF answers the typed record, each routing flag matching the negation line (test_get, :45 — stage :46-52, get :53, expected dict :54-56, assertEqual :56, cleanup :57-60)', async () => {
    const vrf = 'livevrf1'
    requireApplied('get-prep', await batch(node, 'get-prep', [prelude(vrf), header(vrf), 'rd 10:10', 'description blah desc']))
    const found = await readVrf(node, vrf)
    if (found === undefined) {
      console.warn(`${SUITE}: \`vrf instance ${vrf}\` committed but reads back absent — which header keyword this container speaks is a device answer (this stage used the client's default form, DR-099)`)
      requireApplied('get-teardown', await batch(node, 'get-teardown', [prelude(vrf)]))
      return
    }
    expect(found.name).toBe(vrf)
    expect(found.rd).toBe('10:10')
    expect(found.description).toBe('blah desc')
    expect([true, false]).toContain(found.ipv4Routing)
    expect([true, false]).toContain(found.ipv6Routing)
    // Divergence 5, live: a flag is "the exact negation key is absent" — the same rule pyeapi implements with two
    // `get_block` calls (`vrfs.py:92-99`). Asserting flag-against-document is stronger than upstream's value pin.
    const sections = await node.chunkConfig()
    expect(found.ipv4Routing).toBe(!sections.has(`no ip routing vrf ${vrf}`))
    expect(found.ipv6Routing).toBe(!sections.has(`no ipv6 unicast-routing vrf ${vrf}`))
    console.log(`${SUITE}: test_get for ${vrf} → ipv4Routing=${String(found.ipv4Routing)} ipv6Routing=${String(found.ipv6Routing)} form=${found.definitionForm} (upstream pins False/False at :55)`)
    if (found.definitionForm !== 'instance') console.warn(`${SUITE}: this entry's header spelled the \`definition\` keyword — the container speaks the older form, and detection (not a version compare) saw it (DR-099)`)
    requireApplied('get-teardown', await batch(node, 'get-teardown', [prelude(vrf)]))
    expect(await readVrf(node, vrf)).toBeUndefined()
  })

  it('getAll() reports both VRFs this run created and every record names itself (test_getall, :62 — CliVariants stage :63-68, getall :69, isinstance :70, len==2 :71, membership :72-73, cleanup :74-76)', async () => {
    const names = ['livevrf2', 'livevrf3']
    requireApplied('all-prep', await batch(node, 'all-prep', names.map((name) => prelude(name))))
    if (!(await batch(node, 'all-stage', names.map((name) => header(name)))).ok) return
    const all = await node.vrfs.getAll()
    console.log(`${SUITE}: getAll() keys = ${JSON.stringify([...all.keys()])} (upstream demands exactly 2 at :71; this container also holds whatever its owner configured)`)
    for (const name of names) {
      expect(all.has(name)).toBe(true)
      const record = all.get(name)
      expect(record?.name).toBe(name)
      expect(['instance', 'definition']).toContain(record?.definitionForm)
      expect([true, false]).toContain(record?.ipv4Routing)
      expect([true, false]).toContain(record?.ipv6Routing)
    }
    // This client builds its table from the section keys, so every entry's name must equal its key (row 96).
    for (const [name, record] of all) expect(record.name).toBe(name)
    requireApplied('all-teardown', await batch(node, 'all-teardown', names.map((name) => prelude(name))))
    const after = await node.vrfs.getAll()
    for (const name of names) expect(after.has(name)).toBe(false)
  })

  it('vrfs.create() makes the VRF and the device\'s own `show vrf` names it (test_create_and_return_true, :78 — pre-stage :80-83, create :84, assertTrue :85, show vrf :86-87, cleanup :88-91)', async () => {
    const vrf = 'livevrf4'
    requireApplied('create-prep', await batch(node, 'create-prep', [prelude(vrf)]))
    expect(await readVrf(node, vrf)).toBeUndefined()
    if (!(await verb(`vrfs.create(${vrf})`, () => node.vrfs.create(vrf))).ok) return
    expect((await readVrf(node, vrf))?.name).toBe(vrf)
    try {
      const shown = await node.showText('show vrf')
      console.log(`${SUITE}: show vrf → ${JSON.stringify(shown.split('\n').slice(0, 5))}`)
      expect(shown).toContain(vrf)
    } catch (rawErr) {
      if (!(rawErr instanceof EapiError)) throw rawErr
      console.warn(`${SUITE}: \`show vrf\` refused (${describeError(rawErr)}): ${firstLine(rawErr.message)} — upstream's verification at :86-87 is recorded as this container's capability answer; the running-config read above does not depend on it`)
    }
    requireApplied('create-teardown', await batch(node, 'create-teardown', [prelude(vrf)]))
    expect(await readVrf(node, vrf)).toBeUndefined()
  })

  it('create(name, { rd }) writes the rd inside the same transaction (test_create_with_valid_rd, :93 — pre-stage :94-98, create :99, assertTrue :100, section-vrf scan :101-108, assertIn(rd 10:10) :109, cleanup :110-113)', async () => {
    const vrf = 'livevrf5'
    requireApplied('rd-prep', await batch(node, 'rd-prep', [prelude(vrf)]))
    if (!(await verb(`vrfs.create(${vrf}, { rd: 10:10 })`, () => node.vrfs.create(vrf, { rd: '10:10' }))).ok) return
    expect((await readVrf(node, vrf))?.rd).toBe('10:10')
    const block = (await node.vrfs.getBlock(header(vrf))) ?? ''
    console.log(`${SUITE}: the ${JSON.stringify(header(vrf))} section reads ${JSON.stringify(block.trim().split('\n').slice(0, 4))}`)
    expect(block).toContain(`vrf instance ${vrf}`)
    expect(block).toContain('rd 10:10')
    requireApplied('rd-teardown', await batch(node, 'rd-teardown', [prelude(vrf)]))
  })

  it('a name the grammar cannot hold is refused before the wire; the device answers its own arm (test_create_and_return_false, :115 — create(\'a%\') :117, assertFalse :118)', async () => {
    await expect(node.vrfs.create('livevrf%1')).rejects.toThrow(NotSupportedError)
    expect((await node.vrfs.getAll()).has('livevrf%1')).toBe(false)
    // Upstream's False came from the CLI rejecting the name (pyeapi validates nothing here — divergence 6), so the
    // container's answer to that literal line is recorded, not asserted as EOS wording.
    const deviceArm = await batch(node, 'bad-name-device', ['vrf instance livevrf%1'])
    console.log(`${SUITE}: the raw \`vrf instance livevrf%1\` arm → ${deviceArm.ok ? 'ACCEPTED by this container (upstream asserts a refusal at :117-118)' : `refused (${deviceArm.code}): ${deviceArm.text}`}`)
    if (deviceArm.ok) requireApplied('bad-name-clean', await batch(node, 'bad-name-clean', ['no vrf instance livevrf%1']))
  })

  it('an rd the reader could never name is decided by the device and invents nothing (test_create_with_invalid_rd, :120 — pre-stage :121-125, create :126, assertFalse :127, scan :128-135, assertNotIn(rd) :136-138, cleanup :139-142)', async () => {
    const vrf = 'livevrf6'
    requireApplied('badrd-prep', await batch(node, 'badrd-prep', [prelude(vrf), header(vrf)]))
    // Upstream stages header+rd in one `configure` (`vrfs.py:169-175`) and its DUT kept the header while
    // rejecting the rd (`:131-138`). This client's `configure` (`base.ts:163-164` → `Node.configure`) makes no
    // atomicity promise, so neither outcome is assumed: the VRF is pre-staged with upstream's own config lines
    // (`:123`/`:125`), then the identical `rd …` line goes out as a one-command verb, and the only thing
    // asserted is upstream's real invariant — no invented rd, and a refusal is a typed error, never `False`.
    const attempt = await verb(`vrfs.setVrfRd(${vrf}, 192.168.1.1:99999999)`, () => node.vrfs.setVrfRd(vrf, '192.168.1.1:99999999'))
    const found = await readVrf(node, vrf)
    if (!attempt.ok) {
      if (found === undefined) console.warn(`${SUITE}: the bad rd aborted the entire transaction on this container, so the VRF itself is gone — upstream's DUT kept the section and dropped only the rd (:131-135). Recorded as a device/all-or-nothing difference, not as a pass`)
      else expect(found.rd).toBeUndefined()
    } else {
      console.warn(`${SUITE}: this container ACCEPTED \`rd 192.168.1.1:99999999\`, which upstream asserts as a refusal at :126-127 — reported as a capability answer, and the read must still round-trip it`)
      expect(found?.rd).toBe('192.168.1.1:99999999')
    }
    requireApplied('badrd-teardown', await batch(node, 'badrd-teardown', [prelude(vrf)]))
    expect(await readVrf(node, vrf)).toBeUndefined()
  })

  it('vrfs.delete() takes the section away (test_delete_and_return_true, :143 — stage :144-147, delete :149, assertTrue :150, scan :151-153, assertNotIn :154-157)', async () => {
    const vrf = 'livevrf7'
    requireApplied('del-prep', await batch(node, 'del-prep', [prelude(vrf), header(vrf)]))
    if ((await readVrf(node, vrf)) === undefined) {
      console.warn(`${SUITE}: the staged VRF did not read back, so :154-157's not-in half would prove nothing — case reported, not claimed`)
      requireApplied('del-teardown', await batch(node, 'del-teardown', [prelude(vrf)]))
      return
    }
    if (!(await verb(`vrfs.delete(${vrf})`, () => node.vrfs.delete(vrf))).ok) return
    expect(await readVrf(node, vrf)).toBeUndefined()
    expect((await node.vrfs.getAll()).has(vrf)).toBe(false)
  })

  it('deleting a name outside the grammar is refused before the wire (test_delete_and_return_false, :160 — delete(\'a%\') :162, assertFalse :163)', async () => {
    await expect(node.vrfs.delete('livevrf%2')).rejects.toThrow(NotSupportedError)
    const all = await node.vrfs.getAll()
    expect([...all.keys()].some((name) => name.includes('livevrf%'))).toBe(false)
    console.log(`${SUITE}: test_delete_and_return_false — the client guard refused it (NotSupportedError, zero round trips), where upstream's False came from the CLI at :162`)
  })

  it('setDefault defaults the VRF; gone-or-empty, with the staged description proven off (test_default, :165 — stage :166-172, default :173, assertTrue :174, scan :175-177, assertNotIn :178-183, cleanup :184)', async () => {
    const vrf = 'livevrf8'
    requireApplied('default-prep', await batch(node, 'default-prep', [prelude(vrf), header(vrf), 'description test desc']))
    const staged = await readVrf(node, vrf)
    if (staged === undefined) {
      console.warn(`${SUITE}: the staged VRF did not read back — nothing to default, case reported`)
      requireApplied('default-teardown', await batch(node, 'default-teardown', [prelude(vrf)]))
      return
    }
    expect(staged.description).toBe('test desc')
    if (!(await verb(`vrfs.setDefault(${vrf})`, () => node.vrfs.setDefault(vrf))).ok) return
    const after = await readVrf(node, vrf)
    if (after === undefined) expect(after).toBeUndefined()
    else {
      console.warn(`${SUITE}: after \`default ${header(vrf)}\` the section still reads (${JSON.stringify({ rd: after.rd, description: after.description, form: after.definitionForm })}) — upstream asserts absence at :178-183`)
      expect(after.description).toBeUndefined()
    }
    requireApplied('default-teardown', await batch(node, 'default-teardown', [prelude(vrf)]))
  })

  it('setVrfRd writes the rd inside the VRF section (test_set_rd, :186 — stage :187-191, set_rd :192, assertTrue :193, scan :194-195, assertIn :196-197, cleanup :198-201)', async () => {
    const vrf = 'livevrf9'
    requireApplied('setrd-prep', await batch(node, 'setrd-prep', [prelude(vrf), header(vrf)]))
    if (!(await verb(`vrfs.setVrfRd(${vrf}, 10:10)`, () => node.vrfs.setVrfRd(vrf, '10:10'))).ok) return
    expect((await readVrf(node, vrf))?.rd).toBe('10:10')
    expect((await node.vrfs.getBlock(header(vrf))) ?? '').toContain('10:10')
    requireApplied('setrd-teardown', await batch(node, 'setrd-teardown', [prelude(vrf)]))
  })

  it('setVrfDescription then defaultVrfDescription round-trips the text, then reads it back absent (test_set_description, :203 — random_string :205, stage :206-209, set_description :210, assertTrue :211, scan :212-213, assertIn :214-215, default=True :216, assertTrue :217, scan :218, assertNotIn :219-220, cleanup :221-224)', async () => {
    const vrf = 'livevrf10'
    const text = 'live suite description'
    requireApplied('setdesc-prep', await batch(node, 'setdesc-prep', [prelude(vrf), header(vrf)]))
    if (!(await verb(`vrfs.setVrfDescription(${vrf}, …)`, () => node.vrfs.setVrfDescription(vrf, text))).ok) return
    expect((await readVrf(node, vrf))?.description).toBe(text)
    expect((await node.vrfs.getBlock(header(vrf))) ?? '').toContain(`description ${text}`)
    if (!(await verb(`vrfs.defaultVrfDescription(${vrf})`, () => node.vrfs.defaultVrfDescription(vrf))).ok) return
    const cleared = await readVrf(node, vrf)
    // DR-029's family: upstream's `DESCRIPTION_RE` (`vrfs.py:56`, `:120-133`) answered `''` for a negated
    // description; this port reads absence, and `resources/vrfs.test.ts` pins that. So `undefined`, not `''`.
    expect(cleared?.description).toBeUndefined()
    expect((await node.vrfs.getBlock(header(vrf))) ?? '').not.toContain(`description ${text}`)
    requireApplied('setdesc-teardown', await batch(node, 'setdesc-teardown', [prelude(vrf)]))
  })

  it('setIpv4Routing / defaultIpv4Routing move the flag by the exact negation line (test_set_ipv4_routing, :226 — stage :227-233, set :234, assertTrue :235, scan :236-237, assertIn :238-239, default=True :240, assertTrue :241, scan :242, assertIn(no …) :243-244, cleanup :245-248)', async () => {
    const vrf = 'livevrf11'
    requireApplied('ipv4-prep', await batch(node, 'ipv4-prep', [prelude(vrf), header(vrf), 'rd 10:10', 'description test']))
    if (routingAttempt !== undefined && !routingAttempt.ok) console.warn(`${SUITE}: test_set_ipv4_routing runs with \`ip routing\` already refused (${routingAttempt.code}) — the two arms below carry that device answer (DR-122)`)
    const on = await verb(`vrfs.setIpv4Routing(${vrf})`, () => node.vrfs.setIpv4Routing(vrf))
    if (!on.ok) {
      requireApplied('ipv4-teardown', await batch(node, 'ipv4-teardown', [prelude(vrf)]))
      return
    }
    expect((await readVrf(node, vrf))?.ipv4Routing).toBe(true)
    const off = await verb(`vrfs.defaultIpv4Routing(${vrf})`, () => node.vrfs.defaultIpv4Routing(vrf))
    if (!off.ok) {
      requireApplied('ipv4-teardown', await batch(node, 'ipv4-teardown', [prelude(vrf)]))
      return
    }
    expect((await readVrf(node, vrf))?.ipv4Routing).toBe(false)
    const sections = await node.chunkConfig()
    // Upstream demands the literal `no ip routing vrf blah` line at :243; that key is what this client's flag is.
    expect(sections.has(`no ip routing vrf ${vrf}`)).toBe(true)
    console.log(`${SUITE}: after defaultIpv4Routing the document carries ${JSON.stringify(`no ip routing vrf ${vrf}`)} = ${String(sections.has(`no ip routing vrf ${vrf}`))}`)
    requireApplied('ipv4-teardown', await batch(node, 'ipv4-teardown', [prelude(vrf)]))
  })

  it('setIpv6Routing / defaultIpv6Routing do the same for the unicast-routing line (test_set_ipv6_routing, :250 — stage :251-257, set :258, assertTrue :259, all-section-vrf scan :260-261, assertIn :262-263, default=True :264, assertTrue :265, scan :266, assertIn(no …) :267-268, cleanup :269-272)', async () => {
    const vrf = 'livevrf12'
    requireApplied('ipv6-prep', await batch(node, 'ipv6-prep', [prelude(vrf), header(vrf), 'rd 10:10', 'description test']))
    const on = await verb(`vrfs.setIpv6Routing(${vrf})`, () => node.vrfs.setIpv6Routing(vrf))
    if (!on.ok) {
      requireApplied('ipv6-teardown', await batch(node, 'ipv6-teardown', [prelude(vrf)]))
      return
    }
    expect((await readVrf(node, vrf))?.ipv6Routing).toBe(true)
    const off = await verb(`vrfs.defaultIpv6Routing(${vrf})`, () => node.vrfs.defaultIpv6Routing(vrf))
    if (!off.ok) {
      requireApplied('ipv6-teardown', await batch(node, 'ipv6-teardown', [prelude(vrf)]))
      return
    }
    expect((await readVrf(node, vrf))?.ipv6Routing).toBe(false)
    const sections = await node.chunkConfig()
    expect(sections.has(`no ipv6 unicast-routing vrf ${vrf}`)).toBe(true)
    // Upstream switched to `show running-config all section vrf` for this case alone (:260) because the line it
    // wants is default-level; this Node reads with the config defaults on, so the flags and this key come from
    // the same document (`configDefaults` default, command-layer.ts:616).
    requireApplied('ipv6-teardown', await batch(node, 'ipv6-teardown', [prelude(vrf)]))
  })
})

describe.skipIf(!writeReady)('live VRF→interface binding on the scratch port: pyeapi test_api_vrfs.py (test_set_interface, :274)', () => {
  let node: Node
  let intf: string

  beforeAll(async () => {
    intf = scratch.name ?? ''
    node = buildFullWriteNode(unwrapLiveTarget(gate.resolution))
  })

  it('vrfs.setInterface binds the scratch port, unsetInterface releases it, and the port is re-defaulted (:274 — stage incl. default/interface/no switchport :276-283, set_interface :284, assertTrue :285, interface block :286-287, assertIn :288-293, disable=True :294-295, assertTrue :296, block :297, assertNotIn :298-305)', async () => {
    const vrf = 'livevrf13'
    // Upstream stages `default interface Ethernet1` + `interface Ethernet1` + `no switchport` in the ≥'4.23' arm
    // (`:277-279`); the named scratch port stands in for Ethernet1, which `lab-provision` owns (DR-122/DR-126).
    requireApplied('bind-prep', await batch(node, 'bind-prep', [prelude(vrf), header(vrf), 'rd 10:10', `default interface ${intf}`, `interface ${intf}`, 'no switchport']))
    const created = await readVrf(node, vrf)
    if (created === undefined) {
      console.warn(`${SUITE}: the VRF for the binding case did not read back — :284-305 is reported, not claimed`)
      await teardownVrfAndPort(node, 'bind-abort', vrf, [intf])
      return
    }
    if (!(await verb(`vrfs.setInterface(${intf}, ${vrf})`, () => node.vrfs.setInterface(intf, vrf))).ok) {
      await teardownVrfAndPort(node, 'bind-refused', vrf, [intf])
      return
    }
    const bound = (await node.getBlock(`interface ${intf}`)) ?? ''
    // Divergence 8: the interface keyword comes from the same detected form as the section header — `vrf <name>`
    // on an instance-form device, `vrf forwarding <name>` on a definition-form one (`vrfs.py:322-329`).
    const keyword = created.definitionForm === 'definition' ? 'vrf forwarding' : 'vrf'
    console.log(`${SUITE}: ${intf} block after binding → ${JSON.stringify(bound.trim().split('\n').slice(0, 5))}`)
    expect(bound).toContain(`${keyword} ${vrf}`)
    expect((await node.ipinterfaces.get(intf))?.name).toBe(intf)
    if (!(await verb(`vrfs.unsetInterface(${intf})`, () => node.vrfs.unsetInterface(intf))).ok) {
      await teardownVrfAndPort(node, 'unbind-refused', vrf, [intf])
      return
    }
    const released = (await node.getBlock(`interface ${intf}`)) ?? ''
    expect(released).not.toContain(`${keyword} ${vrf}`)
    // Upstream re-reads the same block for the `disable=True` half (`:297-305`) and leaves the port as it staged
    // it; the `default interface` here is that restoration, inside a named session that never persists (DR-035).
    await teardownVrfAndPort(node, 'bind-teardown', vrf, [intf])
    expect(await readVrf(node, vrf)).toBeUndefined()
  })
})
