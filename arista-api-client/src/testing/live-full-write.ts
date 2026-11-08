/**
 * `live-full-write.ts` — the wiring half of the DR-126 **full-write lab** lane (#14 D2).
 *
 * Every `test/system/*` port that mutates anything beyond the scratch interface/VLAN must (a) carry
 * the `EAPI_LAB_FULL_WRITE=1` consent, (b) run only against the `lab` target class, and (c) route its
 * batches through `withLabWriteScope` so the self-lockout set (listener, built-in/in-use users,
 * management path, `copy run start`) is refused **before the wire**. Doing those three per suite is
 * how one suite forgets the fence; this module is the single place a live suite builds its `Node`.
 *
 * Node-only by construction: it instantiates the transport through `createTransport` from
 * `./node.ts` (the TLS trust material from the guard is `./node`-entry business, DR-013). This file
 * is NOT re-exported from any barrel (`./testing` stays browser-safe — DR-002), exactly like
 * `live-guard.ts` and `live-session-policy.ts`, which suites import by path (src/testing/README.md).
 *
 * The offline test (`live-full-write.test.ts`) injects a `MockTransport` via the `transport`
 * override and drives a real resource facade (`node.vlans`) through the wrapper — that is the
 * fence firing through the choke point, end to end, with no device and no container (DR-034).
 */

import { Node } from '../command-layer'
import { createTransport } from '../node'
import { withLabWriteScope } from './live-session-policy'
import { liveTransportOptions, requireLabFullWrite, resolveLiveEnv, type LiveEnv, type LiveResolution, type LiveTarget } from './live-guard'
import type { Transport } from '../transports/contract'

/** The gate a full-write live suite checks once, at module load, before any `describe.skipIf`. */
export interface FullWriteReadiness {
  readonly runnable: boolean
  /** Printed as the loud skip line when `runnable` is false (DR-034: a silent skip is the failure mode). */
  readonly skipReason?: string | undefined
  /** The accepted resolution, for the suite to `unwrapLiveTarget` in its `beforeAll`. */
  readonly resolution: LiveResolution
}

/**
 * `resolveLiveEnv` + the DR-126 consent, composed: refuse loudly and in the right order (env first —
 * an unaccepted endpoint is never rescued by the flag — then class, then consent).
 */
export function liveFullWriteReadiness(env: LiveEnv): FullWriteReadiness {
  const resolution = resolveLiveEnv(env)
  if (!resolution.ok) return { runnable: false, resolution, skipReason: resolution.reason }
  const consent = requireLabFullWrite(resolution, env)
  if (consent !== undefined) return { runnable: false, resolution, skipReason: consent.reason }
  return { runnable: true, resolution }
}

/**
 * Build the suite's `Node`: `createTransport` over the guard-accepted options, wrapped in
 * `withLabWriteScope` bound to *this run's* username, then the command layer over it. `Node` is
 * constructed directly (not `createNode`) because the seam must sit between them: every verb —
 * `configure`, `configSession`, and every resource facade built on either — passes the fence there.
 *
 * `options.transport` replaces the built transport (the offline test hands in a `MockTransport`);
 * the scope wrapper is applied either way, so the tested path and the live path are the same graph.
 */
export function buildFullWriteNode(target: LiveTarget, options: { transport?: Transport } = {}): Node {
  const transport = options.transport ?? createTransport(liveTransportOptions(target))
  return new Node(withLabWriteScope(transport, { username: target.username }))
}
