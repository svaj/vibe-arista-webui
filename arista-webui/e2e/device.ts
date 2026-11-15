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
export async function deviceRun(request: APIRequestContext, cmds: readonly string[]): Promise<unknown[]> {
  const response = await request.post('/command-api', {
    data: { jsonrpc: '2.0', method: 'runCmds', params: { version: 1, cmds: [...cmds], format: 'json' }, id: 'webui-e2e' },
  })
  expect(response.ok(), `device API call failed: HTTP ${response.status()}`).toBe(true)
  const body = (await response.json()) as DeviceResponse
  expect(body.error, `device rejected: ${JSON.stringify(body.error)}`).toBeUndefined()
  return body.result ?? []
}

/** `enable <cmd>`-framed single read, matching the client's read framing (App.test convention). */
export async function deviceRead<T = Record<string, unknown>>(request: APIRequestContext, command: string): Promise<T> {
  const [result] = await deviceRun(request, ['enable', command])
  expect(result, `device returned no result row for: ${command}`).toBeDefined()
  return result as T
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
