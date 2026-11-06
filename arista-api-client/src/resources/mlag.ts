/**
 * `mlag` — the MLAG entity resource, W2d (#43). One hybrid read of the `mlag configuration` section
 * and every `interface Po…` section from the running-config, plus the five global writes and the
 * per-interface `mlag` write, built on the M7 (#9) framework like `system.ts` (the single-entity twin)
 * and `vlans.ts` (DR-026 memo, {@link submodeCommands}/{@link commandBuilder}, registry row replacing
 * pyeapi's `node.api('mlag')` autoload — DR-006).
 *
 * Port of `pyeapi/api/mlag.py` (302 lines, BSD-3-Clause, Arista Networks — DR-001). Every `pyeapi`
 * ref below was re-opened in the pinned clone `/home/svaj/development/arista/pyeapi`
 * (1.0.4-rc0, `develop` @ `6816d9e`) on 2026-11-06 and says what the code **does** — nothing here
 * cites EOS image internals, and nothing claims what the DCS-7050TX-64 accepts: unit tests never
 * reach a device, a real MLAG needs TWO switches, and every EOS-side question reads "unverified on
 * hardware, M12 (#14) to capture". Feature licensing of MLAG on this SKU is likewise device-territory
 * (DECISIONS.md open items).
 *
 * **What `get()` actually reads** — the brief asks whether the hybrid read speaks `show mlag` JSON,
 * config, or both: answer verified in the clone, **config text only**. `get` (`:81-91`) merges
 * `_parse_config` (`:93-107`, one `get_block('mlag configuration')`) and `_parse_interfaces`
 * (`:178-192`, `re.findall` over the raw config plus one `get_block('interface …')` per hit); not one
 * `show` command runs anywhere in the module. The cEOS-lab capture at
 * `test/fixtures/live/ceos-4.28.14M/show-mlag.json` therefore stays a SHAPE cross-check for the words
 * (`domain_id`, `local_interface`, `peer_address`, `peer_link`, `shutdown`, per-interface `mlag_id`
 * are the same nouns EOS itself prints in its JSON) — container evidence only, `hardwareEvidence`
 * false, and this module deliberately never reads that JSON: reading state (which is down, what the
 * peer sees) is a different question, owed to a `show mlag` contract M12 (#14) can capture — pinning
 * the config-only scope is DR-101.
 *
 * | pyeapi (verified refs) | here |
 * |---|---|
 * | `Mlag(Entity)` (`:74`) | {@link MlagResource} extends `Entity<MlagState>` (`base.ts`) |
 * | `get` (`:81-91`): merge of the two `_parse_*` dicts | {@link MlagResource.get} — one pass over the chunked document (DR-030), record types instead of merged dicts |
 * | `_parse_config` (`:93-107`) + `_parse_domain_id` (`:109-121`, `domain-id (.+)$` at `:119`), `_parse_local_interface` (`:123-135`, `local-interface (\w+)` at `:133`), `_parse_peer_address` (`:137-149`, dotted-quad-at-line-end at `:147`), `_parse_peer_link` (`:151-163`, `(\S+)` at `:161`), `_parse_shutdown` (`:165-176`: `'no shutdown' not in config` at `:175`) | {@link MlagGlobalConfig} — fields absent where upstream answers `None` (DR-029 family); the same keyword-anchored single-pass extraction `vlans.ts` uses |
 * | `_parse_interfaces` (`:178-192`): `^interface (Po.+)$` findall (`:186`), a `get_block` re-scan per hit (`:188`), `mlag (\d+)` search per block (`:189`) | {@link MlagInterface} rows kept from the chunked keys, one read total (divergence 4) |
 * | `_configure_mlag` (`:194-198`): `command_builder` then `cmds = ['mlag configuration', cfg]` and `super().configure(cmds)` — `super(Mlag, self)` resolves the MRO straight to `BaseEntity.configure` (`abstract.py:103`), because **this** version of `Entity` defines no `configure` override (`abstract.py:181-196` is `__call__`/`get` only) | private {@link configureMlag}: the same two-line transaction through {@link submodeCommands} — never enters a session, never reads first |
 * | `set_domain_id` (`:200-211`), `set_local_interface` (`:213-225`), `set_peer_address` (`:227-239`), `set_peer_link` (`:241-253`) — each delegates with (value, default, disable) | {@link setDomainId}/{@link unsetDomainId}/{@link defaultDomainId} and the sibling trios — DR-037's named-verb split of kwargs |
 * | `set_shutdown` (`:255-270`): `_configure_mlag('shutdown', True, default, disable)` with **`disable=True` as the parameter default** (`:255`) — a no-argument call sends `no shutdown`; both flags false sends bare `shutdown` | {@link shutdown}/{@link noShutdown}/{@link defaultShutdown} — the exact naming `interfaces.ts` established for its own `set_shutdown` family (`interfaces.ts:1275-1294`), because the two intents deserve two verbs (brief: "mirror what M9/M10a's set_shutdown-family did") |
 * | `set_mlag_id` (`:272-290`): `command_builder('mlag', …)` then `configure_interface(name, cmd)` (`:288` via `abstract.py:166-178`) | {@link setMlagId}/{@link unsetMlagId}/{@link defaultMlagId} — divergence 5: the interface/switch distinction is CORRECT at this revision, and the port pins that |
 * | `instance(node)` (`:292-302`) | the `RESOURCE_FACTORIES.mlag` row plus `Node.mlag` (DR-006/DR-052) |
 *
 * Upstream's own suite is `pyeapi/test/unit/test_api_mlag.py` — **7** test methods (verified in the
 * pinned clone on 2026-11-06): `test_get` (`:48-62`), `test_set_domain_id` (`:64-76`),
 * `test_set_local_interface` (`:78-91`), `test_set_peer_address` (`:93-105`),
 * `test_set_peer_link` (`:107-119`), `test_set_shutdown` (`:121-133`), `test_set_mlag_id`
 * (`:135-148`). All seven are ported below with the pinned command texts verbatim — including
 * `domain-id test.dom-id string` (`:68-69`, a THREE-WORD value, the only upstream case proving a
 * multi-word value survives staticroute-style composition… in fact this one: `mlag.py` is the other).
 * Upstream also has `test/system/test_api_mlag.py` — **21** methods that need a PAIRED switch setup
 * (an MLAG domain is two boxes and a peer link): they are **not ported and cannot be** by this lane,
 * which is stated as a skip rather than faked (docs/TESTING.md §5's honest-skip rule). A future
 * dual-cEOS harness could run them; M12 (#14) owns whether that shape is even lab-buildable.
 *
 * ## Divergences this file owns (rows 181-183 are the orchestrator's; under-filled rows are declared skips)
 *
 * 1. **a device with no `mlag configuration` section answers a record, not a crash.** Upstream's
 *    `get` (`:81-91`) funnels the missing block through `_parse_domain_id`, whose
 *    `re.search(r'domain-id (.+)$', config)` (`:119`) receives `None` from `get_block`
 *    (`abstract.py:82-101` answers None) and raises `TypeError: expected string or bytes-like
 *    object` — `get()` on a fresh switch is an exception, not an empty answer. Here an absent section
 *    means an empty {@link MlagGlobalConfig} (every field absent — DR-027/DR-029: absence is a field
 *    answer, and `shutdown` in particular is NOT invented, it is simply not known) and the interface
 *    half still runs. Pinned.
 * 2. **the five field values come from keyword-anchored body lines.** Upstream's four field regexes
 *    are plain `re.search` over the block text: `domain-id (.+)$` (`:119`) reads ANY line containing
 *    `domain-id ` — a `no domain-id` line does not match (no space+value after the key, pinned by the
 *    fixture itself, `running_config.text:2073` answering `None`), but anything else containing the
 *    word would, and `peer-address (\d+\.\d+\.\d+\.\d+)$` (`:147`) refuses a trailing word
 *    (`peer-address 1.2.3.4 standby` answers `None` upstream); `local-interface (\w+)` (`:133`)
 *    truncates `Vlan4094 backup` to `Vlan4094`, and `peer-link (\S+)` (`:161`) takes one token.
 *    Here each value is the whole remainder of the BODY LINE that starts with the keyword
 *    (`valueAfterKeyword`), so `peer-address 1.2.3.4 standby` reads `1.2.3.4 standby`, not `None`,
 *    and no unmodelled line can vote by containing the word mid-line. The two readings DISAGREE on
 *    junk shapes; both sides pin the common ones (the fixture block, and the writers' round trips).
 *    An EOS config actually carrying those junk shapes is unverified on hardware, M12 (#14).
 * 3. **shutdown is an exact line check, and the block's presence decides whether the word exists at
 *    all.** Upstream `_parse_shutdown` is `'no shutdown' not in config` (`:175`) — a bare substring
 *    test: a block without an explicit `no shutdown` reads `shutdown=True` even when no shutdown
 *    line exists at all (the derived-default upstream keeps — pinned here as the same derivation),
 *    and a hypothetical longer line CONTAINING the substring would also flip it. Here: with the
 *    section present, `shutdown` is `true` unless a body line IS `no shutdown` (dedented by
 *    `describeLine`, compared whole); with the section absent, `shutdown` is absent (divergence 1).
 *    No claims about what 4.28 writes by default — M12 capture.
 * 4. **interfaces are the chunker's keys, negations do not vote, and `Po` is upstream's token.**
 *    Upstream finds candidate names with `^interface (Po.+)$` over the raw config (`:186`) — so a
 *    column-0 banner line spelling `interface Po-ghost` joins the party, and the per-name
 *    `get_block` re-scans (`:188`) cost N passes. Then `re.search(r'mlag (\d+)', config)` (`:189`)
 *    is substring-based: **`no mlag 7` inside a Port-Channel block reads as `mlag_id: '7'`** — a
 *    negation reported as a configured id — and a block without the match is dropped from the dict
 *    entirely (`:190-191`). Here: names come from real `interface Po…` section keys (banners cannot
 *    vote), at most ONE config read for the whole pass (DR-030, pinned with a request count), and an
 *    interface counts when a body LINE begins `mlag ` + digits — `no mlag 7` is the negation and
 *    says nothing. The drop-unmatched behaviour is kept faithfully. The `Po` filter itself is
 *    upstream's (its docstring restricts `set_mlag_id` names to Port-Channel too, `:277-278`) even
 *    though EOS writes per-interface `mlag` only under `port-channel` membership — matching it keeps
 *    the read cheap and the divergence count honest; widening it means an upstream-shaped v6/Ethernet
 *    decision this lane does not own.
 * 5. **`setMlagId` is an interface command — the revision checked pins that, no NotSupportedError.**
 *    The dispatch brief flagged a "THE interface-vs-switch command bug" for `set_mlag_id` and left
 *    the chosen divergence to itself; the pinned clone is re-read on 2026-11-06 and shows
 *    `mlag.py:288` calling `self.configure_interface(name, cmd)` — CORRECT, and upstream's unit test
 *    proves it (`test_api_mlag.py:135-148` pins `['interface Ethernet1', 'mlag 1']`, no
 *    `mlag configuration` opener). The variant of `mlag.py` the brief's refs describe
 *    (`set_interface_mlag_id`, `verify_local`, int-coerced `set_domain_id`, line numbers `:46-:70`,
 *    `:242-:256`) does not exist at `6816d9e` — reported upward as corrected refs (DR-101 records the
 *    revision check), and this port implements the checked code: a per-interface verb through
 *    `configureInterface`. Its name is guarded by the framework's `assertInterfaceName` (open item 7
 *    keeps subinterface/slot forms refused), which is one upstream-had-nothing guard this client does.
 *    DR-101 records all of it.
 * 6. **falsy zero: `0` composes `mlag 0`, where upstream's builder would NEGATE.** Upstream's value
 *    path for every setter is `command_builder` — and `abstract.py:155-161` falls through
 *    `elif value:` to the deprecated `return 'no %s'` for any falsy value, so `set_mlag_id(i, 0)`
 *    sends **`no mlag`**, `set_domain_id(0)` sends `no domain-id`: the row 73 / DR-037 truthiness
 *    bug, live in this module. The repo builder already repaired the general case (`{value: 0}` →
 *    `stem 0`, pinned there), and this module keeps that repair: {@link setMlagId} accepts the
 *    number `0` only as a digit the reader can bring back (`mlag (\d+)` matches `0`) and composes
 *    `mlag 0` — a UI that means "remove MLAG" uses {@link unsetMlagId}, never `0` (DR-037's named
 *    negation). Empty-string values ride the same refusal: upstream sends `no domain-id` for `''`
 *    (falsy fall-through), here it is a refusal naming the verb that means it.
 * 7. **input guards where upstream has none, sized to each reader.** The five global setters
 *    interpolate whatever arrives; so does `set_mlag_id`. The guards here are each verb's OWN
 *    round-trip grammar (DR-053 pattern, no new error classes DR-005/DR-010, refusals cost zero
 *    round trips — pinned): domain-id is a non-empty line remainder without outer whitespace or
 *    control characters (the `(.+)$` at `:119` keeps inner spaces — the pinned write test's
 *    `'test.dom-id string'` rides, `test_api_mlag.py:68-69`); local-interface is the `\w+` of `:133`;
 *    peer-address is the dotted shape of `:147` (octet ranges are the image's to enforce, DR-032);
 *    peer-link is one `\S+` token (`:161`); the mlag id is `(\d+)` digits (`:189`) whether handed a
   * number or a string (its docstring's 1..2000 range at `:35-36`/`:277-280` is quoted, never
 *    enforced — pyeapi checks nothing, and `mlag 0` above proves where a range check does NOT come
 *    from). Line boundaries are refused everywhere by the row 74 argument.
 */

import { NotSupportedError } from '../errors'
import { pythonRepr } from '../internal/wire'
import { parseBlock } from '../config/text'
import { Entity } from './base'
import { submodeCommands } from './command-builder'
import { valueAfterKeyword } from './config-block'
import type { ConfigSections } from '../config/chunk'

/** pyeapi's section for the global MLAG knobs — `get_block('mlag configuration')` (`mlag.py:99`). */
const MLAG_SECTION = 'mlag configuration'

/** Upstream's interface-name filter kept verbatim in shape: `^interface (Po.+)$` (`:186`). */
const PO_INTERFACE = /^interface (Po.+)$/u

/** The per-interface id line: upstream's `mlag (\d+)` search anchored to a body line (`:189`). */
const MLAG_ID_LINE = /^mlag (\d+)/u

/** How the negation reads: `_parse_shutdown`'s substring made whole-line honest (`:175`). */
const NO_SHUTDOWN = 'no shutdown'

/**
 * The global MLAG knobs as this client reads them. Field parity with upstream's
 * `config` dict (`_parse_config` → the five `_parse_*` merges, `:99-107`), snake_case → camelCase
 * (MIGRATION.md §5's naming rows) and the `None` answers replaced by absence (divergence 2) — with
 * `shutdown` the one DERIVED field: present-true/present-false, absent only with the whole section
 * missing (divergences 1/3).
 */
export interface MlagGlobalConfig {
  /** `domain-id …` — the whole line remainder, upstream's `(.+)` kept inner spaces (`:119`). */
  readonly domainId?: string
  /** `local-interface …` — the `(\w+)` SVI name (`:133`). */
  readonly localInterface?: string
  /** `peer-address …` — the dotted quad at line end (`:147`). */
  readonly peerAddress?: string
  /** `peer-link …` — the single token (`:161`). */
  readonly peerLink?: string
  /** False exactly when the section carries a `no shutdown` line; true when the section exists without one (upstream's derivation, `:175`); absent when the section itself is missing (divergence 1). */
  readonly shutdown?: boolean
}

/** One Port-Channel carrying an `mlag` id — upstream's `interfaces[name] = dict(mlag_id=…)` rows (`:190-191`). */
export interface MlagInterface {
  /** The interface name from the section header — `Port-Channel10` in the pinned fixture. */
  readonly name: string
  /** `mlag (\d+)` as a STRING — pyeapi's `match.group(1)` is text (`:191`); the id is an identifier, not arithmetic. */
  readonly mlagId: string
}

/** What {@link MlagResource.get} answers — upstream's two top-level keys (`:86-87`). */
export interface MlagState {
  readonly config: MlagGlobalConfig
  /** Interfaces with a digits `mlag` line, keyed by name, in device order (divergence 4). */
  readonly interfaces: ReadonlyMap<string, MlagInterface>
}

/** How a rejected argument is described — the `refuse` pattern from `validators.ts` (DR-053). */
function refuse(label: string, value: unknown, because: string): never {
  throw new NotSupportedError(`invalid ${label} ${pythonRepr(value)} — ${because}`, { cause: value })
}

/** C0 controls plus DEL, code-unit by code-unit — the same test `vlans.ts`/`vrfs.ts` use. */
function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

/** Shared line-boundary argument (row 74) for every value below. */
function assertLineSafe(label: string, value: string): void {
  if (hasControlCharacter(value)) refuse(label, value, 'a control character would break the config line this client reads back (row 74)')
}

/**
 * domain-id: the `(.+)` reader keeps ANY inner spaces (`:119`, and the upstream write test's value is
 * `test.dom-id string`, `test_api_mlag.py:68-69`), but outer whitespace is gone before the reader
 * sees it (`describeLine` rstrips, valueAfterKeyword lstrips at the keyword) — and an empty value is
 * where upstream's `command_builder` truthiness fall-through silently sends `no domain-id`
 * (`abstract.py:158-161`, row 73 — DR-037's family). Refusal instead (divergences 6/7).
 */
function assertDomainId(value: unknown): asserts value is string {
  if (typeof value !== 'string') refuse('mlag domain-id', value, 'expected a string domain id — pyeapi interpolates anything non-falsy (mlag.py:209-211 via abstract.py:158-159)')
  if (value.trim() === '') refuse('mlag domain-id', value, 'an empty domain id is refused — clear it with unsetDomainId() (upstream falls through to `no domain-id` for falsy values, abstract.py:160-161, DR-037)')
  if (value !== value.trim()) refuse('mlag domain-id', value, 'outer whitespace cannot read back: the value is the rstripped, keyword-cut line remainder (mlag.py:119 keeps only an INTERIOR space run)')
  assertLineSafe('mlag domain-id', value)
}

/** local-interface: the `(\w+)` of `:133`, the same token the reader re-produces. */
function assertLocalInterface(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^\w+$/u.test(value)) {
    refuse('mlag local-interface', value, 'expected the one \\w+ token pyeapi reads back (mlag.py:133 `local-interface (\\w+)`) — the docstring narrows values to VLAN SVIs (mlag.py:16-19), and anything else composes a line the reader truncates')
  }
  assertLineSafe('mlag local-interface', value)
}

/** peer-address: the dotted shape of `:147`; octet RANGES are the image's to enforce, not this client's (DR-032; pyeapi enforces nothing anywhere). */
function assertPeerAddress(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^\d+\.\d+\.\d+\.\d+$/u.test(value)) {
    refuse('mlag peer-address', value, 'expected a dotted IPv4 address — the reader anchors `peer-address (\\d+\\.\\d+\\.\\d+\\.\\d+)$` (mlag.py:147) and a looser token reads back as nothing; whether the image accepts out-of-range octets is unverified on hardware, M12 (#14)')
  }
  assertLineSafe('mlag peer-address', value)
}

/** peer-link: one token, as `(\S+)` reads it (`:161`). */
function assertPeerLink(value: unknown): asserts value is string {
  if (typeof value !== 'string') refuse('mlag peer-link', value, 'expected a string interface name — pyeapi interpolates whatever arrives (mlag.py:249-251)')
  if (value === '') refuse('mlag peer-link', value, 'an empty peer link would put a trailing space in the line and read back as the bare-negation shape (mlag.py:161 is `peer-link (\\S+)`) — clear it with unsetPeerLink()')
  if (/\s/u.test(value)) refuse('mlag peer-link', value, 'a peer link with inner whitespace splits the line; the reader takes one \\S+ token (mlag.py:161)')
  assertLineSafe('mlag peer-link', value)
}

/**
 * The interface mlag id: digits, in either spelling — upstream's `match.group(1)` is a string and the
 * write test hands strings (`test_api_mlag.py:141`), while a caller (or JSON profile) may hand the
 * NUMBER form. Number inputs must be safe non-negative integers so the composed digits round-trip
 * exactly; **0 is deliberately accepted** and composes `mlag 0` where upstream's falsy fall-through
 * composed `no mlag` (divergence 6). The docstring's 1..2000 claim (`mlag.py:35-36`, restated at
 * `:277-284`) is quoted, not enforced — pyeapi never checked and the image is the authority (DR-032).
 */
function assertMlagId(value: unknown): asserts value is string {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) {
      refuse('mlag interface id', value, 'a numeric mlag id must be a safe non-negative integer — the reader takes \\d+ digits (mlag.py:189) and fractions/negatives/oversized numerics cannot echo back. 0 composes `mlag 0`; removing MLAG is unsetMlagId(), not 0 (DR-037)')
    }
    return
  }
  if (typeof value !== 'string' || !/^\d+$/u.test(value)) {
    refuse('mlag interface id', value, 'expected digits — the reader captures `mlag (\\d+)` (mlag.py:189). pyeapi checks nothing (mlag.py:287-288) and its command_builder would NEGATE a falsy value like 0 (abstract.py:160-161) — this client composes `mlag 0`, and the 1..2000 docstring range (mlag.py:35-36) is the image to enforce, not this guard')
  }
}

/** Normalize number-or-string ids to the exact digits to compose (divergence 7). */
function mlagIdText(value: string | number): string {
  return typeof value === 'number' ? String(value) : value
}

/**
 * `node.mlag` — the MLAG configuration of one switch (its peer's state is a different switch's
 * record; the paired-system questions stay in the unported 21 system tests).
 *
 * pyeapi's `Mlag(Entity)` (`:74`) — a single entity per node, not a collection (the closest TS twin
 * is `SystemResource`, `system.ts`).
 */
export class MlagResource extends Entity<MlagState> {
  /**
   * The whole MLAG picture in ONE config pass — pyeapi's `get()` (`:81-91`) as a typed record.
   * Upstream pays a `get_block('mlag configuration')` scan (`:99`) plus one `re.findall` over raw
   * config (`:186`) plus a `get_block` per Port-Channel hit (`:188`) — and CRASHES (`TypeError` from
   * `re.search(..., None)`, `:119`) when the section is missing (divergence 1). The request-count
   * assertion below pins the one-read budget (DR-030).
   */
  async get(): Promise<MlagState> {
    const sections = await this.configSections()
    return { config: this.readConfig(sections), interfaces: this.readInterfaces(sections) }
  }

  /** The global half — upstream's `_parse_config` chain (`:93-176`) without the `None`-funnel crashes. */
  private readConfig(sections: ConfigSections): MlagGlobalConfig {
    const sectionText = sections.get(MLAG_SECTION)
    if (sectionText === undefined) return {} // upstream raises TypeError here (divergence 1)
    const block = parseBlock(sectionText)
    // `describeLine` dedents and rstrips, so the shutdown probe compares WHOLE line text — the
    // substring rule at :175 kept line-scoped (divergence 3).
    const hasExplicitNegation = block.body.some((line) => line.text === NO_SHUTDOWN)
    const domainId = valueAfterKeyword(block.body, 'domain-id')
    const localInterface = valueAfterKeyword(block.body, 'local-interface')
    const peerAddress = valueAfterKeyword(block.body, 'peer-address')
    const peerLink = valueAfterKeyword(block.body, 'peer-link')
    return {
      ...(domainId === undefined ? {} : { domainId }),
      ...(localInterface === undefined ? {} : { localInterface }),
      ...(peerAddress === undefined ? {} : { peerAddress }),
      ...(peerLink === undefined ? {} : { peerLink }),
      shutdown: !hasExplicitNegation,
    }
  }

  /** The interface half — upstream's `_parse_interfaces` (`:178-192`) over chunked keys (divergence 4). */
  private readInterfaces(sections: ConfigSections): Map<string, MlagInterface> {
    const interfaces = new Map<string, MlagInterface>()
    for (const [key, sectionText] of sections) {
      const header = PO_INTERFACE.exec(key)
      const name = header?.[1]
      if (name === undefined) continue
      const block = parseBlock(sectionText)
      // Upstream's search picks the first `mlag <digits>` MATCH ANYWHERE (`:189`) — including inside a
      // `no mlag 7` negation; this reader insists a body LINE starts with the keyword, so the
      // negation says nothing and `no mlag 7` keeps the interface out of the table (divergence 4).
      let mlagId: string | undefined
      for (const line of block.body) {
        const found = MLAG_ID_LINE.exec(line.text)
        if (found !== null) {
          mlagId = found[1]
          break
        }
      }
      if (mlagId === undefined) continue // upstream drops unmatched interfaces (`:190-191`) — kept.
      interfaces.set(name, { name, mlagId })
    }
    return interfaces
  }

  /** The five global setters' shared transaction — `_configure_mlag` (`:194-198`): opener + one built line. */
  private async configureMlag(command: string): Promise<void> {
    await this.configure(submodeCommands(MLAG_SECTION, [command]))
  }

  /**
   * `domain-id <value>` — pyeapi's `set_domain_id(value)` (`:200-211`); the pinned text is
   * `['mlag configuration', 'domain-id test.dom-id string']` (`test_api_mlag.py:64-76`, `:68-69`),
   * THREE WORDS — the only upstream case where a multi-word value legitimately rides through a
   * setter.
   */
  async setDomainId(domainId: string): Promise<void> {
    assertDomainId(domainId)
    await this.configureMlag(this.commandBuilder('domain-id', { value: domainId }))
  }

  /** `no domain-id` — upstream's `disable=True` arm (`:205-210` via `abstract.py:154-155`), pinned at `test_api_mlag.py:72-73`. */
  async unsetDomainId(): Promise<void> {
    await this.configureMlag(this.commandBuilder('domain-id', { mode: 'no' }))
  }

  /** `default domain-id` — the `default=True` arm (`abstract.py:152-153`), pinned at `test_api_mlag.py:74-76`. */
  async defaultDomainId(): Promise<void> {
    await this.configureMlag(this.commandBuilder('domain-id', { mode: 'default' }))
  }

  /** `local-interface < svi >` — pyeapi's `set_local_interface` (`:213-225`); pinned `local-interface Vlan1234` (`test_api_mlag.py:78-91`, `:81`). */
  async setLocalInterface(localInterface: string): Promise<void> {
    assertLocalInterface(localInterface)
    await this.configureMlag(this.commandBuilder('local-interface', { value: localInterface }))
  }

  /** `no local-interface` / `default local-interface` — the `disable`/`default` arms (`:217-224`, pinned `test_api_mlag.py:84-90`). */
  async unsetLocalInterface(): Promise<void> {
    await this.configureMlag(this.commandBuilder('local-interface', { mode: 'no' }))
  }

  /** See {@link unsetLocalInterface}. */
  async defaultLocalInterface(): Promise<void> {
    await this.configureMlag(this.commandBuilder('local-interface', { mode: 'default' }))
  }

  /** `peer-address <ipv4>` — pyeapi's `set_peer_address` (`:227-239`); pinned `peer-address 1.2.3.4` (`test_api_mlag.py:93-105`, `:96`). */
  async setPeerAddress(peerAddress: string): Promise<void> {
    assertPeerAddress(peerAddress)
    await this.configureMlag(this.commandBuilder('peer-address', { value: peerAddress }))
  }

  /** `no peer-address` / `default peer-address` — the negation/default arms (`:231-238`, pinned `test_api_mlag.py:99-104`). */
  async unsetPeerAddress(): Promise<void> {
    await this.configureMlag(this.commandBuilder('peer-address', { mode: 'no' }))
  }

  /** See {@link unsetPeerAddress}. */
  async defaultPeerAddress(): Promise<void> {
    await this.configureMlag(this.commandBuilder('peer-address', { mode: 'default' }))
  }

  /**
   * `peer-link <name>` — pyeapi's `set_peer_link` (`:241-253`); the pinned value is
   * `Ethernet1` (`test_api_mlag.py:107-119`, `:110`) even though the docstring prefers
   * "layer 2 Ethernet or Port-Channel" (`mlag.py:26-29`) — both ride the same one-token guard.
   */
  async setPeerLink(peerLink: string): Promise<void> {
    assertPeerLink(peerLink)
    await this.configureMlag(this.commandBuilder('peer-link', { value: peerLink }))
  }

  /** `no peer-link` / `default peer-link` — the negation/default arms (`:245-252`, pinned `test_api_mlag.py:113-118`). */
  async unsetPeerLink(): Promise<void> {
    await this.configureMlag(this.commandBuilder('peer-link', { mode: 'no' }))
  }

  /** See {@link unsetPeerLink}. */
  async defaultPeerLink(): Promise<void> {
    await this.configureMlag(this.commandBuilder('peer-link', { mode: 'default' }))
  }

  /**
   * Bare `shutdown` — upstream gets here only by passing BOTH flags false
   * (`set_shutdown(default=False, disable=False)`, `:255` is the signature whose PARAMETER DEFAULT
   * is `disable=True`, so the no-argument call is the NEGATE arm, `:264-270`). The two intents are
   * separate verbs here, exactly as `interfaces.ts` chose for its own `set_shutdown` family
   * (`interfaces.ts:1275-1294`, PLAN/M10a's precedent the brief points at); the pinned texts are
   * `test_api_mlag.py:121-133`.
   */
  async shutdown(): Promise<void> {
    await this.configureMlag(this.commandBuilder('shutdown', { value: true }))
  }

  /** `no shutdown` — upstream's ZERO-argument `set_shutdown()` default (`:255`, `disable=True`); pinned `test_api_mlag.py:126-128`. */
  async noShutdown(): Promise<void> {
    await this.configureMlag(this.commandBuilder('shutdown', { mode: 'no' }))
  }

  /** `default shutdown` — the `default=True` arm (`:267-269`); pinned `test_api_mlag.py:130-132`. */
  async defaultShutdown(): Promise<void> {
    await this.configureMlag(this.commandBuilder('shutdown', { mode: 'default' }))
  }

  /**
   * `interface <name>` + `mlag <id>` — pyeapi's `set_mlag_id` (`:272-290`), which at THIS revision is
   * correctly an interface command (`:288`, pinned `['interface Ethernet1', 'mlag 1']` at
   * `test_api_mlag.py:135-148`); divergence 5 records why no refusal is owed. The id guard accepts
   * digits or a safe non-negative number — and the NUMBER `0` composes `mlag 0`, where upstream's
   * builder would have sent `no mlag` (divergences 6/7).
   */
  async setMlagId(name: string, value: string | number): Promise<void> {
    assertMlagId(value)
    await this.configureInterface(name, [this.commandBuilder('mlag', { value: mlagIdText(value) })])
  }

  /** `no mlag` — upstream's `disable=True` arm (`:281-282` via `abstract.py:154-155`), pinned `test_api_mlag.py:139-142`. That is the removal verb — NOT the number `0` (divergence 6). */
  async unsetMlagId(name: string): Promise<void> {
    await this.configureInterface(name, [this.commandBuilder('mlag', { mode: 'no' })])
  }

  /** `default mlag` — the `default=True` arm (`abstract.py:152-153`), pinned `test_api_mlag.py:143-147`. */
  async defaultMlagId(name: string): Promise<void> {
    await this.configureInterface(name, [this.commandBuilder('mlag', { mode: 'default' })])
  }
}
