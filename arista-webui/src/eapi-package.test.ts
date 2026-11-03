import { describe, expect, it } from 'vitest'

import {
  createConnection,
  createNode,
  createProfiles,
  Node,
  NotSupportedError,
} from '@devhax-heavy-industries/arista-eapi'

// M0 (#2) exit-gate assertion: the webui must resolve the API client **by package name**,
// with no `resolve.alias` and no relative path into the other package. Vite/Vitest resolve
// the `development` export condition to the client's TypeScript source (built `dist/`
// output is used for production builds), so this test also proves dev-mode serving works
// without a prior library build.
describe('@devhax-heavy-industries/arista-eapi resolves from the workspace', () => {
  it('imports the browser-safe entry by name', () => {
    expect(typeof createNode).toBe('function')
  })

  // The M0 placeholder spec ("throws until M4 lands") is obsolete twice over: M4 (#6) shipped the
  // command layer and M3 (#5) shipped these factories. This is the **consumer** view of the shipped
  // contract — what a browser caller may hand `createNode`/`createConnection` and what comes back.
  // The client's own `src/index.test.ts` owns the exhaustive rules; this spec pins that the webui
  // actually resolves them through `dist/index.d.ts`.
  it('accepts an explicit kind bag and hands back the command layer over a browser transport (#5)', () => {
    const node = createNode({ kind: 'https', host: 'sw1.lan', username: 'ui-ro', password: 'never-sent' })
    expect(node).toBeInstanceOf(Node)
    expect(node.connection.kind).toBe('https')
    expect(node.connection.address).toBe('https://sw1.lan:443/command-api')
    // Nothing has been sent yet — construction makes no request (M2 rule, ARCHITECTURE §4).
  })

  it('accepts a profile bag from app config, defaulting a missing transport to https (#5)', () => {
    // pyeapi's DEFAULT_TRANSPORT (`client.py:124`, applied at `:452`): a profile that says `host`
    // but no `transport` still means https. The store is app-supplied because this entry has no
    // filesystem to read an `eapi.conf` from (DR-002/DR-038).
    const store = createProfiles({ lab: { host: 'sw1.lan', username: 'ui-ro', password: 'never-sent' } })
    const transport = createConnection({ profileName: 'lab', store })
    expect(transport.kind).toBe('https')
    expect(transport.address).toBe('https://sw1.lan:443/command-api')
  })

  it('never yields a unix-socket path, from a spelling or a kind (#5, DR-002/DR-008/DR-014)', () => {
    // pyeapi's `socket` transport resolves to this package's `unix` kind through TRANSPORT_ALIASES
    // (`client.py:114-122`). From the browser entry that is a typed refusal naming the import that
    // *can* build it — a webui bundle must not be one config-file edit away from priv-15 on the switch.
    const store = createProfiles({ onswitch: { transport: 'socket', host: 'sw1.lan' } })
    expect(() => createConnection({ profileName: 'onswitch', store })).toThrow(NotSupportedError)
    const fromFile = (): unknown => createConnection({ profileName: 'onswitch', store })
    let message = ''
    try {
      fromFile()
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    expect(message).toMatch(/resolves to kind "unix"/u)
    expect(message).toContain('@devhax-heavy-industries/arista-eapi/node')
    expect(() => createNode({ kind: 'unix', allowLocalUnauthenticated: true } as never)).toThrow(
      NotSupportedError,
    )
  })
})
