/**
 * Capability probing — M11 (#13), the **mechanism** half of PLAN §M11 ("capability probe + dry-run").
 *
 * ## What this module is
 *
 * `docs/PLAN.md` §M11 asks for a way to find out what a switch accepts. DR-033 fixes the rule that
 * shapes it: nothing in this package may hard-code "supported on the DCS-7050TX-64". Presence is
 * **probed**, at the level the device can actually answer — a *command list*, not a feature name. So
 * this file exposes:
 *
 *  - {@link probeCommands} — stage candidate CLI commands inside a throwaway **named config session**
 *    and classify what the device did to each one;
 *  - {@link createCapabilityCache} — remember those answers per endpoint, with a TTL and an injectable
 *    clock, so a UI does not open a config session on every render.
 *
 * `Node.verifyConfig()` (the `verifyConfig` eAPI method, `src/command-layer.ts`) is the *device-side*
 * dry run and answers a different question — see its doc comment for why `rollback clean-config` makes
 * it a normalisation preview rather than "what my change would do". This module owns the probe that
 * **this client** runs, which is why it owns the guarantee that its session is always ended.
 *
 * ## Feature names are deliberately absent
 *
 * `featureProbeCommands` is the seam: a caller-supplied `name → commands` map used **only to label**
 * each verdict. There is no built-in table, no `probe('trunkGroups')`, and no claim anywhere in this
 * file about what the 7050TX-64 supports (DR-033). The feature-name layer is a later slice, once M10
 * (#12) lands and there is a source for candidate lists worth trusting.
 *
 * ## Evidence status — read this before quoting anything below
 *
 * pyeapi has no twin for any of this: `grep -rn "verifyConfig\|getCommandCompletions\|capability"
 * pyeapi/pyeapi/` in the pinned clone (`develop` `6816d9e`) matches nothing, and the closest upstream
 * idea is `_chunkify`-driven blind writes with no read-back (`client.py:676-696`). Everything here is
 * therefore **new surface**, built on two kinds of evidence:
 *
 *  - *Verified offline*: the error-code set 1000-1006 (`CliCommon.py:11-33` via DR-010) and the fact
 *    that a `stopOnError:false` batch reports **each** rejected command in
 *    `error.data.errorDetail[]` (`JsonCli.py:106-127`, `:425-456`; the same file pair backs
 *    `src/internal/wire.ts`'s method section). Both read out of Arista's own Python for
 *    **EOS 4.28.13.1M** (`usr/lib/python3.9/site-packages/`, extracted from
 *    `/home/svaj/development/arista/_rea_swi/Base.sqsh`), which is vendor build content read for
 *    interoperability — no code below was copied from it.
 *  - *Carried, unverified*: every claim about what a session does on hardware is inherited from
 *    `src/config-session.ts`, whose header records the `*Cli.py:` references as carried claims. The
 *    [STATUS.md §3 sweep](../../docs/STATUS.md) and the M12 (#14) capture stay open. The verdicts below
 *    say what the device *answered*, never what EOS did with the configuration, and a verdict whose
 *    reading depends on vendor-side prose (`not-rejected`) is named differently from one that does not
 *    (`supported`) so no caller can confuse them.
 *
 * Browser-safe (DR-002): no `node:` import, no timer, no global state except the cache the caller
 * constructs.
 */

import { CommandError, EapiErrorCode, NotSupportedError, SessionError, eapiErrorName } from './errors'
import { assertNoSessionConflict } from './config-session'
import type { ChangesetOutcome, ConfigSession, ConfigSessionOptions, ConfigSessionState, SessionCommandTarget, SessionJournal, SessionRequestOptions } from './config-session'
import { warnOnce } from './internal/warn'
import type { ErrorDetailEntry } from './types/eapi'

/**
 * What {@link probeCommands} needs, which `Node` already provides. Declared structurally for the same
 * reason `SessionCommandTarget` is (`config-session.ts`): this module sits below `Node`, and importing
 * `command-layer.ts` here would be the cycle `import/no-cycle` exists to refuse.
 */
export interface CapabilityProbeTarget extends SessionCommandTarget {
  /** The live-session guard DR-025 reads. `probeCommands` refuses to interleave with a caller's session. */
  readonly activeConfigSession: ConfigSession | undefined
  /** The M5 opener: lazy (no request), journal-recorded, and the only way this probe gets a session. */
  configSession(options?: ConfigSessionOptions): Promise<ConfigSession>
}

/**
 * The caller's feature → candidate-commands map: the **only** feature-shaped thing in this slice.
 * Names are opaque strings chosen by the caller; this package stores them on each verdict and never
 * interprets one (DR-033 — inventing a 7050TX-64 feature list here would be exactly the hard-coding
 * DR-033 forbids).
 */
export type FeatureProbeCommands = Readonly<Record<string, readonly string[]>>

/**
 * What one candidate command came back as. The set is the honest version of "supported / not
 * supported": four of these seven verdicts are explicitly *not* a statement about the feature.
 *
 * | Verdict | Means | Says the command is unavailable? |
 * | --- | --- | --- |
 * | `supported` | the device accepted a batch containing it | no — acceptance is the strongest evidence offline |
 * | `not-rejected` | the batch failed but this command was not listed in `errorDetail` | no |
 * | `unsupported` | `1002 COMMAND_INVALID` | yes, as a CLI-grammar answer |
 * | `incompatible` | `1004 COMMAND_INCOMPATIBLE` | **no** — the eAPI context, not the feature |
 * | `unauthorized` | `1005 COMMAND_UNAUTHORIZED` | **no** — a privilege question |
 * | `config-locked` | `1006 COMMAND_CONFIG_LOCKED` | **no** — nothing was probed |
 * | `unknown` | any other code, or a failure with no per-command detail | no |
 *
 * The three "no" rows are the point of the taxonomy: DR-033 forbids turning an authorisation or
 * locking accident into a feature matrix, and DR-010 is what makes them distinguishable at all.
 */
export type CapabilityVerdict = 'supported' | 'not-rejected' | 'unsupported' | 'incompatible' | 'unauthorized' | 'config-locked' | 'unknown'

/** Codes this module maps to a verdict of their own. Everything else is `unknown` (DR-010 is closed). */
const VERDICT_BY_CODE: Readonly<Record<number, CapabilityVerdict>> = Object.freeze({
  [EapiErrorCode.COMMAND_INVALID]: 'unsupported',
  [EapiErrorCode.COMMAND_INCOMPATIBLE]: 'incompatible',
  [EapiErrorCode.COMMAND_UNAUTHORIZED]: 'unauthorized',
  [EapiErrorCode.COMMAND_CONFIG_LOCKED]: 'config-locked',
})

/** Verdicts that answer "is this command unavailable?". The rest are inconclusive by construction. */
const NEGATIVE_VERDICTS: readonly CapabilityVerdict[] = ['unsupported']

/** Verdicts that say nothing at all happened, and so must never be cached (DR-063: do not store what you could not verify). */
const INCONCLUSIVE_VERDICTS: readonly CapabilityVerdict[] = ['config-locked', 'unknown']

/**
 * Candidate commands this client refuses to probe, as our rule and not the device's (a config session
 * would happily try all of these). The probe stages commands in a **live** config session for as long
 * as it takes to walk the list, so a candidate that ends or commits that session destroys the probe's
 * own state — and `commit` would land whatever earlier candidates had staged, which DR-050's whole
 * "a preview never writes" rule exists to prevent. `configure replace` is refused because it exits the
 * session it finds and rewrites running-config (`ConfigSessionCli.py:128-155`, cited in
 * `config-session.ts` as a carried claim), and `copy running-config startup-config` because durability
 * is explicit in this package (DR-024). Matched on a word boundary against the whole candidate, so
 * `commit-buffer something` is not caught but `commit` and `commit timer 00:05:00` are.
 */
const PROBE_FORBIDDEN_COMMANDS: Readonly<Record<string, string>> = Object.freeze({
  abort: "it ends the probe's own config session (`configure session <name>` then `abort`, pyeapi `client.py:1023-1026`), so the remaining candidates would be probed in a fresh session and the earlier staged context would be gone",
  commit: 'it would commit the candidates staged before it in the probe session; a probe never writes running-config (DR-050, and DR-022 is the reason the session exists at all)',
  'configure session': 'it re-attaches a different named session mid-probe (SessionCli.py, carried claim), so the abort this client guarantees would end that session instead of the probe',
  'configure replace': 'it replaces running-config wholesale and exits the session it finds (ConfigSessionCli.py:128-155), which is a write, not a probe',
  'copy running-config startup-config': 'saving startup-config is always explicit in this package (DR-024); a probe cannot trigger it',
  reload: 'it reboots the switch; nothing in a capability probe may do that',
})

/** The prefix-match form of {@link PROBE_FORBIDDEN_COMMANDS}, built once from the same keys. */
const PROBE_FORBIDDEN_PATTERN = new RegExp(`^(?:${Object.keys(PROBE_FORBIDDEN_COMMANDS).map((command) => command.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('|')})(?:\\s|$)`, 'u')

/** One candidate's answer. `command` is the exact text that went on the wire. */
export interface CommandProbeResult {
  readonly command: string
  readonly verdict: CapabilityVerdict
  /**
   * The code the classification rests on: the `errorDetail` entry's own `code` when the device sent one
   * (`JsonCli.py:441-446`), else the batch failure's code, else absent. **Caveat:** a batch reports the
   * *first* failure's code in `error.code` (`JsonCli.py:436`), so a batch-level code is only the
   * weakest evidence and `codeSource` says which case this is.
   */
  readonly code?: number | undefined
  /** `eapiErrorName(code)` — the symbolic name for a log line or a table cell (DR-010). */
  readonly codeName?: string | undefined
  /** Which member the code came from, so a caller never reads a batch-level code as per-command proof. */
  readonly codeSource?: 'errorDetail' | 'batch' | undefined
  /** `errorDetail[].message`, or the batch message — device prose, already redacted by the codec (DR-011). */
  readonly message?: string | undefined
  /** The `error.data.errorDetail[]` member this verdict was derived from, when there was one. */
  readonly errorDetail?: ErrorDetailEntry | undefined
  /** The whole batch's failure object, for a caller that wants `trace()`/`code`/`requestId`. */
  readonly error?: CommandError | undefined
  /** Which chunk of the probe carried this command (0-based; `batchSize` decides how many there are). */
  readonly batchIndex: number
  /** Every feature name in {@link FeatureProbeCommands} whose list contained this command. */
  readonly features: readonly string[]
  /** `true` when the verdict is a **no** about the command (only `unsupported` qualifies). */
  readonly unavailable: boolean
}

/** The state of the probe session when {@link probeCommands} finished. */
export interface ProbeSessionReport {
  readonly name: string
  readonly state: ConfigSessionState
  /**
   * `true` only when this client sent the `abort` and the device answered. `false` with state `lost`
   * means the handle was already dead (the opener was rejected, or `1006` took the lock — DR-023), so
   * there was nothing to abort; `false` with a live state should be impossible and is reported as an
   * error instead (see {@link ProbeCommandsOptions.onCleanupFailure}).
   */
  readonly aborted: boolean
  /** Whether the session was opened `no-commit`, i.e. could not be committed even by accident. */
  readonly noCommit: boolean
  /** The `opener` text, for a UI that tells an operator what to clean up by hand. */
  readonly opener: string
}

/** One chunk of the probe, reported as it completes so a UI can show progress. */
export interface ProbeBatchProgress {
  readonly batchIndex: number
  readonly batchesUpperBound: number
  readonly commands: readonly string[]
  readonly results: readonly CommandProbeResult[]
  readonly sessionName: string
}

/** What a failed cleanup looks like, for {@link ProbeCommandsOptions.onCleanupFailure}. */
export interface ProbeCleanupFailure {
  readonly sessionName: string
  readonly error: unknown
  /** The probe failure that happened first, when there was one — the error `probeCommands` rethrows. */
  readonly probeError: unknown
  readonly message: string
}

/** Options for {@link probeCommands}. */
export interface ProbeCommandsOptions {
  /**
   * Probe session name. Omit it and M5's DR-047 default (`ui-<host>-p<pid>-<hex8>`) is used, which is
   * on purpose: `SESSION_NAME_PREFIX` is `recoverOrphans()`'s default filter, so a probe session that
   * outlived its process is still findable (DR-022/DR-023). A `probe-…` name would hide it from that
   * filter and leave the config lock held.
   */
  readonly sessionName?: string | undefined
  /** Optional `configure session <name> description "…"` text. Off by default — see `config-session.ts` on quoting depth. */
  readonly sessionDescription?: string | undefined
  /** Journal to record the session in, so a crash mid-probe leaves a recoverable name (DR-022). */
  readonly journal?: SessionJournal | undefined
  /**
   * How many candidates per batch. Defaults to all of them in **one** batch, which is the smallest
   * device-side footprint. Splitting is a UI concern (progress, and a bounded request for a long
   * candidate list); it is also why classification keys on the `cmd` **text** rather than the
   * `errorDetail` index, whose base is the whole wire list including `enable` and the opener.
   */
  readonly batchSize?: number | undefined
  /** Labels only: `name → commands`. Nothing here interprets a name (DR-033). */
  readonly featureProbeCommands?: FeatureProbeCommands | undefined
  /**
   * Progress sink, called once per chunk as it completes. It runs **inside** the probe's guarantee: a
   * sink that throws still gets the session aborted before the error leaves {@link probeCommands}.
   */
  readonly onBatch?: ((progress: ProbeBatchProgress) => void) | undefined
  /**
   * Clock for the outcome timings (and for the cache in {@link createCapabilityCache}). Injectable
   * because the offline suite must not depend on wall-clock time.
   */
  readonly now?: (() => number) | undefined
  /**
   * Called when the guaranteed `abort` itself failed while the probe had already failed — the one case
   * where a pending session can survive this function without the thrown error mentioning it (the
   * probe error stays the primary failure, since its class is what a caller branches on). Defaults to
   * the package's `warnOnce`, so the default is loud rather than silent (DR-023).
   */
  readonly onCleanupFailure?: ((failure: ProbeCleanupFailure) => void) | undefined
  /** Pass-through session-request knobs (`sendEnable`, `timeoutMs`, `signal`). No `format`: the verdicts do not depend on the encoding. */
  readonly request?: SessionRequestOptions | undefined
}

/** What {@link probeCommands} answers. */
export interface ProbeCommandsOutcome {
  /** One entry per candidate, in the order they were offered. */
  readonly results: readonly CommandProbeResult[]
  /** The per-command detail every failed batch reported, concatenated — nothing is dropped (PLAN: unknown fields survive). */
  readonly errorDetail: readonly ErrorDetailEntry[]
  /** The first batch failure, when any chunk failed. Per-cascade note: `1002` here is the first rejection, not the only one. */
  readonly error?: CommandError | undefined
  /** How many `runCmds` batches the probe sent (`≥ 1`; the `abort` is one more, and is not counted). */
  readonly batchCount: number
  readonly session: ProbeSessionReport
  /** `true` when any verdict is `config-locked`, i.e. nothing can be concluded from this run at all. */
  readonly configLocked: boolean
  /** `false` only when the probe never got a batch out (a refusal), which today always throws instead. */
  readonly probed: boolean
  readonly startedAt: number
  readonly finishedAt: number
  readonly elapsedMs: number
  /** The verdict counts, so a review screen prints "3 supported, 1 unsupported, 2 inconclusive" without a loop. */
  readonly summary: Readonly<Record<CapabilityVerdict, number>>
}

/** Options for {@link createCapabilityCache}. */
export interface CapabilityCacheOptions {
  /**
   * How long a verdict set stays answerable. **Ours, not the device's**: nothing on EOS invalidates a
   * capability answer, and what would change one (an `eos` upgrade, a `feature` toggle, an AAA change)
   * is unbounded by any offline evidence. `0` means "cache nothing" rather than "cache forever"; use
   * {@link CapabilityCache.invalidate} after a config change you know about.
   */
  readonly ttlMs?: number | undefined
  /** Clock. Defaults to `Date.now`; injectable so expiry is testable without waiting. */
  readonly now?: (() => number) | undefined
  /** Labels for every probe this cache runs (see {@link FeatureProbeCommands}). */
  readonly featureProbeCommands?: FeatureProbeCommands | undefined
  /** Session-name override passed to every probe. Mostly for tests: one predictable name per endpoint. */
  readonly sessionName?: string | undefined
  /** Journal passed to every probe, so a crashed background probe stays recoverable (DR-022). */
  readonly journal?: SessionJournal | undefined
  /** Candidates per batch, for every probe this cache runs. Part of the cache key. */
  readonly batchSize?: number | undefined
  /** Where a cleanup failure goes when the probe had already failed. See {@link ProbeCommandsOptions.onCleanupFailure}. */
  readonly onCleanupFailure?: ((failure: ProbeCleanupFailure) => void) | undefined
}

/** A stored probe. */
export interface CapabilityCacheEntry {
  /** `Transport#address` — the identity a capability answer belongs to (no globals, no per-`Node` guesswork). */
  readonly endpoint: string
  /** The full key: endpoint + candidates + the options that change the answer. */
  readonly key: string
  readonly outcome: ProbeCommandsOutcome
  readonly storedAt: number
  readonly expiresAt: number
}

/** {@link CapabilityCache.peek}'s answer: what is stored, and whether it still counts. */
export interface CapabilityCachePeek {
  readonly entry: CapabilityCacheEntry
  readonly fresh: boolean
  /** `expiresAt - now`, negative for an expired entry, so a UI can render "stale since 5 min ago". */
  readonly remainingMs: number
}

/** The cache surface. Constructed per app with {@link createCapabilityCache}; it holds no global state. */
export interface CapabilityCache {
  /** Cached probe: answers from the store when fresh, otherwise probes and stores what was verified. */
  probe(target: CapabilityProbeTarget, commands: readonly string[], options?: ProbeCommandsOptions): Promise<ProbeCommandsOutcome>
  /** Read without probing. `undefined` when nothing is stored; `fresh: false` when it has expired. */
  peek(target: CapabilityProbeTarget | string, commands: readonly string[], options?: Pick<ProbeCommandsOptions, 'featureProbeCommands' | 'batchSize'>): CapabilityCachePeek | undefined
  /** Drop one endpoint's entries — call it after a config change you made on purpose. Returns how many went. */
  invalidate(endpoint: string): number
  /** Drop everything. Returns how many entries went. */
  clear(): number
  readonly size: number
  /** The endpoints currently held, in insertion order. */
  endpoints(): readonly string[]
  /** Entries for an endpoint, fresh or not — a settings screen's "probed at" table. */
  entries(endpoint?: string): readonly CapabilityCacheEntry[]
}

/** {@link probeCommands}: one chunk of candidates, one session, verdicts in send order. */
export async function probeCommands(target: CapabilityProbeTarget, commands: readonly string[], options: ProbeCommandsOptions = {}): Promise<ProbeCommandsOutcome> {
  // Every guard below runs before `target.configSession()`, which is itself lazy (M5 §5 row 61), so a
  // refusal here is provably a refusal at **zero** round trips — asserted case by case in the spec.
  const candidates = assertCandidateList(commands)
  const labels = buildFeatureLabels(options.featureProbeCommands, candidates)
  const batchSize = assertBatchSize(options.batchSize, candidates.length)
  // DR-025: the probe owns its session for the whole candidate list, so it cannot share a node with a
  // caller's live session — that is the whole reason `CapabilityProbeTarget` asks for
  // `activeConfigSession`. Refused here, before the opener, exactly as M5 refuses `configure()` in
  // terminal mode for the same reason.
  assertNoSessionConflict(target.activeConfigSession, 'probeCommands()')
  const now = options.now ?? Date.now
  const startedAt = now()

  const session = await target.configSession({
    // `no-commit`: a review-only session cannot be committed even by a stray `commit` from another
    // process holding the same name, and the refusal is device-verified in M5's `assertCommittable`
    // (DR-050: the verb that stages must not be the verb that lands).
    noCommit: true,
    ...(options.sessionName === undefined ? {} : { name: options.sessionName }),
    ...(options.sessionDescription === undefined ? {} : { description: options.sessionDescription }),
    ...(options.journal === undefined ? {} : { journal: options.journal }),
  })

  const collected: CommandProbeResult[] = []
  const detail: ErrorDetailEntry[] = []
  let batchError: CommandError | undefined
  let batchCount = 0
  let probeError: unknown
  let lockFailure: CommandError | undefined

  try {
    const chunks = chunk(candidates, batchSize)
    for (const [batchIndex, chunkCommands] of chunks.entries()) {
      batchCount += 1
      const outcome = await session.validateChanges(chunkCommands, options.request ?? {})
      const results = classifyChunk(chunkCommands, batchIndex, outcome, labels)
      if (!outcome.ok) {
        detail.push(...outcome.failures)
        batchError ??= outcome.error
      }
      collected.push(...results)
      options.onBatch?.({
        batchIndex,
        batchesUpperBound: chunks.length,
        commands: chunkCommands,
        results,
        sessionName: session.name,
      })
    }
  } catch (error) {
    probeError = error
    // `validateChanges` re-throws when a failure killed the handle, and `ConfigSession` marks `1006`
    // fatal to the handle (DR-023), so a lock arrives as a `SessionError` wrapping the `CommandError`.
    lockFailure = configLockCause(error)
  }

  if (lockFailure !== undefined) {
    // Nothing further can be learned: the config lock is held, so the session was never usable. Every
    // candidate without a verdict yet gets `config-locked` (and `unknown` is reserved for "the device
    // answered and we could not read it"), because the honest report is "no probe happened".
    const seen = new Set(collected.map((result) => result.command))
    for (const [index, command] of candidates.entries()) {
      if (seen.has(command)) continue
      collected.push(baseResult(command, 'config-locked', Math.floor(index / batchSize), labels, { code: EapiErrorCode.COMMAND_CONFIG_LOCKED, codeSource: 'batch', message: lockFailure.message, error: lockFailure }))
    }
    // Ordered by the candidate list, so `results[i]` still matches `commands[i]` after a mid-probe lock.
    collected.sort((left, right) => candidates.indexOf(left.command) - candidates.indexOf(right.command))
  }

  // --- the guarantee this module exists for: the session this client opened is ended. -------------
  let aborted = false
  let cleanupFailure: unknown
  if (session.isOpen) {
    try {
      await session.abort()
      aborted = true
    } catch (error) {
      cleanupFailure = error
    }
  }

  const finishedAt = now()
  // A `1006` is the one device failure that is an *answer* rather than a probe failure: the config lock
  // means "nothing could be probed", which the candidate table above reports verdict-by-verdict
  // (`config-locked`) and {@link ProbeCommandsOutcome.configLocked} says out loud. Rethrowing it would
  // make that table, the `configLocked` flag, path 4 of the no-orphan guarantee below ("the outcome says
  // so instead of pretending") and the cache's never-store-a-locked-run rule (`isCacheable`) all
  // unreachable, and would replace a machine-readable verdict with an exception class the caller cannot
  // tell apart from our own bookkeeping failure. The device error still travels as `outcome.error`.
  if (lockFailure === undefined && probeError !== undefined) {
    if (cleanupFailure !== undefined) {
      const failure = cleanupFailureReport(session.name, cleanupFailure, probeError)
      const report = options.onCleanupFailure ?? defaultCleanupReporter
      report(failure)
    }
    // The probe's own failure is what the caller asked about and what its `catch` branches on
    // (`CommandError` vs `ConnectError` vs `SessionError`); replacing it with the cleanup failure would
    // hide "the switch was unreachable" behind "could not abort".
    throw probeError
  }
  if (lockFailure !== undefined) batchError ??= lockFailure
  // A lock never reaches the cleanup branch with a live handle: `classifyFailure` marks the session
  // `lost` (DR-023), so `session.isOpen` was false and no `abort` was attempted. The guard is written
  // out anyway so an orphan can never be reported as a clean locked answer.
  if (cleanupFailure !== undefined) {
    // Nothing else went wrong, so this *is* the failure: returning a happy verdict table while a
    // pending session holds the config lock is the DR-023 bug this function exists to prevent.
    throw new SessionError(
      `capability probe finished but could not abort config session ${JSON.stringify(session.name)}: ${String(cleanupFailure instanceof Error ? cleanupFailure.message : cleanupFailure)}. The session may still be pending and holding the config lock — clean up with node.abortSession(${JSON.stringify(session.name)}) or node.recoverOrphans() (DR-023).`,
      { commands: [`configure session ${session.name} abort`], cause: cleanupFailure },
    )
  }

  return buildOutcome(collected, detail, batchError, batchCount, session, aborted, startedAt, finishedAt, lockFailure !== undefined)
}

/** `true` when a verdict is a statement that the command is unavailable. Only `1002` qualifies. */
export function isUnavailableVerdict(verdict: CapabilityVerdict): boolean {
  return NEGATIVE_VERDICTS.includes(verdict)
}

/** `true` when the verdict says nothing usable happened (`1006`, or a failure this client could not read). */
export function isInconclusiveVerdict(verdict: CapabilityVerdict): boolean {
  return INCONCLUSIVE_VERDICTS.includes(verdict)
}

// --- classification -------------------------------------------------------------------------------

interface ResultPatch {
  readonly code?: number
  readonly codeSource?: 'errorDetail' | 'batch'
  readonly message?: string
  readonly errorDetail?: ErrorDetailEntry
  readonly error?: CommandError
}

function baseResult(
  command: string,
  verdict: CapabilityVerdict,
  batchIndex: number,
  labels: Readonly<Record<string, readonly string[]>>,
  patch: ResultPatch = {},
): CommandProbeResult {
  const code = patch.code
  return {
    command,
    verdict,
    ...(code === undefined ? {} : { code }),
    ...(code === undefined ? {} : { codeName: eapiErrorName(code) }),
    ...(patch.codeSource === undefined ? {} : { codeSource: patch.codeSource }),
    ...(patch.message === undefined ? {} : { message: patch.message }),
    ...(patch.errorDetail === undefined ? {} : { errorDetail: patch.errorDetail }),
    ...(patch.error === undefined ? {} : { error: patch.error }),
    batchIndex,
    features: labels[command] ?? [],
    unavailable: NEGATIVE_VERDICTS.includes(verdict),
  }
}

/**
 * Turn one chunk's {@link ChangesetOutcome} into per-command verdicts.
 *
 * The key is the **`cmd` text**, never `errorDetail[].index`: the device's index counts the whole wire
 * list, which inside a session starts `enable`, `configure session <name> …` (`JsonCli.py:441-446`
 * writes the index as the CLI saw it, and `config-session.ts` pops two replies before the caller sees
 * them), so an index would silently mis-attribute the moment `batchSize` or `sendEnable` changes.
 * Text matching is what makes the classification independent of both — and a detail whose `cmd` matches
 * no candidate (the opener's own rejection, say) is kept in {@link ProbeCommandsOutcome.errorDetail}
 * rather than being forced onto a candidate it does not describe.
 */
function classifyChunk(
  chunkCommands: readonly string[],
  batchIndex: number,
  outcome: ChangesetOutcome,
  labels: Readonly<Record<string, readonly string[]>>,
): CommandProbeResult[] {
  if (outcome.ok) {
    // The batch was accepted whole. Note what that is *not*: proof that the resulting configuration is
    // valid or that a `show` proves the feature works — only that the CLI did not refuse these commands
    // in this session (DR-050).
    return chunkCommands.map((command) => baseResult(command, 'supported', batchIndex, labels))
  }
  const byText = new Map<string, readonly ErrorDetailEntry[]>()
  for (const entry of outcome.failures) {
    if (typeof entry.cmd !== 'string') continue
    const existing = byText.get(entry.cmd)
    byText.set(entry.cmd, existing === undefined ? [entry] : [...existing, entry])
  }
  return chunkCommands.map((command) => {
    const entries = byText.get(command)
    if (entries === undefined) {
      // The batch failed and this command was not listed. `JsonCli.py:106-127` does not break on a
      // rejected command when `stopOnError` is false — it keeps going and lists every failure
      // (`:425-456`) — so silence means "not rejected". That reading rests on vendor Python rather
      // than a capture, which is exactly why this verdict is named apart from `supported`.
      return baseResult(command, 'not-rejected', batchIndex, labels, {
        code: outcome.error.code,
        codeSource: 'batch',
        message: outcome.error.message,
        error: outcome.error,
      })
    }
    const [first] = entries
    const code = first?.code ?? outcome.error.code
    return baseResult(command, VERDICT_BY_CODE[code] ?? 'unknown', batchIndex, labels, {
      code,
      codeSource: typeof first?.code === 'number' ? 'errorDetail' : 'batch',
      ...(typeof first?.message === 'string' ? { message: first.message } : { message: outcome.error.message }),
      ...(first === undefined ? {} : { errorDetail: first }),
      error: outcome.error,
    })
  })
}

/** Is this failure the `1006` config lock, in either wrapping this package uses? (DR-010, DR-023) */
function configLockCause(error: unknown): CommandError | undefined {
  if (error instanceof CommandError) return error.code === EapiErrorCode.COMMAND_CONFIG_LOCKED ? error : undefined
  if (error instanceof SessionError) {
    const cause = error.cause
    return cause instanceof CommandError && cause.code === EapiErrorCode.COMMAND_CONFIG_LOCKED ? cause : undefined
  }
  return undefined
}

function buildOutcome(
  results: readonly CommandProbeResult[],
  errorDetail: readonly ErrorDetailEntry[],
  error: CommandError | undefined,
  batchCount: number,
  session: ConfigSession,
  aborted: boolean,
  startedAt: number,
  finishedAt: number,
  configLocked: boolean,
): ProbeCommandsOutcome {
  const summary = {
    supported: 0,
    'not-rejected': 0,
    unsupported: 0,
    incompatible: 0,
    unauthorized: 0,
    'config-locked': 0,
    unknown: 0,
  } satisfies Record<CapabilityVerdict, number>
  for (const result of results) summary[result.verdict] += 1
  return {
    results,
    errorDetail,
    ...(error === undefined ? {} : { error }),
    batchCount,
    session: {
      name: session.name,
      state: session.state,
      aborted,
      noCommit: session.noCommit,
      opener: probeOpenerName(session.name),
    },
    configLocked,
    probed: batchCount > 0,
    startedAt,
    finishedAt,
    elapsedMs: finishedAt - startedAt,
    summary,
  }
}

function probeOpenerName(name: string): string {
  return `configure session ${name}`
}

function cleanupFailureReport(sessionName: string, error: unknown, probeError: unknown): ProbeCleanupFailure {
  return {
    sessionName,
    error,
    probeError,
    message:
      `capability probe config session ${JSON.stringify(sessionName)} was left behind: aborting it failed (${String(error instanceof Error ? error.message : error)}) after the probe itself had already failed ` +
      `(${String(probeError instanceof Error ? `${probeError.name}: ${probeError.message}` : probeError)}). Clean up with node.abortSession(${JSON.stringify(sessionName)}) or node.recoverOrphans() (DR-023).`,
  }
}

/** The default cleanup reporter: the package's one-shot console warning, so an orphan is never silent. */
function defaultCleanupReporter(failure: ProbeCleanupFailure): void {
  warnOnce('capability-probe:orphaned-session', failure.message)
}

// --- the `no orphan` invariant, spelled out for the reviewer --------------------------------------
/**
 * Every path through {@link probeCommands} ends the session it opened:
 *
 *  1. all batches accepted → `abort` in the normal path;
 *  2. a batch **rejected** (`1002`/`1004`/`1005`, any code) → `ConfigSession` keeps the handle live
 *     (DR-048: a session whose commands failed still exists), so `abort` runs;
 *  3. the **opener** rejected / a transport failure → the handle is live or already `lost`; abort when
 *     it is live, and report `aborted: false` with state `lost` when it is not;
 *  4. `1006` config lock → M5 marks the handle `lost` (`config-session.ts#classifyFailure`), so no
 *     `abort` is attempted and the outcome says so instead of pretending;
 *  5. `onBatch` (a caller sink) throws → the `finally`-equivalent above still aborts;
 *  6. the `abort` itself fails → either the probe already failed (reported through
 *     {@link ProbeCommandsOptions.onCleanupFailure}, default `warnOnce`) or this function throws a
 *     `SessionError` naming the session. There is no path that returns success with a live session.
 *
 * The spec pins paths 1-6 with `MockTransport#sent()`, including that a batch containing the candidates
 * is always followed by a batch whose last command is `abort`.
 */

// --- the cache ------------------------------------------------------------------------------------

/** Default TTL for {@link createCapabilityCache}. Our policy, not a device property — see {@link CapabilityCacheOptions.ttlMs}. */
export const DEFAULT_CAPABILITY_TTL_MS = 15 * 60 * 1_000

/**
 * A per-endpoint probe cache (PLAN §M11 "cache the probe results"). Why it exists: a probe is a config
 * session, and a session takes the config lock (DR-023), so a UI that re-probed on every render would
 * do more than waste a round trip — it would contend with the operator's own session.
 *
 * Three policies, all ours and all stated in {@link CapabilityCacheOptions}:
 *  - keyed by `Transport#address` **plus** the candidate list **plus** the options that change the
 *    answer (`batchSize`, and the label map, because labels are part of what is returned);
 *  - never stores a rejection, a `config-locked` run, or a `not-rejected`-without-detail run
 *    ({@link isInconclusiveVerdict}) — DR-063: an unverifiable answer must not become a cached fact;
 *  - probes against one endpoint are serialised, and concurrent probes for the **same** key share one
 *    promise, because {@link Node.configSession} allows one live session per node (DR-025) and a second
 *    tab must not turn a dedupe opportunity into a `SessionError`.
 */
export function createCapabilityCache(options: CapabilityCacheOptions = {}): CapabilityCache {
  const now = options.now ?? Date.now
  const ttlMs = options.ttlMs ?? DEFAULT_CAPABILITY_TTL_MS
  const entries = new Map<string, CapabilityCacheEntry>()
  const inflight = new Map<string, Promise<ProbeCommandsOutcome>>()
  /** One tail per endpoint, so two different candidate lists on one switch queue instead of colliding. */
  const queues = new Map<string, Promise<unknown>>()

  /** Cache defaults, then the per-call options, then the cache's clock. A per-call map beats the cache's. */
  function probeOptions(call: ProbeCommandsOptions): ProbeCommandsOptions {
    const labels = call.featureProbeCommands ?? options.featureProbeCommands
    return {
      ...(options.sessionName === undefined ? {} : { sessionName: options.sessionName }),
      ...(options.journal === undefined ? {} : { journal: options.journal }),
      ...(options.batchSize === undefined ? {} : { batchSize: options.batchSize }),
      ...(options.onCleanupFailure === undefined ? {} : { onCleanupFailure: options.onCleanupFailure }),
      ...call,
      ...(labels === undefined ? {} : { featureProbeCommands: labels }),
      now,
    }
  }

  function keyFor(endpoint: string, commands: readonly string[], call: Pick<ProbeCommandsOptions, 'featureProbeCommands' | 'batchSize'>): string {
    const labels = call.featureProbeCommands ?? options.featureProbeCommands
    const batchSize = call.batchSize ?? options.batchSize
    // `JSON.stringify` of a sorted-pairs structure rather than the objects themselves: a map's key order
    // is a caller detail and must not split one logical probe into two cache entries.
    const labelSignature = labels === undefined ? '' : Object.entries(labels).map(([name, list]) => `${name}=${list.join('\u0000')}`).sort().join('\u0001')
    const sizeSignature = batchSize === undefined ? '' : `bs=${String(batchSize)}`
    return `${endpoint}\u0002${commands.join('\u0000')}\u0002${sizeSignature}\u0002${labelSignature}`
  }

  function endpointOf(target: CapabilityProbeTarget | string): string {
    return typeof target === 'string' ? target : target.connection.address
  }

  function isCacheable(outcome: ProbeCommandsOutcome): boolean {
    if (outcome.configLocked) return false
    return !outcome.results.some((result) => INCONCLUSIVE_VERDICTS.includes(result.verdict))
  }

  function runQueue<T>(endpoint: string, task: () => Promise<T>): Promise<T> {
    const tail = queues.get(endpoint) ?? Promise.resolve()
    // `tail.then(task, task)`: a previous probe's failure must not poison the queue for later callers.
    const result = tail.then(task, task)
    const settled = result.then(
      () => undefined,
      () => undefined,
    )
    queues.set(endpoint, settled)
    // Drop the tail once it is still the current one and settled, so a long-lived cache does not
    // accumulate one retained promise per probe.
    void settled.then(() => {
      if (queues.get(endpoint) === settled) queues.delete(endpoint)
    })
    return result
  }

  return {
    probe(target, commands, call: ProbeCommandsOptions = {}) {
      const endpoint = endpointOf(target)
      const key = keyFor(endpoint, commands, call)
      const stored = entries.get(key)
      if (stored !== undefined && stored.expiresAt > now()) return Promise.resolve(stored.outcome)
      const running = inflight.get(key)
      if (running !== undefined) return running
      const probe = runQueue(endpoint, () => probeCommands(target, commands, probeOptions(call)))
      const tracked = probe.then(
        (outcome) => {
          inflight.delete(key)
          if (isCacheable(outcome) && ttlMs > 0) {
            const storedAt = now()
            entries.set(key, { endpoint, key, outcome, storedAt, expiresAt: storedAt + ttlMs })
          }
          return outcome
        },
        (error: unknown) => {
          // A failed probe is never remembered, so the next caller retries rather than inheriting a
          // lock or an unreachable switch as this endpoint's capability answer.
          inflight.delete(key)
          throw error
        },
      )
      inflight.set(key, tracked)
      return tracked
    },
    peek(target, commands, call = {}) {
      const key = keyFor(endpointOf(target), commands, call)
      const entry = entries.get(key)
      if (entry === undefined) return undefined
      const remainingMs = entry.expiresAt - now()
      return { entry, fresh: remainingMs > 0, remainingMs }
    },
    invalidate(endpoint) {
      let dropped = 0
      for (const [key, entry] of [...entries]) {
        if (entry.endpoint !== endpoint) continue
        entries.delete(key)
        dropped += 1
      }
      for (const key of [...inflight.keys()]) {
        if (key.startsWith(`${endpoint}\u0002`)) inflight.delete(key)
      }
      return dropped
    },
    clear() {
      const dropped = entries.size
      entries.clear()
      inflight.clear()
      queues.clear()
      return dropped
    },
    get size() {
      return entries.size
    },
    endpoints() {
      return [...new Set([...entries.values()].map((entry) => entry.endpoint))]
    },
    entries(endpoint) {
      const all = [...entries.values()]
      return endpoint === undefined ? all : all.filter((entry) => entry.endpoint === endpoint)
    },
  }
}

// --- guards (every one runs before the first request) ----------------------------------------------

/**
 * The candidate list. `probeCommands` takes **strings** only: verdict attribution depends on the text
 * the device echoes in `errorDetail[].cmd`, and a `{cmd, input}` object's echo (`CliCommand.__str__`
 * appends `input=%r`, per `config-session.ts`) is not something this package has verified well enough to
 * match on. A caller with a multiline candidate should probe the parent command instead.
 */
function assertCandidateList(commands: readonly string[]): readonly string[] {
  if (!Array.isArray(commands)) {
    throw new TypeError(`probeCommands needs an array of candidate command strings, got ${describeValue(commands)}`)
  }
  if (commands.length === 0) {
    throw new TypeError(
      'probeCommands needs at least one candidate command — an empty probe opens a config session to learn nothing, and a UI would render "0 unsupported" as "all supported"',
    )
  }
  const seen = new Set<string>()
  for (const [index, command] of commands.entries()) {
    if (typeof command !== 'string') {
      throw new TypeError(
        `probe candidate ${String(index)} is ${describeValue(command)}, not a command string — a {cmd, input} candidate cannot be matched to the device's echoed 'cmd' text, so the probe would guess which command failed`,
      )
    }
    const text = command.trim()
    if (text === '') {
      throw new TypeError(`probe candidate ${String(index)} is empty — drop it or pass the command`)
    }
    if (/[\u0000-\u001f\u007f]/u.test(command)) {
      throw new NotSupportedError(
        `probe candidate ${String(index)} contains a control character — a candidate is one CLI command line inside the probe session, and a newline would start a second one`,
      )
    }
    const forbidden = PROBE_FORBIDDEN_PATTERN.exec(text)
    if (forbidden !== null) {
      const key = Object.keys(PROBE_FORBIDDEN_COMMANDS).find((command0) => text === command0 || text.startsWith(`${command0} `))
      throw new NotSupportedError(
        `probe candidate ${JSON.stringify(text)} is refused: ${PROBE_FORBIDDEN_COMMANDS[String(key)]}. This is this client's rule, not the device's — the command would still be sent by session.run()/configure() (see PROBE_FORBIDDEN_COMMANDS in src/capabilities.ts)`,
      )
    }
    if (seen.has(command)) {
      // Not a device constraint, a reporting one: two identical candidates produce two `errorDetail`
      // entries for the same text, and a caller that zips results by index would then double-count.
      throw new TypeError(`probe candidate ${JSON.stringify(text)} appears more than once — offer each command once; the verdict is per command, not per position`)
    }
    seen.add(command)
  }
  return commands
}

function assertBatchSize(batchSize: number | undefined, total: number): number {
  if (batchSize === undefined) return total
  if (typeof batchSize !== 'number' || !Number.isInteger(batchSize) || batchSize <= 0) {
    throw new TypeError(`probe batchSize must be a positive integer, got ${describeValue(batchSize)}`)
  }
  return batchSize
}

/**
 * Validate the feature seam and invert it into `command → feature names`. A value that is not a
 * non-empty array of strings is refused (rather than ignored) because a silently-skipped feature would
 * read as "that feature has no verdicts" — indistinguishable from "nothing matched".
 */
function buildFeatureLabels(map: FeatureProbeCommands | undefined, candidates: readonly string[]): Readonly<Record<string, readonly string[]>> {
  if (map === undefined) return {}
  if (typeof map !== 'object' || map === null || Array.isArray(map)) {
    throw new TypeError(`featureProbeCommands must be an object of feature name → command array, got ${describeValue(map)}`)
  }
  const labels: Record<string, string[]> = {}
  for (const command of candidates) labels[command] = []
  for (const [name, list] of Object.entries(map)) {
    if (name.trim() === '') {
      throw new TypeError('featureProbeCommands has an empty feature name — a name is the only thing this package can report a verdict against')
    }
    if (!Array.isArray(list) || list.length === 0) {
      throw new TypeError(`featureProbeCommands[${JSON.stringify(name)}] must be a non-empty array of candidate commands — an empty list would make ${JSON.stringify(name)} look probed but empty`)
    }
    for (const [index, command] of list.entries()) {
      if (typeof command !== 'string' || command.trim() === '') {
        throw new TypeError(`featureProbeCommands[${JSON.stringify(name)}][${String(index)}] is ${describeValue(command)}, not a non-empty command string`)
      }
      const bucket = labels[command]
      if (bucket === undefined) labels[command] = [name]
      else if (!bucket.includes(name)) bucket.push(name)
    }
  }
  return labels
}

function describeValue(value: unknown): string {
  if (Array.isArray(value)) return 'an array'
  if (value === null) return 'null'
  if (typeof value === 'string') return JSON.stringify(value)
  return typeof value
}

/** Split a candidate list into chunks of at most `batchSize`, preserving order. Exported for the spec. */
export function chunk(commands: readonly string[], batchSize: number): readonly (readonly string[])[] {
  const size = Math.max(1, Math.floor(batchSize))
  const chunks: (readonly string[])[] = []
  for (let index = 0; index < commands.length; index += size) chunks.push(commands.slice(index, index + size))
  return chunks
}
