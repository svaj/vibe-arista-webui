/**
 * docs/CEOS.md item 3 — explicit ERROR states against real failures, never mocked:
 *  - E2E_UNREACHABLE_URL: a dev server whose proxy target is a closed loopback port
 *    (connection failure surfaced, NOT a silent empty screen). Since #153 the failure is
 *    BOUNDED: the app node carries an explicit UI-path deadline
 *    (`src/eapi/app-node.ts: UI_REQUEST_TIMEOUT_MS`), so the hang must transition to
 *    'Connection failed' naming the timeout — this spec asserts the transition itself.
 *  - E2E_BADAUTH_URL: a dev server whose proxy carries a DELIBERATELY WRONG credential pair
 *    against the live device, so a real 401 from cEOS is exercised. The bogus pair is a
 *    fixed dummy value; no lab secret is involved (the connected lane keeps credentials in
 *    the vite proxy process only — browser storage/URLs never see them).
 * A command-level 1002 refusal is not scriptable end-to-end from this UI today: every write
 * screen validates client-side before staging (DECISIONS honesty), and the 1002-class parser
 * surfaces are pinned offline (src/** failure-slot tests) plus recorded on-device by the
 * hardware session-probe lane (`recordings/7050tx-64-r-4.28.13.1M/`). Disclosed, not faked.
 */
import { expect, test } from './fixtures'

test.describe('error states against real failing upstreams', () => {
  // Live-run finding (2026-11-15, docs/CEOS.md item 3 "test … errors explicitly"): with the
  // proxy target's TCP port refused, the vite proxy never answers. Pre-#153 the app therefore
  // sat in its honest 'Connecting through local proxy' state for the client's full 60 s library
  // default — longer than any wait this lane could reasonably hold — and this spec could only
  // pin the no-false-connected INVARIANT, never the transition. #153 gave the app node an
  // explicit UI-path deadline (src/eapi/app-node.ts), so both halves are pinned now: nothing
  // success-shaped ever appears, AND the dead link surfaces 'Connection failed' with the
  // timeout as the reason. DR-043 note from #153: this stays loopback-only lane evidence —
  // bounded here, never quoted as a 7050TX latency figure.
  test('a dead upstream fails visibly, with the timeout as the reason, and never renders a false connected state', async ({ browser }) => {
    const url = process.env['E2E_UNREACHABLE_URL']
    test.skip(url === undefined || url === '', 'E2E_UNREACHABLE_URL is only set under scripts/e2e-run.mjs')
    // try/finally is load-bearing here (run-1 finding): this context deliberately holds
    // requests to a hanging upstream, and a failed test that skips context.close() keeps
    // those sockets open past the run, delaying the lab forwarder's release of the endpoint.
    const context = await browser.newContext({ baseURL: url })
    try {
      const page = await context.newPage()
      await page.goto('/#/vlans')
      // The honest pending state appears first — short window, because the #153 deadline can
      // end the read well before the old spec's 30 s observation bound.
      await expect(page.getByText('Connecting through local proxy')).toBeVisible({ timeout: 10_000 })
      // Nothing success-shaped may EVER appear (the invariant the pre-#153 spec could pin).
      await expect(page.getByText('Connected through local proxy')).toHaveCount(0)
      await expect(page.locator('.device-identity')).toHaveCount(0)
      // The transition #153 unblocked: the deadline surfaces the failure, naming the timeout.
      // 90 s is generous margin over the 30 s UI deadline (page boot + read batch) and keeps
      // the per-test budget under playwright's 120 s timeout — retune the two together if
      // UI_REQUEST_TIMEOUT_MS ever moves.
      await expect(page.getByText('Connection failed')).toBeVisible({ timeout: 90_000 })
      await expect(page.getByRole('alert')).toContainText(/timed out/u)
      await expect(page.getByText('Connected through local proxy')).toHaveCount(0)
      await expect(page.locator('.device-identity')).toHaveCount(0)
    } finally {
      await context.close()
    }
  })

  test('a rejected credential from the real device renders the failed state too', async ({ browser }) => {
    const url = process.env['E2E_BADAUTH_URL']
    test.skip(url === undefined || url === '', 'E2E_BADAUTH_URL is only set under scripts/e2e-run.mjs')
    const context = await browser.newContext({ baseURL: url })
    try {
      const page = await context.newPage()
      await page.goto('/#/vlans')
      await expect(page.getByText('Connection failed')).toBeVisible({ timeout: 60_000 })
      expect(page.url()).toContain('#/vlans')
    } finally {
      await context.close()
    }
  })
})
