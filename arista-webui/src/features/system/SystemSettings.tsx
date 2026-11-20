/**
 * S8 (#78): the system settings screen — hostname, `ip routing`, and the EOF-terminated banners,
 * staged exactly the way the rest of the screen wave writes: named session → device `diff()` →
 * confirm → commit, startup-config never touched (DR-024), abort always offered.
 *
 * ## Reads
 *
 * `node.system.get()` (M8, §5 rows 83-90) is the single hard read; it is parsed config, not a
 * show-model, so the loading/failure copy names the source. The identity chip is a soft
 * `show version` read — its failure removes the chip and claims nothing (F3 contract).
 *
 * ## Guards — client policy, labelled as such, device as referee
 *
 * `hostnameRule` / `bannerFraming` (./system-rules.ts) mirror the client's `assertHostname` /
 * `assertBannerBody` and refuse IN-FORM, before any session opens (the #78 acceptance line that
 * the banner payload must be byte-exact, `input: <body>\nEOF\n`, is produced there and pinned
 * here at the session's `run()` argv). Every refusal message says "this client refuses…": those
 * rules are unverified on hardware (DR-057, §5 row 89 — pyeapi validates nothing at
 * system.py:118-134), and a write the client allowed but the CLI rejects renders as the device's
 * own `CommandError`.
 *
 * ## The one guard the issue grades as hard
 *
 * `no ip routing` (like a hostname removal) reaches the commit only after `preview` has put the
 * risk sentence in the panel AND the F4 confirm repeats it: turning routed reachability off can
 * drop the eAPI path this UI rides if that path is routed — the client cannot see the interface
 * table from this screen, so the copy says "if", and the device's answer stays the referee. The
 * routing pill reads from the parsed config only (absence of both lines means ON, upstream's
 * default kept by `ipRoutingFromConfig`).
 *
 * ## Banners
 *
 * Bodies render as `<pre>` text, never HTML (§78 acceptance), and the Set/Remove vocabulary per
 * kind comes from `BANNER_KINDS` — the closed set `assertBannerKind` enforces, because pyeapi
 * interpolates `banner %s` unguarded (system.py:171). Overwriting an existing body is allowed
 * but named in the risks; the device diff is the evidence of what it replaces. `exec` is a
 * this-client extension over the chunker's sections (login/motd upstream); the note lives in the
 * view copy.
 *
 * No `useCapabilities` here: #78 names no probe-gated vocabulary — hostname/ip-routing/banners
 * are config-backed M verbs, and staging an always-aborted probe session with no decision attached
 * is what DR-063's rule exists to avoid (same stated absence as S6, #76).
 */
import { useState } from 'react'
import type { FormEvent } from 'react'
import type { CommandSpec, Node, SystemSettings as DeviceSettings } from '@devhax-heavy-industries/arista-eapi'

import { softRead, softValue, useDeviceRead } from '../../shared/use-device-read'
import type { DeviceIdentity } from '../../shared/identity'
import { identityFrom } from '../../shared/identity'
import { useOperation } from '../../shared/use-operation'
import { ConfirmProvider } from '../../shared/use-confirm'
import { TransactionScope, useTransaction, useTransactionSnapshot } from '../sessions/TransactionContext'
import { stageDisplay } from '../staged-batch'
import { SystemSettingsView } from './SystemSettingsView'
import type { BannerRowView } from './SystemSettingsView'
import { BANNER_KINDS, BANNER_LABEL, bannerFraming, hostnameRule } from './system-rules'
import type { BannerKind } from './system-rules'

// The typed `show('version')` overload (the F-tier extension mechanism) — same import S6 uses so
// the identity read types end-to-end without a cast.
import '../../eapi/show-contracts'

export type SystemSettingsClient = Pick<Node, 'system' | 'show' | 'configSession'>

export interface SystemSettingsProps {
  readonly node: SystemSettingsClient | undefined
  readonly proxyConfigured?: boolean
}

type DraftKind =
  | { readonly action: 'set-hostname' }
  | { readonly action: 'remove-hostname' }
  | { readonly action: 'routing'; readonly enable: boolean }
  | { readonly action: 'set-banner'; readonly kind: BannerKind }
  | { readonly action: 'remove-banner'; readonly kind: BannerKind }

interface PendingStage {
  readonly action: DraftKind
  readonly description: string
  readonly effectLabel: string
  readonly specs: readonly CommandSpec[]
  readonly display: readonly string[]
  readonly risks: readonly string[]
  readonly destructive: boolean
}

const PROXY_PROMPT = 'Local proxy is not configured. Set EAPI_HOST, EAPI_USER, and EAPI_PASS in arista-webui/.env.local, then restart Vite.'

export function SystemSettings(props: SystemSettingsProps) {
  return <TransactionScope node={props.node}><ConfirmProvider><SystemWorkspace {...props} /></ConfirmProvider></TransactionScope>
}

function SystemWorkspace({ node, proxyConfigured = true }: SystemSettingsProps) {
  const operation = useOperation()
  const { busy, notice, failure } = operation
  const transaction = useTransaction()
  const transactionState = useTransactionSnapshot()
  const transactionBusy = transactionState.status === 'opening' || transactionState.status === 'staging' || transactionState.status === 'committing' || transactionState.status === 'aborting'
  const canAct = proxyConfigured && node !== undefined && transaction !== undefined && transactionState.status !== 'uncertain'

  const [hostnameDraft, setHostnameDraft] = useState('')
  const [hostnameError, setHostnameError] = useState<string | undefined>(undefined)
  const [bannerDrafts, setBannerDrafts] = useState<Record<BannerKind, string>>({ login: '', motd: '', exec: '' })
  const [bannerErrors, setBannerErrors] = useState<Partial<Record<BannerKind, string>>>({})

  const read = useDeviceRead<{ settings: DeviceSettings; identity?: DeviceIdentity }>(
    async () => {
      if (node === undefined) throw new Error('no device client')
      const settings = await node.system.get()
      // Silent fold (the SwitchManager identity-chip shape): a failed version read removes the
      // chip and claims nothing, it never blanks the settings the config read DID answer.
      const versionRead = await softRead(node.show('version'), { silent: true })
      const version = softValue(versionRead)
      return { settings, ...(version === undefined ? {} : { identity: identityFrom(version) }) }
    },
    [node],
    { enabled: canAct, disabledMessage: '' },
  )
  const data = read.state.kind === 'ready' ? read.state.data : undefined
  const settings = data?.settings

  function clearErrors() {
    setHostnameError(undefined)
    setBannerErrors({})
    operation.clear()
  }

  function plan(stage: PendingStage): void {
    void preview(stage)
  }

  async function preview(stage: PendingStage) {
    if (busy || transactionBusy || !canAct || transaction === undefined) return
    await operation.run(() => transaction.append({
      source: '/system',
      action: stage.effectLabel,
      commands: stage.specs,
      display: stage.display,
      risks: stage.risks,
    }), {
      progress: 'Adding the change to the shared transaction and reading the device diff…',
      success: 'System change added to the transaction. Review the combined diff in Transaction Center.',
    })
  }

  /** One entry point for every control: form guards first (zero sessions), then stage. */
  function begin(request: DraftKind) {
    clearErrors()
    if (!canAct || node === undefined) return
    if (settings === undefined) {
      operation.run(async () => { throw new Error('The system read has not answered, so nothing can be compared or staged against it.') }).catch(() => undefined)
      return
    }

    if (request.action === 'set-hostname') {
      const value = hostnameDraft.trim()
      const guarded = hostnameRule(value) ?? (value === settings.hostname
        ? `${value} is already the running-config hostname — staging an identical line opens a session that would change nothing.`
        : undefined)
      if (guarded !== undefined) { setHostnameError(guarded); return }
      plan({
        action: request,
        description: 'webui system set hostname',
        effectLabel: `hostname \u2192 ${value}`,
        specs: [`hostname ${value}`],
        display: stageDisplay([`hostname ${value}`]),
        risks: [
          `The device section will re-read as ${value} after commit; the identity chip refreshes from show version. Hostnames the CLI dislikes are this client\u2019s unverified policy (DR-057, \u00a75 row 89) \u2014 the CommandError is the referee.`,
        ],
        destructive: false,
      })
      return
    }
    if (request.action === 'remove-hostname') {
      if (settings.hostname === '') { setHostnameError('There is no hostname line in the parsed running-config \u2014 there is nothing to remove.'); return }
      plan({
        action: request,
        description: 'webui system remove hostname',
        effectLabel: `removes hostname (currently ${settings.hostname})`,
        specs: ['no hostname'],
        display: stageDisplay(['no hostname']),
        risks: ['Removing the hostname makes this client read the section as UNSET (pyeapi would invent \'localhost\' \u2014 divergence \u00a75 row 83, kept in the client\'s favour). The header identity needs a refresh to say what the device now answers.'],
        destructive: false,
      })
      return
    }
    if (request.action === 'routing') {
      if (settings.ipRouting === request.enable) {
        operation.run(async () => { throw new Error(`IP routing is already ${request.enable ? 'on' : 'off'} in the parsed config — staging \`${request.enable ? 'ip routing' : 'no ip routing'}\` opens a session that would change nothing.`) }).catch(() => undefined)
        return
      }
      const line = request.enable ? 'ip routing' : 'no ip routing'
      plan({
        action: request,
        description: `webui system ${request.enable ? 'enable' : 'disable'} ip routing`,
        effectLabel: line,
        specs: [line],
        display: stageDisplay([line]),
        risks: request.enable
          ? ['Enabling routed forwarding changes reachability device-wide; the concrete interfaces affected are only visible in the S6 addressing screen — this screen claims nothing about them.']
          : [
            'no ip routing can drop routed reachability — and if this UI\u2019s eAPI path rides a routed interface (it reads as proxied through the Vite dev server here; the device names its own serving interfaces on the S6/S1 screens), this page may lose its device path mid-session. The screen cannot see the interface table from here, so it says IF, not IS.',
            'What the device does to forwarding/routing state around the toggle is uncaptured on this unit (M12 #14): only its diff() is evidence here.',
          ],
        destructive: !request.enable,
      })
      return
    }

    const kind = request.kind
    if (request.action === 'set-banner') {
      const framed = bannerFraming(kind, bannerDrafts[kind])
      if ('refusal' in framed) { setBannerErrors((current) => ({ ...current, [kind]: framed.refusal })); return }
      const current = settings.banner[kind]
      if (current !== undefined && current === framed.body) {
        setBannerErrors((current2) => ({ ...current2, [kind]: `The ${kind} banner already holds exactly this body in the parsed config — staging it again opens a session that would change nothing. Use Remove to take it out.` }))
        return
      }
      const specs: readonly CommandSpec[] = [{ cmd: `banner ${kind}`, input: framed.input }]
      plan({
        action: request,
        description: `webui system set ${kind} banner`,
        effectLabel: `banner ${kind} (multiline, EOF-terminated)`,
        specs,
        display: stageDisplay(specs),
        risks: current === undefined
          ? ['This is a new EOF-terminated block; the stored input is byte-for-byte the framed payload below, which assertBannerBody pre-cleared of early terminators, CR, and blank bodies.']
          : [`A ${kind} block already exists (${countLines(current)} line(s)); the commit replaces it wholesale, and the device diff names the old text — this screen does not merge banner bodies.`],
        destructive: current !== undefined,
      })
      return
    }
    // remove-banner
    if (settings.banner[kind] === undefined) {
      setBannerErrors((current) => ({ ...current, [kind]: `The running-config carries no banner ${kind} block for this client\u2019s reader — there is nothing to remove. (A block terminated only by end-of-file without the EOF line reads as no banner in upstream pyeapi; §5 row 86.)` }))
      return
    }
    plan({
      action: request,
      description: `webui system remove ${kind} banner`,
      effectLabel: `no banner ${kind}`,
      specs: [`no banner ${kind}`],
      display: stageDisplay([`no banner ${kind}`]),
      risks: [`The ${kind} block disappears device-side and the reader's ${kind} key with it. Banner content people log in reading: make sure the removal is intended, not a placeholder cleanup.`],
      destructive: true,
    })
  }

  const bannerRows: readonly BannerRowView[] = BANNER_KINDS.map((kind) => {
    const body = settings?.banner[kind]
    return {
      kind,
      label: BANNER_LABEL[kind],
      present: body !== undefined,
      ...(body === undefined ? {} : { body }),
      draft: bannerDrafts[kind],
      ...(bannerErrors[kind] === undefined ? {} : { draftError: bannerErrors[kind] }),
      currentLabel: body === undefined
        ? (settings === undefined ? 'no system read has answered yet' : `no banner ${kind} block in the parsed running-config`)
        : body === ''
          ? 'present with an empty body (the chunker saw the EOF-terminated block; \u00a75 row 87 \u2014 upstream reads this as no banner at all)'
          : `present (${String(countLines(body))} line(s), exactly as the device wrote it between the opener and EOF)`,
      onDraftChange: (value: string) => { setBannerDrafts((current) => ({ ...current, [kind]: value })) },
      onSet: () => begin({ action: 'set-banner', kind }),
      onRemove: () => begin({ action: 'remove-banner', kind }),
    }
  })

  const state = !canAct || read.state.kind === 'error' ? 'failed' : read.state.kind === 'loading' ? 'loading' : 'ready'

  return <SystemSettingsView
    state={state}
    {...(read.state.kind === 'error' && read.state.message !== '' ? { readError: read.state.message } : {})}
    {...(proxyConfigured ? {} : { proxyPrompt: PROXY_PROMPT })}
    {...(data?.identity === undefined ? {} : { identity: data.identity })}
    hostname={settings?.hostname ?? ''}
    hostnameKnown={settings !== undefined}
    hostnameDraft={hostnameDraft}
    {...(hostnameError === undefined ? {} : { hostnameError })}
    onHostnameDraftChange={(value) => { setHostnameDraft(value); setHostnameError(undefined) }}
    onSetHostname={(event: FormEvent<HTMLFormElement>) => { event.preventDefault(); begin({ action: 'set-hostname' }) }}
    onRemoveHostname={() => begin({ action: 'remove-hostname' })}
    ipRouting={settings?.ipRouting ?? true}
    routingKnown={settings !== undefined}
    onRouting={(enable: boolean) => begin({ action: 'routing', enable })}
    banners={bannerRows}
    busy={busy || transactionBusy}
    canAct={canAct && state === 'ready'}
    notice={notice}
    failure={failure}
    connection={!canAct || state === 'failed' ? 'error' : state === 'loading' || busy || transactionBusy ? 'connecting' : 'connected'}
    connectionLabel={!canAct
      ? 'Local proxy is not configured'
      : state === 'loading'
        ? 'Reading the running-config\u2026'
        : state === 'failed'
          ? 'The system read did not come back'
          : 'System settings read from the parsed running-config'}
    onReload={() => { clearErrors(); read.reload() }}
  />
}

function countLines(body: string): number {
  return body === '' ? 0 : body.split('\n').length
}
