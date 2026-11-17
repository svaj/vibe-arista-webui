/**
 * The app's single eAPI node factory (#153).
 *
 * Before #153 `App.tsx` inlined `createNode({ kind: 'http', … })` with no deadline of its own, so
 * the UI ran on the client's library default — `DEFAULT_TIMEOUT_MS` (`transports/contract.ts:69`) =
 * 60 000 ms per request (DR-019). That is a *library* default sized for scripted device work, not a UI decision: the B5
 * browser lane observed the live symptom (proxy target refused → the vite proxy never answers →
 * `#/vlans` sits on "Connecting through local proxy…" for the whole minute, which no operator
 * experiences as anything but "hangs forever"; `arista-webui/e2e/errors.e2e.ts` could only pin the
 * no-false-connected invariant because the transition happened past its patience). #153 asks for an
 * **explicit UI-path timeout** so a dead link surfaces "Connection failed" with the timeout as the
 * reason — this module is that decision, in one place, testable offline (see `app-node.test.ts`).
 *
 * ## Why the deadline lives here and not in `useDeviceRead`
 * The client's transport already converts its own deadline into a typed `TimeoutError`
 * naming the endpoint and the expired number ("… timed out after N ms …", `error-map.ts`), and the
 * read hooks already land every rejection on the error branch with `error.message` (the
 * error-vs-empty rule in `shared/load-state.ts`). A hook-side `Promise.race` timer would duplicate
 * both while *not* cancelling the in-flight request — the real deadline belongs where the fetch is.
 *
 * ## Tuning (issue #153 constraint: never fire on a legitimately slow large read)
 * The largest single read on the UI path is `show running-config all` (parsed by the addressing /
 * ACL / system screens). On the capture lane that whole class of read lands inside seconds through
 * the same proxy this app uses, and nothing measured on this deployment has approached 30 s — but
 * no per-command latency figure has been *recorded* either, so 30 000 ms is stated as a floor, not
 * as a tuned margin: if the #14 hardware sweep later measures a worst-case read, retune here and
 * let `app-node.test.ts` pin the new number. Staying under the 60 s library default is deliberate —
 * the UI bound exists precisely because 60 s is too long to wait inside a browser.
 *
 * ## What this does NOT change
 * The live-lane guards (`arista-api-client/src/testing/live-guard.ts`) build their own connections
 * and keep their own timeout semantics (DR-035/DR-043) — they never import this module. Same for
 * per-call overrides: a caller may still pass `{ timeoutMs }` per exec; this value only bounds the
 * default the browser app runs on.
 */
import { createNode } from '@devhax-heavy-industries/arista-eapi'
import type { Node } from '@devhax-heavy-industries/arista-eapi'

/**
 * The UI-path request deadline in ms (#153). One request, one bound: it starts when `fetch` is
 * issued and covers connect + proxy wait + device think time, which is the only decomposition
 * a browser `fetch` allows. Kept as a named constant so the e2e unreachable-spec margin and the
 * unit test pin the same number the app ships.
 */
export const UI_REQUEST_TIMEOUT_MS = 30_000

/**
 * Build the app's node against the Vite dev-server proxy (`/command-api` → the configured eAPI
 * target). Cleartext `http` is legal here only because the proxy is loopback — the client's
 * `assertCleartextAllowed` gate (DR-027) still decides, exactly as it did for the inlined call.
 */
export function createAppNode(origin: string): Node {
  return createNode({
    kind: 'http',
    baseUrl: origin,
    path: '/command-api',
    timeoutMs: UI_REQUEST_TIMEOUT_MS,
  })
}
