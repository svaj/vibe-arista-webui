/**
 * `ntp` — the W2a wave-2 resource module (#35): the global NTP configuration of one switch, ported
 * from `pyeapi/api/ntp.py` (208 lines, BSD-3-Clause, Arista Networks — DR-001). Every `pyeapi` range
 * in this file was opened in the pinned clone `/home/svaj/development/arista/pyeapi` @ `6816d9e` on
 * 2026-11-05; behavioural claims are probes of that clone (noted inline), not docstrings. EOS-side
 * claims (which releases spell `ntp source` vs `ntp local-interface`, what `no ntp` covers in 4.28)
 * read "unverified on hardware, M12 (#14) to capture".
 *
 * Like `system.ts` this is an **`Entity`, not an `EntityCollection`**: pyeapi's `Ntp(Entity)`
 * (`ntp.py:46`) is one global object per node — the pattern M8 set for `System(Entity)`
 * (`system.py:50`). The name lookup a collection provides has no meaning here; the fields of the
 * global record are the state.
 *
 * | pyeapi (verified refs) | here |
 * |---|---|
 * | `Ntp(Entity)` (`:46`), `__init__` passthrough (`:50-51`) | {@link NtpResource} extends `Entity<NtpSettings>` (`base.ts`) — the passthrough constructor is not ported (it adds nothing upstream either) |
 * | `get()` (`:53-88`): `None` for an empty config (`:69-70`), else `_parse_source_interface` + `_parse_servers` merged | {@link NtpResource.get} — always a record (base.ts's `Entity` note); a config with no `ntp …` line answers `servers: []` and **no** `sourceInterface` key (§5 row 156's absence rule, continuing row 126/DR-076 for ports and row 151 for users) |
 * | `_parse_source_interface` (`:90-96`): version-worded `^ntp local-interface ([^\s]+)` : 92 / `^ntp source ([^\s]+)` : 94, `re.search`, first match wins | {@link settingsFromSections} — one walk of the chunked top-level keys, reading **either** spelling from the text (row 155), first appearance wins (parity with `re.search` + the device-order rule of `hostnameFromSections`, `system.ts:276-286`) |
 * | `_parse_servers` (`:98-105`): **unanchored** `re.findall(r'ntp server ([\S]+) ?(prefer)?', config)` (`:99`) | {@link settingsFromSections} again — the exact-key form (row 156; see divergence 1 for what the substring scrape otherwise counts) |
 * | `create(name)` (`:107-116`) = `set_source_interface(name)` (pinned by `test_api_ntp.py:69-72`: `ntp source Ethernet2`) | **not aliased** — {@link NtpResource.setSourceInterface} is the single write; **DR-090**, row 157 |
 * | `delete()` (`:118-128`) / `default()` (`:130-140`) despite the Entity-presence names, both act on the source word | {@link NtpResource.unsetSourceInterface} / {@link NtpResource.defaultSourceInterface} — the field names say what the commands do (DR-090; `test_api_ntp.py:74-82` pins `no ntp source` / `default ntp source`) |
 * | `set_source_interface(name)` (`:142-155`) | {@link NtpResource.setSourceInterface} — same command per version arm |
 * | `add_server(name, prefer)` (`:157-172`): `ValueError` for empty/whitespace (`:168-169`), `prefer` folded **into the value string** (`:170-171`) then `command_builder('ntp server', value=…)` | {@link NtpResource.addServer} — `{ value: '<address> prefer' }` composition ported verbatim so the wire line matches `test_api_ntp.py:89-97` byte for byte |
 * | `remove_server(name)` (`:174-184`): `command_builder('no ntp server', value=…)` | {@link NtpResource.removeServer} |
 * | `remove_all_servers()` (`:186-196`): `command_builder('ntp', disable=True)` — the comment `# 'no ntp' removes all server entries.` (`:192-193`) | {@link NtpResource.removeAllServers} — same single `no ntp` line; the comment's scope claim is an EOS-side statement, flagged not verified (row 157's tail) |
 * | version arms `>= '4.23'` string-compared (`:91`/`:119`/`:131`/`:143`) | {@link NtpResource.sourceKeyword} — numeric segment compare, refusal when unclassifiable (row 155, DR-078; the reviewed rule ported from `interfaces.ts:819-827`, local copy per that file's `hasControlCharacter` arrangement precedent) |
 * | `instance(node)` (`:198-208`) | the `RESOURCE_FACTORIES.ntp` row plus `Node.ntp` (DR-006/DR-052); upstream's `test_instance` (`test_api_ntp.py:51-53`) is ported through the registry/accessor specs |
 *
 * Upstream's own suite is `pyeapi/test/unit/test_api_ntp.py` — **11** test methods (the sibling
 * brief's `test_ntp.py` does not exist in the clone; verified by listing `test/unit/` on 2026-11-05).
 * All eleven are ported in `ntp.test.ts`; `test_get` (`:50-63`) is ported with its **comparison**
 * (which is all it ever runs: `source_interface` and the key set), and its expectation dict — which
 * lists a server `joe` that appears neither in the fixture nor in the parser's real probe output, and
 * omits `192.168.1.32`, which the parser does return — is **corrected** rather than copied
 * (§5 row 156; the probe of `98-105` over `test/fixtures/running_config.text:244-250` is recorded
 * there and re-run 2026-11-05).
 *
 * ## Divergences this file owns — §5 rows 155-157, cited at each item below
 *
 * 1. **the scrape reads commands, not substrings** (§5 row 156). `_parse_servers` is an
 *    **unanchored** findall (`:99`): inside the whole document, so the negation line
 *    `no ntp server 1.1.1.9` contains the pattern and would count as a live server; an indented copy
 *    under any sub-mode (a VRF-style block, or a banner body reciting the words) counts too; and the
 *    `prefer` group's leading ` ?` means `ntp server 1.2.3.4  prefer` (two spaces) answers `''` — the
 *    server without its preference. Here both readers run over the chunker's **top-level section
 *    keys**: a server entry needs a whole line `ntp server <token>…`, and its `prefer` is exactly the
 *    second token (which answers upstream's real behaviour byte-for-byte on its own fixture — probe:
 *    `1.2.3.4 prefer, 10.20.30.40, 11.22.33.44, 123.33.22.11 prefer, 123.44.55.66, 192.168.1.32` —
 *    including the `iburst`-suffixed line, whose extra token upstream ignores exactly as this reader
 *    does). The scan is one pass, and the whole record costs one `show running-config` instead of one
 *    per `_parse_*` property read (row 15; `:91`/`:99` each touch `self.config`).
 * 2. **absence, not `None`** (row 156's header rule, DR-076 — the same control flow rows 126 gave
 *    ports and row 151 gives users). `_parse_source_interface` **always** emits the key with `None`
 *    when the regex misses (`:95`), and `get()` returns `None` only for an entirely empty config
 *    (`:69-70`). Here `sourceInterface` is absent when no source line exists, and `servers` is `[]` —
 *    upstream's own answer for a config with no `ntp server` line (`:100` initialises `value = []`),
 *    kept because an empty list states the same fact as an empty scan.
 * 3. **the version floor is compared numerically, and the reader never asks** (§5 row 155, DR-078).
 *    Upstream string-compares `version_number >= '4.23'` in four places (`:91`, `:119`, `:131`,
 *    `:143`) — the `'4.9' >= '4.23'` character-compare trap `interfaces.ts` and row 131 already
 *    record, re-pinned here — and its **reader** looks only for the word its version arm picked, so a
 *    4.23-era box still writing `ntp source …` reads `source_interface: None`. {@link sourceKeyword}
 *    numerically compares the leading `major.minor` of `VersionProperties.versionNumber` and refuses
 *    an unclassifiable release instead of guessing the command; the read accepts **either spelling from
 *    the config text** (the `vrf`/`vrf forwarding` reader precedent), which is also what makes the read
 *    zero-extra-request.
 * 4. **no alias-presence verbs** (§5 row 157, **DR-090**). pyeapi drives a global through
 *    Entity-presence names: `create(name)` delegates to `set_source_interface` (`:116`), and
 *    `delete()`/`default()` negate/default the **source line** while the names suggest the whole NTP
 *    config (`:118-141`). Owning one write under three names invites an operator to read
 *    `ntp.delete()` as "remove NTP"; this module spells the writes after the field they act on
 *    ({@link setSourceInterface}/{@link unsetSourceInterface}/{@link defaultSourceInterface}) and
 *    keeps `removeAllServers` named for the single `no ntp` line it sends — with the upstream
 *    comment's scope claim ("removes all server entries", `:192-193`) marked unverified on hardware:
 *    negating `ntp` in 4.28 may cover more than servers, and the client states neither, it just sends
 *    the command upstream sends.
 * 5. **junk arguments are refusals** (row 155/DR-077 pattern). Upstream's `add_server('')` /
 *    `add_server(' ')` `ValueError` (`:168-169`, `test_api_ntp.py:99-104`) is ported as a
 *    `NotSupportedError` naming the input (DR-005/DR-077), and — where upstream interpolates any
 *    string unchecked into `ntp server <value>` — a server **address** must be one token with no
 *    control characters: the read keeps `[\S]+` in one whole-line key, so an address with a space
 *    could never come back (`1.1.1.1 prefer` as an "address" would also fabricate a preference). The
 *    source interface goes through `assertInterfaceName` (`validators.ts`) — the same grammar
 *    `interfaces.ts` and `switchports.ts` put on every interface-position name; whether EOS accepts an
 *    `ntp source` of a given kind on this platform is an M12 (#14) question, the guard only protects
 *    this client's own round trip.
 */

import { NotSupportedError } from '../errors'
import { pythonRepr } from '../internal/wire'
import { Entity } from './base'
import { assertInterfaceName } from './validators'
import type { ConfigSections } from '../config/chunk'

/** One `ntp server` line: the address token as written, and whether the line names it preferred. */
export interface NtpServer {
  /** The address/FQDN token after `ntp server` — one token, because that is what both readers keep. */
  readonly address: string
  /** `true` only when the line's second token is exactly `prefer` (pyeapi's `prefer`-or-`None` at `ntp.py:101-104`, stated as a boolean instead). */
  readonly prefer: boolean
}

/**
 * What `node.ntp.get()` answers — pyeapi's `{source_interface, servers}` dict (`ntp.py:66-88`) with
 * divergence 2's vocabulary: `sourceInterface` absent when the config has no source line (upstream
 * invents the `None`), `servers` present always (upstream's empty-scan `[]`).
 */
export interface NtpSettings {
  /** The `ntp source` / `ntp local-interface` word's value, whichever spelling the device wrote (row 155). */
  readonly sourceInterface?: string
  /** Every `ntp server …` line in device order, duplicates kept — pyeapi's findall keeps both (`ntp.py:99-104`). */
  readonly servers: readonly NtpServer[]
}

/** The version floor at which EOS spells the source command `ntp local-interface` — pyeapi's own `'4.23'` literal (`ntp.py:91`, `:119`, `:131`, `:143`). */
const LOCAL_INTERFACE_FORM_MIN: readonly [number, number] = [4, 23]

/** A whole top-level source line, either spelling (row 155: the **reader** asks the text, never the version). */
const NTP_SOURCE_KEY = /^ntp (local-interface|source) (\S+)$/u

/**
 * A whole top-level server line (`row 156`'s exact-key form of upstream's unanchored :99). The
 * optional second token is what decides `prefer`; further tokens (`attribute 3`, `iburst`) are extra
 * state this model does not carry, kept by upstream's `[\S]+`-then-optional-`prefer` as "server
 * without preference" and here the same way.
 */
const NTP_SERVER_KEY = /^ntp server (\S+)(?: (\S+))?(?: .*)?$/u

/** A rejected argument is named in the message, rendered pyeapi's way — the `refuse` pattern from `validators.ts` (DR-053). */
function refuse(label: string, value: unknown, because: string): never {
  throw new NotSupportedError(`invalid ${label} ${pythonRepr(value)} — ${because}`, { cause: value })
}

/** C0 controls plus DEL, code-unit by code-unit — the same local-copy arrangement as `users.ts`/`vlans.ts` took. */
function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

/**
 * The numeric reading of pyeapi's version floor — the reviewed rule from `interfaces.ts:819-827`
 * carried as a local copy (see divergence 3); upstream's test is the raw compare
 * `version_number >= '4.23'` (`ntp.py:91`/`:119`/`:131`/`:143`), and `'4.9' >= '4.23'` is true
 * character-wise while 4.9 predates 4.23 by years. `undefined` means "no leading major.minor at all".
 */
function versionFloorCompare(versionNumber: string, floor: readonly [number, number]): boolean | undefined {
  const parts = /^([0-9]+)\.([0-9]+)/u.exec(versionNumber)
  if (parts === null) return undefined
  const major = Number(parts[1])
  const minor = Number(parts[2])
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor)) return undefined
  return major - floor[0] !== 0 ? major > floor[0] : minor >= floor[1]
}

/**
 * Require a server address that can come back. Upstream checks only emptiness/whitespace
 * (`ntp.py:168-169`) and interpolates anything else; `test_api_ntp.py:89-97` sends
 * `ntp server 1.1.1.1` and `... 1.1.1.1 prefer`, so a one-token address is the shape its own pins use.
 */
function assertServerAddress(verb: string, value: unknown): asserts value is string {
  if (typeof value !== 'string') refuse(`${verb} server address`, value, 'expected a string address — pyeapi interpolates whatever is passed (`ntp.py:157-184`)')
  if (value.trim() === '') refuse(`${verb} server address`, value, 'ntp server name must be specified (pyeapi\'s ValueError message, ntp.py:169; it raises for `\'\'` and whitespace-only, test_api_ntp.py:99-104 — this client throws the same refusal, DR-077)')
  if (/\s/u.test(value)) refuse(`${verb} server address`, value, 'expected a single token: a space inside the address cannot read back (the reader keeps `ntp server ([\\S]+)` as one line key, row 156) — a preference is addServer(addr, { prefer: true }), not an embedded word')
  if (hasControlCharacter(value)) refuse(`${verb} server address`, value, 'a control character would break the config line this client reads back (row 74 — line boundaries included)')
}

/** One pass over the chunked document's top-level keys: the source line's value (first match) and every server line, in device order. */
function settingsFromSections(sections: ConfigSections): NtpSettings {
  const servers: NtpServer[] = []
  let sourceInterface: string | undefined
  for (const key of sections.keys()) {
    if (sourceInterface === undefined) {
      const source = NTP_SOURCE_KEY.exec(key)
      if (source?.[2] !== undefined) {
        sourceInterface = source[2]
        continue
      }
    }
    const server = NTP_SERVER_KEY.exec(key)
    if (server === null) continue
    const address = server[1]
    if (address === undefined) continue
    servers.push({ address, prefer: server[2] === 'prefer' })
  }
  return {
    ...(sourceInterface === undefined ? {} : { sourceInterface }),
    servers,
  }
}

/**
 * `node.ntp` — the single global NTP configuration of one switch.
 *
 * `Entity<NtpSettings>` (pyeapi's `Ntp(Entity)`, `ntp.py:46`): one per `Node`, following the
 * {@link SystemResource} shape — a global entity always HAS an answer, so `get()` resolves to a
 * record even when the device configures no NTP at all (upstream's `None` for an empty config,
 * `:69-70`, is divergence 2's `servers: []`; a device failure throws).
 */
export class NtpResource extends Entity<NtpSettings> {
  /**
   * The current NTP record — pyeapi's `get` (`ntp.py:53-88`) minus one read per field (row 15) and
   * minus the `None` fabrications (divergence 2, row 156).
   */
  override async get(): Promise<NtpSettings> {
    return settingsFromSections(await this.configSections())
  }

  /**
   * Name the NTP source interface — the single write upstream spells twice
   * (`set_source_interface`, `ntp.py:142-155`, and `create`, `:107-116`, which just delegates — the
   * aliasing decision is DR-090/row 157). `ntp local-interface <name>` on 4.23+, `ntp source <name>`
   * below, per {@link sourceKeyword}. `test_api_ntp.py:69-87` pins both command shapes at the 4.17
   * testlib version: `ntp source Ethernet2` / `ntp source Vlan50`.
   */
  async setSourceInterface(name: string): Promise<void> {
    assertInterfaceName(name)
    const keyword = await this.sourceKeyword()
    await this.configure(this.commandBuilder(keyword, { value: name }))
  }

  /** `no ntp local-interface` / `no ntp source` — pyeapi's `delete()` (`ntp.py:118-128`), the Entity-presence name acting on the source field (DR-090); `test_api_ntp.py:74-77` pins `no ntp source`. */
  async unsetSourceInterface(): Promise<void> {
    const keyword = await this.sourceKeyword()
    await this.configure(this.commandBuilder(keyword, { mode: 'no' }))
  }

  /** `default ntp local-interface` / `default ntp source` — pyeapi's `default()` (`ntp.py:130-140`), same naming note; `test_api_ntp.py:79-82` pins `default ntp source`. */
  async defaultSourceInterface(): Promise<void> {
    const keyword = await this.sourceKeyword()
    await this.configure(this.commandBuilder(keyword, { mode: 'default' }))
  }

  /**
   * `ntp server <address>` — pyeapi's `add_server(name, prefer=False)` (`ntp.py:157-172`). The `prefer`
   * port is upstream's own composition: it folds `' prefer'` into the **value string** before the
   * builder (`:170-171`), so `addServer('1.1.1.1', { prefer: true })` sends
   * `ntp server 1.1.1.1 prefer` exactly as `test_api_ntp.py:94-97` pins. "Add or update" is upstream's
   * docstring (`:158`) — the device decides whether a repeat line replaces or duplicates; the read
   * keeps both lines and their order (divergence 1), so a duplicate is at least reported honestly.
   *
   * @throws {NotSupportedError} an empty/whitespace address (upstream's `ValueError`, `:168-169`) or an
   *   address that could not read back ({@link assertServerAddress}).
   */
  async addServer(address: string, options: { readonly prefer?: boolean } = {}): Promise<void> {
    assertServerAddress('addServer', address)
    const value = options.prefer === true ? `${address} prefer` : address
    await this.configure(this.commandBuilder('ntp server', { value }))
  }

  /** `no ntp server <address>` — pyeapi's `remove_server` (`ntp.py:174-184`), `command_builder('no ntp server', value=…)` (`:182-183`); `test_api_ntp.py:106-109` pins the text. The same round-trip guard runs as on {@link addServer}: negating an unparseable address is the same mistake the device would silently accept. */
  async removeServer(address: string): Promise<void> {
    assertServerAddress('removeServer', address)
    await this.configure(this.commandBuilder('no ntp server', { value: address }))
  }

  /**
   * `no ntp` — pyeapi's `remove_all_servers` (`ntp.py:186-196`), one command, built with
   * `command_builder('ntp', disable=True)` while the module's own comment claims it "removes all
   * server entries" (`:192-193`). What `no ntp` covers in 4.28 (servers only, or the whole NTP
   * context) is an EOS-side statement **unverified on hardware, M12 (#14) to capture**; the verb is
   * named after upstream's, and a UI putting it behind a button should treat it as the broader
   * negation until the capture says otherwise (the device-config discipline in this repo's brief).
   */
  async removeAllServers(): Promise<void> {
    await this.configure(this.commandBuilder('ntp', { mode: 'no' }))
  }

  /**
   * The version-selected source stem — the `users.ts` ssh-key rule mirrored (row 155,
   * DR-078): numeric compare of the leading `major.minor` against `4.23`; `ntp local-interface` if
   * at/above, `ntp source` below; an unclassifiable release throws rather than guessing which stem a
   * device accepts (upstream picks `'4.23'`/'`'`-style character comparison at `:119`/`:131`/`:143`).
   * The read side never calls this — divergence 3 (the `vrf` reader precedent, row 131).
   */
  private async sourceKeyword(): Promise<'ntp local-interface' | 'ntp source'> {
    const info = await this.node.getVersion()
    const atLeast = versionFloorCompare(info.versionNumber, LOCAL_INTERFACE_FORM_MIN)
    if (atLeast === undefined) {
      throw new NotSupportedError(
        `cannot pick the NTP source command form: this device's version ${pythonRepr(info.version)} (parsed number ${pythonRepr(info.versionNumber)}) has no leading major.minor to compare against ${pythonRepr(LOCAL_INTERFACE_FORM_MIN.join('.'))} — pyeapi would string-compare whatever it was given against '4.23' (ntp.py:118-155) and this client refuses to guess which \`ntp\` command a device it cannot name accepts (DR-032/DR-057)`,
      )
    }
    return atLeast ? 'ntp local-interface' : 'ntp source'
  }
}
