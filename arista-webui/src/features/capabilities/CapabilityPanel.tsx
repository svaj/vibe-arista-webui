/**
 * S7 (#77): the capability probe panel — the interactive surface for F5's machinery, where the
 * operator asks a named question and the device's own answers become evidence for the other screens'
 * gates (trunk groups = DECISIONS open item 4, LACP fields, B1's VXLAN question, STATUS §3 rows).
 *
 * ## The four rules this container exists to hold
 *
 * 1. **Nothing probes on mount.** `useCapabilities` runs here with `probeTrigger: 'manual'` (#123 —
 *    shipped in the PR this branch stacks on): an uncached probe costs a config session (DR-063),
 *    and #77's safety line is "rate-limit + confirm **before** running". `enabled: false` could not
 *    express this — it means *never* — which is the whole of #123.
 * 2. **Confirm before the session.** Every run (and every forced re-probe) passes the F4 confirm,
 *    which names the session cost and the always-abort guarantee. Cancelling resolves `false` with
 *    zero wire calls — pinned by `transport` call counts in the spec.
 * 3. **Presence, never capacity.** The header states it, the export header repeats it, and each
 *    verdict's meaning row says whether it may be a feature claim at all (DR-062's closed rule:
 *    only `1002` reads unavailable; `1004`/`1005`/`1006`/unmapped are labelled non-claims).
 * 4. **The export is redaction-clean by construction, then scanned.** {@link buildExport} composes
 *    commands/verdicts/codes only — never device `message` prose, never the endpoint — and the F8
 *    guard (`scanText`, #70) has veto over the rendered text.
 *
 * ## Why no `useOperation` (same divergence the S4 console flagged for review)
 *
 * The hook already owns this call's lifecycle: in-flight join, rate limit, cache, the `1006` →
 * `listSessions()` affordance, and the typed `ProbeCommandsOutcome` this table renders. Wrapping it
 * in F2's triplet would collapse exactly the structure #77's acceptance names. The
 * notice/alert/status live-region contract is still honoured — one channel per fact class, fed from
 * the hook's view plus this container's refusal slot (guard refusals never reach the device and say
 * so in the same alert markup a device failure uses).
 *
 * ## Cache staleness is displayed, not hidden
 *
 * `cacheRemainingMs`/`cacheNote` come from the hook's view pass-through (PR #130): an answer backed
 * by the cache says so and for how long it stands; an inconclusive run says why it was never stored.
 * After any config change from this app the shared cache should be invalidated by the caller screen —
 * that wiring is S9's (#79), not this lane's.
 */
import { useMemo, useState } from 'react'
import type { FormEvent } from 'react'

import { useCapabilities } from '../../shared/use-capabilities'
import type { CapabilityClient } from '../../shared/use-capabilities'
import { ConfirmProvider, useConfirm } from '../../shared/use-confirm'
import { CapabilityPanelView } from './CapabilityPanelView'
import type { PanelFeatureRow, PanelSessionRow } from './CapabilityPanelView'
import { buildExport, candidateRows, parseCandidates, questionSetRefusal, summarize } from './capability-panel'
import type { QuestionSet } from './capability-panel'

/** The client surface this screen touches: the F5 wrapper's target plus nothing else. */
export type CapabilityPanelClient = CapabilityClient

export interface CapabilityPanelProps {
  readonly node: CapabilityPanelClient | undefined
  readonly proxyConfigured?: boolean
}

/** Deterministic probe-session name so `show configuration sessions` correlates with what this panel
 *  opened (and the name keeps the client's `ui-` prefix, `recoverOrphans()`'s default filter —
 *  capabilities.ts' header on `sessionName` explains why a non-`ui-` name would hide the orphan). */
const PROBE_SESSION = 'ui-webui-capabilities'

const PROXY_PROMPT = 'Local proxy is not configured. Set EAPI_HOST, EAPI_USER, and EAPI_PASS in arista-webui/.env.local, then restart Vite.'

export function CapabilityPanel(props: CapabilityPanelProps) {
  return <ConfirmProvider><CapabilityWorkspace {...props} /></ConfirmProvider>
}

function CapabilityWorkspace({ node, proxyConfigured = true }: CapabilityPanelProps) {
  const confirm = useConfirm()
  const [setName, setSetName] = useState('')
  const [setCommands, setSetCommands] = useState('')
  const [sets, setSets] = useState<readonly QuestionSet[]>([])
  const [notice, setNotice] = useState('')
  const [failure, setFailure] = useState('')
  const [exportState, setExportState] = useState<{ text?: string; blocked?: string }>({})

  const canAct = proxyConfigured && node !== undefined

  const featureProbeCommands = useMemo(
    () => Object.fromEntries(sets.map((set) => [set.name, set.commands])),
    [sets],
  )

  const capabilities = useCapabilities({
    ...(node === undefined ? { node: undefined } : { node }),
    featureProbeCommands,
    // The #123 knob: mount must never cost a session; `probe()` (button-driven, confirmed) is the
    // only trigger. Cache/throttle/lock affordances all stay armed.
    probeTrigger: 'manual',
    sessionName: PROBE_SESSION,
  })
  const view = capabilities.view
  const busy = view.status === 'probing'

  const connection = !canAct ? 'error' : busy ? 'connecting' : view.status === 'ready' ? 'connected' : view.status === 'failed' ? 'error' : 'connecting'
  const connectionLabel = !canAct
    ? 'Local proxy is not configured'
    : busy
      ? 'Probe in flight — a config session is open'
      : view.status === 'ready'
        ? `Device answered the probe (${view.lastProbeSource === 'cache' ? 'cache-backed, no session opened' : 'live probe session, aborted'})`
        : view.status === 'failed'
          ? 'The probe did not come back from the device'
          : 'Nothing sent yet — this panel never probes on its own'

  function addSet(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!canAct) return
    setNotice('')
    const commands = parseCandidates(setCommands)
    const refusal = questionSetRefusal(setName, commands, sets)
    if (refusal !== undefined) {
      // A form refusal is the same slot a device failure uses, and the call-count pins prove the
      // wire stayed silent: refusing here opens zero sessions (the issue's acceptance line).
      setFailure(refusal)
      return
    }
    const name = setName.trim()
    setSets((current) => [...current, { name, commands }])
    setSetName('')
    setSetCommands('')
    setExportState({})
    setNotice(`Question set ${JSON.stringify(name)} added (staging only — no session opened yet). Press the probe button when you want the device asked.`)
  }

  function removeSet(name: string) {
    if (!canAct || busy) return
    setSets((current) => current.filter((set) => set.name !== name))
    setExportState({})
    setNotice(`Question set ${JSON.stringify(name)} removed. The verdict table still shows what an earlier run answered.`)
  }

  async function runProbe(force: boolean) {
    if (!canAct || busy || sets.length === 0) return
    setFailure('')
    const candidateCount = sets.reduce((total, set) => total + set.commands.length, 0)
    const confirmed = await confirm({
      title: force ? 'Re-probe fresh: costs a config session' : 'Open the probe session',
      body: `A ${force ? 'forced ' : ''}probe asks the device ${String(candidateCount)} candidate command(s) from ${String(sets.length)} question set(s)${force ? ', ignoring any cached answer' : ' — a fresh cached answer would cost no session and run without asking'}. The client opens one named session (${PROBE_SESSION}), stages the candidates inside it, never commits, and aborts it on every path (DR-047/DR-063). It contends for the device\u2019s config lock while it lasts.`,
      confirmLabel: force ? 'Open a fresh probe session' : 'Open probe session and ask',
      destructive: false,
      subject: PROBE_SESSION,
    })
    if (!confirmed) {
      setNotice('Probe declined: no config session was opened and nothing reached the device.')
      return
    }
    setExportState({})
    await capabilities.probe({ force })
  }

  const features: readonly PanelFeatureRow[] = view.features.map((feature) => ({
    name: feature.name,
    display: feature.display,
    reason: feature.reason,
    candidates: candidateRows(feature.name, view.lastOutcome),
  }))

  const pendingSessions: readonly PanelSessionRow[] = view.pendingSessions.map((session) => ({
    name: session.name,
    state: session.state,
    description: session.description ?? '',
  }))

  function makeExport() {
    if (!canAct || view.lastOutcome === undefined) return
    const built = buildExport(view, sets)
    if (built.findings.length > 0) {
      const rules = [...new Set(built.findings.map((finding) => finding.rule))].join(', ')
      // The finding DETAILS may themselves name the offending token, so the panel reports rule
      // names and lets the operator inspect their own candidates — a leak cannot be plugged by
      // echoing it louder (F8, #70).
      setExportState({ blocked: `The F8 guard flagged ${String(built.findings.length)} finding(s) in this table (rules: ${rules}). Candidate commands are operator text too: remove the candidates carrying device identity (MACs, serials, credential-shaped words) and rebuild. Nothing was copied.` })
      return
    }
    setExportState({ text: built.text })
    setNotice('Export built: commands, verdicts and codes only. Clipboard copy is offered below; the text is also selected-visible for manual copy.')
  }

  async function copyExport() {
    if (exportState.text === undefined) return
    // No clipboard API is a real browser state (jsdom, older Safari), not an error: the honest
    // fallback is "select and copy", which the <pre> the operator can already see supports fully.
    const clipboard = typeof navigator === 'object' ? navigator.clipboard : undefined
    if (clipboard === undefined) {
      setNotice('This browser exposes no clipboard API — select the export text and copy it manually.')
      return
    }
    try {
      await clipboard.writeText(exportState.text)
      setNotice('Export copied to the clipboard — paste it straight into the DECISIONS/open-item note it came from.')
    } catch {
      setNotice('This browser refused clipboard access; select the export text and copy it manually.')
    }
  }

  async function abortPending(name: string) {
    if (!canAct || busy) return
    const confirmed = await confirm({
      title: 'Abort pending device session',
      body: `Abort pending device session ${name}? Its staged changes are discarded. A pending session holds the config lock, which is why probes keep answering 1006 until it is cleared.`,
      confirmLabel: 'Abort pending session',
      destructive: true,
      subject: name,
    })
    if (!confirmed) return
    setFailure('')
    await capabilities.abortPendingSessions()
  }

  return <CapabilityPanelView
    setName={setName}
    setCommands={setCommands}
    onNameChange={setSetName}
    onCommandsChange={setSetCommands}
    onAddSet={addSet}
    onRemoveSet={(name) => removeSet(name)}
    sets={sets}
    onProbe={() => void runProbe(false)}
    onReprobe={() => void runProbe(true)}
    onAbortPending={(name) => void abortPending(name)}
    onBuildExport={makeExport}
    onCopyExport={() => void copyExport()}
    busy={busy}
    canAct={canAct}
    {...(proxyConfigured ? {} : { proxyPrompt: PROXY_PROMPT })}
    notice={notice}
    // One alert channel: the container's zero-wire refusal slot first (it is the fresher fact),
    // then the hook's device failure — without this the throw arm's honest error text would
    // render nowhere.
    failure={failure !== '' ? failure : (view.failure ?? '')}
    probeStatus={view.status}
    fromCache={view.fromCache}
    suppressedCount={view.suppressedCount}
    {...(view.cacheNote === undefined ? {} : { cacheNote: view.cacheNote })}
    connection={connection}
    connectionLabel={connectionLabel}
    statusLine={summarize(view.lastOutcome)}
    features={features}
    configLocked={view.configLocked}
    pendingSessions={pendingSessions}
    {...(exportState.text === undefined ? {} : { exportText: exportState.text })}
    {...(exportState.blocked === undefined ? {} : { exportBlocked: exportState.blocked })}
  />
}
