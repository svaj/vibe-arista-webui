/**
 * Shared driver for the Interfaces screen preview → (abort | commit) flow.
 * Control labels/strings are from src/features/interfaces/InterfacesDashboard.tsx:
 * 'Interface' select, 'Change' select, 'Description' input, 'Preview change' submit,
 * ConfigDiff <pre aria-label="Configuration diff">, 'Abort staged changes' /
 * 'Commit to running-config' — the final step always opens ConfirmDialog (native
 * <dialog>), whose confirm button repeats the action label.
 */
import { expect, type Page } from '@playwright/test'

export async function openInterfaces(page: Page): Promise<void> {
  await page.goto('/#/interfaces')
  await expect(page.getByRole('heading', { level: 2, name: 'Interfaces dashboard' })).toBeVisible()
}

/** Stage a description change and wait for the device diff to appear in the review panel.
 *  Controls are addressed by role + EXACT accessible name: bare getByLabel('Interface')
 *  substring-collides with the inventory DataTable's aria-label="Interface inventory"
 *  (live-run finding, 2026-11-15 → selectOption hit the table, not the <select>). */
export async function stageDescription(page: Page, port: string, text: string): Promise<void> {
  await page.getByRole('combobox', { name: 'Interface', exact: true }).selectOption(port)
  await page.getByRole('combobox', { name: 'Change', exact: true }).selectOption('set-description')
  await page.getByRole('textbox', { name: 'Description', exact: true }).fill(text)
  await page.getByRole('button', { name: 'Preview change' }).click()
  await expect(page.getByRole('heading', { level: 3, name: /^Session / })).toBeVisible()
  await expect(page.getByLabel('Configuration diff')).toContainText(text, { timeout: 30_000 })
}

/** Stage 'clear-description' (restores `no description`) and wait for its diff. */
export async function stageClearDescription(page: Page, port: string, needle: string): Promise<void> {
  await page.getByRole('combobox', { name: 'Interface', exact: true }).selectOption(port)
  await page.getByRole('combobox', { name: 'Change', exact: true }).selectOption('clear-description')
  await page.getByRole('button', { name: 'Preview change' }).click()
  await expect(page.getByRole('heading', { level: 3, name: /^Session / })).toBeVisible()
  await expect(page.getByLabel('Configuration diff')).toContainText(needle, { timeout: 30_000 })
}

/** Confirm inside the modal dialog (the panel button behind it shares the label — scope to the dialog). */
export async function confirmInDialog(page: Page, label: string): Promise<void> {
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: label }).click()
  await expect(dialog).toBeHidden()
}

export async function abortStaged(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Abort staged changes' }).click()
  await confirmInDialog(page, 'Abort staged changes')
}

export async function commitStaged(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Commit to running-config' }).click()
  await confirmInDialog(page, 'Commit to running-config')
}

export async function refreshState(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Refresh state' }).click()
}

/** Read the staged session's name out of the review panel's "Session <name>" heading. */
export async function stagedSessionName(page: Page): Promise<string> {
  const heading = page.getByRole('heading', { level: 3, name: /^Session / })
  const text = (await heading.textContent()) ?? ''
  return text.replace(/^Session\s+/u, '').trim()
}
