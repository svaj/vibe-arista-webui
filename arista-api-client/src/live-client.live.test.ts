/**
 * `*.live.test.ts` port of `pyeapi/test/system/test_client.py` @ `6816d9e` — the **client/command-layer**
 * half of the D2 full-write lane (#14, DR-126): this upstream file tests `Node`/`connection` itself
 * ( batching, the `enable` splice, revisions, error shapes, timeouts, `get_block`, the `runCmds` extra
 * parameters), not a resource module, so it is the one live suite whose subject is this package.
 *
 * ## Which exemplar, honestly
 * The lane brief points at `live-wiring.live.test.ts` as "the M12a exemplar that already hosts some
 * `test_client` methods". Re-checked in this tree: that file is **27 lines** — the M0 (#2) project-wiring
 * proof (`EAPI_LIVE` skip + an address assertion), with no ledger header and no upstream case in it
 * (`grep -n "test_client" src/live-wiring.live.test.ts` → no match), and identical in every sibling
 * worktree. The M12a read-mostly exemplar that this file follows for *structure* is
 * `live-system.live.test.ts`, whose ledger is only about `test_api_system.py`. So **nothing from
 * `test/system/test_client.py` was ported before this file**; the coverage that already exists for it is
 * offline (`src/command-layer.test.ts` / `command-layer.config.test.ts` port `test/unit/test_client.py`).
 * `live-system.live.test.ts:17-18` skips the banner/hostname writes for want of a full-write consent —
 * D2 supplies that consent, so the multiline arm (`:203`) is ported here and says so below.
 *
 * ## Gates (DR-034 / DR-126), and why there are three describes
 * * client-level **reads/failures** (`resolveLiveEnv` only, following `live-system.live.test.ts:38`) —
 *   nothing below them mutates the device: they send reads, malformed commands, a bad credential, or a
 *   deadline. `console.warn` names the refusal reason when the env is not accepted.
 * * client-level **writes** need the DR-126 consent, so they sit behind `liveFullWriteReadiness(process.env)`
 *   (`src/testing/live-full-write.ts`) and run only through a `buildFullWriteNode` client, where the
 *   self-lockout fence (`live-session-policy.ts:196`) sits on the transport seam.
 * * an **interface-scoped** write additionally needs `EAPI_SCRATCH_INTERFACE` (`requireScratchInterface`);
 *   when it is unset the file prints why and that describe collects nothing but skipped cases.
 * With `EAPI_LIVE!=1` (ordinary `npm test`, which runs the `unit` project only) this file executes zero
 * cases and exits 0.
 *
 * ## Ledger — every upstream line below re-verified with `grep -n`/`awk` against the pinned clone
 * `TestClient` has 19 `test_*` methods (`:116`–`:312`) and `TestNode` has 1 (`:343`); `setUp` (`:98`) and
 * `tearDown` (`:305`) — with the `_dut_eos_version` helper at `:301` — are the enable-password fixture, not cases.
 *
 * | upstream (verified line @6816d9e) | ported? | here / why |
 * |---|---|---|
 * | `test_unauthorized_user` (`:116`) | ✅ | builds a second client on the guard's trust material with a wrong username (`:120-124`) and reads `show version` (`:126`). Upstream demands one exact pyeapi string (`:117-118`, `:128`); this client maps HTTP 401 to `AuthError` (`transports/error-map.ts:100-101`) where pyeapi folded it into `ConnectionError` (§5 row 21), so the port asserts the **class** and prints the device text |
 * | `test_populate_version_properties` (`:130`) | ✅ | `:133-135` compares three lazy pyeapi properties against a raw reply — and each property fires its own `show version` (`client.py:557-575`). Ours: one memoised `getVersion()` (§5 row 35, `command-layer.ts:1058-1074`) proven by a request-counting transport (exactly one `show version` batch for two calls), then the same three relationships against an independently fetched reply: `version` verbatim, `model` **inside** `modelName` (`:134`), `versionNumber` **inside** `version` (`:135`) |
 * | `test_enable_single_command` (`:137`) | ✅ | `:139-141` one command → a list of one. The port additionally inspects the **wire** batch through the counting transport: it carries the spliced `enable` (`command-layer.ts:647`, `:660-666`) while the reply array does not (`command-layer.ts:664`, pyeapi `client.py:922-923`) — the half upstream cannot see |
 * | `test_enable_single_unicode_command` (`:155`) | ◐ merged | `u'show version'` (`:157`) is not a distinct state in TS — every string is Unicode, and the JSON encoder is UTF-8 both ways. Ported as the same wire path as `:137`; no separate case is claimed |
 * | `test_enable_single_extended_command` (`:143`) | ✅ tolerant | the pinned 4.28 target supports the `revision` member of a command object (`types/eapi.ts:30`; pyeapi's dict form at `:145`/`:150`), and upstream asserts `clusterMode` absent at rev 1 (`:148`) and present at rev 2 (`:153`). We send the same object form, assert one reply each, and assert the `clusterMode` pair **only if the device answers both**; on a container where `show cvx` is refused (the `% Unavailable command` class this lane records as `DR-122`, `docs/DECISIONS.md:1900`) the arm is reported, not claimed |
 * | `test_no_enable_single_command` (`:161`) | ✅ | `send_enable=False` (`:163`) → the wire batch must contain **no** `enable` line (checked in the recorded batch) and still answer one reply (`:165`) |
 * | `test_no_enable_single_command_no_auth` (`:167`) | ❌ skipped | the case depends on `:170-171` sending `disable` inside the batch to walk the *shared CLI session* down to privilege 3, then recovering. Upstream's recovery is the enable-password fixture it installs in `setUp` (`:110-113`) and removes in `tearDown` (`:305-310`) over **both** `runCmds` and `config`; our harness user is a priv-15 lab account with no enable password, so the same batch would leave the session un-re-enableable for every later case in this file (and every other lane sharing the container). The insufficient-priv condition is pinned offline instead (`internal/wire` fixtures + `command-layer.test.ts`) |
 * | `test_enable_multiple_commands` (`:173`) | ✅ (N fixed) | `random_int(10,200)` (`:176`) is replaced by a deterministic 12 so a failure is reproducible: one batch, N replies, `results.length === commands.length` — the positional pairing §5 row 38 says pyeapi never validates |
 * | `test_enable_multiple_unicode_commands` (`:182`) | ✅ (unicode arm merged) | `dut.enable(commands)` (`:187`) is pyeapi's **non-strict** `enable`, whose per-command requests §5 row 38 documents; ours is `exec(commands)` with `tolerateErrors` left at its default (`command-layer.ts:695-727`) → N entries and N wire batches, both counted. Same command strings as `:173`, which is why the `u''` half (`:186`) adds nothing |
 * | `test_multiple_requests` (`:227`) | ✅ (N fixed to 5) | `:230-232` N separate round trips, one reply each — no reply ever leaks between requests, and the counting transport proves it was exactly N batches |
 * | `test_get_block` (`:234`) | ✅ (read-only) | `api.config` (`:238`) is the cached text, `get_block('interface Ethernet1')` (`:239`) the memo path, `get_block(..., config=config)` (`:240`) the explicit-text path, `assertEqual` at `:241`. Ours: `node.getBlock(parent)` over the DR-026 memo, plus the pure `getBlock(parent, { config: text })` (`config/section.ts:100`) for pyeapi's `config=` arm, compared verbatim. `Ethernet1` is only **read** — writing a provisioned port stays out of DR-035/DR-126 |
 * | `test_get_block_none` (`:243`) | ✅ | `config='config'` (`:247`) is literal text that matches nothing → `None` (`:248`); ours is `undefined` (DR-027), and the device-side absence half uses a section EOS cannot have written (`interface Ethernet1000000`) so the read needs no write |
 * | `test_execute_with_autocomplete` (`:250`) | ✅ (the ≥4.17 arm only) | `:258-260` sends `['sh ver']` with the `autoComplete` **runCmds parameter** and demands a `version` key. The parameter is on this client's allow-list (`internal/wire.ts:58`, pinned offline by `wire.test.ts:75-77`) and reaches the device through `NodeRequestOptions`. The `else` arm (`:264-266`) asserts the *absence* of the parameter on a pre-4.17 build — unhospitable here: the guard pins the 4.28 train, so the refusal branch cannot be produced and is not faked |
 * | `test_execute_with_expandaliases` (`:268`) | ✅ (fresh alias name) | writes `alias test show version` (`:274`) — a global write, hence the DR-126 gate — then `execute(['test'], expandAliases=True)` (`:278-279`) and demands `version` (`:280`). Ours uses `d2c_exp<runid>` (never the bare `test`), stages it in a named guarded session, and cleans it up in a `finally`. Same reason as above for not porting the pre-4.17 `else` arm (`:284-286`) |
 * | `test_execute_socket_timeout_error` (`:289`) | ✅ (our taxonomy) | upstream mutates `connection.transport.timeout` to 0.001 (`:292`) and demands its own message (`:296-297`). Ours passes a **per-call** deadline (`TransportExecOptions.timeoutMs`, `transports/contract.ts:311`) → `eAPI request … timed out` as `TimeoutError` (`error-map.ts:303-308`, DR-019), never pyeapi's `ConnectionError` string. The `@patch(_LOGGER.exception)` assertion (`:288`, `:298`) is a Python mock of a module logger — offline-only, not ported. The case ends by proving the client recovers with a normal read |
 * | `test_config_single_command` (`:191`) | ✅ (payload substituted) | upstream writes a random `hostname` (`:193`) — **refused here**: renaming the DUT we are connected through breaks the endpoint and the identity pin, and DR-035 keeps global identity writes out of the live lane (`live-system.live.test.ts:14`). The command-layer *behaviour* under test — one config command, one reply, then a read-back (`:194-201`) — is ported with a fresh `alias` line. `assertEqual(result[0], {})` (`:197`) is a device reply shape we do not claim: the port asserts one reply per staged command and that no reply reported an `errors` entry, and prints the raw shape |
 * | `test_config_single_multiline_command` (`:203`) | ✅ (`{cmd,input}` instead of `MULTILINE:`) | clears any login banner (`:206`), writes a two-line banner (`:208-210`), reads it back line-by-line (`:214-216`). pyeapi's `MULTILINE:` pseudo-syntax is **not ported** (DR-015, §5 row 16) — the same write goes as the real `{cmd, input}` object; `result[0] == {}` (`:213`) treated exactly as above. This is the arm `live-system.live.test.ts:16` declines for want of consent: with DR-126 it is a named-session write on a throwaway container, restored in a `finally` |
 * | `test_config_multiple_commands` (`:218`) | ✅ (payload substituted) | `:221-223` writes N random hostnames; ours writes 6 fresh `alias` lines in **one** batch and asserts `results.length === 6` (the config-batch pairing half of §5 row 38) plus a read-back that every line landed |
 * | `test_secure_transport` (`:312`) | ❌ skipped | the client-cert transport exists (`transports/node-client-cert.ts`, pyeapi `https_certs`, M2 #4) and is pinned offline (`node-client-cert.test.ts`), but the arm needs the **device** to accept mTLS on the eAPI listener — i.e. `management api http-commands` config, which `labWriteScopeRefusal` (`live-session-policy.ts:162`, `:196`) refuses before the wire because reworking the listener ends the run. Upstream also pairs its key/cert with a host provisioned for them (`:50-93` temp files for `localhost`), so a live pass here would be an artefact of the fixture, not of this client |
 * | `TestNode.test_exception_trace` (`:343`) | ✅ 2 of 4 arms | ports `:350-351` (mangled command → `1002 invalid command`, upstream's `:353-354` pair being the same code/text shape) and the incomplete-token arm, asserting the exception members `:383-386` demand (`commandError`, the answers that came back, the command list) plus `trace()` covering **every** command — §5 row 20's divergence, where pyeapi's `if index:` drops the tail. The message regex is asserted only for the arm whose wording is stable, and the device's text is printed either way. **`reload` (`:361-362`) is deliberately not sent**: the arm assumes the API guard answers 1004, and the file's own comment (`:356-360`) admits the command changed shape across EOS releases — a build where it is accepted reboots the container out from under the live chain that owns this host, so it stays offline. The priv arm (`:364-366`, driven by `disable` at `:375`) is skipped for the same session-privilege reason as `:167` |
 *
 * ## The three arms the lane brief listed that this upstream file does **not** contain
 * Marked as such rather than smuggled in as pyeapi coverage, and they are the reason this file exists at
 * all — no other live suite touches these client verbs.
 *
 * | arm | upstream | ported? | here |
 * |---|---|---|---|
 * | running/startup config caching + `refresh()` | `client.py:519-535`, `:991-1001` — no case in `test/system/test_client.py` | ✅ | §5 row 34's documented shape, proved by request counting: two `getRunningConfig()` = **one** `show running-config all` batch (the `all` half is `configDefaults`, `command-layer.ts:616`/`:771-781`); `chunkConfig()` twice adds nothing (DR-026 memo); `refresh()` makes the next read re-fetch; `getStartupConfig()` asks `show startup-config` **without** `all`, exactly as row 34 says |
 * | `autorefresh` dropping the caches on a write | `client.py:665-669` | ✅ | also counting: after a committed named-session write the next read is a **new** request whose text contains the fresh line (default `autorefresh: true`); with `autorefresh = false` the same write leaves the cached text stale (row 34/row 80 — the chunk memos still clear, the text does not), and `refresh()` then makes it visible. The flag is restored in a `finally` |
 * | config-session create / diff / abort / commit visible in `listSessions` | **none — upstream has no session tests at all** (`docs/MIGRATION.md` §6: "`test/unit/test_client.py`'s 53 methods contain no session/`diff`/`commit`/`abort` case") | ✅ on a scratch port | named session → staged `description` on `EAPI_SCRATCH_INTERFACE` → the name is listed as pending (`config-session.ts:1049`), `diff()` answers text (`:748-764`, the DR-012 case: `show session-config diffs` has no `cliModel`), `abort()` → the marker never reached running-config; the sibling case commits instead, proves the marker is in a **freshly fetched** running-config, and that nothing was persisted (DR-024: no `copy run start`, and `runGuardedLiveWriteSession` refuses it pre-wire) |
 * | `getCompletions` (the M11 #13 verb) | not in this file; upstream's completion surface is the `autoComplete` **parameter** above | ✅ added, tolerant | `command-layer.ts:1273` (`getCommandCompletions`, `JsonCli.py:173-192`) is shipped in this tree, so the completion arms above are ported as the parameter they are — and this one extra case exercises the method verb so the #13 seam has live evidence. A device refusal here is reported, never converted into a pass |
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { AuthError, CommandError, EapiError, TimeoutError } from './errors'
import { getBlock as blockFromText } from './config/section'
import { createNode, createTransport } from './node'
import { buildFullWriteNode, liveFullWriteReadiness } from './testing/live-full-write'
import { describeLiveTarget, liveTransportOptions, matchesDeviceIdentity, requireScratchInterface, resolveLiveEnv, unwrapLiveTarget, type LiveTarget } from './testing/live-guard'
import { runGuardedLiveWriteSession } from './testing/live-session-policy'
import { Node } from './command-layer'
import type { ConfigSession } from './config-session'
import type { CommandResult, CommandSpec } from './types/eapi'
import type { Transport } from './transports/contract'

const SUITE = 'live-client'
const runId = String(Date.now()).slice(-6)

/** The pure-read gate (DR-034): this half mutates nothing, so `resolveLiveEnv` alone is the guard. */
const readResolution = resolveLiveEnv(process.env)
const readReady = readResolution.ok
if (!readReady) {
  console.warn(`${SUITE}: read cases SKIPPED (DR-034) — ${readResolution.ok ? '' : readResolution.reason}`)
}

/** The DR-126 consent gate for the client-level write arms. */
const gate = liveFullWriteReadiness(process.env)
const writeReady = gate.runnable
if (!writeReady) {
  console.warn(`${SUITE}: write cases SKIPPED (DR-034/DR-126) — ${gate.skipReason ?? 'gate refused the run'}`)
}

/** Interface-scoped writes additionally need a declared scratch port (DR-035(b)). */
const scratch: { ok: boolean; name?: string; reason?: string } = writeReady
  ? (() => {
      const req = requireScratchInterface(unwrapLiveTarget(gate.resolution))
      return req.ok ? { ok: true, name: req.name } : { ok: false, reason: req.reason }
    })()
  : { ok: false, reason: 'live target not accepted' }
if (writeReady && !scratch.ok) {
  console.warn(`${SUITE}: config-session cases SKIPPED (DR-035b) — ${scratch.reason ?? ''}`)
}
const scratchReady = writeReady && scratch.ok

// ────────────────────────────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────────────────────────────

function firstLine(message: string): string {
  return message.split('\n')[0]?.slice(0, 220) ?? message
}

function describeRefusal(rawErr: unknown): string {
  if (rawErr instanceof CommandError) return `CommandError(${String(rawErr.code)})`
  if (rawErr instanceof EapiError) return String(rawErr.constructor.name)
  return rawErr instanceof Error ? `${rawErr.constructor.name}: ${firstLine(rawErr.message)}` : String(rawErr)
}

function commandText(spec: CommandSpec): string {
  return typeof spec === 'string' ? spec : spec.cmd
}

/**
 * A recording pass-through around the real transport. Every caching/batching claim in this file is a
 * claim about **how many requests reached the device**, so it has to be measured rather than inferred
 * from an identical string. The wrapper adds nothing to the wire — it records and forwards — and mirrors
 * `withLabWriteScope`'s shape (`live-session-policy.ts:227`) so the two wrappers cannot drift.
 */
function withRequestLog(transport: Transport): { readonly transport: Transport; readonly batches: string[][] } {
  const batches: string[][] = []
  const wrapped: Transport = {
    kind: transport.kind,
    address: transport.address,
    execute: async (commands, options) => {
      const specs = Array.isArray(commands) ? commands : [commands]
      batches.push(specs.map((spec) => commandText(spec)))
      return transport.execute(commands, options)
    },
    close: () => transport.close(),
    toString: () => transport.toString(),
  }
  if (transport.callMethod !== undefined) {
    wrapped.callMethod = transport.callMethod.bind(transport) as typeof transport.callMethod
  }
  return { transport: wrapped, batches }
}

function countMatching(batches: readonly string[][], needle: string): number {
  return batches.filter((batch) => batch.some((line) => line.includes(needle))).length
}

function replyMember(reply: CommandResult | undefined, key: string): string | undefined {
  const value = reply?.[key]
  return typeof value === 'string' ? value : undefined
}

/** The readiness gate every suite runs before interpreting a device answer (docs/CEOS.md, DR-066). */
async function assertDeviceIdentity(node: Node, target: LiveTarget): Promise<void> {
  const reported = await node.getVersion()
  const mismatch = matchesDeviceIdentity(target, { version: reported.version, modelName: reported.modelName })
  // Tolerate ONLY the suffix-driven EAPI_VERSION_MISMATCH (the cEOS build string carries an engineering
  // suffix the base pin cannot match); model/train/TLS identity stay enforced.
  if (mismatch !== undefined && mismatch.code !== 'EAPI_VERSION_MISMATCH') {
    throw new Error(`${SUITE} readiness: ${mismatch.reason}`)
  }
  if (mismatch?.code === 'EAPI_VERSION_MISMATCH') {
    console.warn(`${SUITE}: reported version "${reported.version}" vs pin "${target.allowVersion}" (base-level enforced by the probe, DR-066)`)
  }
}

/**
 * Stage commands (one-liners, or a `{cmd,input}` multiline) in their own named session. pyeapi's
 * `dut.config([...])` twin under DR-035/DR-126: named session, committed, never persisted.
 */
async function stageLines(node: Node, label: string, lines: readonly CommandSpec[]): Promise<void> {
  await runGuardedLiveWriteSession(node, { name: `${SUITE}-${label}-${runId}`, commands: lines })
}

/** Undo what {@link stageLines} staged. Never asserted: an absent entry is the success state. */
async function unstageLines(node: Node, label: string, lines: readonly CommandSpec[]): Promise<void> {
  try {
    await stageLines(node, `undo-${label}`, lines)
  } catch (rawErr) {
    console.warn(`${SUITE}: cleanup of ${String(lines.length)} command(s) was refused (${describeRefusal(rawErr)}) — the entry may survive on the throwaway container; reported, not hidden`)
  }
}

/** A successful config command: our layer hands back the device's per-command reply, and `{}` (pyeapi `:197`/`:213`) is printed rather than demanded. */
function assertNoDeviceErrorIn(replyList: readonly CommandResult[], label: string): void {
  for (const reply of replyList) {
    const errors = reply['errors']
    if (Array.isArray(errors) && errors.length > 0) {
      throw new Error(`${SUITE}: ${label} came back with a device error member on a resolved write: ${JSON.stringify(errors).slice(0, 220)}`)
    }
  }
  console.log(`${SUITE}: ${label} per-command replies = ${JSON.stringify(replyList).slice(0, 160)}`)
}

// ────────────────────────────────────────────────────────────────────────────────────────────────────
// Read/write-free client arms
// ────────────────────────────────────────────────────────────────────────────────────────────────────

describe.skipIf(!readReady)('live client reads: pyeapi test/system/test_client.py TestClient (:116-:312)', () => {
  let node: Node
  let counted: Node
  let batches: string[][]

  beforeAll(async () => {
    const target = unwrapLiveTarget(readResolution)
    console.log(`${SUITE}: target = ${describeLiveTarget(target)}`)
    node = createNode(liveTransportOptions(target))
    const log = withRequestLog(createTransport(liveTransportOptions(target)))
    counted = new Node(log.transport)
    batches = log.batches
    await assertDeviceIdentity(node, target)
  })

  afterAll(async () => {
    await node.close()
    await counted.close()
  })

  it('a wrong credential is an AuthError, not pyeapi\'s ConnectionError string (test_unauthorized_user, :116)', async () => {
    const target = unwrapLiveTarget(readResolution)
    // Same host/port/trust material as the accepted target (`:120-124` re-uses `dut.settings`), only the
    // account is wrong. This is the one case here that reaches the auth subsystem: no config write, and
    // a 401 is never retried (DR-019 retries `ConnectError` only), so exactly one attempt is made.
    const wrong = createNode({ ...liveTransportOptions(target), username: `d2c_wrong_${runId}`, password: 'not-a-password' })
    let rejected: AuthError | undefined
    try {
      await wrong.runCommands('show version', { format: 'json' })
    } catch (rawErr) {
      if (rawErr instanceof AuthError) rejected = rawErr
      else throw rawErr
    } finally {
      await wrong.close()
    }
    // Upstream tolerates a successful read here (its `try/except` at `:125-128` only asserts inside the
    // handler), i.e. a DUT with any local account named `wrong` silently passes. We refuse that hole:
    // a target that authenticates this pair is a target this run must not test against.
    expect(rejected).toBeInstanceOf(AuthError)
    if (rejected === undefined) return
    expect(rejected.status === undefined || rejected.status === 401 || rejected.status === 403).toBe(true)
    console.log(`${SUITE}: bad credential answered ${describeRefusal(rejected)}: ${firstLine(rejected.message)} (upstream's fixed string, :117-118/:128, is pyeapi's own wording)`)
  })

  it('one memoised getVersion() round trip feeds every identity field (test_populate_version_properties, :130)', async () => {
    const before = countMatching(batches, 'show version')
    const first = await counted.getVersion()
    const second = await counted.getVersion()
    expect(second).toBe(first)
    // §5 row 35: pyeapi's three lazy properties paid up to three `show version` requests; ours pays one.
    expect(countMatching(batches, 'show version')).toBe(before + 1)

    // The reply it was parsed from, fetched independently so the comparison is not circular (`:132`).
    const [reply] = await counted.runCommands('show version', { format: 'json' })
    expect(reply).toBeDefined()
    const version = replyMember(reply, 'version')
    const modelName = replyMember(reply, 'modelName')
    expect(typeof version).toBe('string')
    expect(typeof modelName).toBe('string')
    if (version === undefined || modelName === undefined) return
    expect(first.version).toBe(version)
    expect(first.modelName).toBe(modelName)
    // Upstream's two `assertIn`s (`:134`, `:135`) survive as substring relations, because `model` is the
    // four-digit run pulled out of the product string and `versionNumber` the leading digit/dot run.
    expect(modelName.includes(first.model)).toBe(true)
    expect(version.startsWith(first.versionNumber)).toBe(true)
    console.log(`${SUITE}: identity parse = version=${first.version} versionNumber=${first.versionNumber} model=${first.model} modelName=${first.modelName}`)
  })

  it('runCommands with the default enable yields one reply for one command (test_enable_single_command, :137)', async () => {
    batches.length = 0
    const results = await counted.runCommands('show version', { format: 'json' })
    expect(Array.isArray(results)).toBe(true)
    expect(results.length).toBe(1)
    // The command-layer half upstream cannot observe: `enable` is on the wire, its reply is popped.
    expect(batches.length).toBe(1)
    expect(batches[0]?.[0]).toBe('enable')
    expect(batches[0]?.includes('show version')).toBe(true)
    expect(replyMember(results[0], 'version')).toBeDefined()
  })

  it('the u-prefix arm is not a distinct state in TS (test_enable_single_unicode_command, :155)', async () => {
    // Recorded so the ledger row is executed, not merely asserted in prose: `u'show version'` (`:157`) and
    // `'show version'` are the same value here, and the answers must therefore be the same shape.
    const plain = await node.runCommands('show version', { format: 'json' })
    const unicode = await node.runCommands('show version', { format: 'json' })
    expect(unicode.length).toBe(plain.length)
    expect(typeof replyMember(unicode[0], 'version')).toBe('string')
  })

  it('sendEnable:false puts no enable on the wire and still answers (test_no_enable_single_command, :161)', async () => {
    batches.length = 0
    const results = await counted.runCommands('show version', { format: 'json', sendEnable: false })
    expect(results.length).toBe(1)
    expect(batches.length).toBe(1)
    expect(batches[0]?.some((line) => line === 'enable')).toBe(false)
    expect(replyMember(results[0], 'version')).toBeDefined()
  })

  it('the revision member rides the command object (test_enable_single_extended_command, :143)', async () => {
    // The `clusterMode` claims (`:148`, `:153`) only mean something if this platform models `show cvx` at
    // both revisions, so the refusals are reported instead of being asserted away.
    let rev1: CommandResult | undefined
    let rev2: CommandResult | undefined
    try {
      const one = await node.runCommands({ cmd: 'show cvx', revision: 1 }, { format: 'json' })
      const two = await node.runCommands({ cmd: 'show cvx', revision: 2 }, { format: 'json' })
      expect(one.length).toBe(1)
      expect(two.length).toBe(1)
      rev1 = one[0]
      rev2 = two[0]
    } catch (rawErr) {
      if (!(rawErr instanceof EapiError)) throw rawErr
      console.warn(`${SUITE}: this target refused the "show cvx" revision pair (${describeRefusal(rawErr)}): ${firstLine(rawErr.message)} — the clusterMode half of :148/:153 is NOT claimed here`)
      return
    }
    expect('clusterMode' in (rev1 ?? {})).toBe(false)
    expect('clusterMode' in (rev2 ?? {})).toBe(true)
  })

  it('one batch, N replies — the pairing §5 row 38 says pyeapi never validates (test_enable_multiple_commands, :173)', async () => {
    const commands = Array.from({ length: 12 }, () => 'show version')
    batches.length = 0
    const results = await counted.runCommands(commands, { format: 'json' })
    expect(results.length).toBe(commands.length)
    expect(batches.length).toBe(1)
    expect(batches[0]?.filter((line) => line === 'show version').length).toBe(commands.length)
  })

  it('exec() sends one request per command and answers one entry each (test_enable_multiple_unicode_commands, :182 — the enable()/strict=False half at :187)', async () => {
    const commands = Array.from({ length: 6 }, () => 'show version')
    batches.length = 0
    const entries = await counted.exec(commands)
    expect(entries.length).toBe(commands.length)
    for (const entry of entries) {
      expect(entry.encoding).toBe('json')
      expect(replyMember(entry.result, 'version')).toBeDefined()
    }
    expect(batches.length).toBe(commands.length)
  })

  it('N sequential requests stay separate (test_multiple_requests, :227)', async () => {
    batches.length = 0
    for (let i = 0; i < 5; i += 1) {
      const results = await counted.runCommands('show version', { format: 'json' })
      expect(results.length).toBe(1)
    }
    expect(batches.length).toBe(5)
  })

  it('getBlock over the memo equals getBlock over the explicit text (test_get_block, :234)', async () => {
    const header = 'interface Ethernet1'
    const memo = await node.getBlock(header)
    if (memo === undefined) {
      console.warn(`${SUITE}: this target's running-config has no \`${header}\` section — the equality half of :241 is reported, not claimed (read-only case; DR-035 forbids writing a provisioned port to make it appear)`)
      return
    }
    // pyeapi's `config=` argument (`:240`) is the config **text**; the same lookup here is the pure helper.
    const text = await node.getRunningConfig()
    expect(blockFromText(header, { config: text })).toBe(memo)
    expect(memo.includes(header)).toBe(true)
  })

  it('a match that fails is undefined, from text and from the device (test_get_block_none, :243)', async () => {
    expect(blockFromText('interface Ethernet1', { config: 'config' })).toBeUndefined()
    expect(await node.getBlock('interface Ethernet1000000')).toBeUndefined()
  })

  it('the autoComplete runCmds parameter reaches the device (test_execute_with_autocomplete, :250)', async () => {
    // 4.28 ≥ 4.17, so the guard-pinned target always takes the `:258-260` arm; the pre-4.17 else-branch
    // (`:264-266`) cannot be produced without a 4.16 device and is not simulated.
    const results = await node.runCommands(['sh ver'], { format: 'json', autoComplete: true })
    expect(results.length).toBe(1)
    expect('version' in (results[0] ?? {})).toBe(true)
  })

  it('a per-call deadline is a TimeoutError, and the client recovers (test_execute_socket_timeout_error, :289)', async () => {
    // pyeapi mutates the transport's shared 60 s timeout (`:291-292`, `:299`); ours is one request's
    // deadline (`contract.ts:311`), so nothing else in the process is exposed to it.
    batches.length = 0
    try {
      await node.runCommands('show version', { format: 'json', timeoutMs: 1 })
      throw new Error(`${SUITE}: test_execute_socket_timeout_error — the request completed inside a 1 ms deadline, so the timeout arm is not evidenced on this host`)
    } catch (rawErr) {
      if (!(rawErr instanceof TimeoutError)) throw rawErr
      expect(rawErr.retryable).toBe(false)
      console.log(`${SUITE}: deadline answered ${describeRefusal(rawErr)}: ${firstLine(rawErr.message)} (upstream's own text, :296-297, is pyeapi's)` )
    }
    // Upstream restores the timeout and moves on (`:299`); the equivalent here is proving the next read
    // still works after a destroyed socket.
    const recovered = await node.runCommands('show version', { format: 'json' })
    expect(recovered.length).toBe(1)
    expect(replyMember(recovered[0], 'version')).toBeDefined()
  })

  it('the config caches are lazy, memoised, and dropped only by refresh() (§5 row 34 — added arm, no live case in this file)', async () => {
    batches.length = 0
    const first = await counted.getRunningConfig()
    const again = await counted.getRunningConfig()
    expect(again).toBe(first)
    expect(countMatching(batches, 'running-config')).toBe(1)
    // row 34/`configDefaults`: the running-config read is asked with `all` (`command-layer.ts:616`, `:771-781`).
    expect(batches.some((batch) => batch.includes('show running-config all'))).toBe(true)

    // DR-026: the chunk memo rides the same text, so a section read adds no request.
    await counted.chunkConfig()
    await counted.chunkConfig()
    expect(countMatching(batches, 'running-config')).toBe(1)

    // Absence-safe section probe (DR-027): a block lookup must not pay for another read either.
    await counted.getBlock('banner motd')
    expect(countMatching(batches, 'running-config')).toBe(1)

    // startup is asked without `all`, exactly as row 34 records.
    await counted.getStartupConfig()
    await counted.getStartupConfig()
    expect(countMatching(batches, 'startup-config')).toBe(1)
    expect(batches.some((batch) => batch.some((line) => /^show startup-config$/u.test(line)))).toBe(true)

    // refresh() is the single invalidation point (row 34/DR-030).
    counted.refresh()
    const afterRefresh = await counted.getRunningConfig()
    expect(afterRefresh.length).toBeGreaterThan(0)
    expect(countMatching(batches, 'running-config')).toBe(2)
  })

  it('a mangled command throws CommandError with the members upstream demands (TestNode.test_exception_trace, :343 — arms at :353-354, members at :383-386)', async () => {
    const batch: readonly string[] = ['show version', 'shwo version', 'show hostname']
    let thrown: CommandError | undefined
    try {
      await node.exec(batch, { tolerateErrors: false })
    } catch (rawErr) {
      if (rawErr instanceof CommandError) thrown = rawErr
      else throw rawErr
    }
    expect(thrown).toBeInstanceOf(CommandError)
    if (thrown === undefined) return
    expect(thrown.code).toBe(1002)
    // `:383-385`: the CLI text, the answers produced before the failure, and the command list.
    expect(typeof thrown.commandError).toBe('string')
    expect(thrown.results.length).toBeGreaterThan(0)
    expect(thrown.commands?.length).toBe(batch.length + 1)
    // §5 row 20: ours keeps every command in the trace, including the ones that never ran — pyeapi's
    // `if index:` drops the tail. `+1` is the spliced `enable`, which pyeapi also sent.
    expect(thrown.trace().length).toBe(batch.length + 1)
    expect(thrown.failedCommand).toBeDefined()
    console.log(`${SUITE}: 1002 text = ${JSON.stringify(String(thrown.commandError).slice(0, 160))}`)
    if (/invalid input/iu.test(String(thrown.commandError))) {
      // upstream's regex at :353-354, whose prefix our renderer already produced (`Error [1002]: CLI command …`)
      expect(thrown.message).toMatch(/Error \[1002\]: CLI command \d+ of \d+ '/u)
    } else {
      console.warn(`${SUITE}: this image did not phrase the refusal as upstream's :353-354 regex expects — the wording half is reported, not claimed`)
    }
  })

  it('an incomplete command is refused with 1002 and a full trace (TestNode.test_exception_trace, :343 — the incomplete-token arm at :350-351)', async () => {
    const batch: readonly string[] = ['show version', 'show', 'show hostname']
    let thrown: CommandError | undefined
    try {
      await node.exec(batch, { tolerateErrors: false })
    } catch (rawErr) {
      if (rawErr instanceof CommandError) thrown = rawErr
      else throw rawErr
    }
    expect(thrown).toBeInstanceOf(CommandError)
    if (thrown === undefined) return
    expect(thrown.code).toBe(1002)
    expect(thrown.trace().length).toBe(batch.length + 1)
    const text = String(thrown.commandError)
    if (!/incomplete/iu.test(text)) {
      console.warn(`${SUITE}: the bare \`show\` arm did not answer with an "incomplete" wording (${text.slice(0, 160)}) — upstream's :350-351 half of the regex is reported, not claimed`)
    }
    // The `reload` (`:361-362`) and `disable`+priv (`:364-366`, `:375`) arms are ledger-skips; see the header.
  })

  it('getCompletions (M11 #13) answers over the callMethod seam — added arm, not in this upstream file', async () => {
    try {
      const completions = await node.getCompletions('show v')
      expect(Array.isArray(completions.completions)).toBe(true)
      console.log(`${SUITE}: getCommandCompletions("show v") → ${String(completions.completions.length)} suggestions; unparsed=${String(completions.unparsed.length)}`)
      if (completions.completions.length === 0) {
        console.warn(`${SUITE}: the device returned no completions for \`show v\` — the non-empty half is not claimed here (unparsed: ${JSON.stringify(completions.unparsed).slice(0, 160)})`)
      }
    } catch (rawErr) {
      if (!(rawErr instanceof EapiError)) throw rawErr
      console.warn(`${SUITE}: this target refused getCommandCompletions (${describeRefusal(rawErr)}): ${firstLine(rawErr.message)} — reported, and the :250/:268 parameter arms above are the upstream completion coverage`)
    }
  })
})

// ────────────────────────────────────────────────────────────────────────────────────────────────────
// Client-level write arms (DR-126 consent; every batch goes through the fenced, named-session helper)
// ────────────────────────────────────────────────────────────────────────────────────────────────────

describe.skipIf(!writeReady)('live client writes: pyeapi test/system/test_client.py config arms (:191, :203, :218, :268)', () => {
  let node: Node
  let counted: Node
  let batches: string[][]

  beforeAll(async () => {
    const target = unwrapLiveTarget(gate.resolution)
    console.log(`${SUITE}: full-write target = ${describeLiveTarget(target)}`)
    // The fence travels with the Node, so no case below has to remember the self-lockout set.
    node = buildFullWriteNode(target)
    // The counting wrapper goes *under* the fence: `buildFullWriteNode` applies `withLabWriteScope` to
    // whatever transport it is handed (live-full-write.ts:56-59), so this client is fenced and measured.
    const log = withRequestLog(createTransport(liveTransportOptions(target)))
    counted = buildFullWriteNode(target, { transport: log.transport })
    batches = log.batches
    await assertDeviceIdentity(node, target)
  })

  afterAll(async () => {
    await node.close()
    await counted.close()
  })

  it('one config command, one reply, then the read-back (test_config_single_command, :191 — payload substituted)', async () => {
    const alias = `d2c_a_${runId}`
    // Upstream writes `hostname <random>` (`:193`); that half is refused here (header row), so the payload
    // is a fresh alias and the assertions are the command-layer ones: `:194-196` (list of one) and
    // `:199-201` (the line really landed in running-config).
    await unstageLines(node, 'prelude-1', [`no alias ${alias}`])
    try {
      const outcome = await runGuardedLiveWriteSession(node, { name: `${SUITE}-single-${runId}`, commands: [`alias ${alias} show version`] })
      expect(outcome.results.length).toBe(1)
      assertNoDeviceErrorIn(outcome.results, 'single alias batch')
      const text = await node.getRunningConfig()
      expect(text.includes(`alias ${alias} show version`)).toBe(true)
    } finally {
      await unstageLines(node, 'single', [`no alias ${alias}`])
    }
    const reread = await node.getRunningConfig()
    expect(reread.includes(`alias ${alias} show version`)).toBe(false)
  })

  it('a multiline write rides {cmd,input}, never MULTILINE:, and the banner reads back line-for-line (test_config_single_multiline_command, :203)', async () => {
    // DR-015 (§5 row 16): pyeapi's `'banner login MULTILINE:%s'` (`:209`) is not a syntax this client
    // recognises — the identical content goes as the real object form the wire allows.
    const banner = ['This is a new banner', `with different lines!!! run ${runId}`]
    // Upstream clears any current banner first (`:206`); we capture it so the cleanup can restore it.
    let previous = ''
    try {
      previous = (await node.showText('show banner login')).trim()
    } catch (rawErr) {
      if (!(rawErr instanceof EapiError)) throw rawErr
      console.warn(`${SUITE}: the pre-read of \`show banner login\` failed (${describeRefusal(rawErr)}) — cleanup will only negate, not restore`)
    }
    try {
      const outcome = await runGuardedLiveWriteSession(node, {
        name: `${SUITE}-banner-${runId}`,
        commands: [{ cmd: 'banner login', input: banner.join('\n') }],
      })
      expect(outcome.results.length).toBe(1)
      assertNoDeviceErrorIn(outcome.results, 'banner write')

      // `:214-216`: `show banner login` in text, compared line by line.
      const shown = (await node.showText('show banner login')).trim().split('\n').map((line) => line.trim())
      expect(shown).toEqual(banner.map((line) => line.trim()))

      // DR-012 evidence, asked rather than assumed: what encoding answered this un-modelled `show`?
      const [entry] = await node.exec('show banner login')
      console.log(`${SUITE}: \`show banner login\` answered encoding=${String(entry?.encoding)} fellBack=${String(entry?.fellBack)} (DR-012's 1003→text repair fires when the model is missing)`)
      expect(entry).toBeDefined()
    } finally {
      if (previous === '') {
        await unstageLines(node, 'banner', ['no banner login'])
      } else {
        console.log(`${SUITE}: restoring the login banner this container had (${previous.length} chars)`)
        await unstageLines(node, 'banner', [{ cmd: 'banner login', input: previous }])
      }
    }
  })

  it('N config commands in one batch answer N times and all land (test_config_multiple_commands, :218 — payload substituted)', async () => {
    const names = Array.from({ length: 6 }, (_, i) => `d2c_m${String(i)}_${runId}`)
    // Upstream's payload is N random hostnames (`:221-223`) for a request-count assertion (`:225`).
    const commands = names.map((name) => `alias ${name} show hostname`)
    await unstageLines(node, 'prelude-n', names.map((name) => `no alias ${name}`))
    try {
      const batchesBefore = batches.length
      const outcome = await runGuardedLiveWriteSession(counted, { name: `${SUITE}-multi-${runId}`, commands })
      expect(outcome.results.length).toBe(commands.length)
      assertNoDeviceErrorIn(outcome.results, 'six-alias batch')
      // The batch half of §5 row 38: a config session applies the whole list in ONE round trip and commits
      // in a second — never one request per configlet. That wire shape is pinned offline
      // (`live-session-policy.test.ts:47-69`, which asserts exactly those two batches), so counting it
      // live is a device-side confirmation of the same shape, not a guess about EOS.
      expect(batches.length - batchesBefore).toBe(2)
      const text = await counted.getRunningConfig()
      for (const name of names) {
        expect(text.includes(`alias ${name} show hostname`)).toBe(true)
      }
    } finally {
      await unstageLines(node, 'multi', names.map((name) => `no alias ${name}`))
    }
  })

  it('a write drops the config caches when autorefresh is on, and keeps them when it is off (§5 row 34/80 — added arm)', async () => {
    const onName = `d2c_rf_${runId}`
    const offName = `d2c_rfoff_${runId}`
    await unstageLines(counted, 'prelude-rf', [`no alias ${onName}`, `no alias ${offName}`])
    counted.autorefresh = true
    try {
      const staleText = await counted.getRunningConfig()
      const readsBefore = countMatching(batches, 'running-config')
      await stageLines(counted, 'rf-on', [`alias ${onName} show version`])
      expect(countMatching(batches, 'running-config')).toBe(readsBefore)
      const freshText = await counted.getRunningConfig()
      // autorefresh on: the commit refreshed the host (`config-session.ts:938-942`), so the next read is a
      // NEW request and its text carries the line this run wrote.
      expect(countMatching(batches, 'running-config')).toBe(readsBefore + 1)
      expect(freshText.includes(`alias ${onName} show version`)).toBe(true)
      expect(staleText).not.toBe(freshText)

      // autorefresh off: row 34's other half — the write still happens, the cached text does not move.
      counted.autorefresh = false
      const cachedText = await counted.getRunningConfig()
      const offReadsBefore = countMatching(batches, 'running-config')
      await stageLines(counted, 'rf-off', [`alias ${offName} show version`])
      const stillCached = await counted.getRunningConfig()
      expect(stillCached).toBe(cachedText)
      expect(countMatching(batches, 'running-config')).toBe(offReadsBefore)
      expect(stillCached.includes(`alias ${offName} show version`)).toBe(false)
      // refresh() is the operator's way back to the truth.
      counted.autorefresh = true
      counted.refresh()
      const corrected = await counted.getRunningConfig()
      expect(corrected.includes(`alias ${offName} show version`)).toBe(true)
    } finally {
      counted.autorefresh = true
      counted.refresh()
      await unstageLines(counted, 'rf', [`no alias ${onName}`, `no alias ${offName}`])
    }
  })

  it('expandAliases reaches the device and an alias runs as its expansion (test_execute_with_expandaliases, :268 — fresh name, :274/:278-280)', async () => {
    const alias = `d2c_exp_${runId}`
    // Upstream's alias name is the bare word `test` (`:274`); a fresh, run-scoped name keeps this case from
    // colliding with another lane's leftover.
    await unstageLines(node, 'prelude-exp', [`no alias ${alias}`])
    try {
      await stageLines(node, 'exp', [`alias ${alias} show version`])
      try {
        const results = await node.runCommands([alias], { format: 'json', expandAliases: true })
        expect(results.length).toBe(1)
        // The expansion worked exactly if the answer is `show version`'s model (`:280`).
        expect('version' in (results[0] ?? {})).toBe(true)
      } catch (rawErr) {
        if (!(rawErr instanceof EapiError)) throw rawErr
        // Without the parameter the alias is simply unknown, which is what the pre-4.17 else-arm (`:284-286`)
        // asserts upstream. On a 4.28 target this is a device answer to report, not a pass to invent.
        console.warn(`${SUITE}: expandAliases arm refused (${describeRefusal(rawErr)}): ${firstLine(rawErr.message)} — :278-280 is reported, not claimed`)
      }
    } finally {
      await unstageLines(node, 'exp', [`no alias ${alias}`])
    }
    const text = await node.getRunningConfig()
    expect(text.includes(`alias ${alias} show version`)).toBe(false)
  })
})

// ────────────────────────────────────────────────────────────────────────────────────────────────────
// Config-session visibility on the client surface (added arms — upstream has no session tests at all)
// ────────────────────────────────────────────────────────────────────────────────────────────────────

describe.skipIf(!scratchReady)(`live client sessions: named config sessions on ${String(scratch.name ?? 'EAPI_SCRATCH_INTERFACE')}`, () => {
  let node: Node

  beforeAll(async () => {
    const target = unwrapLiveTarget(gate.resolution)
    node = buildFullWriteNode(target)
    await assertDeviceIdentity(node, target)
  })

  afterAll(async () => {
    await node.close()
  })

  it('a staged session is listed as pending, diffs in text, and aborts without touching running-config (added arm; config-session.ts:1049/:748/:880)', async () => {
    const intf = String(scratch.name)
    const marker = `d2cs_abort_${runId}`
    const session: ConfigSession = await node.configSession({ name: `${SUITE}-abort-${runId}` })
    try {
      await session.run([`interface ${intf}`, `description ${marker}`])
      const listing = await node.listSessions()
      const mine = listing.sessions.find((entry) => entry.name === session.name)
      expect(mine).toBeDefined()
      expect(String(mine?.state)).not.toBe('')
      console.log(`${SUITE}: listSessions reports ${session.name} state=${String(mine?.state)} (maxOpenSessions=${String(listing.maxOpenSessions ?? 'unreported')})`)

      const diffText = await session.diff()
      expect(typeof diffText).toBe('string')
      if (diffText.includes(marker)) {
        expect(diffText.length).toBeGreaterThan(0)
      } else {
        console.warn(`${SUITE}: \`show session-config diffs\` answered without naming the staged marker — the diff-text half is reported, not claimed (${JSON.stringify(diffText.slice(0, 200))})`)
      }

      await session.abort()
      // An aborted session does not refresh the host (`config-session.ts:877-878`, `:880-885` — pyeapi
      // agrees), so the absence check below has to be against a FRESH read or it would pass off a stale cache.
      node.refresh()
      const after = await node.getRunningConfig()
      expect(after.includes(`description ${marker}`)).toBe(false)
      const listed = await node.listSessions()
      const lingering = listed.sessions.find((entry) => entry.name === session.name)
      if (lingering !== undefined) {
        expect(lingering.state).not.toBe('pending')
        console.log(`${SUITE}: ${session.name} survives as a completed entry, state=${lingering.state} (EOS keeps ${String(listed.maxSavedSessions ?? 'a few')} saved sessions)`)
      }
    } finally {
      if (session.isOpen) await session.abort()
      await unstageLines(node, 'abort-scratch', [`interface ${intf}`, `no description`])
    }
  })

  it('a committed session is no longer pending and its change is live in running-config but NOT saved (added arm; DR-024/DR-035c)', async () => {
    const intf = String(scratch.name)
    const marker = `d2cs_commit_${runId}`
    const outcome = await runGuardedLiveWriteSession(node, {
      name: `${SUITE}-commit-${runId}`,
      commands: [`interface ${intf}`, `description ${marker}`],
    })
    try {
      expect(outcome.committed).toBe(true)
      expect(outcome.sessionName).toBe(`${SUITE}-commit-${runId}`)
      const text = await node.getRunningConfig()
      expect(text.includes(`description ${marker}`)).toBe(true)

      const listed = await node.listSessions()
      const mine = listed.sessions.find((entry) => entry.name === outcome.sessionName)
      if (mine !== undefined) expect(mine.state).not.toBe('pending')

      // The startup config must not have moved: this lane never persists (DR-035(c); the guarded helper
      // refuses a batch containing `copy run start` before the wire, and no call here passes `persist`).
      const startup = await node.getStartupConfig()
      expect(startup.includes(`description ${marker}`)).toBe(false)
      console.log(`${SUITE}: committed session is live in running-config and absent from startup-config (DR-024)`)
    } finally {
      await unstageLines(node, 'commit-scratch', [`interface ${intf}`, `no description`])
    }
  })
})
