/**
 * The `Node` ↔ M6 config-engine pairing, shipped by M7 (#9). PR #23 landed `src/config/` with **no**
 * `Node` methods on purpose — its STATUS row says "Deliberately no `Node.chunkConfig`/`Node.section`
 * wiring — that pairing is M7" — so this file is where that wiring is pinned.
 *
 * ## Upstream port ledger — `pyeapi/test/unit/test_client.py`
 *
 * M4 left two upstream cases unpored because the engine did not exist yet (see the ledger in
 * `command-layer.test.ts`): `test_chunkify_sections` (`test_client.py:224`) and
 * `test_chunkify_section_subsections` (`test_client.py:231`). Both are chunker tests proper and belong to
 * M6 (#8), which shipped them as `src/config/chunk.test.ts` + `chunk.fixture.test.ts` against the
 * `test/fixtures/config/` oracle. What is ported here is the `Node` half: the same memoisation, the same
 * first-match ordering, and the invalidation that pyeapi performs by hand.
 *
 * Verified refs (opened 2026-11-03):
 * * `_chunkify` decorated `@lru_cache(maxsize=None)` — `client.py:697`; body `:698-774`.
 * * `section(regex, config='running_config')` — `client.py:776-798`; the sentinels are resolved against
 *   `self` at `:789-791`; the pattern is compiled with `re.compile` at `:792`; the scan is over **keys**
 *   via `r.search(k)` at `:793`; the winner is `matching_keys[0]` at `:796`; absence raises
 *   `TypeError('config section not found')` at `:795`.
 * * `configure` → `_configure_terminal` clears the chunk cache *unconditionally* at `client.py:665-666`,
 *   then refreshes only under `autorefresh` at `:668-669`. Same order realised here.
 * * `_configure_session` clears it the same way at `:689-690` — that path is M5 (#7) and not wired yet.
 *
 * DR-026 replaces the unbounded `lru_cache` with one entry per config source
 * (`src/config/cache.ts`: FNV-1a fast reject, then exact string equality), and DR-027 replaces the
 * `TypeError` for "no such section" with `NotFoundError` while `getBlock` answers `undefined`
 * (pyeapi keeps `get_block` on the resource base — `abstract.py:82-101` — and this `Node` exposes it
 * because it is the same splice over the same memo).
 *
 * The memo has no public counters on `Node`, so a hit is asserted the way a caller can actually observe
 * it: the chunked document is handed out of the memo, so **identity** of the returned map is the hit, and
 * a request count is the miss. Mutation is not possible from here either way — `ConfigSections` is a
 * `ReadonlyMap` (row 52), which is why sharing one document across lookups is safe.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, expectTypeOf, it } from 'vitest'

import { Node } from './command-layer'
import { NotFoundError, NotSupportedError } from './errors'
import { mockTransport, type MockTransport } from './testing/mock-transport'
import type { ConfigSections } from './config/chunk'
import type { ConfigTarget, NodeConfigOptions } from './command-layer'
import type { CommandResult } from './types/eapi'

/** The SYNTHETIC 4.28.13.1M / DCS-7050TX-64 `show version` answer (see that fixture's README). */
const VERSION_REPLY: CommandResult = JSON.parse(
  readFileSync(fileURLToPath(new URL('../test/fixtures/show/show-version--4.28.13.1M-dcs-7050tx-64.json', import.meta.url)), 'utf8'),
) as CommandResult

/** Hand-authored, not captured: no device, container or fixture file is touched by `npm test` (DR-034). */
const RUNNING_CONFIG = [
  '!',
  'hostname sw1',
  '!',
  'interface Management1',
  '   ip address dhcp',
  '!',
  'vlan 11-13',
  '   name TEN-THIRTEEN',
  '!',
  'interface Ethernet1',
  '   description WAN uplink',
  '   switchport access vlan 20',
  '!',
  'interface Ethernet2',
  '   shutdown',
  '!',
  'router bgp 65001',
  '   vrf TENANT',
  '      rd 65001:1',
  '   !',
  '!',
  'end',
].join('\n')

const STARTUP_CONFIG = ['!', 'hostname old-name', '!'].join('\n')

/** A transport scripted for both config sources, `all`-params on by default (pyeapi `config_defaults`). */
function configTransport(running = RUNNING_CONFIG, startup = STARTUP_CONFIG): MockTransport {
  return mockTransport()
    .replies('enable\nshow running-config all', [{}, { output: running }])
    .replies('enable\nshow startup-config', [{}, { output: startup }])
    .replies('enable\nconfigure terminal\nhostname sw2', [{}, {}, {}])
}

const shows = (t: MockTransport, command: string): number => t.sent().filter((cmds) => cmds.includes(command)).length

describe('Node.chunkConfig — pyeapi _chunkify behind the cached text (client.py:697)', () => {
  it('reads the running-config once and hands back the section document, sub-section keys included', async () => {
    const t = configTransport()
    const sections = await new Node(t).chunkConfig()
    expect(t.sent()).toEqual([['enable', 'show running-config all']])
    expect(sections.get('vlan 11-13')).toBe('vlan 11-13\n   name TEN-THIRTEEN\n')
    // A section that opens a nested block contributes its own sub-section keys (`client.py:770-771`), and
    // they precede the parent key in iteration order. A **leaf** body line is never a key — the only
    // keys are section headers and block openers, so a resource must not walk keys expecting to find
    // `description …` (row 51 ordering note; pinned per M6's `chunk.test.ts` transcriptions).
    expect(sections.get('   vrf TENANT')).toBe('   vrf TENANT\n      rd 65001:1\n')
    expect(sections.get('router bgp 65001')).toBe('router bgp 65001\n   vrf TENANT\n      rd 65001:1\n   !\n')
    expect(sections.has('   description WAN uplink')).toBe(false)
    expect(sections.has('      rd 65001:1')).toBe(false)
  })

  it('the second read is a memo HIT: the same document, no second device read (DR-026)', async () => {
    const t = configTransport()
    const node = new Node(t)
    const first = await node.chunkConfig()
    const second = await node.chunkConfig()
    expect(second).toBe(first)
    expect(shows(t, 'show running-config all')).toBe(1)
  })

  it('48 lookups over one config text still chunk and fetch it once — the reason the pairing exists', async () => {
    const t = configTransport()
    const node = new Node(t)
    for (let index = 0; index < 48; index += 1) {
      await node.section('^interface Ethernet')
    }
    expect(shows(t, 'show running-config all')).toBe(1)
    expect(t.callCount()).toBe(1)
  })

  it('honours configDefaults: the running-config read is `show running-config all` unless told otherwise', async () => {
    const withDefaults = configTransport()
    await new Node(withDefaults, { configDefaults: true }).chunkConfig()
    expect(withDefaults.sent()).toEqual([['enable', 'show running-config all']])

    const plain = mockTransport().replies('enable\nshow running-config', [{}, { output: RUNNING_CONFIG }])
    const sections = await new Node(plain, { configDefaults: false }).chunkConfig()
    expect(plain.sent()).toEqual([['enable', 'show running-config']])
    expect(sections.size).toBeGreaterThan(0)
  })

  it('`config: startup-config` reads the startup-config, and never with the `all` keyword (pyeapi startup_config, client.py:528-535)', async () => {
    const t = configTransport()
    const node = new Node(t)
    const options: NodeConfigOptions = { config: 'startup-config' }
    const startup = await node.chunkConfig(options)
    expect(t.sent()).toEqual([['enable', 'show startup-config']])
    expect(startup.get('hostname old-name')).toBe('hostname old-name\n')
  })

  it('keeps one memo per source, so alternating sources never evict each other (pyeapi’s single unbounded lru_cache is the counter-example)', async () => {
    const t = configTransport()
    const node = new Node(t)
    const running = await node.chunkConfig()
    const startup = await node.chunkConfig({ config: 'startup-config' })
    const runningAgain = await node.chunkConfig()
    const startupAgain = await node.chunkConfig({ config: 'startup-config' })
    expect(startup).not.toBe(running)
    expect(runningAgain).toBe(running)
    expect(startupAgain).toBe(startup)
    expect(shows(t, 'show running-config all')).toBe(1)
    expect(shows(t, 'show startup-config')).toBe(1)
  })

  it('a bad config name from JS is refused the same way getConfig refuses it (row 36), before any request', async () => {
    const t = configTransport()
    const node = new Node(t)
    // pyeapi's own sentinel strings (`client.py:789-791`) are the likeliest junk to arrive from a port.
    const sentinel = { config: 'running_config' } as unknown as NodeConfigOptions
    await expect(node.chunkConfig(sentinel)).rejects.toThrow(NotSupportedError)
    await expect(node.chunkConfig(sentinel)).rejects.toThrow(/invalid config name specified: "running_config"/)
    expect(t.sent()).toEqual([])
  })

  it('is typed as a read-only document, so sharing the memo cannot poison it (row 52)', async () => {
    const node = new Node(configTransport())
    expectTypeOf<Awaited<ReturnType<typeof node.chunkConfig>>>().toEqualTypeOf<ConfigSections>()
  })
})

describe('Node.section — pyeapi Node.section(regex, config) (client.py:776-798)', () => {
  it('searches section KEYS, not config text, and returns the whole section value', async () => {
    const t = configTransport()
    const node = new Node(t)
    // `WAN uplink` appears in the text of the Ethernet1 section, never as a key: pyeapi's
    // `[k for k in chunked.keys() if r.search(k)]` (:793) would not match it, and neither do we.
    await expect(node.section('WAN uplink')).rejects.toThrow(NotFoundError)
    const ethernet = await node.section('^interface Ethernet1$')
    expect(ethernet).toBe('interface Ethernet1\n   description WAN uplink\n   switchport access vlan 20\n')
  })

  it('first matching key in device order wins (client.py:796), deepest keys merged first', async () => {
    const node = new Node(configTransport())
    expect(await node.section('^interface Ethernet')).toContain('interface Ethernet1')
    expect(await node.section('Ethernet')).toContain('interface Ethernet1')
    // `client.py:770-771` merges a section's sub-sections with `parsed.update(sections)`, so the deeper
    // keys sit earlier in iteration order and an unanchored pattern reaches them first. Transcribed
    // exactly (row 51) — an M8+ resource that wants the parent anchors its pattern.
    expect(await node.section('vrf TENANT')).toBe('   vrf TENANT\n      rd 65001:1\n')
    expect(await node.section('^router bgp')).toBe('router bgp 65001\n   vrf TENANT\n      rd 65001:1\n   !\n')
  })

  it('accepts a RegExp and never advances lastIndex on a /g pattern (String#search, unlike RegExp#test)', async () => {
    const node = new Node(configTransport())
    const pattern = /^interface Ethernet/gu
    expect(await node.section(pattern)).toBe(await node.section(pattern))
  })

  it('absence is a NotFoundError naming the pattern — not pyeapi’s TypeError (DR-027)', async () => {
    const node = new Node(configTransport())
    const error = await node.section('^vlan 99$').catch((thrown: unknown) => thrown)
    expect(error).toBeInstanceOf(NotFoundError)
    expect((error as Error).message).toBe('config section not found: ^vlan 99$')
    expect(error).not.toBeInstanceOf(TypeError)
  })

  it('a broken pattern stays a SyntaxError instead of being reported as a missing section', async () => {
    const node = new Node(configTransport())
    const thrown = await node.section('vlan [').catch((error: unknown) => error)
    expect(thrown).toBeInstanceOf(SyntaxError)
    expect(thrown).not.toBeInstanceOf(NotFoundError)
  })

  it(`the startup-config source is searched when asked, without touching the running-config`, async () => {
    const t = configTransport()
    const node = new Node(t)
    expect(await node.section('^hostname', { config: 'startup-config' })).toBe('hostname old-name\n')
    expect(shows(t, 'show running-config all')).toBe(0)
    expect(shows(t, 'show startup-config')).toBe(1)
  })
})

describe('Node.getBlock — get_block on the command layer (pyeapi keeps it on the base, abstract.py:82-101)', () => {
  it('answers the exact header match, or undefined for a section the switch does not have', async () => {
    const node = new Node(configTransport())
    expect(await node.getBlock('vlan 11-13')).toBe('vlan 11-13\n   name TEN-THIRTEEN\n')
    expect(await node.getBlock('vlan 99')).toBeUndefined()
    // Keys are whole header LINES, so a bare keyword is not a section: pyeapi's `^%s$` splice
    // (`abstract.py:98`) answers None for `get_block('hostname')` and this port answers undefined.
    expect(await node.getBlock('hostname')).toBeUndefined()
    expect(await node.getBlock('hostname sw1')).toBe('hostname sw1\n')
    // An indented sub-section header must be spelled with its indentation to match the anchor.
    expect(await node.getBlock('vrf TENANT')).toBeUndefined()
    expect(await node.getBlock('   vrf TENANT')).toBe('   vrf TENANT\n      rd 65001:1\n')
  })

  it('splices the parent into the pattern as-written, so a metacharacter widens the match (upstream parity, abstract.py:98)', async () => {
    const node = new Node(configTransport())
    // `^vlan 11.13$` — the `.` is a wildcard, so it answers the `vlan 11-13` section. pyeapi does exactly
    // this; row 51 records it as kept-verbatim rather than papered over. A caller wanting a literal name
    // escapes it or builds the RegExp and calls section().
    expect(await node.getBlock('vlan 11.13')).toBe('vlan 11-13\n   name TEN-THIRTEEN\n')
    expect(await node.getBlock('vlan 11-13')).toBe(await node.getBlock('vlan 11.13'))
  })

  it('catches only NotFoundError: a bad pattern still throws (the except TypeError at abstract.py:100-101 is the counter-example)', async () => {
    const node = new Node(configTransport())
    await expect(node.getBlock('vlan [')).rejects.toThrow(SyntaxError)
  })

  it('reuses the running-config memo rather than re-reading the switch', async () => {
    const t = configTransport()
    const node = new Node(t)
    await node.section('^interface Ethernet1$')
    await node.getBlock('vlan 11-13')
    expect(await node.getBlock('interface Ethernet2')).toBe('interface Ethernet2\n   shutdown\n')
    expect(shows(t, 'show running-config all')).toBe(1)
  })
})

describe('invalidation — the two seams pyeapi does by hand (client.py:665-666, :689-690, :991-1001)', () => {
  it('refresh() drops the derived document WITH the text caches: one show before, one after', async () => {
    const t = configTransport()
    const node = new Node(t)
    const before = await node.chunkConfig()
    const hit = await node.chunkConfig()
    expect(hit).toBe(before)
    expect(shows(t, 'show running-config all')).toBe(1)

    node.refresh()
    const after = await node.chunkConfig()
    expect(after).not.toBe(before)
    expect(shows(t, 'show running-config all')).toBe(2)
  })

  it('configure() clears the memo before the autorefresh gate, exactly like client.py:665-669', async () => {
    const t = configTransport()
    const node = new Node(t)
    const before = await node.chunkConfig()
    const results = await node.configure('hostname sw2')
    // The write's own replies come back minus `configure terminal` (pyeapi `client.py:672`), and the
    // default autorefresh then drops the text caches (`:668-669`) — so the next chunk re-reads.
    expect(results).toHaveLength(1)
    const after = await node.chunkConfig()
    expect(after).not.toBe(before)
    expect(shows(t, 'show running-config all')).toBe(2)
    expect(after.get('hostname sw1')).toBe('hostname sw1\n')
  })

  it('with autorefresh off the text stays cached but the derived document is still dropped (no re-read, no stale parse)', async () => {
    const t = configTransport()
    const node = new Node(t, { autorefresh: false })
    const before = await node.chunkConfig()
    await node.configure('hostname sw2')
    // pyeapi clears `_chunkify` unconditionally (`client.py:665-666`) and only the TEXT refetch is behind
    // the autorefresh gate (`:668-669`). Same split: no second `show`, and the parse re-derived from the
    // (deliberately stale) cached text — which is what an operator who turned autorefresh off asked for.
    expect(shows(t, 'show running-config all')).toBe(1)
    const after = await node.chunkConfig()
    expect(after).not.toBe(before)
    expect(after).toBe(await node.chunkConfig())
    expect(after.get('hostname sw1')).toBe('hostname sw1\n')
  })

  it('a write with an unread config still costs nothing extra to the memo', async () => {
    const t = configTransport()
    const node = new Node(t)
    await node.configure('hostname sw2')
    expect(shows(t, 'show running-config all')).toBe(0)
    await node.chunkConfig()
    expect(shows(t, 'show running-config all')).toBe(1)
  })

  it('section() after a write sees the new config, not the cached document (the class of bug DR-026 removes)', async () => {
    const t = mockTransport()
      .repliesOnce('enable\nshow running-config all', [{}, { output: RUNNING_CONFIG }])
      .replies('enable\nconfigure terminal\nhostname sw2', [{}, {}, {}])
      .replies('enable\nshow running-config all', [{}, { output: RUNNING_CONFIG.replace('hostname sw1', 'hostname sw2') }])
    const node = new Node(t)
    expect(await node.section('^hostname')).toBe('hostname sw1\n')
    expect(await node.section('^hostname')).toBe('hostname sw1\n')
    expect(shows(t, 'show running-config all')).toBe(1)
    await node.configure('hostname sw2')
    expect(await node.section('^hostname')).toBe('hostname sw2\n')
    expect(shows(t, 'show running-config all')).toBe(2)
  })

  it('the device identity memo is untouched by config churn, exactly as pyeapi leaves it (client.py:991-1001)', async () => {
    const t = configTransport().replies('enable\nshow version', [{}, VERSION_REPLY])
    const node = new Node(t)
    const before = await node.getVersion()
    node.refresh()
    await node.chunkConfig()
    await node.section('^hostname')
    const after = await node.getVersion()
    expect(after).toBe(before)
    expect(t.sent().filter((cmds) => cmds.includes('show version'))).toHaveLength(1)
  })
})

describe('the source union is the only accepted vocabulary', () => {
  it('types the two config sources and nothing else (a wrong literal is a compile error, row 36)', () => {
    const options: NodeConfigOptions = { config: 'startup-config' }
    expectTypeOf(options.config).toEqualTypeOf<ConfigTarget | undefined>()
    // @ts-expect-error 'running_config' is pyeapi's sentinel, not this client's ConfigTarget union
    const wrong: NodeConfigOptions = { config: 'running_config' }
    expect(wrong.config).toBe('running_config')
  })
})
