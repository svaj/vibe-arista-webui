/**
 * F5 (#67): the capability-gating wrapper every feature-flagged screen (S2 trunk groups, S7 VXLAN,
 * LAG capacity, STP modes, VRF licensing) uses so it can answer **"available / not available /
 * unknown on this device"** instead of firing a candidate that `1002`-errors at the operator.
 *
 * What this file deliberately is NOT: a feature table. The client exports no capability list and no
 * name vocabulary — DR-033's rule ("presence is probed, never looked up in a table this package
 * ships"; `arista-api-client/docs/DECISIONS.md` DR-062/DR-063) — so every probe question arrives as
 * a caller-supplied `featureProbeCommands` map from the screen that knows its own CLI.
 *
 * ## Why a wrapper exists at all
 *
 * `probeCommands` opens a **named config session** (`no-commit`) and aborts it, so each uncached run
 * contends for the device's config lock. A React screen that re-renders on every keystroke would
 * otherwise re-probe on render. The wrapper adds exactly three things on top of the client, and owns
 * nothing else:
 *
 * 1. **the client's own cache** (`createCapabilityCache`, keyed endpoint+candidates+batchSize, 15-min
 *    TTL, and it never stores an inconclusive run — DR-063). `peek` first, so a fresh answer costs no
 *    round trip and no session at all;
 * 2. **in-flight de-duplication plus a rate limit**, because the cost is a session, not a request:
 *    concurrent callers share one probe, and a re-entrant `probe()` within `throttleMs` is refused
 *    without touching the wire (`view.suppressedCount` counts the refusals so the UI can say so);
 * 3. **the pending-session affordance DR-062 asks for**: when a run reports `configLocked` (the
 *    `1006` arm — usually an orphan from a crashed process, not a feature answer), the view surfaces
 *    `listSessions()` and offers `abortPendingSessions()` rather than a bare error.
 *
 * ## The three-way render, and why it is not two-way
 *
 * {@link capabilityDisplay} folds the client's seven verdicts with the client's own predicates
 * (`isUnavailableVerdict` — only `1002 COMMAND_INVALID` says a command is absent; `isInconclusiveVerdict`
 * — `config-locked` and `unknown` say nothing happened):
 *
 * | display | requires |
 * | --- | --- |
 * | `available` | every candidate for that feature came back `supported` |
 * | `unavailable` | at least one candidate was `unsupported` (`1002`) |
 * | `unknown` | anything else, including `not-rejected`, `incompatible` (`1004`, an eAPI-context answer, not a feature answer), `unauthorized` (`1005`, a privilege answer) |
 *
 * An inconclusive run therefore cannot render as supported: a probe that never reached the CLI grammar
 * (config lock, transport failure, an unclassified code) is not evidence of a feature. Equally, a
 * green probe is **not a capacity claim** — probes answer command presence, never limits (epic open
 * item 6), which is why the view exposes per-feature verdicts rather than a boolean permission.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  createCapabilityCache,
  isInconclusiveVerdict,
  isUnavailableVerdict,
} from '@devhax-heavy-industries/arista-eapi'
import type {
  CapabilityCache,
  CapabilityProbeTarget,
  CapabilityVerdict,
  CommandProbeResult,
  ConfigSessionSummary,
  FeatureProbeCommands,
  Node,
  ProbeCommandsOutcome,
} from '@devhax-heavy-industries/arista-eapi'

/** The screen-side seam: probe target plus the two handles the pending-session affordance needs. */
export type CapabilityClient = CapabilityProbeTarget & Pick<Node, 'listSessions' | 'abortSession'>

/** The three honest answers the UI renders — see the table in the header. */
export type CapabilityDisplay = 'available' | 'unavailable' | 'unknown'

export interface FeatureCapability {
  readonly name: string
  readonly display: CapabilityDisplay
  /** One verdict per candidate, in probe order — enough for a screen to print why. */
  readonly verdicts: readonly CapabilityVerdict[]
  /** The device/client text behind `display`: a code name, or the reason a run proved nothing. The
   *  numeric code the device returned is part of that text (`1002 COMMAND_INVALID`). */
  readonly reason: string
}

export interface CapabilitiesView {
  /** `idle` before the first probe attempt, `probing` while a session is open, `ready`/`failed` after. */
  readonly status: 'idle' | 'probing' | 'ready' | 'failed'
  readonly features: readonly FeatureCapability[]
  /** True when the last run reported `1006`: nothing was probed, and `pendingSessions` explains it. */
  readonly configLocked: boolean
  /** Device sessions in `pending` state — the cleanup an operator can act on. */
  readonly pendingSessions: readonly ConfigSessionSummary[]
  /** Failure text for a probe that threw, or the pending-session cleanup itself. */
  readonly failure?: string
  /** True when the last view came from the client cache without a round trip. */
  readonly fromCache: boolean
  /** How many `probe()` calls the rate limiter refused since the last real probe. */
  readonly suppressedCount: number
  readonly probedAt?: number
}

export interface UseCapabilitiesOptions {
  /** Omit the node (no proxy configured) and the hook stays `idle` without ever probing. */
  readonly node: CapabilityClient | undefined
  /** The screen's own CLI map. Nothing here supplies or validates a default. */
  readonly featureProbeCommands: FeatureProbeCommands
  /** Candidates per batch (part of the cache key). Defaults to one batch, the client's rule. */
  readonly batchSize?: number
  /** Reuse a cache shared across screens so two screens asking the same question cost one session. */
  readonly cache?: CapabilityCache
  /** TTL for the cache this hook builds when none is supplied. `0` disables caching. */
  readonly ttlMs?: number
  /** Minimum spacing between real probes. In-flight calls are always joined regardless. */
  readonly throttleMs?: number
  /** Probe session name (default is the client's `ui-…` form, which `recoverOrphans` can find). */
  readonly sessionName?: string
  /** Gate the auto-probe (a screen that only asks when a control is open). */
  readonly enabled?: boolean
  /** Clock, injectable so a throttle/TTL test never sleeps. */
  readonly now?: () => number
}

export interface UseCapabilitiesResult {
  readonly view: CapabilitiesView
  /** Start (or join) a probe. `force` skips the fresh-cache short-circuit, e.g. after a config change. */
  readonly probe: (options?: { readonly force?: boolean }) => Promise<void>
  /** Abort every `pending` session the view surfaced, then re-probe. Device writes, so screens gate this behind a confirm. */
  readonly abortPendingSessions: () => Promise<void>
}

const EMPTY_VIEW: CapabilitiesView = {
  status: 'idle', features: [], configLocked: false, pendingSessions: [], fromCache: false, suppressedCount: 0,
}

/** Join the client's verdict list into one honest display value plus the text that explains it. */
export function capabilityDisplay(results: readonly CommandProbeResult[]): { display: CapabilityDisplay; reason: string } {
  if (results.length === 0) return { display: 'unknown', reason: 'No candidate command was probed for this feature.' }
  const negative = results.find((result) => isUnavailableVerdict(result.verdict))
  if (negative !== undefined) {
    // Both halves of the device's answer are printed: the numeric code EOS actually returned next to the
    // symbolic name this package mapped, so a reader can tell `1002 COMMAND_INVALID` (grammar absent)
    // from another refusal that classified as unavailable.
    const code = negative.code === undefined ? '' : `${String(negative.code)} `
    return { display: 'unavailable', reason: `${negative.command}: ${code}${negative.codeName ?? '1002 COMMAND_INVALID'}` }
  }
  if (results.every((result) => result.verdict === 'supported')) return { display: 'available', reason: 'Every candidate was accepted by the device.' }
  const inconclusive = results.find((result) => isInconclusiveVerdict(result.verdict))
  if (inconclusive !== undefined) {
    return { display: 'unknown', reason: `${inconclusive.command}: ${inconclusive.verdict} — nothing was established, so the result is not cached.` }
  }
  const soft = results.find((result) => result.verdict !== 'supported')
  return {
    display: 'unknown',
    reason: `${soft?.command ?? 'candidate'}: ${soft?.verdict ?? 'not-rejected'} — the probe never refused the grammar, and that is not a green light.`,
  }
}

/** Probe candidates in caller order, de-duplicated across features. Exported for the screens' tests. */
export function candidateList(featureProbeCommands: FeatureProbeCommands): readonly string[] {
  const seen = new Set<string>()
  const commands: string[] = []
  for (const list of Object.values(featureProbeCommands)) {
    for (const command of list) if (!seen.has(command)) { seen.add(command); commands.push(command) }
  }
  return commands
}

function featureRows(featureProbeCommands: FeatureProbeCommands, outcome: ProbeCommandsOutcome): readonly FeatureCapability[] {
  return Object.keys(featureProbeCommands).map((name) => {
    // `probeCommands` attributes every row against the caller's own `featureProbeCommands` map (which
    // the cache forwards), so grouping by `result.features` needs no local re-mapping here.
    const results = outcome.results.filter((result) => result.features.includes(name))
    const { display, reason } = capabilityDisplay(results)
    return { name, display, verdicts: results.map((result) => result.verdict), reason }
  })
}

/**
 * Capability state for one screen. Probing stays **explicit** — every uncached run costs a config
 * session — so the hook auto-probes once per (node, candidate set) when `enabled`; refreshes go
 * through `probe()`.
 *
 * Render-safe by construction: the volatile inputs live in a ref refreshed each render (the
 * `useDeviceRead` loader-ref idiom), so `probe` keeps a stable identity and the auto-probe effect can
 * never re-fire because the state it wrote changed.
 */
export function useCapabilities(options: UseCapabilitiesOptions): UseCapabilitiesResult {
  const [view, setView] = useState<CapabilitiesView>(EMPTY_VIEW)
  const viewRef = useRef(view)
  // One cache per hook instance, built once. `featureProbeCommands` is normally an inline literal, so
  // it must not be a memo dependency — that would rebuild the cache every render and forget every
  // answer, which is precisely the config-lock churn the client's cache exists to prevent.
  const cacheRef = useRef<CapabilityCache | undefined>(undefined)
  if (cacheRef.current === undefined) {
    cacheRef.current = options.cache ?? createCapabilityCache({
      ...(options.ttlMs === undefined ? {} : { ttlMs: options.ttlMs }),
      ...(options.batchSize === undefined ? {} : { batchSize: options.batchSize }),
      ...(options.sessionName === undefined ? {} : { sessionName: options.sessionName }),
    })
  }
  const inFlight = useRef<Promise<ProbeCommandsOutcome | undefined> | undefined>(undefined)
  const lastStart = useRef(0)
  const suppressed = useRef(0)

  const latest = useRef(options)
  useEffect(() => { latest.current = options })
  const commands = useMemo(() => candidateList(options.featureProbeCommands), [options.featureProbeCommands])
  // The auto-probe trigger is the candidate *content*, precomputed so the dependency array stays a
  // plain identifier list (an inline `commands.join(…)` in a dep array is exactly the "complex
  // expression" shape `use-device-read` had to exempt itself from).
  const commandsKey = useMemo(() => commands.join('\n'), [commands])
  const commandsRef = useRef(commands)
  useEffect(() => { commandsRef.current = commands })

  const applyOutcome = useCallback((outcome: ProbeCommandsOutcome, fromCache: boolean) => {
    const rows = featureRows(latest.current.featureProbeCommands, outcome)
    setView((current) => ({
      status: 'ready',
      features: rows,
      configLocked: outcome.configLocked,
      pendingSessions: current.pendingSessions,
      fromCache,
      suppressedCount: suppressed.current,
      probedAt: outcome.finishedAt,
      // A failed batch on an otherwise-classified run rides into the alert slot: the operator sees
      // both the honest verdicts AND that the device answered with an error envelope.
      ...(outcome.error === undefined ? {} : { failure: outcome.error.message }),
    }))
  }, [])

  const probe = useCallback(async ({ force = false }: { readonly force?: boolean } = {}): Promise<void> => {
    const { node, featureProbeCommands, batchSize, throttleMs = 5_000, enabled = true, now = Date.now } = latest.current
    if (!enabled || node === undefined) return
    const cache = cacheRef.current as CapabilityCache
    const probeOptions = { featureProbeCommands, ...(batchSize === undefined ? {} : { batchSize }) }
    const cached = cache.peek(node, commandsRef.current, probeOptions)
    if (cached !== undefined && cached.fresh && !force) {
      applyOutcome(cached.entry.outcome, true)
      return
    }
    if (inFlight.current !== undefined) { await inFlight.current; return }
    if (lastStart.current !== 0 && now() - lastStart.current < throttleMs) {
      suppressed.current += 1
      setView((current) => ({ ...current, suppressedCount: suppressed.current }))
      return
    }
    lastStart.current = now()
    setView((current) => ({ ...current, status: 'probing' }))
    const refreshPending = async (): Promise<void> => {
      try {
        const sessions = (await node.listSessions()).sessions.filter((session) => session.state === 'pending')
        setView((current) => ({ ...current, pendingSessions: sessions }))
      } catch { /* the lock question went unanswered; the verdict/failure text still stands */ }
    }
    const task = cache.probe(node, commandsRef.current, probeOptions)
      .then((outcome) => {
        applyOutcome(outcome, false)
        // A probe that settled but reported the config lock has an actionable side answer: which
        // sessions are sitting `pending`. The screen's cleanup control needs that list even when the
        // verdict itself came back cleanly, so it is asked here rather than only on the throw path.
        if (outcome.configLocked) void refreshPending()
        return outcome
      })
      .catch(async (error: unknown) => {
        // The client owns the always-abort guarantee, so a throw means the live question is now "is
        // something sitting on the config lock?". Ask the device that (best effort) rather than leaving
        // the screen on a bare exception — the DR-062 `1006` affordance.
        await refreshPending()
        setView((current) => ({
          ...current,
          status: 'failed',
          failure: error instanceof Error ? error.message : String(error),
          fromCache: false,
          suppressedCount: suppressed.current,
        }))
        return undefined
      })
    inFlight.current = task
    try {
      await task
    } finally {
      inFlight.current = undefined
    }
  }, [applyOutcome])

  const abortPendingSessions = useCallback(async (): Promise<void> => {
    const { node } = latest.current
    const targets = viewRef.current.pendingSessions
    if (node === undefined || targets.length === 0) return
    try {
      for (const session of targets) await node.abortSession(session.name)
      setView((current) => ({ ...current, pendingSessions: [], configLocked: false }))
      lastStart.current = 0 // a cleanup is exactly the retry the rate limiter must not swallow
      await probe({ force: true })
    } catch (error: unknown) {
      setView((current) => ({
        ...current,
        status: 'failed',
        failure: error instanceof Error ? error.message : String(error),
      }))
    }
  }, [probe])

  useEffect(() => { viewRef.current = view })

  // Auto-probe once per (node, candidate set). The trigger is `commandsKey`, not the map's object
  // identity — screens pass inline literals, and re-probing per render is what the throttle exists
  // to refuse. `probe` is stable, so this cannot re-fire off its own state write.
  const enabled = options.enabled ?? true
  const node = options.node
  useEffect(() => {
    if (!enabled || node === undefined) return
    void probe()
  }, [enabled, node, commandsKey, probe])

  return { view, probe, abortPendingSessions }
}
