/**
 * `*.live.test.ts` port of `pyeapi/test/system/test_api_system.py` @ `6816d9e` — M12a (#14), a
 * read-mostly live suite. Follows `live-wiring.live.test.ts` as the exemplar and `src/testing/live-guard.ts`
 * as the ONLY gate.
 *
 * ## Loud skip (DR-034), then the upstream ledger
 * With `EAPI_LIVE!=1` or an incomplete lab env this file prints the guard's refusal reason and skips every
 * case — `npm run test:live` green still means "no device ran", and it never affects offline `npm test`
 * (the `unit` project excludes `*.live.test.ts`). The guard reads `process.env` once at module load, before
 * any `describe`; `unwrapLiveTarget` is only called inside `it`/`beforeAll` bodies, which do not execute
 * under `describe.skipIf`, so a misconfigured run cannot crash during collection.
 *
 * | upstream (verified line @6816d9e) | ported? | here / why |
 * |---|---|---|
 * | `test_get` (`:44`) | ✅ shape | `node.system.get()` returns the typed record ({hostname, ipRouting, banner}); assertion is on **keys/types**, not the dynamic upstream value — the container's hostname/`ip routing` are whatever the lab booted. Its `dut.config('default hostname')` (`:46`) is the same reset this lane's hostname restore performs (`default hostname` when the capture carried no `hostname` line) |
 * | `test_get_with_period` (`:52`), `test_get_check_hostname` (`:58`) | ✅ **now ported behind DR-126 consent** (was: DR-035(b) skip) | the global hostname writes — `hostname host.domain.net` (`:54`), `hostname teststring` (`:60`) — and their read-backs (`:56`, `:62`) run in the second describe, in named guarded sessions, with the device's own hostname captured before and restored in a `finally`. What made these unsafe under DR-035(b) alone ("the `abort` of a scratch session cannot un-rename the DUT") is answered by the DR-126 pairing: the run is a throwaway container that is always torn down, **and** the suite restores deliberately instead of relying on a session rollback. The rename also cannot take this connection down: the lab API certificate has no SAN (`scripts/ceos-lab.mjs:1414`), so trust rides the run's CA/fingerprint (DR-013), not a hostname match, and the harness itself stages an **uncommitted** `hostname lab-pending-not-committed` for its own pending-session capture (`scripts/ceos-lab.mjs:1285`, `:1280`) |
 * | `test_get_check_banners` (`:64`), `test_get_banner_with_EOF` (`:74`) | ✅ **now ported behind DR-126 consent** (was: DR-035(b) skip) | the two banner payloads (`:68`/`:69`, `:77`) are exactly DR-015's `{cmd, input}` shape, and the read-backs (`:71`/`:72`, `:79`) are what `bannerBodyFrom` answers verbatim — `SecondLIneEOF…` (`:76`) is **not** a terminator for either reader, because a banner block closes only on a line that *is* `EOF` (divergence 4, `system.ts:315-323`). Captured/restored per kind, like the hostname |
 * | the 15 `test_set_*` cases (`:81`–`:222`) | ✅ **all 15 arms now ported behind DR-126 consent** (was: DR-035(b) skip) | hostname / `ip routing` / banner setters. They collapse onto the **9 verbs this module ships** — see the arm→verb map below — because pyeapi reaches the same command text through `value=`/`disable=`/`default=` keyword soup (`abstract.py:152-161`) while this client names each command (`DR-037`). The command lists and refusals stay pinned offline in `system.test.ts`; here they get the device's answer, with capture-before/restore-after in a `finally` so the container is left as found. One arm is capability-**probed**, never asserted: `ip routing` (see the caveats below) |
 *
 * The `read`-side here is deliberately the *typed record*, not pyeapi's snake_case dict: `test_get`'s
 * `self.assertEqual(sorted(keys), …)` (`:49`) is against `['hostname','iprouting','banner_motd','banner_login']`
 * — the snake_case names MIGRATION.md §4 replaces, so the port asserts the shape of `SystemSettings`, which
 * is the honest current contract (DR-003/row 90), not the upstream one.
 *
 * ## The full-write lane (second describe) — DR-126
 * `liveFullWriteReadiness(process.env)` (`./testing/live-full-write`) composes the env gate, the `lab`
 * target-class rule and the `EAPI_LAB_FULL_WRITE=1` consent that DR-126 added (`docs/DECISIONS.md:1996`);
 * `scripts/ceos-lab.mjs`'s `cmdRun` child env is what passes that consent, together with
 * `EAPI_SCRATCH_INTERFACE` (`:2276`) and `EAPI_SCRATCH_VLAN=1201` (`:2285`). Without it every case in the
 * second describe is skipped **loudly** and nothing reaches a device. The `Node` comes from
 * `buildFullWriteNode`, so the self-lockout fence (eAPI listener, built-in `admin`/`netadmin`, the API user
 * in use, the `interface Management…` path, `copy run start` — `src/testing/live-session-policy.ts:162-165`)
 * sits on the transport seam and no case has to remember it.
 *
 * Arm → shipped verb, with the upstream call/assert lines (grep-verified on the pinned clone):
 * `set_hostname(value=…)` → `setHostname` (`:85`/`:88`, `:145`/`:148`); `set_hostname(disable=True)` →
 * `unsetHostname` (`:93`, text `no hostname` at `:95`-`:96`); `set_hostname(default=True)` →
 * `defaultHostname` (`:101`/`:104`); `set_hostname(value='foo', default=True)` → also `defaultHostname`,
 * because this client has no value-plus-default combination left to disagree about (`:109`/`:112`);
 * `set_iprouting(True)` → `setIpRouting(true)` (`:117`/`:119` — upstream's own assert at `:119` carries the
 * typo `no ip rotuing`, so it can never fail there); `set_iprouting(False)` → `setIpRouting(false)`
 * (`:124`/`:126`); `set_iprouting(disable=True)` → `unsetIpRouting` (`:131`/`:133`);
 * `set_iprouting(default=True)` → `defaultIpRouting` (`:138`/`:140`); `set_banner(kind, text)` →
 * `setBanner` (`:157`/`:159`, `:186`/`:188`, `:204`/`:206` and the read at `:207`-`:208`);
 * `set_banner(kind, None, default=True)` → `defaultBanner` (`:194`/`:195`, `:214`/`:215`);
 * `set_banner(kind, None, disable=True)` → `unsetBanner` (`:221`/`:222`). Every upstream post-assert reads
 * `dut.running_config` **text** for the literal line (`hostname foo`, `no banner motd`, …); this client
 * asserts the **typed record**, where a cleared global is absent rather than a stored `no …` line (DR-027),
 * and prints `Node.getBlock` text when the device's own spelling is the question.
 *
 * Two container caveats this lane states up front instead of discovering mid-run:
 *  - **`ip routing` is container-shape dependent.** cEOS-lab 4.28.14M answered `% Unavailable command`, which
 *    is why the harness sends its own `ip routing` (`scripts/ceos-lab.mjs:1172`) through a **tolerated**
 *    refusal list (`:1193`, `:1202`) and records the routing-table consequence of it (`:1604`). The routing
 *    arms are therefore probed: attempt, then either the typed read-back or the device's printed refusal —
 *    never an assumption, and the captured flag is restored either way.
 *  - **the banner/hostname writes are single-command transactions already.** Every shipped `system` verb
 *    composes exactly one config command (`system.ts:378-447`), so all-or-nothing comes for free there;
 *    the multi-line staging and the capture/restore payloads run through `runGuardedLiveWriteSession` with
 *    names `live-sys-<case>` (DR-035/DR-081), which is this lane's only all-or-nothing primitive.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createNode } from './node'
import { CommandError, EapiError, NotSupportedError, ProtocolError } from './errors'
import { buildFullWriteNode, liveFullWriteReadiness } from './testing/live-full-write'
import { resolveLiveEnv, unwrapLiveTarget, liveTransportOptions, matchesDeviceIdentity, describeLiveTarget } from './testing/live-guard'
import { runGuardedLiveWriteSession } from './testing/live-session-policy'
import type { SystemBannerKind, SystemSettings } from './resources/system'
import type { CommandSpec } from './types/eapi'
import type { Node } from './command-layer'

const resolution = resolveLiveEnv(process.env)
if (!resolution.ok) {
  console.warn(`live-system: SKIPPED (DR-034) — ${resolution.reason}`)
}
const ready = resolution.ok

describe.skipIf(!ready)('live read-mostly: pyeapi test_api_system.py (test_get, :44)', () => {
  let node: Node

  beforeAll(async () => {
    const target = unwrapLiveTarget(resolution)
    console.log(`live-system: target = ${describeLiveTarget(target)}`)
    node = createNode(liveTransportOptions(target))
    // Readiness/identity gate (docs/CEOS.md:113/128-129): the device must say what the guard required,
    // before any read below is interpreted as "the software does X".
    const reported = await node.getVersion()
    const mismatch = matchesDeviceIdentity(target, { version: reported.version, modelName: reported.modelName })
    // The guard's EXACT-version branch cannot be satisfied by this image: the recorded cEOS capture
    // (`test/fixtures/live/ceos-4.28.14M/show-version.json`) carries
    // `version = "4.28.14M-… (engineering build)"`, while `resolveLiveEnv` pins `EAPI_ALLOW_VERSION` to the
    // base image `4.28.14M`. The base-level version identity + TLS/model cross-check is what the lab
    // harness's `probe` enforces (DR-066), so here we hard-fail on any MODEL or train refusal and tolerate
    // ONLY the suffix-driven `EAPI_VERSION_MISMATCH` — without editing or weakening the guard.
    if (mismatch !== undefined && mismatch.code !== 'EAPI_VERSION_MISMATCH') {
      throw new Error(`live-system readiness: ${mismatch.reason}`)
    }
    if (mismatch?.code === 'EAPI_VERSION_MISMATCH') {
      console.warn(`live-system: cEOS reported version "${reported.version}"; the exact pin "${target.allowVersion}" is base-level enforced by the probe (DR-066), not here`)
    }
  })

  it('system.get() answers the typed record, not pyeapi\'s snake_case dict (shape-level)', async () => {
    const settings = await node.system.get()
    // Keys the record always has (upstream `test_get`, :44-50, proves the same field set exists — under the
    // old names). Types, never values: hostname/ipRouting/banner are lab-dependent on a running target.
    expect(typeof settings.hostname).toBe('string')
    expect(typeof settings.ipRouting).toBe('boolean')
    expect(settings.banner).toBeTypeOf('object')
    // DR-027 vocabulary: a configured switch reports a non-empty hostname; the fallback is `''`, never pyeapi's
    // invented 'localhost' (system.ts divergence 1). We do not hard-assert non-empty (a bare lab default may be
    // empty), only that the field round-trips as a string the reader produced.
    expect(settings.hostname).not.toBe('localhost')
  })
})

// --- DR-126 full-write lane: the global `system` writes pyeapi's file is mostly made of ----------------

/**
 * The DR-126 gate, checked once at module load like every other live suite: env first, then the `lab`
 * target class, then the `EAPI_LAB_FULL_WRITE=1` consent (`live-full-write.ts:32-40`,
 * `live-guard.ts:requireLabFullWrite`). Unset consent ⇒ the refusal prints and **zero** cases execute.
 */
const fullWrite = liveFullWriteReadiness(process.env)
if (!fullWrite.runnable) {
  console.warn(`live-system: full-write cases SKIPPED (DR-034/DR-126) — ${fullWrite.skipReason ?? 'reason unavailable'}`)
}

/** Upstream's EOF payload verbatim (`test_api_system.py:76`): EOF *inside* a line, which no reader here treats as the terminator. */
const EOF_BODIED_BANNER = '!!!newlinebaner\nSecondLIneEOF!!!newlinebanner'

/** The device/transport refusal vocabulary, printed rather than swallowed (mirrors `live-users.live.test.ts`). */
function refusalText(rawErr: unknown): string {
  if (rawErr instanceof EapiError) {
    const code = rawErr instanceof CommandError ? String(rawErr.code) : rawErr instanceof ProtocolError ? `protocol ${String(rawErr.code)}` : 'no code'
    return `${rawErr.constructor.name} ${code}: ${rawErr.message.split('\n')[0]?.slice(0, 160) ?? ''}`
  }
  return rawErr instanceof Error ? `${rawErr.constructor.name}: ${rawErr.message.split('\n')[0]?.slice(0, 160) ?? ''}` : String(rawErr)
}

describe.skipIf(!fullWrite.runnable)('live full-write: pyeapi test_api_system.py (get_with_period :52 / get_check_hostname :58 / banners :64,:74 / the 15 set_* arms :81-:222)', () => {
  let node: Node
  /** What the device answered **before** this describe wrote anything — the restore target of every case. */
  let captured: SystemSettings

  /** One named guarded session (`live-sys-<case>`, never `copy run start`): DR-035/DR-081. */
  const guard = (caseName: string, commands: readonly CommandSpec[]) =>
    runGuardedLiveWriteSession(node, { name: `live-sys-${caseName}`, commands })

  /** The banner payload shape upstream sends (`:68`/`:69`/`:77`-style `dict(cmd=…, input=…)`), i.e. DR-015's CommandObject. */
  const bannerPayload = (kind: SystemBannerKind, body: string): CommandSpec => ({ cmd: `banner ${kind}`, input: `${body}\nEOF\n` })

  /** A restore is allowed to fail — the device may refuse its own default — but never silently. */
  async function restore(label: string, commands: readonly CommandSpec[]): Promise<void> {
    try {
      await guard(label, commands)
    } catch (rawErr) {
      console.warn(`live-system: restore ${JSON.stringify(label)} was refused (${refusalText(rawErr)}) — this case's value may survive on the container; reported, not hidden`)
    }
  }

  function restoreHostname(): Promise<void> {
    // pyeapi's own reset for this file is `default hostname` (`:46`), which is what a capture with no readable
    // hostname line means; a captured name is re-applied as-is so a device-chosen name is not "improved".
    return restore('restore-hostname', captured.hostname === '' ? ['default hostname'] : [`hostname ${captured.hostname}`])
  }

  function restoreBanner(kind: SystemBannerKind): Promise<void> {
    const body = captured.banner[kind]
    return restore(`restore-banner-${kind}`, body === undefined ? [`no banner ${kind}`] : [bannerPayload(kind, body)])
  }

  const restoreIpRouting = (): Promise<void> => restore('restore-iprouting', [captured.ipRouting ? 'ip routing' : 'no ip routing'])

  /**
   * A captured **empty** hostname means the running-config had no readable `hostname …` line, so what the
   * device answers after `default hostname` is its own default spelling (a `show running-config all` fact,
   * not a client rule) — reported, not forced into pyeapi's or our empty string. With a captured name, the
   * restore is asserted, because "we renamed it back" is a claim this lane owns.
   */
  async function expectHostnameRestored(caseName: string): Promise<void> {
    const restored = (await node.system.get()).hostname
    if (captured.hostname !== '') {
      expect(restored).toBe(captured.hostname)
      return
    }
    if (restored !== '') {
      console.warn(`live-system: ${caseName} left hostname=${JSON.stringify(restored)} where the capture read \`\` — \`default hostname\` restored the device's own default spelling rather than an absent line; reported (§5 row 185 discipline), and harness teardown owns the final state`)
    }
  }

  beforeAll(async () => {
    const target = unwrapLiveTarget(fullWrite.resolution)
    console.log(`live-system: full-write target = ${describeLiveTarget(target)}`)
    // The fence travels with the Node, so a management/listener/user line from any facade dies before the wire.
    node = buildFullWriteNode(target)
    const reported = await node.getVersion()
    const mismatch = matchesDeviceIdentity(target, { version: reported.version, modelName: reported.modelName })
    if (mismatch !== undefined && mismatch.code !== 'EAPI_VERSION_MISMATCH') throw new Error(`live-system full-write readiness: ${mismatch.reason}`)
    if (mismatch?.code === 'EAPI_VERSION_MISMATCH') console.warn(`live-system: reported version "${reported.version}" vs pin "${target.allowVersion}" (base-level enforced by the probe, DR-066)`)
    captured = await node.system.get()
    console.log(`live-system: captured before any write: hostname=${JSON.stringify(captured.hostname)} ipRouting=${String(captured.ipRouting)} banner kinds=${JSON.stringify(Object.keys(captured.banner))}`)
  })

  afterAll(async () => {
    // Every case also restores in its own `finally`; this only mops up after a case threw mid-flight.
    if (captured === undefined) return
    await restoreHostname()
    await restoreBanner('motd')
    await restoreBanner('login')
    await restoreIpRouting()
  })

  it('a staged hostname reads back through the typed record (get_with_period :52 — write :54, assert :56; get_check_hostname :58 — write :60, assert :62)', async () => {
    try {
      for (const [caseName, value] of [
        ['period', 'host.domain.net'],
        ['check', 'teststring'],
      ] as const) {
        await guard(`hostname-${caseName}`, [`hostname ${value}`])
        const after = await node.system.get()
        // The dotted form is the point of :52: HOSTNAME_KEY (`system.ts:149`) takes one unquoted token of any
        // shape, exactly as pyeapi's `^hostname ([^\s]+)$` does (`system.py:82`) — no quoting, no truncation.
        expect(after.hostname).toBe(value)
      }
      // pyeapi's `test_set_hostname_with_period` (`:142`) stages `hostname localhost` first (`:144`); the
      // interesting half of that arm is a period-shaped name arriving through the **facade**, which case D
      // below writes, so the staging line is not repeated here (a container does not need an invented
      // `localhost` to prove the reader).
    } finally {
      await restoreHostname()
      await expectHostnameRestored('hostname read-back case')
    }
  })

  it('banner motd and login round-trip verbatim, EOF terminator included (get_check_banners :64 — payloads :68/:69, asserts :71/:72)', async () => {
    // Upstream's payloads are `random_string() + "\\n"`; the trailing newline is rstripped before comparing
    // (`:71`/`:72`), so this lane writes bodies with no trailing whitespace, where "verbatim" is a claim both
    // readers can honour, and separately records what the device does with a trailing blank line.
    const motd = 'd2 live motd banner\n   indented second line   with   inner   spaces'
    const login = 'd2 live login banner'
    try {
      await guard('banner-roundtrip', [bannerPayload('motd', motd), bannerPayload('login', login)])
      const after = await node.system.get()
      expect(after.banner.motd).toBe(motd)
      expect(after.banner.login).toBe(login)
      // The device text side, which is what upstream's assert reads: `getBlock` (M6, #8) over the same
      // section document the record came from.
      const motdBlock = await node.getBlock('banner motd')
      expect(typeof motdBlock).toBe('string')
      expect(motdBlock ?? '').toContain('d2 live motd banner')
      try {
        await guard('banner-trailing-blank', [bannerPayload('motd', 'd2 trailing\n\n')])
        const trailing = await node.system.get()
        console.log(`live-system: a body with a trailing blank line reads back as ${JSON.stringify(trailing.banner.motd)} (upstream rstrips its payload values at :71/:72; whether EOS keeps the blank is the device's answer, reported not asserted)`)
      } catch (rawErr) {
        console.warn(`live-system: the trailing-blank-line banner probe was refused (${refusalText(rawErr)}) — reported, the exactness claim above does not depend on it`)
      }
    } finally {
      await restoreBanner('motd')
      await restoreBanner('login')
    }
  })

  it('a body whose line merely CONTAINS EOF is not terminated by it — this client writes and reads it (get_banner_with_EOF :74 — payload :76/:77, assert :79)', async () => {
    // Divergence 4 made offline, now with a real device: `bannerBodyFrom` closes a block only on a line whose
    // rstrip IS 'EOF' (`system.ts:315-323`), which is the same rule the chunker uses (`client.py:743`), and
    // `assertBannerBody` (`system.ts:264-272`) refuses exactly that shape from a caller — never this one.
    try {
      await node.system.setBanner('motd', EOF_BODIED_BANNER)
      const after = await node.system.get()
      expect(after.banner.motd).toBe(EOF_BODIED_BANNER)
      console.log(`live-system: motd block → ${JSON.stringify((await node.getBlock('banner motd') ?? '').slice(0, 200))}`)
    } finally {
      await restoreBanner('motd')
    }
  })

  it('the hostname verbs reach the device: set / no / default (set_hostname_with_value :81 — call :85, assert :88; with_no_value :90 — call :93, text no hostname :95-:96; with_default :98 — call :101, assert :104; default_over_value :106 — call :109, assert :112)', async () => {
    try {
      // A marker the device cannot have by default, and that obeys this client's own hostname rules
      // (single token, no quote, no leading digit — `assertHostname`, `system.ts:210-227`).
      await node.system.setHostname('d2sysalpha')
      expect((await node.system.get()).hostname).toBe('d2sysalpha')

      await node.system.unsetHostname()
      const negated = await node.system.get()
      // Upstream asserts the literal text `no hostname` in running-config (`:95`-`:96`). This client reads the
      // section document: a negated global leaves **no** line, and under `show running-config all` the device
      // may still spell its own default name — so the claim is "our marker is gone", and the device's answer
      // is printed rather than guessed at (DR-027, DR-043).
      expect(negated.hostname).not.toBe('d2sysalpha')
      console.log(`live-system: after unsetHostname() the record answers hostname=${JSON.stringify(negated.hostname)} — upstream's :96 text assert is about a line this client never stores`)

      await guard('hostname-stage-default', ['hostname d2sysbeta'])
      expect((await node.system.get()).hostname).toBe('d2sysbeta')
      await node.system.defaultHostname()
      const defaulted = await node.system.get()
      expect(defaulted.hostname).not.toBe('d2sysbeta')
      console.log(`live-system: after defaultHostname() the record answers hostname=${JSON.stringify(defaulted.hostname)}`)
      // :106-:112 (upstream's `set_hostname(value='foo', default=True)`) has no twin here: a set and a default
      // are separate verbs, so there is no precedence for a keyword bag to disagree about (DR-037).
    } finally {
      await restoreHostname()
      await expectHostnameRestored('hostname verb family case')
    }
  })

  it('the banner verbs reach the device for both kinds: set / no / default (motd :150 — call :157, assert :159; motd_default :190 — call :194, assert :195; login :197 — call :204, asserts :206/:207-:208; login_default :210 — call :214, assert :215; login_negate :217 — call :221, assert :222)', async () => {
    try {
      for (const kind of ['motd', 'login'] as const) {
        const body = `d2 verb ${kind} first line\n  second line keeps its indent`
        await node.system.setBanner(kind, body)
        const after = await node.system.get()
        // Byte fidelity of the multi-line body: the shortened twin of the ASCII-art arm (`:161`, call `:186`,
        // assert `:188`), whose blob's per-line trailing whitespace is a device-normalisation question, not a
        // client rule — the narrowing is stated in the header rather than paid for in requests.
        expect(after.banner[kind]).toBe(body)
        if (kind === 'login') {
          // :207-:208 — upstream reads get() and demands a truthy banner_login; the same read here is the
          // typed record's own field, already asserted above.
          expect(after.banner.login).toBe(body)
        }
      }
      await node.system.unsetBanner('login')
      await node.system.defaultBanner('motd')
      await node.system.defaultBanner('login')
      const cleared = await node.system.get()
      // :195/:215/:222 all assert the literal **text** `no banner …`; the config-side read this client uses
      // answers no block at all, i.e. an absent field (DR-027). Printed alongside the section text so the
      // reviewer sees the same device text upstream compared.
      expect(cleared.banner.motd).toBeUndefined()
      expect(cleared.banner.login).toBeUndefined()
      for (const kind of ['motd', 'login'] as const) {
        const block = await node.getBlock(`banner ${kind}`)
        console.log(`live-system: banner ${kind} section after the clear arms → ${JSON.stringify(block ?? '<no section>')} (upstream asserts the text "no banner ${kind}" at :195/:215/:222)`)
      }
    } finally {
      await restoreBanner('motd')
      await restoreBanner('login')
    }
  })

  it('the ip-routing arms are probed against this container shape, then restored (:114 — stage :116, call :117, assert :119; :121 — stage :123, call :124, assert :126; :128 — stage :130, call :131, assert :133; :135 — call :138, assert :140)', async () => {
    // DR-122: cEOS-lab 4.28.14M refused `ip routing` outright (`scripts/ceos-lab.mjs:1193`, tolerated at
    // `:1202`, consequence recorded at `:1604`), so the *verb* is not assumed available — each arm attempts
    // its own upstream staging line, then either the typed read-back or the device's typed refusal.
    const arms = [
      { label: 'false', stage: 'ip routing', expected: false, upstream: ':123/:124 asserts :126', verb: () => node.system.setIpRouting(false) },
      { label: 'no', stage: 'ip routing', expected: false, upstream: ':130/:131 asserts :133', verb: () => node.system.unsetIpRouting() },
      { label: 'default', stage: 'ip routing', expected: false, upstream: ':137/:138 asserts :140', verb: () => node.system.defaultIpRouting() },
      { label: 'true', stage: 'no ip routing', expected: true, upstream: ':116/:117 asserts :119', verb: () => node.system.setIpRouting(true) },
    ] as const
    const verdicts: string[] = []
    try {
      for (const arm of arms) {
        try {
          await guard(`iprouting-stage-${arm.label}`, [arm.stage])
          await arm.verb()
          const after = await node.system.get()
          if (after.ipRouting === arm.expected) {
            verdicts.push(`${arm.label}: ipRouting=${String(after.ipRouting)} (${arm.upstream})`)
          } else {
            // The batch applied and the device still answers the other way — a statement about EOS's default
            // spelling in `show running-config all`, produced by `ipRoutingFromSections` (`system.ts:286-296`).
            console.warn(`live-system: the ip-routing ${arm.label} arm (${arm.upstream}) left ipRouting=${String(after.ipRouting)} — reported as the device's answer, not overwritten`)
            verdicts.push(`${arm.label}: answered ${String(after.ipRouting)}`)
          }
        } catch (rawErr) {
          if (!(rawErr instanceof EapiError) && !(rawErr instanceof NotSupportedError)) throw rawErr
          verdicts.push(`${arm.label}: refused — ${refusalText(rawErr)}`)
        }
      }
      expect(verdicts).toHaveLength(arms.length)
      console.log(`live-system: ip-routing verdicts → ${JSON.stringify(verdicts)}`)
      // The one thing that is never device-dependent: a refusal here must be a **typed** one, and an applied
      // arm must leave the record answering boolean. No arm may be silently dropped.
      for (const verdict of verdicts) expect(/^(false|no|default|true): /.test(verdict)).toBe(true)
    } finally {
      await restoreIpRouting()
      const restored = await node.system.get()
      if (restored.ipRouting !== captured.ipRouting) {
        console.warn(`live-system: ipRouting restored to the captured value was refused by this container shape — capture said ${String(captured.ipRouting)}, the record now answers ${String(restored.ipRouting)} (harness teardown owns the final state; reported per DR-034/DR-043)`)
      } else {
        expect(restored.ipRouting).toBe(captured.ipRouting)
      }
    }
  })

  it('the inputs this client refuses never reach the wire, and change nothing on the device', async () => {
    // Not an upstream arm per method: these are the same call sites pyeapi spells with `None`/keyword tricks
    // (`set_hostname(disable=True)` :93, `set_banner(kind, None, …)` :194/:214/:221, `set_iprouting` with a
    // falsy non-False `system.py:151-152`), which this module answers with a named verb plus a refusal
    // (DR-037/DR-053). Upstream's crash for the same input is `AttributeError` (`system.py:177`).
    const before = await node.system.get()
    await expect(node.system.setHostname('')).rejects.toBeInstanceOf(NotSupportedError)
    await expect(node.system.setHostname('two words')).rejects.toBeInstanceOf(NotSupportedError)
    await expect(node.system.setHostname('9lives')).rejects.toBeInstanceOf(NotSupportedError)
    await expect(node.system.setBanner('motd', 'first\nEOF\nsecond')).rejects.toBeInstanceOf(NotSupportedError)
    await expect(node.system.setBanner('teleprompter' as SystemBannerKind, 'not a banner kind')).rejects.toBeInstanceOf(NotSupportedError)
    await expect(node.system.setIpRouting('yes' as unknown as boolean)).rejects.toBeInstanceOf(NotSupportedError)
    const after = await node.system.get()
    expect(after.hostname).toBe(before.hostname)
    expect(after.ipRouting).toBe(before.ipRouting)
    expect(after.banner).toEqual(before.banner)
  })
})
