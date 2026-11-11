/**
 * S10 (#80): the static-route manager — container half, route `#/routes/static`.
 *
 * The plainest L3 surface in the screen wave because it needs no new show-model: the table is read
 * from the parsed `running-config all` capture through the config-backed `staticroute` resource
 * (wave-2, W2d #42), and every write is the standing named-session shape — `configSession()` →
 * `run()` → device `diff()` → confirm → commit, running-config only, `copy run start` never (DR-024),
 * abort always offered.
 *
 * ## Reads
 *
 * `node.staticroute.getAll()` is the only hard read (one `show running-config all`, DR-030 — the
 * client memoises the chunk per `Node`, so the table is not re-fetched per action). It answers flat
 * {@link StaticRoute} records grouped per destination (client divergence 2), which
 * {@link routesToViews} flattens into device order and flags with the two removal guards. The
 * identity chip is a soft `show version` read: its failure removes the chip and claims nothing.
 *
 * There is deliberately **no route viewer over `show ip route`**. #80 says why, and this screen
 * repeats it in its own copy: the client extracts no static routes from any RIB model, so nothing
 * here may claim a route is installed, active or working — the table is configured intent, and the
 * client's reader has known blind spots (`ip route vrf …`, `ipv6 route …`, a distance-less
 * `ip route` line: divergences 4/6), so "no rows" means "none readable", never "none configured".
 *
 * ## Writes — command text comes from the client's grammar, never from this file
 *
 * {@link stageRoute} in `./static-route-rules.ts` validates and composes every line, and its spec
 * pins the result against the real `StaticRouteResource` over the client's `mockTransport`:
 *
 * | action | staged line (fixed segment order, `staticroute.py:317-327` via `routeCommand`) |
 * | --- | --- |
 * | add | `ip route <dest> <hop> <distance> [tag N] [name X]` |
 * | remove | `no ip route …` — the WHOLE composed line prefixed, every segment from the read row (exact-match removal) |
 * | set tag / set name | a full replacement `ip route …` restating the segments the read saw, changing only the named field |
 *
 * The restatement is a deliberate divergence from the client's typed `setTag`/`setRouteName` (whose
 * own docstring warns that upstream resets whatever field it is not given, and whose spec pins the
 * SPARSE line). The leaf line is replaced whole device-side, so restating is the only way to change
 * one field without silently erasing the other; the pinned command text is the proof.
 *
 * ## Guards
 *
 * - **Field refusals are the client's mirrored** (`assertIpDest`/`assertNextHop`/
 *   `assertUnsignedSegment`/`assertRouteName`) and they cost zero sessions — the copy names each
 *   mirrored guard, and the two screen-only bounds (IPv4 octet/prefix arithmetic per DR-032, and the
 *   required distance) say plainly that they are this screen's rule, not the client's.
 * - **The two hard removal guards** (#80's own list): removing `0.0.0.0/0`, or removing a route whose
 *   next hop the read table itself spells as a default-route next hop. Both trip an in-form
 *   acknowledgement before Preview, a risk bullet in the review panel, the danger-tone commit control,
 *   and the F4 destructive confirm variant whose body repeats the exact `no ip route …` text. The
 *   candidate gateway set comes ONLY from the static-route table this screen fetched; the note says
 *   out loud that this page cannot see the interface table, the RIB, or where eAPI is served, so it
 *   flags a shared gateway and never promises the management path survives. Declining the confirm
 *   commits nothing.
 * - **Never a batched delete.** One staged line per session, enforced structurally (there is no
 *   multi-select on this screen), and the review panel shows the one line the device diff will explain.
 *
 * ## What #80 left out, and where that is written
 *
 * `default ip route …` (the client pins the text; upstream's docstring calls it "currently equivalent
 * to" `no ip route …`, which is an uncaptured EOS behaviour — M12 #14 — so this screen offers the
 * negation only); the optional next-hop-address **input** on the add form (not in #80's write list —
 * rows carrying one are still removed/replaced with the segment restated); any IPv6 form (no grammar
 * in `staticroute.ts`, and its refusal wording is the client's); tag/name CLEARING (no such verb in
 * this client); and no `useCapabilities` (F5) gate, for the reason S6 (#76) and S8 (#78) state —
 * every verb here is a config-backed M read/write with no version-conditional spelling in this client,
 * so staging an always-aborted probe session would cost a config session for no decision (DR-063).
 */
import { useState } from 'react'
import type { FormEvent } from 'react'
import type { CommandSpec, ConfigSession, Node, StaticRoute } from '@devhax-heavy-industries/arista-eapi'

import { identityFrom } from '../../shared/identity'
import type { DeviceIdentity } from '../../shared/identity'
import { softRead, softValue, useDeviceRead } from '../../shared/use-device-read'
import { useOperation } from '../../shared/use-operation'
import { ConfirmProvider, useConfirm } from '../../shared/use-confirm'
import { stageLines } from '../staged-batch'
import { StaticRoutesView } from './StaticRoutesView'
import type { StaticRouteRowView, StaticRoutesDraftView } from './StaticRoutesView'
import {
  EMPTY_ROUTE_FIELDS,
  gatewayCandidates,
  routeGuard,
  routeKey,
  routeLabel,
  stageRoute,
} from './static-route-rules'
import type { RouteAction, RouteFields, RouteRow } from './static-route-rules'

// The typed `show('version')` overload (the F-tier extension mechanism) — same import S6/S8 use so
// the identity read types end-to-end without a cast.
import '../../eapi/show-contracts'

export type StaticRoutesClient = Pick<Node, 'staticroute' | 'show' | 'configSession'>

export interface StaticRoutesProps {
  readonly node: StaticRoutesClient | undefined
  readonly proxyConfigured?: boolean
}

type Session = Pick<ConfigSession, 'name' | 'state' | 'run' | 'diff' | 'hasDiffBeenRead' | 'commit' | 'abort'>

interface PendingStage {
  readonly description: string
  readonly effectLabel: string
  readonly specs: readonly CommandSpec[]
  readonly display: readonly string[]
  readonly risks: readonly string[]
  readonly destructive: boolean
  /** The guard sentence repeated inside the F4 confirm, when the action tripped one. */
  readonly guardNote?: string
}

interface DraftState extends PendingStage {
  readonly session: Session
  readonly diff?: string
  readonly commitAttempted: boolean
}

const PROXY_PROMPT = 'Local proxy is not configured. Set EAPI_HOST, EAPI_USER, and EAPI_PASS in arista-webui/.env.local, then restart Vite.'
const COMMIT_RECOVERY = 'Commit was attempted; refresh device state before taking another action.'

/** The two sentences every staged write carries into the review panel: what the staged text is, and
 *  what "staged" means on a config session (it is not yet a change to running-config). */
const ONE_LINE_NOTE = 'This session stages exactly one route line: no batching, so the device diff below enumerates the whole change.'
const COMMIT_FRAME = 'The staged text is composed in the client’s fixed segment order (staticroute.py:317-327 via its private routeCommand) and is staged inside this named session — running-config changes only when this session commits, and startup-config is never written by this screen (DR-024).'

/** The session description verb per action — pinned verbatim by the screen test. */
const DESCRIPTION_VERB: Record<RouteAction, string> = {
  'add-route': 'add',
  'remove-route': 'remove',
  'set-tag': 'set-tag',
  'set-name': 'set-name',
}

/**
 * Flatten the client's per-destination map into table rows in device order, then attach each row's
 * guard. The candidate gateway set is built once per read, from the default-route rows of that read
 * only — that set is the entire evidence base for the shared-gateway claim (#80's guard).
 */
function routesToViews(routes: readonly StaticRoute[]): readonly StaticRouteRowView[] {
  const candidates = gatewayCandidates(routes)
  return routes.map((route) => {
    const guard = routeGuard(route, candidates)
    return {
      ...route,
      routeKey: routeKey(route),
      optionLabel: routeLabel(route),
      ...(guard === undefined ? {} : { guard }),
    }
  })
}

export function StaticRoutes(props: StaticRoutesProps) {
  return <ConfirmProvider><StaticRoutesWorkspace {...props} /></ConfirmProvider>
}

function StaticRoutesWorkspace({ node, proxyConfigured = true }: StaticRoutesProps) {
  const confirm = useConfirm()
  const operation = useOperation()
  const { busy, notice, failure } = operation
  const canAct = proxyConfigured && node !== undefined

  const [fields, setFields] = useState<RouteFields>(EMPTY_ROUTE_FIELDS)
  const [formError, setFormError] = useState<string | undefined>(undefined)
  const [ack, setAck] = useState(false)
  const [draft, setDraft] = useState<DraftState | undefined>(undefined)

  const read = useDeviceRead<{ routes: readonly StaticRoute[]; identity?: DeviceIdentity }>(
    async () => {
      if (node === undefined) throw new Error('no device client')
      const grouped = await node.staticroute.getAll()
      const routes: StaticRoute[] = []
      for (const bucket of grouped.values()) routes.push(...bucket)
      // Silent fold (the S6/S8 identity-chip shape): a failed version read removes the chip and
      // claims nothing — it never blanks the route table the config read DID answer.
      const versionRead = await softRead(node.show('version'), { silent: true })
      const version = softValue(versionRead)
      return { routes, ...(version === undefined ? {} : { identity: identityFrom(version) }) }
    },
    [node],
    { enabled: canAct, disabledMessage: '' },
  )

  const data = read.state.kind === 'ready' ? read.state.data : undefined
  const rows = data === undefined ? [] : routesToViews(data.routes)
  const readRows: readonly RouteRow[] = data?.routes ?? []

  // A blank `routeKey` means "nothing chosen yet"; the first readable row answers it so the select is
  // never rendered in a state the operator cannot act on.
  const activeFields: RouteFields = fields.routeKey === '' && rows.length > 0 ? { ...fields, routeKey: rows[0].routeKey } : fields
  const selectedRow = rows.find((row) => row.routeKey === activeFields.routeKey)
  const guardNote = fields.action === 'remove-route' ? selectedRow?.guard?.note : undefined
  const ackRequired = guardNote !== undefined
  const draftOpen = draft !== undefined

  function changeFields(next: RouteFields): void {
    setFields(next)
    setFormError(undefined)
    // Acknowledging a guard is tied to the thing being acknowledged: changing the action or the
    // selected route withdraws it.
    if (next.action !== fields.action || next.routeKey !== fields.routeKey) setAck(false)
  }

  function risksFor(action: RouteAction, target: RouteRow | undefined, guardNoteText: string | undefined): readonly string[] {
    const shared = [COMMIT_FRAME, ONE_LINE_NOTE]
    const guard = guardNoteText === undefined ? [] : [guardNoteText]
    if (action === 'add-route') {
      return [...guard, ...shared, 'This form offers no next-hop-address segment (#80’s write list omits it), so a route written from here always uses the exit form you typed. Whether the prefix/next-hop pair is acceptable on this build is the device’s answer — the client’s guards cover only what its reader could never echo back.', 'A route written from here is only re-listable if this client’s reader can parse it: a VRF-scoped or IPv6 line, or one the device rewrites into a shape the grammar misses, would leave this table unable to show it (divergences 4/6).']
    }
    if (action === 'remove-route') {
      return [...guard, ...shared, `Exact-match removal: every segment below comes from the row this read answered (${target === undefined ? '' : routeLabel(target)}) in the client\u2019s fixed order. The reader\u2019s grammar is end-open and the tag/name segments are optional, so a config line carrying text this client does not model is not byte-reproducible from here \u2014 read the device diff below before committing; it is the evidence of which line the removal actually addressed.`]
    }
    return [...guard, ...shared, 'EOS replaces the whole leaf line, so this replacement restates every segment the read produced and changes only the named field. The client\u2019s own set_tag/set_route_name do not do that \u2014 their docstring warns that a field left out is reset by the call \u2014 and their spec pins the sparse line; staging the sparse form here would silently drop the other field.']
  }

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    setFormError(undefined)
    if (!canAct || node === undefined) return
    if (draftOpen) {
      setFormError('A staged session is already open on this screen; commit or abort it before staging another change.')
      return
    }
    const outcome = stageRoute(activeFields, readRows)
    if ('refusal' in outcome) {
      setFormError(outcome.refusal)
      return
    }
    const { intent } = outcome
    const destructive = intent.guard !== undefined
    const actionLabel: Record<RouteAction, string> = {
      'add-route': 'add',
      'remove-route': `remove ${intent.row === undefined ? '' : `${intent.row.ipDest} via ${intent.row.nextHop}`.trim()}`,
      'set-tag': `set tag on ${intent.row?.ipDest ?? ''} via ${intent.row?.nextHop ?? ''}`,
      'set-name': `set name on ${intent.row?.ipDest ?? ''} via ${intent.row?.nextHop ?? ''}`,
    }
    const specs: readonly CommandSpec[] = [intent.command]
    const stage: PendingStage = {
      description: `webui static-route ${DESCRIPTION_VERB[fields.action]}`,
      effectLabel: actionLabel[fields.action],
      specs,
      display: stageLines(specs),
      risks: risksFor(fields.action, intent.row, intent.guard?.note),
      destructive,
      ...(intent.guard === undefined ? {} : { guardNote: intent.guard.note }),
    }
    void preview(stage)
  }

  async function preview(stage: PendingStage) {
    if (busy || !canAct || node === undefined || draftOpen) return
    await operation.run(async () => {
      const session = await node.configSession({ description: stage.description })
      const handle: Session = session
      setDraft({ ...stage, session: handle, commitAttempted: false })
      await handle.run(stage.specs)
      const diff = await handle.diff()
      setDraft({ ...stage, session: handle, diff, commitAttempted: false })
      return diff
    }, {
      progress: 'Staging the route line and reading the device diff…',
      success: 'Review the device diff before committing this change.',
    })
  }

  /** The F4 body. #80's acceptance line "delete shows the exact route string in the confirm" is this
   *  first sentence; a tripped guard repeats its own sentence verbatim. */
  function commitBody(draftState: DraftState): string {
    const parts = [
      `Commit session ${draftState.session.name}? The exact command this session stages is: ${draftState.display.join(' · ')}. This changes running-config only; startup-config is never written by this screen (DR-024).`,
    ]
    if (draftState.guardNote !== undefined) parts.push(`Guard repeated: ${draftState.guardNote}`)
    parts.push('If this session is lost mid-commit, the change may still have applied — reconnect and refresh before any further action.')
    return parts.join(' ')
  }

  async function commitDraft() {
    if (busy || draft === undefined || draft.diff === undefined || !draft.session.hasDiffBeenRead() || draft.commitAttempted) return
    const label = draft.effectLabel
    if (!await confirm({
      title: draft.destructive ? `Confirm: ${label}` : 'Commit to running-config',
      body: commitBody(draft),
      confirmLabel: draft.destructive ? `Commit despite the guard: ${label}` : 'Commit to running-config',
      destructive: true,
      subject: `${draft.session.name} \u00b7 ${draft.display.join(' ')}`,
    })) return
    setDraft({ ...draft, commitAttempted: true })
    const committed = await operation.run(() => draft.session.commit(), {
      progress: 'Committing the reviewed change to running-config\u2026',
      success: 'Changes committed to running-config. Startup-config was not changed.',
      failureSuffix: COMMIT_RECOVERY,
    })
    if (committed.ok) {
      setDraft(undefined)
      setFields(EMPTY_ROUTE_FIELDS)
      setAck(false)
      read.reload() // #80: a committed route changes the table AND the gateway-candidate set — re-read both.
    }
  }

  async function abortDraft() {
    if (busy || draft === undefined || (draft.session.state !== 'open' && draft.session.state !== 'diffed')) return
    if (!await confirm({ title: 'Abort staged changes', body: `Abort staged changes in session ${draft.session.name}? Its staged ${draft.display.join(' · ')} will be discarded and nothing reaches running-config.`, confirmLabel: 'Abort staged changes', destructive: true, subject: draft.session.name })) return
    const aborted = await operation.run(async () => {
      await draft.session.abort()
      setDraft(undefined)
      setAck(false)
      return draft.session.name
    }, { success: `Session ${draft.session.name} was aborted; nothing was written to the device.` })
    if (aborted.ok) read.reload()
  }

  const draftView: StaticRoutesDraftView | undefined = draft === undefined ? undefined : {
    sessionName: draft.session.name,
    effectLabel: draft.effectLabel,
    batch: draft.display,
    risks: draft.risks,
    ...(draft.diff === undefined ? {} : { diff: draft.diff }),
    canCommit: draft.diff !== undefined && draft.session.hasDiffBeenRead() && !draft.commitAttempted,
    destructive: draft.destructive,
  }

  const state = !canAct || read.state.kind === 'error' ? 'failed' : read.state.kind === 'loading' ? 'loading' : 'ready'

  return <StaticRoutesView
    state={state}
    {...(read.state.kind === 'error' && read.state.message !== '' ? { readError: read.state.message } : {})}
    {...(proxyConfigured ? {} : { proxyPrompt: PROXY_PROMPT })}
    {...(data?.identity === undefined ? {} : { identity: data.identity })}
    rows={rows}
    tableKnown={data !== undefined}
    fields={activeFields}
    onFieldsChange={changeFields}
    onPreview={submit}
    onCommit={() => void commitDraft()}
    onAbortDraft={() => void abortDraft()}
    onReload={() => { setFormError(undefined); setAck(false); read.reload() }}
    ack={ack}
    onAckChange={(next: boolean) => { setAck(next); setFormError(undefined) }}
    ackRequired={ackRequired}
    {...(guardNote === undefined ? {} : { guardNote })}
    {...(formError === undefined ? {} : { formError })}
    {...(draftView === undefined ? {} : { draft: draftView })}
    busy={busy}
    canAct={canAct && state === 'ready'}
    notice={notice}
    failure={failure}
    connection={!canAct || state === 'failed' ? 'error' : state === 'loading' || busy ? 'connecting' : 'connected'}
    connectionLabel={!canAct
      ? 'Local proxy is not configured'
      : state === 'loading'
        ? 'Reading the running-config…'
        : state === 'failed'
          ? 'The static-route read did not come back'
          : 'Static routes read from the parsed running-config'}
  />
}
