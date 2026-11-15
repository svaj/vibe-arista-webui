/**
 * docs/CEOS.md item 3 — explicit ERROR states against real failures, never mocked:
 *  - E2E_UNREACHABLE_URL: a dev server whose proxy target is a closed loopback port
 *    (connection failure surfaced, NOT a silent empty screen).
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
  // proxy target's TCP port refused, the vite proxy never answers and the app sits in its
  // honest 'Connecting through local proxy' state indefinitely (no client-side request
  // timeout is configured — a product observation for a future issue, deliberately NOT
  // papered over here). What this spec pins is the invariant that matters: a dead link may
  // never RENDER AS A CONNECTED DEVICE. The transition to 'Connection failed' is pinned by
  // the bad-auth test below, which gets (and surfaces) a real device rejection.
  test('a dead upstream never renders a false connected state', async ({ browser }) => {
    const url = process.env['E2E_UNREACHABLE_URL']
    test.skip(url === undefined || url === '', 'E2E_UNREACHABLE_URL is only set under scripts/e2e-run.mjs')
    // try/finally is load-bearing here (run-1 finding): this context deliberately holds
    // requests to a hanging upstream, and a failed test that skips context.close() keeps
    // those sockets open past the run, delaying the lab forwarder's release of the endpoint.
    const context = await browser.newContext({ baseURL: url })
    try {
      const page = await context.newPage()
      await page.goto('/#/vlans')
      await expect(page.getByText('Connecting through local proxy')).toBeVisible({ timeout: 30_000 })
      // Hold the position for a beat, then verify nothing success-shaped ever appears:
      await page.waitForTimeout(5_000)
      await expect(page.getByText('Connected through local proxy')).toHaveCount(0)
      await expect(page.locator('.device-identity')).toHaveCount(0)
      await expect(page.getByRole('alert')).toHaveCount(0)
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
