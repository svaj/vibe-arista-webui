/**
 * `SystemResource` — M8 (#10), the first wave-1 module on the M7 framework.
 * Driven entirely through `MockTransport` over the real `Node` (`node.system`), so every read answer is a
 * device text and every write answer is an exact `cmds` list (docs/TESTING.md §3).
 *
 * ## Upstream port ledger
 *
 * `pyeapi/test/unit/test_api_system.py` has **5** tests (counted by AST on 2026-11-03; `docs/TESTING.md`
 * §6 already says 5, `docs/PLAN.md` §M8 says 7 and is wrong): `test_get` (`:50-55`), `test_set_hostname`
 * (`:57-69`), `test_set_iprouting` (`:71-82`), `test_set_banner` (`:84-89`),
 * `test_set_banner_default_disable` (`:91-99`). All five are ported below and the command texts they pin
 * are reproduced verbatim: `hostname <v>` / `no hostname` / `default hostname` (`:61`/`:64`/`:67`),
 * `ip routing` / `no ip routing` / `default ip routing` (`:74`/`:77`/`:80`), `default banner motd` /
 * `no banner motd` (`:94`/`:98`). Upstream's `test_get` (`:51`) pins the key set to exactly
 * `['hostname', 'iprouting', 'banner_login', 'banner_motd']`; ours groups the banners and reads `exec`
 * (divergences 3 and 8 in `system.ts`).
 *
 * Upstream's **answers** were probed by running its own regexes/rules from the pinned clone on
 * 2026-11-03, not read off its docstrings:
 *  - `system.py:81` supplies the literal `'localhost'` when `:82`'s `^hostname ([^\s]+)$` misses — and it
 *    misses for `hostname `, for `hostname sw1 ` (trailing space) and for `hostname "lab sw1"`.
 *  - `system.py:82` scans the whole config with `re.M`, so a `hostname …` line inside a banner body is
 *    read as the device's name (probe over `banner motd\nhostname frombanner\nEOF\n` → `'frombanner'`).
 *    The hostname, the routing flag and the banners are all read here from the **chunked** document, whose
 *    indent-0 keys cannot be confused by banner bodies (`config/chunk.ts`, `client.py:741-747`).
 *  - `system.py:94` is a whole-document substring test: over a config whose banner body recites
 *    `no ip routing`, it answers `iprouting: False` (probe) — as it does for an indented copy.
 *  - `system.py:108`: `banner exec…` → no match (the class is `login|motd`); `banner motd\nhi\nEOF` (no
 *    newline after `EOF`) → no match; `banner motd  ` (two trailing spaces) → no match;
 *    `banner motd\n\nEOF\n` → `''`; `banner motd\nEOF\n` → **nothing**; an indented opener → no match; and
 *    the 9-space line inside `test/fixtures/running_config.text:407-417`'s `banner login` body survives.
 *  - `system.py:107` defaults both banner values to `None` and `:116` always emits both keys; `:177` raises `AttributeError`
 *    (`'NoneType' object has no attribute 'endswith'`) for `set_banner('motd', None)`.
 *
 * Anything about EOS itself — the maximum hostname length, whether the CLI rejects a leading digit,
 * whether it quotes a hostname in config text, how it matches the `EOF` terminator or treats a CR inside a
 * banner body — is **not** claimed here: this workspace has no readable image sources and unit tests never
 * reach a device, so those notes read "unverified on hardware, M12 (#14) to capture".
 *
 * `MockTransport` key strings below are whole joined command lists (`testing/mock-transport.ts:167`),
 * except where a single-line matcher (`'configure terminal'`) deliberately catches any batch containing it.
 */

import { describe, expect, it } from 'vitest'

import { Node } from '../command-layer'
import { CommandError, EapiErrorCode, NotSupportedError } from '../errors'
import { mockTransport, type MockTransport } from '../testing/mock-transport'
import { SystemResource } from './system'
import type { CommandSpec } from '../types/eapi'

/** Join lines into config text so a whitespace-only or trailing-space line cannot be lost to an editor. */
const textOf = (lines: readonly string[]): string => lines.join('\n')

/** The "realistic minimal 4.28" read: hostname, no `ip routing` line, no banners, one management iface. */
const MINIMAL_428 = textOf([
  '!',
  '! Last configuration change at 14:02:11 UTC Mon Nov  3 2026 by admin',
  '!',
  'hostname lab-sw1',
  '!',
  'interface Management1',
  '   ip address dhcp',
  '!',
  'end',
])

/** A fuller document: `no ip routing`, a motd with a blank line inside it, a login banner carrying quotes. */
const LAB_CONFIG = textOf([
  '!',
  'hostname lab-sw1',
  '!',
  'no ip routing',
  '!',
  'banner motd',
  'Authorized access only.',
  'All activity is logged.',
  '',
  'Questions? noc@example.com',
  'EOF',
  'banner login',
  '"Keep out" - the switch said it first',
  'EOF',
  '!',
  'vlan 20',
  '   name PROD',
  '!',
  'end',
])

/** One line of the pinned upstream fixture, byte for byte (`pyeapi/test/fixtures/running_config.text:410`). */
const NINE_SPACES = '         '

/** The `banner login` + `banner motd` blocks of upstream's own fixture, copied exactly (`:407-421`). */
const UPSTREAM_FIXTURE = textOf([
  'banner login',
  '+++++++++++++++++++++++++++++++++++++++++',
  '              banner:',
  NINE_SPACES,
  'vlan 1',
  'this',
  'is the loging ban',
  'that would b emult',
  'EOF',
  'banner motd',
  'this text',
  'can be multine',
  'EOF',
])

/** What `system.py:108` actually captures for that fixture (probe) — the parity target, kept verbatim. */
const UPSTREAM_LOGIN_BODY = [
  '+++++++++++++++++++++++++++++++++++++++++',
  '              banner:',
  NINE_SPACES,
  'vlan 1',
  'this',
  'is the loging ban',
  'that would b emult',
].join('\n')

function transportFor(config: string): MockTransport {
  return mockTransport().replies('enable\nshow running-config all', [{}, { output: config }])
}

function nodeFor(config: string): { node: Node; transport: MockTransport } {
  const transport = transportFor(config)
  return { node: new Node(transport), transport }
}

/** The subject, reached the way a caller reaches it: the `Node`'s static accessor. */
function systemFor(config: string): SystemResource {
  return nodeFor(config).node.system
}

/** Every command that reached the wire, command objects flattened to their `cmd` for comparison. */
function sentCmds(transport: MockTransport): readonly (readonly string[])[] {
  return transport.sent().map((cmds) => cmds.map((command) => (typeof command === 'string' ? command : command.cmd)))
}

/** The raw wire commands of the first request — the shape a banner `{cmd, input}` has to match exactly. */
function firstCmds(transport: MockTransport): readonly CommandSpec[] {
  return transport.bodies()[0]?.params.cmds ?? []
}

/**
 * The `{cmd, input}` command object of request `index` (default: the only one), asserted to exist — a
 * banner write is a two-part story and `input` is the half under test, so a missing request has to fail
 * with a message rather than an `undefined` property read.
 */
function bannerOf(transport: MockTransport, index = 0): { cmd: string; input: string } {
  const command = transport.sent()[index]?.[2]
  if (typeof command !== 'object' || command === null || typeof command.input !== 'string') {
    throw new Error(`expected request ${String(index)} to carry a {cmd, input} banner, got ${JSON.stringify(command)}`)
  }
  return { cmd: command.cmd, input: command.input }
}

/** Run a verb and report either the resolution or the thrown value, so refusals can be asserted per input. */
async function outcome(fn: () => Promise<unknown>): Promise<unknown> {
  return fn().then(() => 'resolved' as const, (thrown: unknown) => thrown)
}

describe('SystemResource.get — pyeapi api/system.py:57-115', () => {
  it('answers hostname, ipRouting and banner from ONE running-config (upstream pays one read per field)', async () => {
    const { node, transport } = nodeFor(LAB_CONFIG)
    expect(await node.system.get()).toEqual({
      hostname: 'lab-sw1',
      ipRouting: false,
      banner: {
        motd: 'Authorized access only.\nAll activity is logged.\n\nQuestions? noc@example.com',
        login: '"Keep out" - the switch said it first',
      },
    })
    // pyeapi's `get` merges three `_parse_*` one-key dicts (`system.py:67-70`) and each reader re-reads
    // `self.config` (`:82`, `:94`, `:109`) — one `show running-config` per field (MIGRATION §5 row 15).
    // Here the text and its chunked sections both come off the Node's DR-026 memo.
    expect(transport.bodies()).toHaveLength(1)
    expect(firstCmds(transport)).toEqual(['enable', 'show running-config all'])
  })

  it('a bare minimal 4.28 config still answers a record: hostname, routing enabled, no banners', async () => {
    // Absence of `no ip routing` means enabled — upstream's default (`system.py:94`). That EOS ships with
    // routing enabled is an M12 (#14) capture, not a claim of this test.
    expect(await systemFor(MINIMAL_428).get()).toEqual({ hostname: 'lab-sw1', ipRouting: true, banner: {} })
  })

  it('`no ip routing` on its own top-level line answers false (the rule at system.py:94)', async () => {
    expect((await systemFor(textOf(['hostname sw1', 'no ip routing', '!'])).get()).ipRouting).toBe(false)
  })

  it('`ip routing` written explicitly answers true', async () => {
    expect((await systemFor(textOf(['hostname sw1', 'ip routing', '!'])).get()).ipRouting).toBe(true)
  })

  it('a banner body reciting `no ip routing` does not turn routing off in the read (upstream says it does)', async () => {
    const config = textOf(['hostname sw1', 'banner motd', 'no ip routing', 'EOF', '!', 'end'])
    expect((await systemFor(config).get()).ipRouting).toBe(true)
    // Probe of upstream's rule over that same text: `'no ip routing' not in self.config` (`system.py:94`)
    // is a substring test with no anchor at all, so it answers False.
    expect(config.includes('no ip routing')).toBe(true)
  })

  it('an indented `no ip routing` is not the global command (upstream\'s substring test counts it)', async () => {
    const config = textOf(['hostname sw1', 'router bgp 65001', '   no ip routing', '!', 'end'])
    expect((await systemFor(config).get()).ipRouting).toBe(true)
    expect(config.includes('   no ip routing')).toBe(true) // what `system.py:94` effectively tests
  })

  it('a config with no readable hostname answers an empty one, not pyeapi\'s invented localhost (system.py:81)', async () => {
    const settings = await systemFor(textOf(['!', 'ip routing', '!', 'end'])).get()
    expect(settings.hostname).toBe('')
    expect(settings.banner).toEqual({})
    // Upstream's fallback is a literal in the reader: `value = 'localhost'` before the search (`:81`).
  })

  it('a banner body naming a hostname does not name the switch (upstream reads it as the hostname)', async () => {
    const config = textOf(['!', 'banner motd', 'hostname frombanner', 'EOF', '!', 'end'])
    const settings = await systemFor(config).get()
    expect(settings.hostname).toBe('')
    expect(settings.banner).toEqual({ motd: 'hostname frombanner' })
    // Probe of upstream over the same text: `re.search(r'^hostname ([^\s]+)$', self.config, re.M)`
    // (`system.py:82`) answers `'frombanner'`, because a banner body is written at column 0.
  })

  it('a hostname line with a trailing space still reads here, where upstream\'s `$` refuses it', async () => {
    // Upstream: `hostname sw1 ` does not match `^hostname ([^\s]+)$` — Python's `$` under `re.M` is a line
    // end, not a position before trailing spaces — so it answers the `'localhost'` fallback (probe).
    // Here the chunker `rstrip`s each section key (`client.py:741`), so the line is a readable hostname.
    expect((await systemFor(textOf(['hostname sw1 ', '!', 'end'])).get()).hostname).toBe('sw1')
  })

  it('the first hostname line wins, matching re.search (system.py:82)', async () => {
    expect((await systemFor(textOf(['hostname first', 'hostname second', 'end'])).get()).hostname).toBe('first')
  })

  it('a quoted hostname reads through unquote; upstream\'s single-token class cannot read it at all', async () => {
    // Probe: `^hostname ([^\s]+)$` (`system.py:82`) over `hostname "lab sw1"` misses and the reader
    // returns the `'localhost'` fallback (`:81`). Whether EOS ever quotes a hostname is unverified on
    // hardware, M12 (#14) — this case pins what this client does with the text it was given.
    expect((await systemFor(textOf(['hostname "lab sw1"', 'end'])).get()).hostname).toBe('lab sw1')
  })

  it('banner bodies keep every byte of upstream\'s own fixture: the 9-space line, the quotes, the newlines', async () => {
    const banner = (await systemFor(UPSTREAM_FIXTURE).get()).banner
    expect(banner.login).toBe(UPSTREAM_LOGIN_BODY)
    expect(banner.motd).toBe('this text\ncan be multine')
    // Upstream's `re.findall` over that fixture captures these same two values (`system.py:108-113`),
    // which is what makes this a parity assertion rather than a guess. A `parseConfigBlock`/`describeLine`
    // pass would have rstripped the 9-space line to '' — see this module's header note.
    expect(banner.login).toContain(`${NINE_SPACES}\nvlan 1`)
  })

  it('banner exec is read; upstream\'s character class admits only login and motd (system.py:108)', async () => {
    const config = textOf(['hostname sw1', 'banner exec', 'echo hello from exec', 'EOF', 'end'])
    expect((await systemFor(config).get()).banner).toEqual({ exec: 'echo hello from exec' })
    // Probe of upstream's regex over the same text: no match, so `get()` has no exec key — and its
    // `test_get` pins the four-key answer (`test_api_system.py:51`).
  })

  it('an unterminated banner block is not reported (no EOF line means no claim)', async () => {
    // The chunker keeps swallowing to the end of the document (`client.py:741-747`) and upstream's regex
    // refuses an unterminated block outright (`system.py:108`).
    const config = textOf(['hostname sw1', 'banner motd', 'this never ended', '!'])
    expect((await systemFor(config).get()).banner).toEqual({})
  })

  it('a banner opener with nothing after it is an empty section, not a banner and not a parse failure', async () => {
    // `client.py:747` creates the key as soon as the opener is seen, so the section exists with only its
    // header line. `bannerBodyFrom` refuses it for want of an `EOF`, while the other two fields still read.
    const settings = await systemFor(textOf(['hostname sw1', 'banner motd'])).get()
    expect(settings.banner).toEqual({})
    expect(settings.hostname).toBe('sw1')
    expect(settings.ipRouting).toBe(true)
  })

  it('a banner whose EOF is the last line of the config is still read (upstream loses it: it needs a newline after EOF)', async () => {
    // `Node.getRunningConfig()` trims the device text (`getConfig({ as: 'string' })`, pyeapi parity at
    // `client.py:986-987`), so an EOF with no following newline is reachable here even though EOS writes
    // `!` / `end` after it. Probe: `banner motd\nhi\nEOF` gives upstream no match (`system.py:108`).
    const config = textOf(['hostname sw1', 'banner motd', 'hi', 'EOF'])
    expect((await systemFor(config).get()).banner).toEqual({ motd: 'hi' })
  })

  it('present-but-empty and absent are different answers (upstream conflates one of them)', async () => {
    const blank = textOf(['hostname sw1', 'banner motd', '', 'EOF', 'end'])
    expect((await systemFor(blank).get()).banner).toEqual({ motd: '' })
    // Probe: upstream captures `''` for that form but captures nothing for `banner motd\nEOF\n`
    // (`system.py:108`), which reports identically to "the switch has no such banner" (`:107`'s `None`).
    const bare = textOf(['hostname sw1', 'banner motd', 'EOF', 'end'])
    expect((await systemFor(bare).get()).banner).toEqual({ motd: '' })
    expect((await systemFor(textOf(['hostname sw1', 'end'])).get()).banner).toEqual({})
  })

  it('a repeated banner kind keeps the last block (upstream overwrites in a loop, system.py:110-114)', async () => {
    const config = textOf(['hostname sw1', 'banner motd', 'first', 'EOF', 'banner motd', 'second', 'EOF', 'end'])
    expect((await systemFor(config).get()).banner).toEqual({ motd: 'second' })
    // Same answer by a different route: the chunker keys both blocks `banner motd` and the second `set`
    // replaces the first (`client.py:747`), so the earlier body is not in the document at all.
  })

  it('an indented banner opener is not a global banner block (parity with system.py:108, and the chunker agrees)', async () => {
    const config = textOf(['hostname sw1', 'router bgp 65001', '   banner motd', 'nested', 'EOF', 'end'])
    expect((await systemFor(config).get()).banner).toEqual({})
    // Upstream's `^banner` under re.M does not match the indented form either, and
    // `test/fixtures/config/banner-indented-not-multiline.conf` records that the chunker keys such an
    // opener as an ordinary indented line, not a multiline block.
  })

  it('a failed running-config read rejects rather than answering a blank record (four states, USAGE.md §7)', async () => {
    const transport = mockTransport().rejects('show running-config all', {
      code: EapiErrorCode.COMMAND_INVALID,
      message: "CLI command 2 of 2 'show running-config all' failed: invalid input",
    })
    const thrown = await outcome(() => new Node(transport).system.get())
    expect(thrown).toBeInstanceOf(CommandError)
    expect((thrown as CommandError).failedCommand).toBe('show running-config all')
  })
})

describe('SystemResource hostname writes — system.py:118-134 plus the validation upstream does not have', () => {
  it('setHostname / unsetHostname / defaultHostname emit the three forms upstream\'s loop asserts', async () => {
    const transport = mockTransport()
      .replies('enable\nconfigure terminal\nhostname core-sw1', [{}, {}, {}])
      .replies('enable\nconfigure terminal\nno hostname', [{}, {}, {}])
      .replies('enable\nconfigure terminal\ndefault hostname', [{}, {}, {}])
    const system = new Node(transport).system
    await system.setHostname('core-sw1')
    await system.unsetHostname()
    await system.defaultHostname()
    expect(sentCmds(transport)).toEqual([
      ['enable', 'configure terminal', 'hostname core-sw1'],
      ['enable', 'configure terminal', 'no hostname'],
      ['enable', 'configure terminal', 'default hostname'],
    ])
    // `test_api_system.py:61`/`:64`/`:67` pin the same three strings after `configure terminal`.
  })

  it('refuses a name that cannot read back, before anything reaches the wire (pyeapi checks nothing, system.py:118-134)', async () => {
    const transport = transportFor(MINIMAL_428)
    const system = new Node(transport).system
    const illegal: readonly [unknown, RegExp][] = [
      ['1sw1', /may not start with a digit/],
      ['sw 1', /single token/],
      ['sw1\nhostname evil', /single token/],
      ['sw1\u0007evil', /single token/],
      ['sw1\u007f', /single token/],
      ['  sw1', /single token/],
      ['', /empty hostname is refused/],
      ['   ', /empty hostname is refused/],
      ['lab"sw', /cannot round-trip/],
      [7, /expected a string hostname/],
      [undefined, /expected a string hostname/],
    ]
    for (const [value, message] of illegal) {
      const thrown = await outcome(() => system.setHostname(value as string))
      expect(thrown, `setHostname(${String(value)})`).toBeInstanceOf(NotSupportedError)
      expect((thrown as Error).message).toContain('invalid hostname')
      expect((thrown as Error).message).toMatch(message)
    }
    // Every refusal is client-side, and the rejected value is named — validators.ts's pattern (DR-053) —
    // so an error panel can say what to fix. Nothing reached the device, unlike pyeapi, which formats
    // whatever arrives into `hostname …` at `:132`.
    expect(transport.sent()).toEqual([])
  })

  it('the length bound is a client policy with the EOS figure left to M12, and is generous on purpose', async () => {
    const allowed = 'a'.repeat(128)
    const transport = mockTransport().replies(`enable\nconfigure terminal\nhostname ${allowed}`, [{}, {}, {}])
    const system = new Node(transport).system
    const tooLong = await outcome(() => system.setHostname('a'.repeat(129)))
    expect((tooLong as Error).message).toMatch(/at most 128 characters/)
    expect((tooLong as Error).message).toMatch(/unverified on hardware, M12 \(#14\) to capture/)
    await system.setHostname(allowed)
    // Exactly one write reached the wire, and it is the 128-character name — the bound refuses only
    // clearly oversized input, leaving the device the authority on its real limit (DR-032).
    expect(sentCmds(transport)).toEqual([['enable', 'configure terminal', `hostname ${allowed}`]])
  })

  it('a device refusal rejects with CommandError and the failed command, never a false (DR-005)', async () => {
    const transport = mockTransport().rejects('configure terminal', {
      code: EapiErrorCode.COMMAND_INVALID,
      message: "CLI command 3 of 3 'hostname core-sw1' failed: invalid input",
    })
    const thrown = await outcome(() => new Node(transport).system.setHostname('core-sw1'))
    expect(thrown).not.toBe('resolved')
    expect(thrown).toBeInstanceOf(CommandError)
    expect((thrown as CommandError).failedCommand).toBe('hostname core-sw1')
    expect((thrown as CommandError).commands).toEqual(['enable', 'configure terminal', 'hostname core-sw1'])
    // pyeapi answers `False` here and parks the device's text on `connection.error` (`abstract.py:117-127`).
  })
})

describe('SystemResource ip routing writes — system.py:136-155', () => {
  it('setIpRouting(true) emits the bare command; setIpRouting(false) the no form (system.py:151-152)', async () => {
    const transport = mockTransport()
      .replies('enable\nconfigure terminal\nip routing', [{}, {}, {}])
      .replies('enable\nconfigure terminal\nno ip routing', [{}, {}, {}])
    const system = new Node(transport).system
    await system.setIpRouting(true)
    await system.setIpRouting(false)
    expect(sentCmds(transport)).toEqual([
      ['enable', 'configure terminal', 'ip routing'],
      ['enable', 'configure terminal', 'no ip routing'],
    ])
    // Upstream answers the same two strings for `set_iprouting(True)` / `set_iprouting(False)`
    // (`test_api_system.py:74`/`:77`) only because of its `if value is False` special case, which DR-037
    // bans everywhere else in this client — so `false` is translated to a mode, not passed as a value.
  })

  it('unsetIpRouting and defaultIpRouting are the no/default modes (test_api_system.py:77, :80)', async () => {
    const transport = mockTransport()
      .replies('enable\nconfigure terminal\nno ip routing', [{}, {}, {}])
      .replies('enable\nconfigure terminal\ndefault ip routing', [{}, {}, {}])
    const system = new Node(transport).system
    await system.unsetIpRouting()
    await system.defaultIpRouting()
    expect(sentCmds(transport)).toEqual([
      ['enable', 'configure terminal', 'no ip routing'],
      ['enable', 'configure terminal', 'default ip routing'],
    ])
  })

  it('refuses a non-boolean instead of reaching pyeapi\'s deprecated fall-through (abstract.py:158-161)', async () => {
    const transport = transportFor(MINIMAL_428)
    const system = new Node(transport).system
    for (const value of [0, '', 'false', null, undefined]) {
      const thrown = await outcome(() => system.setIpRouting(value as unknown as boolean))
      expect(thrown, `setIpRouting(${String(value)})`).toBeInstanceOf(NotSupportedError)
      expect((thrown as Error).message).toMatch(/expected true or false/)
      // Upstream would have produced `no ip routing` for `0`/`''`/None through `elif value:` / the
      // deprecated `'no %s'` line, i.e. a negation nobody asked for.
      expect(transport.sent()).toEqual([])
    }
  })
})

describe('SystemResource banner writes — system.py:157-181, DR-015 payload shape', () => {
  it('setBanner sends {cmd, input} with the EOF terminator and the body verbatim', async () => {
    const transport = mockTransport().replies('enable\nconfigure terminal\nbanner motd', [{}, {}, {}])
    await new Node(transport).system.setBanner('motd', 'Authorized access only.\nAll activity is logged.')
    expect(firstCmds(transport)).toEqual([
      'enable',
      'configure terminal',
      { cmd: 'banner motd', input: 'Authorized access only.\nAll activity is logged.\nEOF\n' },
    ])
    // pyeapi sends `input = value (+ "\n" if missing)` with no EOF at all (`system.py:177-179`), pinned by
    // `test_api_system.py:88` as `[dict(cmd='banner motd', input=banner_value)]`. DR-015's shape closes the
    // block, so the terminator belongs to the client (divergence 6).
  })

  it('a caller-supplied trailing newline folds into the terminator instead of doubling it', async () => {
    const transport = mockTransport()
      .replies('enable\nconfigure terminal\nbanner login', [{}, {}, {}])
      .replies('enable\nconfigure terminal\nbanner login', [{}, {}, {}])
    const system = new Node(transport).system
    await system.setBanner('login', 'keep out\n')
    await system.setBanner('login', 'keep out')
    expect(bannerOf(transport, 0)).toEqual(bannerOf(transport, 1))
    expect(bannerOf(transport).input).toBe('keep out\nEOF\n')
    // Upstream keeps the caller's newline and adds one when absent (`:177-178`), so `'x'` and `'x\n'`
    // already agree there — but neither form ever ends the block.
  })

  it('a banner body keeps quotes, embedded newlines, a blank line and an indent through the wire payload', async () => {
    const body = 'line one "quoted"\n\n  indented line\tand a tab'
    const transport = mockTransport().replies('enable\nconfigure terminal\nbanner exec', [{}, {}, {}])
    await new Node(transport).system.setBanner('exec', body)
    expect(bannerOf(transport)).toEqual({ cmd: 'banner exec', input: `${body}\nEOF\n` })
    // Round trip: reading the block back keeps those bytes, which is what `setBanner` then `get()` proves
    // in the read cases above.
  })

  it('unsetBanner and defaultBanner are the no/default forms upstream asserts (test_api_system.py:94, :98)', async () => {
    const transport = mockTransport()
      .replies('enable\nconfigure terminal\nno banner motd', [{}, {}, {}])
      .replies('enable\nconfigure terminal\ndefault banner exec', [{}, {}, {}])
    const system = new Node(transport).system
    await system.unsetBanner('motd')
    await system.defaultBanner('exec')
    expect(sentCmds(transport)).toEqual([
      ['enable', 'configure terminal', 'no banner motd'],
      ['enable', 'configure terminal', 'default banner exec'],
    ])
    // Upstream needs `value=None` plus `default=True`/`disable=True` (`system.py:172-175`), and `default`
    // preempts `disable` there (`abstract.py:152-155`) — the order `commandBuilder` keeps.
  })

  it('refuses a kind outside login/motd/exec rather than interpolating it into the command (system.py:171)', async () => {
    const transport = transportFor(MINIMAL_428)
    const system = new Node(transport).system
    for (const kind of ['motd; do-bad', 'motd\nhostname evil', 'console', undefined, 1]) {
      const thrown = await outcome(() => system.setBanner(kind as never, 'text'))
      expect(thrown, `setBanner(${String(kind)})`).toBeInstanceOf(NotSupportedError)
      expect((thrown as Error).message).toMatch(/expected one of login \/ motd \/ exec/)
    }
    expect(transport.sent()).toEqual([])
    // pyeapi has no check: `command_string = "banner %s" % banner_type` (`system.py:171`) puts the caller's
    // string straight on the command line.
  })

  it('refuses a body this client could not read back — an EOF line, a CR, blank, non-string (system.py:177 crashes instead)', async () => {
    const transport = transportFor(MINIMAL_428)
    const system = new Node(transport).system
    const cases: readonly [unknown, RegExp][] = [
      ['fine line\nEOF\ntrailing command', /would end the motd banner block early/],
      ['fine line\nEOF \nmore', /would end the motd banner block early/],
      ['windows line ending\r\nsecond', /carriage return/],
      ['\n \n', /an empty motd banner is refused/],
      ['', /an empty motd banner is refused/],
      [null, /expected the motd banner text as a string/],
      [42, /expected the motd banner text as a string/],
    ]
    for (const [value, message] of cases) {
      const thrown = await outcome(() => system.setBanner('motd', value as string))
      expect(thrown, `setBanner('motd', ${String(value)})`).toBeInstanceOf(NotSupportedError)
      expect((thrown as Error).message).toContain('invalid banner body')
      expect((thrown as Error).message).toMatch(message)
    }
    expect(transport.sent()).toEqual([])
  })

  it('an indented EOF body line is allowed — the terminator the chunker compares is at column 0', async () => {
    // `test/fixtures/config/manifest.json` records that for a banner block too: the chunker compares the
    // `EOF` line after `rstrip` only (`client.py:743`), which is what `bannerBodyFrom` reproduces. EOS's
    // own terminator match is unverified on hardware, M12 (#14) to capture.
    const transport = mockTransport().replies('enable\nconfigure terminal\nbanner motd', [{}, {}, {}])
    await new Node(transport).system.setBanner('motd', 'body\n   EOF\nmore')
    expect(bannerOf(transport).input).toBe('body\n   EOF\nmore\nEOF\n')
  })

  it('a rejected banner write rejects with CommandError and keeps the {cmd, input} payload in the error', async () => {
    const transport = mockTransport().rejects('configure terminal', {
      code: EapiErrorCode.COMMAND_INVALID,
      message: "CLI command 3 of 3 'banner motd' failed: invalid input",
    })
    const thrown = await outcome(() => new Node(transport).system.setBanner('motd', 'line one\nline two'))
    expect(thrown).toBeInstanceOf(CommandError)
    const error = thrown as CommandError
    expect(error.failedCommand).toBe('banner motd')
    // Only an `enable` input is treated as a secret (DR-011, `ENABLE_COMMAND` in internal/redact.ts:63), so
    // a refused banner write stays diagnosable: the operator sees the body the device rejected.
    expect(error.commands).toEqual([
      'enable',
      'configure terminal',
      { cmd: 'banner motd', input: 'line one\nline two\nEOF\n' },
    ])
  })
})

describe('SystemResource on the registry — M7\'s deferred accessor, closed for this kind', () => {
  it('node.system is memoised: the same instance, one construction, one shared config read', async () => {
    const { node, transport } = nodeFor(LAB_CONFIG)
    expect(node.system).toBe(node.system)
    expect(node.system).toBe(node.resource('system'))
    expect(node.system).toBeInstanceOf(SystemResource)
    expect(node.hasResource('system')).toBe(true)
    const first = await node.system.get()
    expect(await node.system.get()).toEqual(first)
    expect(transport.callCount()).toBe(1)
  })

  it('two Nodes get two resources, each reading its own switch (ARCHITECTURE.md §7, pyeapi DR-038)', async () => {
    const one = nodeFor(LAB_CONFIG)
    const two = nodeFor(MINIMAL_428)
    expect(one.node.system).not.toBe(two.node.system)
    expect((await one.node.system.get()).ipRouting).toBe(false)
    expect((await two.node.system.get()).ipRouting).toBe(true)
    expect(one.transport.sent()).toEqual([['enable', 'show running-config all']])
    expect(two.transport.sent()).toEqual([['enable', 'show running-config all']])
  })

  it('a write drops the memo, so the next get() really asks the device again (client.py:665-669, DR-026)', async () => {
    const transport = mockTransport()
      .replies('enable\nshow running-config all', [{}, { output: MINIMAL_428 }])
      .replies('enable\nconfigure terminal\nno ip routing', [{}, {}, {}])
    const system = new Node(transport).system
    expect((await system.get()).ipRouting).toBe(true)
    await system.setIpRouting(false)
    expect((await system.get()).ipRouting).toBe(true) // the mock re-serves the text; the request list is the point
    expect(sentCmds(transport)).toEqual([
      ['enable', 'show running-config all'],
      ['enable', 'configure terminal', 'no ip routing'],
      ['enable', 'show running-config all'],
    ])
  })

  it('a hand-built SystemResource over the same Node behaves like the registry\'s (the factory is the only wiring)', async () => {
    const { node, transport } = nodeFor(LAB_CONFIG)
    const standalone = new SystemResource(node)
    expect(standalone).not.toBe(node.system)
    expect(await standalone.get()).toEqual(await node.system.get())
    expect(transport.callCount()).toBe(1)
  })
})
