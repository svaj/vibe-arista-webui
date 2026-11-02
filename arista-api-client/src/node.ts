/**
 * `@devhax-heavy-industries/arista-eapi/node` — Node-only entry point (DR-002).
 *
 * M0 skeleton (#2). This entry is where the Node-only capabilities will register:
 * unix socket + `127.0.0.1:8080` local eAPI (M2, #4 / DR-014), cert pinning and client
 * certs (DR-013), cookie `/login` sessions (DR-018), `eapi.conf` profiles (M3, #5 /
 * DR-038) and the on-disk config-session journal (M5, #7 / DR-022).
 *
 * Requires Node >= 20 (`engines`) because `fetch` must be global.
 */

import type { NodeOptions } from './index'

export type { NodeOptions }

/**
 * M0 placeholder (#2) — Node sibling of the browser entry's `createNode`.
 *
 * Always throws; the transport set arrives in M2 (#4) and the command layer in M4 (#6).
 * Kept deliberately separate from `src/index.ts` so the two entry points stay
 * independently buildable and the browser bundle can never absorb Node built-ins.
 */
export function createNode(options: NodeOptions = {}): never {
  throw new Error(
    `@devhax-heavy-industries/arista-eapi/node: createNode() is an M0 placeholder (#2) and has ` +
      `no implementation yet — Node transports land in M2 (#4), the command layer in M4 (#6). ` +
      `Received options: ${JSON.stringify(options)}`,
  )
}
