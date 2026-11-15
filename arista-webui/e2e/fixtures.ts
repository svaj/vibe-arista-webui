/**
 * Shared fixture for every spec in this lane: on failure, attach SCRUBBED text diagnostics
 * (UI render + session list) instead of trace/video/HAR artifacts — those containers are
 * opaque to the boundary scanner and would carry device MACs (playwright.config.ts header
 * explains the trade). Items 3/4 of docs/CEOS.md §"Browser E2E and CI plan".
 */
import { test as base, type Page } from '@playwright/test'
import { deviceRun } from './device'
import { scrub } from './scrub'

export { expect } from '@playwright/test'

export const test = base.extend<{ page: Page }>({
  // The second positional arg is Playwright's use() — named `render` here so the repo's
  // react-hooks lint pass doesn't read this test fixture as a React Hook call.
  page: async ({ page }, render, testInfo) => {
    try {
      await render(page)
    } finally {
      if (testInfo.status !== testInfo.expectedStatus) {
        const uiText = await page.evaluate(() => document.body.innerText).catch(() => '(page unreadable after failure)')
        await testInfo.attach('ui-text-redacted', {
          body: Buffer.from(scrub(`url: ${page.url()}\n\n${uiText}`)),
          contentType: 'text/plain',
        })
        try {
          const sessions = await deviceRun(page.request, ['enable', 'show configuration sessions'])
          await testInfo.attach('device-sessions-redacted', {
            body: Buffer.from(scrub(JSON.stringify(sessions, null, 2))),
            contentType: 'text/plain',
          })
        } catch {
          await testInfo.attach('device-sessions-redacted', {
            body: Buffer.from('(device session read unavailable — expected when the proxy target is down or rejects auth)'),
            contentType: 'text/plain',
          })
        }
      }
    }
  },
})
