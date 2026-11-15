/**
 * docs/CEOS.md item 3 — read flows with EOS-state parity: every UI list is compared against
 * a direct `show …` read through the SAME proxy (device.ts), never against a fixture.
 * Ground state is what scripts/ceos-lab.mjs `provisionLab` commits (VLANs 10/100/110 named
 * LAB-NATIVE/LAB-ACCESS/LAB-SPARE; an open never-committed session `lab-pending-capture`).
 */
import { deviceRead } from './device'
import { expect, test } from './fixtures'

interface ShowVlanReply {
  vlans?: Record<string, { name?: string }>
}

const PROVISIONED_VLANS: readonly { id: string; name: string }[] = [
  { id: '10', name: 'LAB-NATIVE' },
  { id: '100', name: 'LAB-ACCESS' },
  { id: '110', name: 'LAB-SPARE' },
]

test('VLAN management table matches the device `show vlan` exactly for provisioned VLANs', async ({ page, request }) => {
  await page.goto('/#/vlans/manage')
  await expect(page.getByRole('heading', { level: 2, name: 'VLAN table' })).toBeVisible()

  const reply = await deviceRead<ShowVlanReply>(request, 'show vlan')
  for (const { id, name } of PROVISIONED_VLANS) {
    // Device truth first, and the pin that the harness really provisioned it:
    expect(reply.vlans?.[id]?.name).toBe(name)
    const row = page.getByRole('table').getByRole('row').filter({ has: page.getByRole('cell', { name }) })
    await expect(row).toBeVisible()
    await expect(row).toContainText(id)
  }
})

test('interfaces table lists the scratch port the harness discovered on the device', async ({ page }) => {
  const scratch = process.env['EAPI_SCRATCH_INTERFACE']
  expect(scratch, 'scripts/ceos-lab.mjs run must export EAPI_SCRATCH_INTERFACE for the lane').toBeTruthy()
  await page.goto('/#/interfaces')
  await expect(page.getByRole('heading', { level: 2, name: 'Interfaces dashboard' })).toBeVisible()
  // Port names come from the device config read — presence in the table AND the editor's
  // <option> set is the parity signal. <option> visibility is not asserted (native selects
  // render options off-DOM until opened), so scope to a count.
  await expect(page.getByLabel('Interface').locator('option', { hasText: scratch as string })).toHaveCount(1)
  await expect(page.getByRole('table').getByRole('row').filter({ hasText: scratch as string }).first()).toBeVisible()
})

test('transaction center shows the provisioner pending session, matching the device', async ({ page, request }) => {
  await page.goto('/#/sessions')
  await expect(page.getByRole('heading', { level: 2, name: 'Transaction center' })).toBeVisible()

  const sessions = await deviceRead<{ sessions?: Record<string, { state?: string }> }>(request, 'show configuration sessions')
  expect(Object.keys(sessions.sessions ?? {})).toContain('lab-pending-capture')
  await expect(page.getByRole('cell').getByText('lab-pending-capture')).toBeVisible({ timeout: 30_000 })
})
