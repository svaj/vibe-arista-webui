/**
 * `createFakeNode` — the device-facing half of the `./testing` seam (#61, epic #60 CAP-TESTING).
 *
 * This is what webui component tests render loading/error/empty states against (docs/TESTING.md §3):
 * a real `Node` over a real `MockTransport` — the production codec, id policy, enable framing,
 * resource registry and error mapping all run — scripted to answer like a device. The seam is
 * deliberately at the **device answers**, not at the Node methods: mock-ing `vlans.getAll()` in a
 * screen test asserts the test's own shape, but scripting
 * `{ 'show running-config all': { output: … } }` asserts the screen against the reply the client
 * will actually parse (the "a loud test failure, never an implicit `{}`" rule stays intact — an
 * unscripted command still throws `NotSupportedError` naming it).
 *
 * **Enable folding (DR-009):** every `Node` request starts with `enable` unless the caller passes
 * `sendEnable: false`, so the repo's transport-level script keys are the *joined wire list*
 * (`'enable\nshow running-config all'`). A `createFakeNode` script key is one **device command**;
 * the fold adds both sides of the framing: the key becomes `enable\n<command>`, and the reply gains
 * the `{}` enable slot at the front (the shape every existing suite scripts by hand, e.g.
 * `vlans.test.ts:96`). A raw-text `string` or a full `{result}/{error}` envelope passes through
 * untouched, because those already own the whole body. Multi-command batches (config-session
 * batches, `configure …` transactions) are **not** folded — `MockTransport` matches a text key by
 * exact join as well as by presence, and the fold cannot know a batch's re-entry commands, so the
 * joined text would silently never match. Script those on the returned `transport` with its
 * chainable API — `.replies`/`.rejects`/`.methodReplies`, keyed or predicated — exactly like
 * `config-session.test.ts` does. (This is also why there is no `rejects` map here: a failed WRITE
 * is always a multi-command configure batch. A failing READ can use `.rejects` on the transport.)
 *
 * Browser-safe (no `node:*`), because it is reachable from `src/testing/index.ts` — the subpath the
 * webui imports (DR-002; pinned by `browser-safety.test.ts`).
 */

import { Node } from '../command-layer'
import type { NodeSettings } from '../command-layer'
import type { CommandResult } from '../types/eapi'
import { mockTransport } from './mock-transport'
import type { MockReply, MockTransport, MockTransportOptions } from './mock-transport'

/**
 * Scripted device answers keyed by one **read** command (`show …`), enable framing folded in.
 * Writes and multi-step flows are scripted on the returned transport — see the header.
 */
export interface FakeNodeScript {
  readonly replies?: Readonly<Record<string, MockReply>>
}

export interface FakeNodeOptions {
  /** Passed to the `MockTransport` (a fixed `address` keeps generated session names assertable). */
  readonly transport?: MockTransportOptions
  /** Passed to the `Node` (e.g. `{ configDefaults: false }` to exercise the bare running-config spelling). */
  readonly settings?: NodeSettings
}

export interface FakeNode {
  readonly node: Node
  /** The transport under the node: chain more scripting onto it and assert via `sent()`/`bodies()`. */
  readonly transport: MockTransport
}

/** Refuse silently-*looks*-wrong keys instead of inventing a wire list the client never sends. */
function assertCommandKey(key: string, field: string): void {
  if (key.includes('\n')) {
    throw new TypeError(
      `createFakeNode: replies/rejects keys are ONE device command (the enable framing is folded; ` +
        `a '\\n' would silently double it). Script the multi-command ${field} batch on the returned ` +
        'transport instead — .replies(<joined wire list or predicate>, …), the config-session-test idiom.',
    )
  }
  if (key.trim() === '') {
    throw new TypeError(`createFakeNode: ${field} keys must name a command, not be empty.`)
  }
}

/**
 * Add enable's `{}` ack slot, per the repo's scripted-wire convention. Full envelopes and raw text
 * already describe the whole body, so they pass through verbatim.
 */
function foldEnable(reply: MockReply): MockReply {
  if (typeof reply === 'string') return reply
  if (Array.isArray(reply)) return [{}, ...(reply as readonly CommandResult[])]
  const record = reply as Record<string, unknown>
  if ('result' in record || 'error' in record) return reply
  return [{}, record as CommandResult]
}

/**
 * Build the offline device pair. With no script the node is still *correct*, just mute: every read
 * throws `NotSupportedError` naming the unscripted commands — that loud failure is the contract,
 * not a default to work around.
 */
export function createFakeNode(script: FakeNodeScript = {}, options: FakeNodeOptions = {}): FakeNode {
  const transport = mockTransport(options.transport ?? {})
  for (const [command, reply] of Object.entries(script.replies ?? {})) {
    assertCommandKey(command, 'replies')
    transport.replies(`enable\n${command}`, foldEnable(reply))
  }
  return { node: new Node(transport, options.settings ?? {}), transport }
}
