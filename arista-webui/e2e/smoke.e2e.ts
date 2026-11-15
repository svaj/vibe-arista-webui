/**
 * docs/CEOS.md §"Browser E2E and CI plan" items 2–3 — connected state over the real proxy,
 * and the honest unconfigured prompt over a proxy-less dev server. A green run here proves
 * browser → same-origin proxy → real cEOS eAPI round-trips (`show version` rendered as the
 * identity chip); it says nothing about 7050TX-64 hardware (README caveat).
 */
import { expect, test } from './fixtures'

test.describe('connected through the live lab proxy', () => {
  test('home renders and the identity chip reports the device EOS version', async ({ page }) => {
    await page.goto('/#/vlans')
    await expect(page.getByRole('heading', { level: 2, name: 'VLAN assignment' })).toBeVisible()
    await expect(page.getByText('Connected through local proxy')).toBeVisible({ timeout: 60_000 })
    // .device-identity is fed by the app's own soft `show version` read through the proxy.
    await expect(page.locator('.device-identity')).toContainText('EOS 4.28.14M', { timeout: 60_000 })
  })

  test('navigation reaches the provisioned screens', async ({ page }) => {
    await page.goto('/#/interfaces')
    await expect(page.getByRole('heading', { level: 2, name: 'Interfaces dashboard' })).toBeVisible()
    await page.goto('/#/sessions')
    await expect(page.getByRole('heading', { level: 2, name: 'Transaction center' })).toBeVisible()
  })
})

test.describe('with no proxy configured', () => {
  test('the app renders the honest prompt and no device claims', async ({ browser }) => {
    const unconfigured = process.env['E2E_UNCONFIGURED_URL']
    test.skip(unconfigured === undefined || unconfigured === '', 'E2E_UNCONFIGURED_URL is only set under scripts/e2e-run.mjs')
    const context = await browser.newContext({ baseURL: unconfigured })
    const page = await context.newPage()
    await page.goto('/#/vlans')
    await expect(page.getByRole('alert')).toContainText('Local proxy is not configured')
    // No connection chrome may lie about a device when the flag is false.
    await expect(page.getByText('Connected through local proxy')).toHaveCount(0)
    await context.close()
  })
})
