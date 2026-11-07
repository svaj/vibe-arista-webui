/**
 * The `./node/testing` entry (issue #61): the **filesystem and socket halves** of the test toolkit,
 * kept out of the browser subpath exactly like `src/node.ts` keeps the Node transports out of
 * `src/index.ts` (DR-002). `vite.config.ts` enforces it from both directions: this entry must reach
 * `node:fs` (a guard that matches nothing proves nothing), and `src/testing/index.ts` must reach no
 * built-in and never name `testing/recorder-node.ts`, `testing/loopback-device.ts` or
 * `testing/fake-conf-fs.ts` in its graph (`src/browser-safety.test.ts`).
 *
 * Not reachable from the production `./node` entry: test scaffolding does not ship inside a client
 * bundle, so nothing in `src/node.ts` imports this file — it exists only for the subpath export.
 */

export * from './testing/recorder-node'
export * from './testing/loopback-device'
export * from './testing/fake-conf-fs'
