/**
 * `@devhax-heavy-industries/arista-eapi` — browser-safe entry point (DR-002).
 *
 * M0 skeleton (#2): the tooling, the entry split and the public name are what is real
 * here. The wire codec is M1 (#3), transports are M2 (#4), profiles are M3 (#5) and the
 * `Node` command layer below is M4 (#6). Nothing in this file performs I/O.
 *
 * Do not import `node:*` from anything reachable from this file — the browser bundle is
 * built from it (build guard: M2, #4).
 */

/**
 * Placeholder for the connection options `createNode` will take.
 * The real shape (transport selection, TLS trust, profiles) is defined by M2/M3.
 */
export interface NodeOptions {
  /** Host or address of the switch's eAPI endpoint (`POST /command-api`). */
  readonly host?: string
}

/**
 * M0 placeholder (#2). Creates a client for one switch.
 *
 * Always throws: the command layer it is supposed to return arrives in M4 (#6).
 * Its only job is to make the package resolvable and importable by name from
 * `arista-webui` — see `arista-webui/src/eapi-package.test.ts`.
 */
export function createNode(options: NodeOptions = {}): never {
  throw new Error(
    `@devhax-heavy-industries/arista-eapi: createNode() is an M0 placeholder (#2) and has no ` +
      `implementation yet — the command layer lands in M4 (#6). Received options: ` +
      `${JSON.stringify(options)}`,
  )
}
