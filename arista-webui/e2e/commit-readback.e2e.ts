/**
 * docs/CEOS.md item 3 — the isolated commit → read-back → cleanup cycle, the only spec that
 * mutates running-config. Guards honored: it skips unless scripts/ceos-lab.mjs exported
 * EAPI_LAB_FULL_WRITE=1 (DR-126: lab class ONLY, the hardware class can never reach it), it
 * touches ONLY EAPI_SCRATCH_INTERFACE, it persists NOTHING (commit defaults to running-config;
 * DR-035(c)/#89 — no "save to startup" control exists in this UI), and it always restores the
 * port (its own clear-description commit, plus the `lab:run` finally-path teardown of the whole
 * disposable container as the backstop for a failed run).
 */
import { deviceReadText } from './device'
import { expect, test } from './fixtures'
import { commitStaged, openInterfaces, refreshState, stageClearDescription, stageDescription } from './interactions'

const TOKEN = `WEBUI-E2E-COMMIT-${process.pid.toString(36)}`

test('commit lands in running-config, the UI reads it back, cleanup restores the port', async ({ page, request }) => {
  test.skip(process.env['EAPI_LAB_FULL_WRITE'] !== '1', 'mutating flow: requires the full-write lab lane (EAPI_LAB_FULL_WRITE=1)')
  const scratch = process.env['EAPI_SCRATCH_INTERFACE']
  expect(scratch, 'requires EAPI_SCRATCH_INTERFACE from scripts/ceos-lab.mjs run').toBeTruthy()

  // running-config / startup-config over eAPI are text-format reads (no JSON converter exists;
  // the client takes the same 1003→text repair path), asserted as raw device bytes.
  const runningOnScratch = async (): Promise<string> =>
    deviceReadText(request, `show running-config interfaces ${scratch as string}`)

  // Precondition: the scratch port carries no stale token from a prior interrupted run.
  expect(await runningOnScratch()).not.toContain(TOKEN)

  await openInterfaces(page)
  await stageDescription(page, scratch as string, TOKEN)
  await commitStaged(page)
  await expect(page.getByText(/Changes committed to running-config\./u)).toBeVisible({ timeout: 60_000 })

  // EOS state, not just the UI message: the committed description is in running-config NOW,
  // and startup was not touched (the app never offers persistence — the enforced #79/#89 split).
  await expect.poll(runningOnScratch, { timeout: 30_000 }).toContain(TOKEN)
  const startup = await deviceReadText(request, 'show startup-config')
  expect(startup).not.toContain(TOKEN)

  // UI read-back after an explicit refresh of device state.
  await refreshState(page)
  await expect(
    page.getByRole('table').getByRole('row').filter({ hasText: scratch as string }).first(),
  ).toContainText(TOKEN, { timeout: 60_000 })

  // Cleanup: restore via the same disciplined flow, then assert EOS really reverted.
  await stageClearDescription(page, scratch as string, 'description')
  await commitStaged(page)
  await expect(page.getByText(/Changes committed to running-config\./u)).toBeVisible({ timeout: 60_000 })
  await expect.poll(runningOnScratch, { timeout: 30_000 }).not.toContain(TOKEN)
})
