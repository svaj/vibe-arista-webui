/**
 * Direct device reads THROUGH THE SAME ORIGIN the app uses: POST /command-api against the
 * connected vite dev server, whose proxy injects the credentials (eapiRunCmds parity,
 * DR-036). This is what "assert EOS state as well as UI messages" (docs/CEOS.md item 3)
 * means concretely — every expectation compares UI truth to device truth read here, never
 * to a mocked transcript. No username/password fields are sent: their absence is itself a
 * pin that the browser holds no credential.
 */
import { expect, type APIRequestContext } from '@playwright/test'

interface DeviceResponse {
  jsonrpc?: string
  result?: unknown[]
  error?: { code?: number; message?: string; data?: unknown }
  id?: string
}

/** Run `cmds` on the lab device through the connected app proxy. Throws the test on refusal. */
export async function deviceRun(request: APIRequestContext, cmds: readonly string[], format: 'json' | 'text' = 'json'): Promise<unknown[]> {
  const response = await request.post('/command-api', {
    data: { jsonrpc: '2.0', method: 'runCmds', params: { version: 1, cmds: [...cmds], format }, id: 'webui-e2e' },
  })
  expect(response.ok(), `device API call failed: HTTP ${response.status()}`).toBe(true)
  const body = (await response.json()) as DeviceResponse
  expect(body.error, `device rejected: ${JSON.stringify(body.error)}`).toBeUndefined()
  return body.result ?? []
}

/**
 * `enable <cmd>`-framed single read. Real EOS answers an enable-framed batch with ONE ROW PER
 * CLI command — the enable ack (`{}`) comes first, the command data last — so the LAST row is
 * the answer. (Pinned by the first live run 2026-11-15: row[0] is `{}`.)
 */
export async function deviceRead<T = Record<string, unknown>>(request: APIRequestContext, command: string): Promise<T> {
  const rows = await deviceRun(request, ['enable', command])
  const result = rows[rows.length - 1]
  expect(result, `device returned no result row for: ${command}`).toBeDefined()
  return result as T
}

/**
 * Text-format read for the commands EOS has no JSON converter for (the same 1003 → format=text
 * path the client itself takes for session diffs, config-session.ts `diff()`): the text row
 * carries `{ output: string }`.
 */
export async function deviceReadText(request: APIRequestContext, command: string): Promise<string> {
  const rows = await deviceRun(request, ['enable', command], 'text')
  const result = rows[rows.length - 1] as { output?: string } | undefined
  expect(result, `device returned no text row for: ${command}`).toBeDefined()
  return String(result?.output ?? '')
}

interface ShowConfigurationSessions {
  sessionKeys?: string[]
  sessions?: Record<string, { state?: string; description?: string }>
}

/** Pending session names currently on the device (the shape pinned by f-tier sessions work). */
export async function pendingSessions(request: APIRequestContext): Promise<Record<string, { state?: string }>> {
  const reply = await deviceRead<ShowConfigurationSessions>(request, 'show configuration sessions')
  return reply.sessions ?? {}
}
