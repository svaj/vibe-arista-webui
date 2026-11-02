/**
 * `Node` — the M4 (#6) command layer, driven offline through `MockTransport` scripted replies and the
 * hand-authored per-command samples in `test/fixtures/show/` (DR-034: `npm test` never touches a
 * device, a container or cEOS, which is not installed on this machine).
 *
 * ## Upstream port ledger — `pyeapi/test/unit/test_client.py` (53 methods)
 *
 * Ported here by **behaviour**, not by copy (DR-003): the same commands in the same order, the same
 * failure class for the same condition, with the renamed shape MIGRATION.md §5 records.
 *
 * * `TestNode` (21 methods) → 19 ported: every `test_enable_*`, `test_no_enable_*`, `test_config_*`,
 *   `test_get_config*`, `test_get_version_properties_*`, `test_version_properties_populate`,
 *   `test_enable_authentication`, `test_enable_with_config_statement`.
 *   **Not ported:** `test_api_autoloader` (DR-006 drops `Node.api()` — MIGRATION.md §7) and the two
 *   `test_chunkify_*` cases (M6, #8 — the config-text engine, owned by a sibling milestone).
 * * `TestClient`'s `Node` half (14 methods: `test_node_str_returns`, `test_node_repr_returns`,
 *   `test_node_hasattr_connection`, `test_node_calls_running_config_*` ×2, `test_node_returns_running_config`,
 *   `test_node_returns_startup_config`, `test_node_returns_cached_startup_config`,
 *   `test_node_returns_version`, `test_node_returns_cached_version`, `test_node_returns_version_number`,
 *   `test_node_returns_cached_version_number`, `test_node_returns_model`, `test_node_returns_cached_model`)
 *   → all 14 ported.
 * * `TestClient`'s config/profile half (20 methods: `test_load_config*`, `test_config_*`,
 *   `test_missing_connection_raises_attribute_error`, `test_hosts_for_tag_*`, `test_connect_*`,
 *   `test_make_connection_raises_typeerror`) → M3 (#5). `test_connect_types`,
 *   `test_connect_default_type`, `test_connect_return_node`, `test_connect_return_node_enablepwd`,
 *   `test_connect_to_with_config` and `test_make_connection_raises_typeerror` were already absorbed by
 *   M2's transport suite (#4) — the profile-store half is still open.
 * * Two upstream cases exist only because Python has two string types
 *   (`test_enable_with_single_unicode_command`, `test_enable_with_multiple_unicode_commands`); they are
 *   replaced by one non-ASCII command case below. `test_enable_authentication` poked the private
 *   `_enablepwd`; here the password's journey is asserted **on the wire** instead, which is the part
 *   that actually matters (and DR-011's redaction with it).
 *
 * Cases beyond the port budget exist where upstream is weak or where this milestone introduced a
 * decision that needs pinning: the DR-007 result shape, the 1003 repair reporting (DR-012),
 * `configure all` versus config mode (row 32), the typed `show` contract shell, the async config
 * accessors (DR-005), the device-identity round trips (row 35) and `tryVariants` (DR-006).
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, expectTypeOf, it } from 'vitest'

import {
  Node,
  parseVersionProperties,
  type ExecResult,
  type NodeSettings,
  type VersionProperties,
} from './command-layer'
import { CommandError, EapiErrorCode, NotSupportedError, ProtocolError, TransportError } from './errors'
import { mockTransport, type MockTransport } from './testing/mock-transport'
import type { Transport, TransportExecOptions } from './transports/contract'
import type { CommandResult, ShowContracts, ShowReply } from './types/eapi'

// --- contract-map expectations ------------------------------------------------------------------
// This file adds **no** `ShowContracts` keys of its own. `src/types/eapi.test.ts` is the program's owner
// of that augmentation: it proves the shipped map contributes zero keys and that the consumer's keys are
// exactly `version` and `lag counters`, and those assertions are program-global (an interface key may be
// declared once per program, TS2717). Widening the map from a second file here would quietly break them,
// so the narrowing tests below thread M4's generic through *that* consumer's keys — which is what a real
// screen does as well (`arista-webui/src/eapi-show-contracts.test.ts` is the published-declarations form).

/**
 * Type identity in both directions (the precedent set in `src/internal/wire.test.ts`: vitest's branded
 * `toEqualTypeOf` cannot take a readonly-array type argument, TS4104).
 */
type Exactly<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false

const FIXTURE_DIR = fileURLToPath(new URL('../test/fixtures/show', import.meta.url))

function showFixture<T extends object>(name: string): T {
  return JSON.parse(readFileSync(`${FIXTURE_DIR}/${name}`, 'utf8')) as T
}

/** The SYNTHETIC stand-in for the target device's `show version` answer (see the fixture README). */
const VERSION_FIXTURE: CommandResult = showFixture('show-version--4.28.13.1M-dcs-7050tx-64.json')
const RUNNING_CONFIG_FIXTURE: { readonly output: string } = showFixture('show-running-config--minimal.json')

/** A reply for a request that carries `enable`, i.e. every default-path request this layer sends. */
function withEnable(reply: CommandResult): CommandResult[] {
  return [{}, reply]
}

function nodeWith(scripted: MockTransport, settings: NodeSettings = {}): Node {
  return new Node(scripted, settings)
}

describe('runCommands — pyeapi run_commands (client.py:876-926)', () => {
  it('sends one batched request with enable prepended and pops the enable reply', async () => {
    const t = mockTransport().replies('enable\nshow version', withEnable({ hostname: 'sw1' }))
    const results = await nodeWith(t).runCommands('show version')
    expect(t.sent()).toEqual([['enable', 'show version']])
    expect(results).toEqual([{ hostname: 'sw1' }])
  })

  it('keeps command objects on the wire exactly as written (cmd/input/revision only)', async () => {
    const t = mockTransport().replies(
      'enable\nshow cvx',
      withEnable({ peers: [] }),
    )
    await nodeWith(t).runCommands({ cmd: 'show cvx', revision: 2 })
    expect(t.sent()[0]).toEqual(['enable', { cmd: 'show cvx', revision: 2 }])
  })

  it('sendEnable: false is the DR-009 priv-15 shortcut — no enable command, nothing popped [pyeapi test_no_enable_with_single_command]', async () => {
    const t = mockTransport().replies('show version', [{ hostname: 'sw1' }])
    const results = await nodeWith(t).runCommands('show version', { sendEnable: false })
    expect(t.sent()).toEqual([['show version']])
    expect(results).toEqual([{ hostname: 'sw1' }])
  })

  it('passes the encoding choice through as the wire parameter `format` (§5 row 31)', async () => {
    const t = mockTransport().replies('enable\nshow version', withEnable({ output: '...' }))
    await nodeWith(t).runCommands('show version', { format: 'text' })
    expect(t.bodies()[0]?.params.format).toBe('text')
  })

  it('never rewrites pyeapi MULTILINE: pseudo-syntax into an input (DR-015, §5 row 16)', async () => {
    const t = mockTransport().replies(
      'enable\nbanner login MULTILINE:This is a new banner',
      [{}, {}],
    )
    await nodeWith(t).runCommands('banner login MULTILINE:This is a new banner')
    const [command] = t.bodies()[0]?.params.cmds ?? []
    expect(t.bodies()[0]?.params.cmds).toEqual(['enable', 'banner login MULTILINE:This is a new banner'])
    // Not an object, and no `input` anywhere: pyeapi's silent rewrite (client.py:909-911) is gone.
    expect(typeof command).toBe('string')
  })

  it('a banner therefore uses a real {cmd, input} object with an explicit EOF (DR-015)', async () => {
    const t = mockTransport().replies('enable\nbanner motd', [{}, {}])
    await nodeWith(t).runCommands({ cmd: 'banner motd', input: 'Authorized use only.\nEOF\n' })
    expect(t.bodies()[0]?.params.cmds).toEqual(['enable', { cmd: 'banner motd', input: 'Authorized use only.\nEOF\n' }])
  })

  it('a device failure throws with the commands that produced it attached (PLAN M4 error attachment)', async () => {
    const t = mockTransport().rejects('enable', {
      code: EapiErrorCode.COMMAND_INVALID,
      message: "CLI command 2 of 2 'show nonsense' failed: invalid command",
    })
    const error = await nodeWith(t).runCommands('show nonsense').catch((thrown: unknown) => thrown)
    expect(error).toBeInstanceOf(CommandError)
    expect((error as CommandError).code).toBe(EapiErrorCode.COMMAND_INVALID)
    expect((error as CommandError).commands).toEqual(['enable', 'show nonsense'])
    expect((error as CommandError).requestId).toBeTruthy()
  })

  it('refuses to invent a reply when the device answers with an empty result array', async () => {
    const t = mockTransport().replies('enable\nshow version', [])
    const node = nodeWith(t)
    await expect(node.show('version')).rejects.toThrow(ProtocolError)
    await expect(node.show('version')).rejects.toThrow(/no result object for "show version"/)
  })

  it('names a command object by its cmd when that command has no reply (exec, revision form)', async () => {
    // The script is the exact command set the transport sends (`enable` plus the object form, which
    // `MockTransport` matches by its `cmd` text) and it answers `enable` **only** — so the object
    // command really is sent and really gets no result object, and the pairing code is what throws.
    // pyeapi pairs results to commands **positionally**: the strict path indexes `commands[index]`
    // while looping the *answers* (`client.py:852-856`), so a short answer silently drops the tail;
    // the non-strict path reads `resp[0]` (`client.py:862-864`), so a short answer dies in a bare
    // `IndexError: list index out of range` with no command named. Neither is usable in a UI, so a
    // short answer is a `ProtocolError` naming the command by its `cmd` text — never the serialised
    // object form and never an index. MIGRATION.md §5 row 38.
    const t = mockTransport().replies('enable\nshow cvx', [{}])
    const error = (await nodeWith(t)
      .exec({ cmd: 'show cvx', revision: 2 })
      .catch((thrown: unknown) => thrown)) as ProtocolError
    expect(error).toBeInstanceOf(ProtocolError)
    expect(error.message).toMatch(/no result object for "show cvx"/)
    expect(error.message).not.toContain('revision')
    expect(error.commands).toEqual([{ cmd: 'show cvx', revision: 2 }])
  })

  it('a batched answer that comes back short names the first unanswered command (§5 row 38)', async () => {
    // `tolerateErrors: false` is one request with every command, so pairing is positional here too:
    // `show a` has its reply, `show b` does not. pyeapi's strict path would emit one entry and stay
    // silent about the missing one (`client.py:852`).
    const t = mockTransport().replies('enable\nshow a\nshow b', [{}, { a: 1 }])
    const error = (await nodeWith(t)
      .exec(['show a', 'show b'], { tolerateErrors: false })
      .catch((thrown: unknown) => thrown)) as ProtocolError
    expect(error).toBeInstanceOf(ProtocolError)
    expect(error.message).toMatch(/no result object for "show b"/)
    expect(t.callCount()).toBe(1)
  })
})

describe('exec — pyeapi enable (client.py:800-875)', () => {
  it('returns one entry per command with the DR-007 shape and nothing else', async () => {
    const t = mockTransport().replies('enable\nshow version', withEnable({ version: '4.28.13.1M' }))
    const entries = await nodeWith(t).exec('show version')
    // `toEqual` on the whole entry is the DR-007 assertion: a reintroduced duplicate `response` key
    // (pyeapi client.py:845-856) would fail here rather than pass unnoticed.
    expect(entries).toEqual([{ command: 'show version', result: { version: '4.28.13.1M' }, encoding: 'json', fellBack: false }])
    expect(entries[0]).not.toHaveProperty('response')
  })

  it('tolerating errors sends one request per command, each with enable again [pyeapi test_enable_with_multiple_commands]', async () => {
    const t = mockTransport()
      .replies('enable\nshow version', withEnable({ hostname: 'sw1' }))
      .replies('enable\nshow vlan', withEnable({ vlans: { 1: { name: 'default' } } }))
      .replies('enable\nshow lldp neighbors', withEnable({ neighbors: [] }))
    const entries = await nodeWith(t).exec(['show version', 'show vlan', 'show lldp neighbors'])
    expect(t.sent()).toEqual([
      ['enable', 'show version'],
      ['enable', 'show vlan'],
      ['enable', 'show lldp neighbors'],
    ])
    expect(t.callCount()).toBe(3)
    expect(entries.map((entry) => entry.command)).toEqual(['show version', 'show vlan', 'show lldp neighbors'])
    expect(entries.map((entry) => entry.result)).toEqual([
      { hostname: 'sw1' },
      { vlans: { 1: { name: 'default' } } },
      { neighbors: [] },
    ])
  })

  it('sends a single non-ASCII command untouched (replaces pyeapi two unicode-string cases)', async () => {
    const command = 'description Café — réseau 10Гбит'
    const t = mockTransport().replies(`enable\n${command}`, [{}, {}])
    const entries = await nodeWith(t).exec(command)
    expect(t.sent()).toEqual([['enable', command]])
    expect(entries[0]).toEqual({ command, result: {}, encoding: 'json', fellBack: false })
  })

  it('sendEnable: false pairs every command with its own reply and omits enable [pyeapi test_no_enable_with_single_command]', async () => {
    const t = mockTransport().replies('show a', [{ a: 1 }]).replies('show b', [{ b: 2 }])
    const entries = await nodeWith(t).exec(['show a', 'show b'], { sendEnable: false })
    expect(t.sent()).toEqual([['show a'], ['show b']])
    expect(entries.map((entry) => entry.result)).toEqual([{ a: 1 }, { b: 2 }])
  })

  it('tolerateErrors: false sends one batched request, pyeapi strict=True (client.py:849-857)', async () => {
    const t = mockTransport().replies('enable\nshow a\nshow b', [{}, { a: 1 }, { b: 2 }])
    const entries = await nodeWith(t).exec(['show a', 'show b'], { tolerateErrors: false })
    expect(t.sent()).toEqual([['enable', 'show a', 'show b']])
    expect(entries.map((entry) => [entry.command, entry.result])).toEqual([
      ['show a', { a: 1 }],
      ['show b', { b: 2 }],
    ])
  })

  it('tolerateErrors: false does not paper over a 1003: it throws and sends once (DR-012)', async () => {
    const t = mockTransport().rejects('enable', { code: EapiErrorCode.COMMAND_UNCONVERTED, message: 'Error: CLI is not ready' })
    const error = await nodeWith(t).exec('show session-config diffs', { tolerateErrors: false }).catch((thrown: unknown) => thrown)
    expect(error).toBeInstanceOf(CommandError)
    expect((error as CommandError).code).toBe(EapiErrorCode.COMMAND_UNCONVERTED)
    expect(t.callCount()).toBe(1)
  })

  it('repairs a 1003 with format:text and reports the encoding that actually answered (DR-012)', async () => {
    const t = mockTransport()
      .repliesOnce('enable\nshow session-config diffs', {
        error: { code: EapiErrorCode.COMMAND_UNCONVERTED, message: 'Error: CLI command 2 of 2 failed: no json model' },
      })
      .replies('enable\nshow session-config diffs', [{}, { output: '+  vlan 20\n-  vlan 30' }])
    const entries = await nodeWith(t).exec('show session-config diffs')
    expect(t.callCount()).toBe(2)
    expect(t.bodies().map((body) => body.params.format)).toEqual(['json', 'text'])
    // DR-017: the retry is a new request with a fresh id, not a replay of the first.
    expect(t.bodies()[0]?.id).not.toBe(t.bodies()[1]?.id)
    expect(entries).toEqual([
      { command: 'show session-config diffs', result: { output: '+  vlan 20\n-  vlan 30' }, encoding: 'text', fellBack: true },
    ])
  })

  it('a 1003 with no text answer to fall back on still throws', async () => {
    const t = mockTransport().rejects('enable', { code: EapiErrorCode.COMMAND_UNCONVERTED, message: 'no json model' })
    await expect(nodeWith(t).exec('show session-config diffs')).rejects.toThrow(CommandError)
    expect(t.callCount()).toBe(2)
  })

  it('refuses config-mode commands and never reaches the device [pyeapi test_enable_with_config_statement]', async () => {
    const t = mockTransport()
    const node = nodeWith(t)
    for (const offending of [
      'configure',
      'configure terminal',
      'configure session ui-9f2c1a7b',
      'configure replace flash:baseline',
      '  configure   ',
    ]) {
      await expect(node.exec(['show version', offending, 'hostname foo'])).rejects.toThrow(NotSupportedError)
    }
    await expect(node.exec({ cmd: 'configure terminal', input: 'hostname foo' })).rejects.toThrow(NotSupportedError)
    expect(t.callCount()).toBe(0)
  })

  it('the refusal names the offending command and keeps it in error.commands', async () => {
    const node = nodeWith(mockTransport())
    const error = await node.exec(['show version', 'configure terminal']).catch((thrown: unknown) => thrown)
    expect((error as NotSupportedError).message).toMatch(/config mode commands are not supported/)
    expect((error as NotSupportedError).message).toMatch(/'configure terminal'/)
    expect((error as NotSupportedError).commands).toEqual(['show version', 'configure terminal'])
  })

  it('but configure all <interface> … stays sendable — it is an executive-mode command', async () => {
    const t = mockTransport().replies(
      'enable\nconfigure all Ethernet1 switchport access vlan 20',
      withEnable({}),
    )
    const entries = await nodeWith(t).exec('configure all Ethernet1 switchport access vlan 20')
    expect(t.callCount()).toBe(1)
    expect(entries).toHaveLength(1)
  })
})

describe('configure — pyeapi config/_configure_terminal (client.py:590-675)', () => {
  it('prepends configure terminal and strips its reply off the answer [pyeapi test_config_with_single_command]', async () => {
    const t = mockTransport().replies('enable\nconfigure terminal\nvlan 20', [{}, {}, { c: 1 }])
    const results = await nodeWith(t).configure('vlan 20')
    expect(t.sent()).toEqual([['enable', 'configure terminal', 'vlan 20']])
    expect(results).toEqual([{ c: 1 }])
  })

  it('keeps the command order for multiple writes [pyeapi test_config_with_multiple_commands]', async () => {
    const t = mockTransport().replies(
      'enable\nconfigure terminal\ninterface Ethernet1\nswitchport mode access',
      [{}, {}, {}, {}],
    )
    await nodeWith(t).configure(['interface Ethernet1', 'switchport mode access'])
    expect(t.sent()).toEqual([
      ['enable', 'configure terminal', 'interface Ethernet1', 'switchport mode access'],
    ])
  })

  it('sends a multiline write as {cmd, input} rather than MULTILINE: text [pyeapi test_config_with_single_multiline]', async () => {
    const t = mockTransport().replies('enable\nconfigure terminal\nbanner login', [{}, {}, {}])
    await nodeWith(t).configure({ cmd: 'banner login', input: 'This is a new banner\nwith different lines!!!\nEOF\n' })
    expect(t.bodies()[0]?.params.cmds).toEqual([
      'enable',
      'configure terminal',
      { cmd: 'banner login', input: 'This is a new banner\nwith different lines!!!\nEOF\n' },
    ])
  })

  it('a config write does reach the device with a session-less enable, unlike exec', async () => {
    const t = mockTransport().replies('enable\nconfigure terminal\nhostname sw1', [{}, {}, {}])
    await nodeWith(t).configure('hostname sw1')
    expect(t.callCount()).toBe(1)
  })

  it('autorefresh on (the default) invalidates the config cache after a write [pyeapi client.py:668-669]', async () => {
    const t = mockTransport()
      .replies('enable\nconfigure terminal\nhostname sw1', [{}, {}, {}])
      .replies('enable\nshow running-config all', [{}, { output: 'hostname sw1\n!' }])
    const node = nodeWith(t)
    await node.getRunningConfig()
    await node.configure('hostname sw1')
    await node.getRunningConfig()
    expect(t.sent().filter((cmds) => cmds.includes('show running-config all'))).toHaveLength(2)
  })

  it('autorefresh off leaves the cached config alone and re-serves the stale text', async () => {
    const t = mockTransport()
      .replies('enable\nconfigure terminal\nhostname sw1', [{}, {}, {}])
      .replies('enable\nshow running-config all', [{}, { output: 'hostname old\n!' }])
    const node = nodeWith(t, { autorefresh: false })
    expect(node.autorefresh).toBe(false)
    expect(await node.getRunningConfig()).toBe('hostname old\n!')
    await node.configure('hostname sw1')
    expect(await node.getRunningConfig()).toBe('hostname old\n!')
    expect(t.sent().filter((cmds) => cmds.includes('show running-config all'))).toHaveLength(1)
  })

  it('forwards request knobs to the wire parameters (stopOnError / includeErrorDetail)', async () => {
    const t = mockTransport().replies('enable\nconfigure terminal\nvlan 20', [{}, {}, {}])
    await nodeWith(t).configure('vlan 20', { stopOnError: false, includeErrorDetail: true })
    expect(t.bodies()[0]?.params).toMatchObject({ stopOnError: false, includeErrorDetail: true })
  })

  it('a rejected write throws with the whole command list attached (DR-005, no bool return)', async () => {
    const t = mockTransport().rejects('configure terminal', {
      code: EapiErrorCode.COMMAND_UNAUTHORIZED,
      message: "CLI command 3 of 3 'vlan 4095' failed: permission denied",
    })
    const error = await nodeWith(t).configure(['vlan 4095']).catch((thrown: unknown) => thrown)
    expect(error).toBeInstanceOf(CommandError)
    expect((error as CommandError).failedCommand).toBe('vlan 4095')
    expect((error as CommandError).commands).toEqual(['enable', 'configure terminal', 'vlan 4095'])
  })

  it('configureVariants tries variants in order and keeps the first success (DR-006)', async () => {
    const t = mockTransport()
      .replies('enable\nconfigure terminal\nvrf instance mgmt', {
        error: { code: EapiErrorCode.COMMAND_INVALID, message: 'invalid input' },
      })
      .replies('enable\nconfigure terminal\nvrf definition mgmt', [{}, {}, {}])
    await nodeWith(t).configureVariants([['vrf instance mgmt'], ['vrf definition mgmt']])
    expect(t.sent()).toEqual([
      ['enable', 'configure terminal', 'vrf instance mgmt'],
      ['enable', 'configure terminal', 'vrf definition mgmt'],
    ])
  })

  it('configureVariants re-raises the LAST CommandError when every variant fails (client.py:654)', async () => {
    const t = mockTransport()
      .replies('enable\nconfigure terminal\nvrf instance mgmt', {
        error: { code: EapiErrorCode.COMMAND_INVALID, message: 'first failure' },
      })
      .replies('enable\nconfigure terminal\nvrf mgmt', {
        error: { code: EapiErrorCode.COMMAND_FAILED, message: 'last failure' },
      })
    const error = await nodeWith(t)
      .configureVariants([['vrf instance mgmt'], ['vrf mgmt']])
      .catch((thrown: unknown) => thrown)
    expect(error).toBeInstanceOf(CommandError)
    expect((error as CommandError).code).toBe(EapiErrorCode.COMMAND_FAILED)
    expect((error as CommandError).message).toMatch(/last failure/)
    expect(t.callCount()).toBe(2)
  })

  it('configureVariants does not try the next variant when the round trip itself failed', async () => {
    const t = mockTransport().connectFailure('nothing listening')
    const error = await nodeWith(t)
      .configureVariants([['vlan 20'], ['vlan 21']])
      .catch((thrown: unknown) => thrown)
    // Only a `CommandError` advances to the next spelling: a transport failure leaves the device's
    // state unknown, so variant 2 could land on top of a half-applied variant 1 (DR-019 — and a
    // config write is never re-sent, because `configure` does not set `readOnly`).
    expect(error).toBeInstanceOf(TransportError)
    expect(t.callCount()).toBe(1)
  })
})

describe('getConfig and the config accessors — pyeapi get_config/running_config/startup_config', () => {
  it('returns lines by default, exactly the way pyeapi as_string=False does [pyeapi test_get_config]', async () => {
    const t = mockTransport().replies('enable\nshow running-config', withEnable(RUNNING_CONFIG_FIXTURE))
    const lines = await nodeWith(t).getConfig({ config: 'running-config' })
    expect(t.sent()).toEqual([['enable', 'show running-config']])
    expect(t.bodies()[0]?.params.format).toBe('text')
    expect(lines).toBeInstanceOf(Array)
    expect(lines[0]).toBe('!')
    expect(lines.at(-1)).toBe('end')
  })

  it('as: string trims, as: lines does not — pyeapi strip/no-strip parity (client.py:987-989) [pyeapi test_get_config_as_string]', async () => {
    const t = mockTransport().replies(
      'enable\nshow startup-config',
      withEnable({ output: '  hostname sw1\n!\n  ' }),
    )
    const node = nodeWith(t)
    expect(await node.getConfig({ config: 'startup-config', as: 'string' })).toBe('hostname sw1\n!')
    const t2 = mockTransport().replies('enable\nshow startup-config', withEnable({ output: '  hostname sw1\n!\n  ' }))
    expect(await nodeWith(t2).getConfig({ config: 'startup-config' })).toEqual(['  hostname sw1', '!', '  '])
  })

  it('appends params to the show command [pyeapi params behaviour, client.py:982-984]', async () => {
    const t = mockTransport().replies('enable\nshow startup-config all', withEnable(RUNNING_CONFIG_FIXTURE))
    await nodeWith(t).getConfig({ config: 'startup-config', params: 'all' })
    expect(t.sent()).toEqual([['enable', 'show startup-config all']])
  })

  it('rejects a config name that is not running- or startup-config [pyeapi test_get_config_raises_type_error]', async () => {
    const node = nodeWith(mockTransport())
    // @ts-expect-error - the option is a union, so a wrong name is a compile error at the call site
    await expect(node.getConfig({ config: 'candidate-config' })).rejects.toThrow(NotSupportedError)
  })

  it('still rejects it at runtime for a caller coming from JS or a stored profile (row 36)', async () => {
    const t = mockTransport()
    const fromJs = { config: 'running-config ' } as unknown as { config: 'running-config' }
    const error = await nodeWith(t)
      .getConfig(fromJs)
      .catch((thrown: unknown) => thrown)
    expect(error).toBeInstanceOf(NotSupportedError)
    expect((error as NotSupportedError).message).toMatch(/invalid config name specified/)
    expect(t.callCount()).toBe(0)
  })

  it('getRunningConfig asks for defaults with `all` [pyeapi test_node_calls_running_config_with_all_by_default]', async () => {
    const t = mockTransport().replies('enable\nshow running-config all', withEnable(RUNNING_CONFIG_FIXTURE))
    const config = await nodeWith(t).getRunningConfig()
    expect(t.sent()).toEqual([['enable', 'show running-config all']])
    expect(config).toBe(RUNNING_CONFIG_FIXTURE.output)
  })

  it('configDefaults: false drops the `all` keyword [pyeapi test_node_calls_running_config_without_params_if_config_defaults_false]', async () => {
    const t = mockTransport().replies('enable\nshow running-config', withEnable(RUNNING_CONFIG_FIXTURE))
    await nodeWith(t, { configDefaults: false }).getRunningConfig()
    expect(t.sent()).toEqual([['enable', 'show running-config']])
  })

  it('caches the running config, serves it again without a request and re-reads after refresh() [pyeapi running_config/cached tests]', async () => {
    const t = mockTransport().replies('enable\nshow running-config all', withEnable(RUNNING_CONFIG_FIXTURE))
    const node = nodeWith(t)
    expect(await node.getRunningConfig()).toBe(RUNNING_CONFIG_FIXTURE.output)
    expect(await node.getRunningConfig()).toBe(RUNNING_CONFIG_FIXTURE.output)
    expect(t.callCount()).toBe(1)
    node.refresh()
    expect(await node.getRunningConfig()).toBe(RUNNING_CONFIG_FIXTURE.output)
    expect(t.callCount()).toBe(2)
  })

  it('caches the startup config separately from the running config [pyeapi test_node_returns_startup_config / test_node_returns_cached_startup_config]', async () => {
    const t = mockTransport()
      .replies('enable\nshow running-config all', withEnable({ output: 'hostname running\n!' }))
      .replies('enable\nshow startup-config', withEnable({ output: 'hostname startup\n!' }))
    const node = nodeWith(t)
    expect(await node.getStartupConfig()).toBe('hostname startup\n!')
    expect(await node.getStartupConfig()).toBe('hostname startup\n!')
    expect(await node.getRunningConfig()).toBe('hostname running\n!')
    expect(t.sent()).toEqual([['enable', 'show startup-config'], ['enable', 'show running-config all']])
  })

  it('refresh() clears both caches and sends nothing itself (pyeapi client.py:991-1001)', async () => {
    const t = mockTransport()
      .replies('enable\nshow running-config all', withEnable(RUNNING_CONFIG_FIXTURE))
      .replies('enable\nshow startup-config', withEnable(RUNNING_CONFIG_FIXTURE))
    const node = nodeWith(t)
    await node.getRunningConfig()
    await node.getStartupConfig()
    const before = t.callCount()
    node.refresh()
    expect(t.callCount()).toBe(before)
    await node.getRunningConfig()
    await node.getStartupConfig()
    expect(t.callCount()).toBe(before + 2)
  })

  it('a text reply with no string output is a ProtocolError, not the literal "None" pyeapi prints (row 36)', async () => {
    const t = mockTransport().replies('enable\nshow running-config', withEnable({ vlans: {} }))
    await expect(nodeWith(t).getConfig()).rejects.toThrow(/has no string 'output' member \(got nothing\)/)
    const t2 = mockTransport().replies('enable\nshow running-config', withEnable({ output: { nested: true } }))
    await expect(nodeWith(t2).getConfig()).rejects.toThrow(/has no string 'output' member \(got object\)/)
  })
})

describe('version and model — pyeapi _get_version_properties (client.py:557-575)', () => {
  it('parses the samples the upstream tests use, regexes and fallbacks included [pyeapi test_get_version_properties_match_version_number_no_match_model]', () => {
    const engineering = '4.17.1.1F-3512479.41711F (engineering build)'
    expect(parseVersionProperties({ version: engineering, modelName: 'vEOS' })).toEqual({
      version: engineering,
      versionNumber: '4.17.1.1',
      model: 'vEOS',
      modelName: 'vEOS',
    })
  })

  it('falls back to the whole string when the version does not start numerically and shortens a numbered model [pyeapi test_get_version_properties_no_match_version_number_match_model]', () => {
    const odd = 'special-4.17.1.1F-3512479.41711F (engineering build)'
    expect(parseVersionProperties({ version: odd, modelName: 'DCS-7260QX-64-F' })).toEqual({
      version: odd,
      versionNumber: odd,
      model: '7260',
      modelName: 'DCS-7260QX-64-F',
    })
  })

  it('parses the target-device sample: 4.28.13.1M on a DCS-7050TX-64', () => {
    const parsed: VersionProperties = parseVersionProperties(VERSION_FIXTURE)
    expect(parsed).toEqual({
      version: '4.28.13.1M',
      versionNumber: '4.28.13.1',
      model: '7050',
      modelName: 'DCS-7050TX-64',
    })
  })

  it('getVersion populates all three pyeapi properties in one round trip [pyeapi test_version_properties_populate]', async () => {
    const t = mockTransport().replies('enable\nshow version', withEnable(VERSION_FIXTURE))
    const node = nodeWith(t)
    expect(t.callCount()).toBe(0)
    const info = await node.getVersion()
    expect(info.versionNumber).toBe('4.28.13.1')
    expect(info.version).toBe('4.28.13.1M')
    expect(info.model).toBe('7050')
    expect(t.sent()).toEqual([['enable', 'show version']])
  })

  it('memoises the answer, where pyeapi has three lazy properties that can each re-send the command (row 35) [pyeapi test_node_returns_cached_*]', async () => {
    const t = mockTransport().replies('enable\nshow version', withEnable(VERSION_FIXTURE))
    const node = nodeWith(t)
    const first = await node.getVersion()
    const again = await node.getVersion()
    expect(again).toBe(first)
    await node.getVersion()
    expect(t.callCount()).toBe(1)
  })

  it('refresh() leaves the device identity alone, exactly as pyeapi does (client.py:991-1001)', async () => {
    const t = mockTransport().replies('enable\nshow version', withEnable(VERSION_FIXTURE))
    const node = nodeWith(t)
    await node.getVersion()
    node.refresh()
    await node.getVersion()
    expect(t.callCount()).toBe(1)
  })

  it('a reply without `version` or `modelName` is a ProtocolError, not the string "None" pyeapi prints [pyeapi str() coercion]', async () => {
    const t = mockTransport().replies('enable\nshow version', withEnable({ hostname: 'sw1' }))
    await expect(nodeWith(t).getVersion()).rejects.toThrow(/show version reply has no `version` field/)
    const t2 = mockTransport().replies('enable\nshow version', withEnable({ version: '4.28.13.1M' }))
    await expect(nodeWith(t2).getVersion()).rejects.toThrow(/no `modelName` field/)
  })

  it('coerces a numeric device field to a string, as pyeapi str() does', () => {
    expect(parseVersionProperties({ version: 4.28, modelName: 7050 }).model).toBe('7050')
  })
})

describe('enable password (DR-009) and redaction (DR-011) — pyeapi enable_authentication', () => {
  it('setEnablePassword switches the prepended enable to the {cmd, input} form [pyeapi test_enable_authentication]', async () => {
    const t = mockTransport().replies('enable\nshow version', withEnable({ hostname: 'sw1' }))
    const node = nodeWith(t)
    await node.runCommands('show version')
    node.setEnablePassword('s3cret')
    await node.runCommands('show version')
    expect(t.bodies()[0]?.params.cmds[0]).toBe('enable')
    expect(t.bodies()[1]?.params.cmds[0]).toEqual({ cmd: 'enable', input: 's3cret' })
  })

  it('an empty or whitespace password means no password, as pyeapi truthiness decides (client.py:914)', async () => {
    const t = mockTransport().replies('enable\nshow version', withEnable({}))
    const node = new Node(t, { enablePassword: 'hunter2' })
    node.setEnablePassword('   ')
    await node.runCommands('show version')
    expect(t.bodies()[0]?.params.cmds[0]).toBe('enable')
  })

  it('trims the password the way enable_authentication does (client.py:588)', async () => {
    const t = mockTransport().replies('enable\nshow version', withEnable({}))
    const node = nodeWith(t)
    node.setEnablePassword('  aligned  ')
    await node.runCommands('show version')
    expect(t.bodies()[0]?.params.cmds[0]).toEqual({ cmd: 'enable', input: 'aligned' })
  })

  it('the password is on the wire untouched but never in an error, a serialisation or toString() (DR-011)', async () => {
    const t = mockTransport().rejects('enable', {
      code: EapiErrorCode.COMMAND_FAILED,
      message: "CLI command 1 of 2 'enable' failed: invalid input\ninput='hunter2'",
      data: [{ cmd: 'enable', input: 'hunter2' }],
    })
    const node = new Node(t, { enablePassword: 'hunter2' })
    const error = await node.exec('show version').catch((thrown: unknown) => thrown)
    expect(error).toBeInstanceOf(CommandError)
    const dumped = JSON.stringify([error, node.toString()])
    expect(dumped).not.toContain('hunter2')
    expect(dumped).toContain('<redacted>')
    expect((error as CommandError).message).not.toContain("'hunter2'")
    expect(node.toString()).toBe('Node(connection=MockTransport(mock://device))')
  })
})

describe('the typed show shell (ARCHITECTURE §9.1 — extension point the webui builds on)', () => {
  it('show(literal) adds the show prefix the contract map is keyed on (USAGE §4)', async () => {
    const t = mockTransport().replies('enable\nshow version', withEnable(VERSION_FIXTURE))
    const reply = await nodeWith(t).show('version')
    expect(t.sent()).toEqual([['enable', 'show version']])
    expect(reply).toEqual(VERSION_FIXTURE)
  })

  it('does not double a prefix the caller already wrote', async () => {
    const t = mockTransport().replies('enable\nshow version', withEnable(VERSION_FIXTURE))
    await nodeWith(t).show('show version')
    expect(t.sent()).toEqual([['enable', 'show version']])
  })

  it('a revision option becomes the command object form (JsonCli.py:36-39)', async () => {
    const t = mockTransport().replies('enable\nshow mlag', withEnable({}))
    await nodeWith(t).show('mlag', { revision: 3 })
    expect(t.bodies()[0]?.params.cmds).toEqual(['enable', { cmd: 'show mlag', revision: 3 }])
  })

  it('reads default to readOnly, so a ConnectError that never reached the device may be re-sent once (DR-019)', async () => {
    const t = mockTransport().connectFailure('refused')
    await expect(nodeWith(t).show('version')).rejects.toThrow(TransportError)
    expect(t.callCount()).toBe(2)
  })

  it('showText forces format:text and returns the device text (DR-012)', async () => {
    const t = mockTransport().replies('enable\nshow session-config diffs', withEnable({ output: '+  vlan 20' }))
    const text = await nodeWith(t).showText('session-config diffs')
    expect(t.bodies()[0]?.params.format).toBe('text')
    expect(t.sent()).toEqual([['enable', 'show session-config diffs']])
    expect(text).toBe('+  vlan 20')
  })

  it('showText on a reply with no text member is a ProtocolError naming the command', async () => {
    const t = mockTransport().replies('enable\nshow version', withEnable({ hostname: 'sw1' }))
    await expect(nodeWith(t).showText('version')).rejects.toThrow(/show version/)
  })
})

describe('the Node surface itself (pyeapi Node.__init__ / __str__ / connection)', () => {
  it('exposes the transport as a readonly connection [pyeapi test_node_hasattr_connection]', () => {
    const t = mockTransport()
    const node = new Node(t)
    expect(node.connection).toBe(t)
    expect(node.connection.kind).toBe('mock')
  })

  it('stringifies like pyeapi and never leaks a credential [pyeapi test_node_str_returns / test_node_repr_returns]', () => {
    const node = new Node(mockTransport(), { enablePassword: 'p@ss' })
    expect(node.toString()).toContain('Node(connection=')
    expect(node.toString()).not.toContain('p@ss')
  })

  it('keeps the resolved settings visible the way pyeapi keeps **kwargs', () => {
    const node = new Node(mockTransport(), { autorefresh: false, configDefaults: false })
    expect(node.settings).toEqual({ autorefresh: false, configDefaults: false })
    expect(node.autorefresh).toBe(false)
    expect(node.configDefaults).toBe(false)
  })

  it('refuses a connection that is not a Transport at construction time, not on first use', () => {
    const notATransport = { kind: 'mock' } as unknown as Transport
    expect(() => new Node(notATransport)).toThrow(TypeError)
    expect(() => new Node(notATransport)).toThrow(/Node requires a Transport/)
  })

  it('close() releases the transport, so a session kind logs out instead of lingering (DR-018)', async () => {
    const t = mockTransport()
    const node = nodeWith(t)
    await node.close()
    await expect(node.runCommands('show version')).rejects.toThrow(/closed/)
  })

  it('forwards the per-call transport knobs (timeoutMs, signal) and keeps its own sendEnable off the wire', async () => {
    const seen: TransportExecOptions[] = []
    const inner = mockTransport().replies('show version', [{ hostname: 'sw1' }])
    const spy: Transport = {
      kind: 'mock',
      address: inner.address,
      async execute(commands, options) {
        seen.push(options ?? {})
        return inner.execute(commands, options)
      },
      close: () => inner.close(),
      toString: () => inner.toString(),
    }
    await new Node(spy).show('version', { timeoutMs: 1234, signal: AbortSignal.abort(), sendEnable: false })
    // `sendEnable` is this layer's knob: it decides whether `enable` is prepended, and the transport
    // and the codec never see it (a stray key would trip `buildRequest`'s parameter allow-list, DR-016).
    expect(seen[0]).toMatchObject({ timeoutMs: 1234 })
    expect(seen[0]).not.toHaveProperty('sendEnable')
    expect(seen[0]?.signal?.aborted).toBe(true)
    expect(inner.sent()).toEqual([['show version']])
  })
})

describe('type-level contract (PLAN M4: narrowing, and unknown for an un-modelled command)', () => {
  const node = new Node(mockTransport())

  // Every assertion below is written in **type position**. `expectTypeOf(node.show('version'))` would
  // narrow correctly but its argument is still *evaluated* at runtime, so it would put an unscripted
  // request on the mock and surface as an unhandled rejection — the suite must stay honest about that.
  // `version` / `lag counters` are the keys the consumer augmentation in `src/types/eapi.test.ts`
  // declares; `ShowReply<'…'>` is the same map the method resolves against.
  it('a command literal in the map narrows to that reply, exactly', () => {
    expectTypeOf<Exactly<Awaited<ReturnType<typeof node.show<'version'>>>, ShowContracts['version']>>().toEqualTypeOf<true>()
    expectTypeOf<Exactly<Awaited<ReturnType<typeof node.show<'lag counters'>>>, ShowContracts['lag counters']>>().toEqualTypeOf<true>()
    // The map value itself is a **readonly array**, which is exactly the shape vitest's branded
    // `toEqualTypeOf` cannot be handed as a type argument (TS4104) — the identity helper can, and it
    // also pins the consumer's member names, so a reply that drifted to `unknown[]` or `any[]` fails.
    expectTypeOf<Exactly<ShowReply<'lag counters'>, readonly { readonly lagName: string; readonly totalInOctets: number }[]>>().toEqualTypeOf<true>()
    expectTypeOf<ShowReply<'version'>>().not.toBeUnknown()
  })

  it('a command literal nobody modelled is unknown, never any — and not assignable to a shaped reply', () => {
    // `'vlan 20'` is the honest half of PLAN M4's "`show('vlan 20')` → …": the map addresses whole
    // literals, so a parameterised command is typed only if a consumer declares that exact literal
    // (ARCHITECTURE §9.1); otherwise it is `unknown` and the caller narrows on purpose (DR-006).
    for (const unmodelled of ['vlan 20', 'vlan 30', 'mlag', 'show version']) {
      expectTypeOf<ShowReply<typeof unmodelled>>().toEqualTypeOf<unknown>()
    }
    expectTypeOf<Exactly<Awaited<ReturnType<typeof node.show<'vlan 30'>>>, unknown>>().toEqualTypeOf<true>()
    expectTypeOf<Awaited<ReturnType<typeof node.show<'vlan 30'>>>>().toBeUnknown()
    expectTypeOf<Awaited<ReturnType<typeof node.show<'vlan 30'>>>>().not.toBeAny()
    expectTypeOf<ShowReply<'mlag'>>().toEqualTypeOf<unknown>()
    // @ts-expect-error - `unknown` cannot be used as if a contract existed for this command
    const unmodelledReply: { vlan: unknown } = null as unknown as ShowReply<'vlan 30'>
    expect(unmodelledReply).toBeNull()
    // And the modelled half does resolve to the consumer's shape, so `show` is not leaking `unknown`
    // for keys that *are* in the map.
    const modelledReply: ShowContracts['version'] = null as unknown as ShowReply<'version'>
    expect(modelledReply).toBeNull()
  })

  it('the augmentation is visible through the re-export the method uses', () => {
    // Cross-file by design: `src/types/eapi.test.ts` declares the keys, this file proves `show` reads
    // the same map rather than inventing its own answer type.
    expectTypeOf<Exactly<ShowReply<'version'>, ShowContracts['version']>>().toEqualTypeOf<true>()
    expectTypeOf<Awaited<ReturnType<typeof node.show<'version'>>>>().not.toBeUnknown()
  })

  it('exec entries have exactly the DR-007 fields and runCommands yields the raw reply array', () => {
    expectTypeOf<Exactly<Awaited<ReturnType<typeof node.exec>>, readonly ExecResult[]>>().toEqualTypeOf<true>()
    expectTypeOf<Exactly<Awaited<ReturnType<typeof node.runCommands>>, readonly CommandResult[]>>().toEqualTypeOf<true>()
    expectTypeOf<ExecResult['fellBack']>().toEqualTypeOf<boolean>()
    expectTypeOf<ExecResult['encoding']>().toEqualTypeOf<'json' | 'text'>()
  })

  it('the config accessors answer with the shape they promise', () => {
    // `as: 'string'` vs `as: 'lines'` is resolved through the method's own type parameter, and the
    // readonly-array form goes through `Exactly` (the precedent in `src/internal/wire.test.ts`).
    // The *default* (`TAs = 'lines'`) is proven at runtime by "returns lines by default" above:
    // `ReturnType` of an uninstantiated generic falls back to the type parameter's constraint, so
    // asserting the default here would compare against `string | readonly string[]` instead.
    expectTypeOf<Awaited<ReturnType<typeof node.getConfig<'string'>>>>().toEqualTypeOf<string>()
    expectTypeOf<Exactly<Awaited<ReturnType<typeof node.getConfig<'lines'>>>, readonly string[]>>().toEqualTypeOf<true>()
    expectTypeOf<Awaited<ReturnType<typeof node.getConfig<'string'>>>>().not.toEqualTypeOf<readonly string[]>()
    expectTypeOf<Awaited<ReturnType<typeof node.getRunningConfig>>>().toEqualTypeOf<string>()
    expectTypeOf<Awaited<ReturnType<typeof node.getStartupConfig>>>().toEqualTypeOf<string>()
  })

  it('getVersion answers all four identity fields, and configure returns no boolean to check (DR-005)', () => {
    expectTypeOf<Awaited<ReturnType<typeof node.getVersion>>>().toEqualTypeOf<VersionProperties>()
    expectTypeOf<Exactly<Awaited<ReturnType<typeof node.configure>>, readonly CommandResult[]>>().toEqualTypeOf<true>()
    expectTypeOf<Awaited<ReturnType<typeof node.configure>>>().not.toEqualTypeOf<boolean>()
    expectTypeOf<ReturnType<typeof node.refresh>>().toEqualTypeOf<void>()
  })

  it('the options bags are closed: a pyeapi kwarg or a positional flag does not compile', () => {
    // Written inside a function that is never called, so the compile-time refusal is asserted without
    // putting a bogus request on the wire (`void` keeps noUnusedLocals honest).
    const neverSent = () => {
      // @ts-expect-error - `enablepwd`/`send_enable` are pyeapi's names; the closed bag rejects them (row 31)
      node.exec('show version', { enablepwd: 'x', send_enable: false })
      // @ts-expect-error - one options object, never positional flags (MIGRATION.md §4)
      node.exec('show version', 'json', true, false)
      // @ts-expect-error - a Node is built from a Transport, not from a connection/profile bag
      new Node({ host: 'sw1' })
      // @ts-expect-error - `show` decides the encoding, so `format` is not an option here (row 31)
      node.show('version', { format: 'text' })
    }
    void neverSent
  })
})
