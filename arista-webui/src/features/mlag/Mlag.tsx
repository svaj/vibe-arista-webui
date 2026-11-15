/**
 * S14 (#84): the READ-ONLY MLAG status screen — route `#/mlag`. Container half of the standing
 * S8 (#78) split: it owns the two reads and nothing else. There is deliberately NO write path,
 * no config session, no confirm flow on this screen: MLAG configuration needs a PAIRED device
 * (#84 closes editing outright), so the container imports no `configSession` seam and the view
 * renders a standing banner saying configuration editing is not offered.
 *
 * ## Reads (and which may fail without blanking the screen)
 *
 * - {@link MlagResource.get} (`node.mlag.get()`, client `resources/mlag.ts`, W2d/#43) is the
 *   HARD read: parsed running-config (`mlag configuration` section + `interface Po…` blocks).
 *   Its failure is the error branch; its empty answer (no section, no interfaces — the
 *   documented divergence-1 shape) is a NORMAL ready payload rendered as “MLAG is not
 *   configured”, never an error.
 * - `node.show('mlag')` is a SOFT read through `softRead`/`softErrorText`: the capture-backed
 *   `ShowMlagReply` (`src/eapi/show-contracts.ts`). Unanswered or rejected — e.g. an
 *   `Error [1002]` refusal — folds its device text into the payload so the status pill renders
 *   UNKNOWN with that verbatim reason; it never throws the screen into the error branch.
 * - `node.show('version')` is a silent soft read for the identity chip only (Ntp/S6 pattern).
 *
 * The status pill maps ONLY the `state` key the capture actually models (see ./mlag-rules.ts and
 * the CAPTURES note in the view); the config fields render exactly the five names
 * `MlagGlobalConfig` carries. Four states: loading, ready-configured, ready-unconfigured, error
 * (plus the no-proxy arm every screen must show).
 */
import type { MlagGlobalConfig, MlagInterface, Node } from '@devhax-heavy-industries/arista-eapi'

import { softErrorText, softRead, softValue, useDeviceRead } from '../../shared/use-device-read'
import type { DeviceIdentity } from '../../shared/identity'
import { identityFrom } from '../../shared/identity'
import { MlagView } from './MlagView'
import { deviceStateView, isMlagUnconfigured } from './mlag-rules'

// The typed `show('mlag')` / `show('version')` overloads — same augmentation S5/S6/S12 import.
import '../../eapi/show-contracts'
import type { ShowMlagReply } from '../../eapi/show-contracts'

/** The two model reads plus nothing else — the type itself cannot reach a config session. */
export type MlagClient = Pick<Node, 'mlag' | 'show'>

export interface MlagProps {
  readonly node: MlagClient | undefined
  readonly proxyConfigured?: boolean
}

interface ReadData {
  readonly config: MlagGlobalConfig
  /** Interfaces half in device order (Map iteration = insertion order, resources/mlag.ts). */
  readonly interfaces: readonly MlagInterface[]
  /** Present only when the soft `show mlag` read answered; absence pairs with `showFailure`. */
  readonly show?: ShowMlagReply
  /** Folded failure text of the soft `show mlag` read (verbatim device/client message). */
  readonly showFailure?: string
  readonly identity?: DeviceIdentity
}

const PROXY_PROMPT = 'Local proxy is not configured. Set EAPI_HOST, EAPI_USER, and EAPI_PASS in arista-webui/.env.local, then restart Vite.'

export function Mlag({ node, proxyConfigured = true }: MlagProps) {
  const canAct = proxyConfigured && node !== undefined

  const read = useDeviceRead<ReadData>(
    async () => {
      if (node === undefined) throw new Error('no device client')
      // The hard read first: an unconfigured answer here is the screen's primary normal state.
      const state = await node.mlag.get()
      const showRead = await softRead(node.show('mlag'))
      const versionRead = await softRead(node.show('version'), { silent: true })
      const showData = softValue(showRead)
      const version = softValue(versionRead)
      return {
        config: state.config,
        interfaces: [...state.interfaces.values()],
        ...(showData === undefined
          ? { showFailure: softErrorText(showRead) ?? 'The `show mlag` read did not answer.' }
          : { show: showData }),
        ...(version === undefined ? {} : { identity: identityFrom(version) }),
      }
    },
    [node],
    { enabled: canAct, disabledMessage: '' },
  )

  const data = read.state.kind === 'ready' ? read.state.data : undefined
  const unconfigured = data !== undefined && isMlagUnconfigured(data.config, data.interfaces.length)
  const state = !canAct || read.state.kind === 'error' ? 'failed' : read.state.kind === 'loading' ? 'loading' : 'ready'

  return <MlagView
    state={state}
    {...(read.state.kind === 'error' && read.state.message !== '' ? { readError: read.state.message } : {})}
    {...(proxyConfigured ? {} : { proxyPrompt: PROXY_PROMPT })}
    {...(data?.identity === undefined ? {} : { identity: data.identity })}
    {...(data === undefined ? {} : { status: deviceStateView(data.show, data.showFailure) })}
    configKnown={data !== undefined}
    {...(data === undefined ? {} : { config: data.config })}
    interfaces={data?.interfaces ?? []}
    unconfigured={unconfigured}
    {...(data?.show === undefined ? {} : { show: data.show })}
    canAct={canAct}
    connection={!canAct || state === 'failed' ? 'error' : state === 'loading' ? 'connecting' : 'connected'}
    connectionLabel={!canAct
      ? 'Local proxy is not configured'
      : state === 'loading'
        ? 'Reading MLAG state\u2026'
        : state === 'failed'
          ? 'The MLAG config read did not come back'
          : 'Reads served: parsed running-config plus the captured show mlag reply'}
    onReload={() => read.reload()}
  />
}
