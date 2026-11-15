/**
 * docs/CEOS.md item 3 — the preview/diff → abort cycle on an isolated scratch interface, with
 * EOS-state parity: the live device diff must show the staged description, and after abort the
 * device must report (a) the running-config for the port UNCHANGED and (b) only the provisioner's
 * `lab-pending-capture` session still open (the test's own session gone). Abort cannot undo a
 * commit; this flow never commits, so it is safe on scratch state.
 */
import { deviceRead, pendingSessions } from './device'
import { expect, test } from './fixtures'
import { abortStaged, openInterfaces, stagedSessionName, stageDescription } from './interactions'

const TOKEN = `WEBUI-E2E-ABORT-${process.pid.toString(36)}`

test('preview shows the real device diff, then abort leaves EOS untouched', async ({ page, request }) => {
  const scratch = process.env['EAPI_SCRATCH_INTERFACE']
  expect(scratch, 'requires EAPI_SCRATCH_INTERFACE from scripts/ceos-lab.mjs run').toBeTruthy()

  const baseline = await deviceRead<Record<string, { generated_configs?: unknown[] }>>(request, `show running-config interfaces ${scratch as string}`)
  const baselineSessions = Object.keys(await pendingSessions(request))

  await openInterfaces(page)
  await stageDescription(page, scratch as string, TOKEN)

  // Device truth WHILE staged: the session the UI named really exists on the box, and ITS
  // diff (scoped by name, since the provisioner leaves `lab-pending-capture` open) names the token.
  const sessionName = await stagedSessionName(page)
  expect(sessionName.length).toBeGreaterThan(0)
  await expect.poll(async () => {
    const keys = Object.keys(await pendingSessions(request))
    return keys.includes(sessionName)
  }, { timeout: 30_000 }).toBe(true)
  const stagedDiff = await deviceRead<{ diff?: string }>(request, `show session-config name ${sessionName} diffs`)
  expect(stagedDiff.diff ?? JSON.stringify(stagedDiff)).toContain(TOKEN)

  await abortStaged(page)
  await expect(page.getByText(/was aborted/i)).toBeVisible({ timeout: 30_000 })

  // EOS parity after abort: the test's session is gone, running-config for the port unchanged.
  await expect.poll(async () => {
    const keys = Object.keys(await pendingSessions(request))
    return keys.filter((k) => !baselineSessions.includes(k))
  }, { timeout: 30_000 }).toEqual([])
  const after = await deviceRead(request, `show running-config interfaces ${scratch as string}`)
  expect(JSON.stringify(after)).not.toContain(TOKEN)
  expect(JSON.stringify(after)).toBe(JSON.stringify(baseline))
})
