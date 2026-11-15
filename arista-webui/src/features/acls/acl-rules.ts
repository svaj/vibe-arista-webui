/**
 * S13 (#83): the pure rules behind the ACL screen. No React and no device contact — these are the
 * frozen client's rules MIRRORED so a refusal can appear IN-FORM before a config session is paid
 * for, while the DEVICE keeps the final say (a line this screen staged that the CLI rejects comes
 * back as the device's own `CommandError`, DR-057). The same mirroring discipline as
 * `../ntp/ntp-rules.ts` (S12) and `../routes/static-route-rules.ts` (S10).
 *
 * ## Why the command text is composed here instead of by calling `node.acls.*`
 *
 * Every ACL verb (`create`/`delete`/`setDefault`/{@link AclsResource.addEntry}/
 * {@link AclsResource.updateEntry}/{@link AclsResource.removeEntry}) writes immediately through its
 * own `Entity.configure` transaction — there is no preview/diff step to hook into. This wave writes
 * the standing named-session way (session → `run` → device `diff()` → confirm → commit), so the
 * screen stages plain command LINES whose text is byte-for-byte what the ported verb puts on the
 * wire. Nothing here is invented: each line is built with the client's own exported builders
 * (`commandBuilder`, `submodeCommands`) exactly the way `AclCollectionBase` uses them, and
 * `acl-rules.test.ts` proves the equality by driving the REAL `StandardAclsResource`/
 * `ExtendedAclsResource` over the client's `mockTransport` against the pinned argv in
 * `arista-api-client/src/resources/acl.test.ts` (`:524-525` create, `:556-558`/`:572-574`
 * delete/default, `:586`/`:627` update, `:603-605`/`:644-646` add, `:616`/`:647` remove).
 *
 * ## The two gaps #83 has to render honestly (both are client facts, not UI choices)
 *
 * - {@link REFERENCE_GAP}: no read in this client covers `ip access-group`, so nothing here can know
 *   whether an interface still points at an ACL. The screen therefore never claims it checked —
 *   deletion is an always-destructive write behind an explicit acknowledgement.
 * - {@link COUNTER_GAP}: `show access-lists` has no capture for this target, so no hit/counter
 *   column exists anywhere in this screen. Rules are CONFIG text, and the copy says so.
 *
 * ## The write surface is narrower than the read model, on purpose
 *
 * The client's entry verbs re-emit `action`, `protocol`, the two matches and `log` and NOTHING else:
 * a port operator (`eq 161`) or an option tail (`ttl eq 1 tracked`) is read into
 * {@link AclMatch.operator}/{@link AclEntry.options} and deliberately never written back (`acl.ts`
 * divergence 9). {@link ruleReproducibility} is the screen-side consequence: a rule carrying that
 * text cannot be rewritten from here without silently dropping it, so the screen refuses the edit
 * and shows the remainder read-only instead of guessing a command form.
 */
import { commandBuilder, maskToPrefixlen, prefixlenToMask, submodeCommands } from '@devhax-heavy-industries/arista-eapi'
import type { AclEntry, AclMatch, AclType, CommandSpec } from '@devhax-heavy-industries/arista-eapi'

/** The two kinds the header grammar knows (`ACL_TYPES` in `resources/acl.ts`). */
export const ACL_KINDS: readonly AclType[] = ['standard', 'extended']

/**
 * The one honest statement of the reference-detection gap, shared by the standing banner, the risk
 * lists and the confirm body so the wording can never drift between them. Pinned verbatim by
 * `Acls.test.tsx`.
 */
export const REFERENCE_GAP =
  'This screen cannot see interface references: no read in this client covers `ip access-group`, so it does not know whether any interface still applies this ACL and the confirm below does NOT claim it checked. Applying an ACL is done on the interface, outside what this page can read — if this ACL is in use, taking it out changes live packet filtering right now, and the device `diff()` is the only evidence of what the write actually removed.'

/** The equally honest statement of why this screen shows no hit counters (#83 CAPTURES gate). */
export const COUNTER_GAP =
  'No hit counters are shown: `show access-lists` has no capture for this target, so this screen renders the configured rules exactly as the running-config writes them and never prints a hit, counter or matched-packet number.'

/** Session description for one ACL action — the `webui <module> <action>` convention (S8/S11/S12). */
export function sessionDescription(action: string): string {
  return `webui acl ${action}`
}

/** A value quoted for refusal copy, matching the way the sibling rule modules quote device text. */
function quoted(value: string): string {
  return JSON.stringify(value)
}

/** C0 controls plus DEL — the client's `hasControlCharacter` scan over a name (`acl.ts`, assertAclName). */
function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

/** A dotted-quad IPv4 address, each octet 0-255 — the client's own `IPV4` grammar (`acl.ts`). */
const QUAD = /^(?:[0-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-5])(?:\.(?:[0-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-5])){3}$/u

/** One word, letters/digits only — the client's `PROTOCOL_TOKEN` (`\w+|\d+` upstream, `acl.py:222`). */
const PROTOCOL_TOKEN = /^[A-Za-z0-9]+$/u

/** A sequence number as the read model keys it: decimal digits, no sign, no separators. */
const SEQ_TOKEN = /^[0-9]+$/u

/** IPv4's own width — the same bound `assertPrefixlen` uses. */
const IPV4_BITS = 32

// ====================================================================================================
// The header texts, composed with the client's own builders
// ====================================================================================================

/**
 * `ip access-list standard <name>` / `ip access-list <name>` — the client's private `aclStem`
 * reproduced exactly, because the header differs by kind and the kind decides everything else.
 */
export function aclStemOf(type: AclType, name: string): string {
  return type === 'standard' ? `ip access-list standard ${name}` : `ip access-list ${name}`
}

/** {@link AclsResource.create}'s single line (`acl.test.ts:524-525`): the bare header. */
export function createLines(type: AclType, name: string): readonly CommandSpec[] {
  return [commandBuilder(aclStemOf(type, name), { value: true })]
}

/** `no ip access-list [standard] <name>` (`acl.test.ts:557`/`:573`) — the whole block goes with it. */
export function deleteLines(type: AclType, name: string): readonly CommandSpec[] {
  return [commandBuilder(aclStemOf(type, name), { mode: 'no' })]
}

/** `default ip access-list [standard] <name>` (`acl.test.ts:558`/`:574`). */
export function defaultLines(type: AclType, name: string): readonly CommandSpec[] {
  return [commandBuilder(aclStemOf(type, name), { mode: 'default' })]
}

/**
 * Append a rule: the header, the rule line, `exit` (`acl.test.ts:603-605` standard, `:644-646`
 * extended). With no sequence number the line carries none, which is the client's `seqno` absent arm
 * — the DEVICE numbers it (nothing in `acl.py` computes a number client-side, and this screen does
 * not either).
 */
export function addEntryLines(type: AclType, name: string, body: string, seqno: string): readonly CommandSpec[] {
  const rule = seqno.trim() === '' ? body : `${seqno.trim()} ${body}`
  return submodeCommands(aclStemOf(type, name), [rule, 'exit'])
}

/**
 * Replace one rule: header, `no <seq>`, the new numbered line, `exit` (`acl.test.ts:586` standard,
 * `:627` extended). The negation before the replacement is upstream's order verbatim, and the
 * replacement line always carries the number — `updateEntry` interpolates it unconditionally.
 */
export function replaceEntryLines(type: AclType, name: string, seqno: string, body: string): readonly CommandSpec[] {
  const seq = seqno.trim()
  return submodeCommands(aclStemOf(type, name), [`no ${seq}`, `${seq} ${body}`, 'exit'])
}

/** Remove one rule: header, `no <seq>`, `exit` (`acl.test.ts:616` standard, `:647` extended). */
export function removeEntryLines(type: AclType, name: string, seqno: string): readonly CommandSpec[] {
  return submodeCommands(aclStemOf(type, name), [`no ${seqno.trim()}`, 'exit'])
}

// ====================================================================================================
// Field-level refusals, mirrored from the client's guards
// ====================================================================================================

/**
 * Why {@link assertAclName} would refuse this ACL name, or `undefined` when the client would send it.
 * Inner whitespace stays legal — the client creates `ip access-list standard has space` and reads the
 * same section key back (`acl.ts`, divergence 5's write half), so refusing it here would make a
 * reportable name unmanageable.
 */
export function aclNameRefusal(rawValue: string): string | undefined {
  if (rawValue.trim() === '') {
    return `This client refuses an empty ACL name — ${quoted('ip access-list standard ')} with a trailing space is a line its own header grammar cannot read back (mirrors assertAclName, resources/acl.ts).`
  }
  if (rawValue !== rawValue.trim()) {
    return `${quoted(rawValue)} has leading or trailing whitespace, which this client refuses: a section key is the rstripped config line, so the name could not read back as typed (mirrors assertAclName, resources/acl.ts).`
  }
  if (hasControlCharacter(rawValue)) {
    return `${quoted(rawValue)} contains a control character, which this client refuses because it would break the config line the ACL is read back from (mirrors assertAclName, resources/acl.ts).`
  }
  return undefined
}

/** Why the client's `assertAclProtocol` would refuse this protocol token. */
export function protocolRefusal(rawValue: string): string | undefined {
  const value = rawValue.trim()
  if (value === '') {
    return 'An extended rule needs a protocol token — the client reads and writes exactly one (`ip`, `tcp`, `udp`, `icmp`, or a decimal such as `47`), and a standard rule has no protocol field at all (mirrors assertAclProtocol, resources/acl.ts).'
  }
  if (!PROTOCOL_TOKEN.test(value)) {
    return `${quoted(value)} is not a single protocol token — the extended grammar is one word (resources/acl.ts, PROTOCOL_TOKEN), so anything with whitespace or punctuation is refused before a session opens rather than interpolated into the line.`
  }
  return undefined
}

/** Why the client's `assertAclSeqno` would refuse this sequence number. */
export function seqnoRefusal(rawValue: string): string | undefined {
  const value = rawValue.trim()
  if (value === '') return undefined
  if (!SEQ_TOKEN.test(value)) {
    return `${quoted(rawValue)} is not a sequence number this client can key a rule by — it accepts digits only, a non-negative safe integer (mirrors assertAclSeqno, resources/acl.ts: the read side keys rules by the decimal a line starts with).`
  }
  if (!Number.isSafeInteger(Number(value))) {
    return `${quoted(value)} has more digits than this client can key a rule by — the read side refuses the same shape with a ConfigParseError, so a write that produced it would make the ACL unreadable (resources/acl.ts, divergence 7's bound).`
  }
  return undefined
}

/**
 * The screen-side guard the client cannot offer: {@link AclsResource.addEntry} happily stages a
 * number the block already uses, but the client's READER treats a duplicate sequence number as a
 * `ConfigParseError` (divergence 7 — upstream silently drops one of the two rules). Staging one
 * would leave an ACL this screen can no longer read, so the number is refused here instead, and the
 * refusal says plainly that it is this screen's rule, not the client's.
 */
export function duplicateSeqRefusal(existing: readonly number[], rawValue: string): string | undefined {
  const value = rawValue.trim()
  if (value === '' || !SEQ_TOKEN.test(value)) return undefined
  const seqno = Number(value)
  if (!existing.includes(seqno)) return undefined
  return `Sequence number ${value} is already used in this ACL, so this screen refuses to stage a second rule with it. The client's own reader reports a duplicated sequence number as a ConfigParseError rather than picking one (resources/acl.ts, divergence 7), which means a write like this would leave the block unreadable here. Leave the field empty and let the device number the rule, or pick a number the listing does not show.`
}

/** Why the client's `assertIpv4` / `assertPrefixlen` would refuse one side of a rule. */
function quadRefusal(label: string, value: string): string | undefined {
  if (value.trim() === '') return `The ${label} is empty — this client sends no blank address token (its ipv4 guard demands a dotted quad, resources/acl.ts). Choose \`any\`, or fill the address in.`
  if (!QUAD.test(value.trim())) {
    return `${quoted(value)} is not a dotted-quad IPv4 address for the ${label} (each octet 0..255). The client's grammar refuses ${quoted(value)} the same way — pyeapi interpolates whatever arrives straight into the rule text, which is why this check runs in-form.`
  }
  return undefined
}

// ====================================================================================================
// The match arms
// ====================================================================================================

/**
 * How the operator says one side of a rule. The four writable arms are the four spellings
 * {@link AclMatchInput} accepts (`{ any: true }` / `{ host }` / `{ address, prefixlen }` /
 * `{ address, mask }`, acl.ts divergence 9); the `wildcard` arm is the standard-only `<address>
 * <mask>` spelling, which the client refuses on the extended side because its reader would take a
 * bare quad as the destination (divergence to `renderMatch`'s `allowMask` flag). `untouched` is the
 * fifth, screen-only arm: a select nobody has chosen, which {@link matchRefusal} refuses so no line
 * is ever composed from a field the operator never filled ({@link DESTINATION_MODES}).
 */
export type MatchMode = 'untouched' | 'any' | 'host' | 'prefix' | 'wildcard'

/** The four arms that compose a line, in select order, with the copy each one shows. */
export const MATCH_MODES: readonly { value: Exclude<MatchMode, 'untouched'>; label: string; standardOnly: boolean }[] = [
  { value: 'any', label: 'any (every address)', standardOnly: false },
  { value: 'host', label: 'host <address> (one host)', standardOnly: false },
  { value: 'prefix', label: '<address>/<prefix length>', standardOnly: false },
  { value: 'wildcard', label: '<address> <wildcard mask> (standard ACLs only)', standardOnly: true },
]

/**
 * The destination select's extra placeholder arm. The destination has no writable default on the
 * extended side (`acl.ts` refuses a missing one outright — upstream formats the string `None` into its
 * own line, divergence 9), and a form that defaults to `any` would stage `permit ip any any` from a
 * select nobody touched. `untouched` therefore refuses in-form until the operator picks an arm;
 * choosing `any (every address)` composes the client's own pin line (`acl.test.ts:669`,
 * `permit ip any any`), so that arm stays reachable.
 */
export const DESTINATION_MODES: readonly { value: MatchMode; label: string; standardOnly: boolean }[] = [
  { value: 'untouched', label: '(choose the destination…)', standardOnly: false },
  ...MATCH_MODES,
]

/** One side of a rule as the form holds it (all strings: this is untouched operator text). */
export interface MatchDraft {
  readonly mode: MatchMode
  readonly address: string
  readonly prefixlen: string
  readonly mask: string
}

/** The empty form value for a SOURCE — `any`, the arm the client itself writes for `any`. */
export const EMPTY_MATCH: MatchDraft = { mode: 'any', address: '', prefixlen: '', mask: '' }

/** The untouched destination ({@link DESTINATION_MODES}); refused by {@link matchRefusal}, never composed. */
export const UNTOUCHED_MATCH: MatchDraft = { mode: 'untouched', address: '', prefixlen: '', mask: '' }

/**
 * Why {@link matchRefusal} would refuse this match, or `undefined` when it would be sent.
 *
 * @param allowMask `true` only for a standard-ACL source — the one place `<address> <mask>` is a
 *   spelling the client both reads and writes (`acl.test.ts:672`, `permit 10.20.0.0 0.0.255.255`).
 */
export function matchRefusal(label: string, draft: MatchDraft, allowMask: boolean): string | undefined {
  if (draft.mode === 'untouched') {
    return `The ${label} is untouched, so this screen would have to guess it. The client refuses a missing extended destination outright (upstream formats the string \`None\` into its own line — probe \`permit ip any any/None\`, resources/acl.ts divergence 9), so pick the arm you mean; choosing \`any (every address)\` is a deliberate answer and composes the line the client itself pins (\`permit ip any any\`, acl.test.ts:669).`
  }
  if (draft.mode === 'any') return undefined
  if (draft.mode === 'wildcard' && !allowMask) {
    return `The \`<address> <mask>\` arm is a standard-ACL spelling: an extended ACL reads a bare quad after the address as the DESTINATION (resources/acl.ts renderMatch refuses it, quoting the probe where upstream reads \`permit icmp 3.3.3.0 0.0.0.255 any\` as dstaddr 0.0.0.255). Use \`<address>/<prefix length>\` on this ${label} instead.`
  }
  const address = quadRefusal(`${label} address`, draft.address)
  if (address !== undefined) return address
  if (draft.mode === 'host') return undefined
  if (draft.mode === 'prefix') {
    const raw = draft.prefixlen.trim()
    if (raw === '') {
      return `The ${label} is missing its prefix length — an address alone is an arm this client does not write on the ${label}: the prefix arm needs ${quoted('address')} plus an integer length (renderMatch refuses \`an address needs either a prefix length or a mask\`, resources/acl.ts).`
    }
    if (!SEQ_TOKEN.test(raw)) {
      return `${quoted(raw)} is not an integer prefix length for the ${label} — the client refuses anything else (assertPrefixlen, resources/acl.ts: pyeapi interpolates the token into the line and lets netaddr explode).`
    }
    const bits = Number(raw)
    if (bits > IPV4_BITS) {
      return `The prefix length ${raw} on the ${label} is outside 0..${String(IPV4_BITS)} — an IPv4 fact, and the same bound the client's assertPrefixlen applies (upstream's reader would keep \`33\` as a written string; this client refuses to write it).`
    }
    return undefined
  }
  return quadRefusal(`${label} wildcard mask`, draft.mask)
}

/**
 * The line text for one match, assuming {@link matchRefusal} passed. Byte-identical to the client's
 * private `renderMatch`: `any`, `host <addr>`, `<addr>/<len>`, `<addr> <mask>` (`acl.test.ts:669-673`).
 */
export function matchText(draft: MatchDraft): string {
  switch (draft.mode) {
    case 'untouched': throw new Error('an untouched match has no line text — the screen must refuse it (matchRefusal) before composing')
    case 'any': return 'any'
    case 'host': return `host ${draft.address.trim()}`
    case 'prefix': return `${draft.address.trim()}/${draft.prefixlen.trim()}`
    case 'wildcard': return `${draft.address.trim()} ${draft.mask.trim()}`
  }
}

// ====================================================================================================
// The rule line
// ====================================================================================================

/** One rule form's fields, as the container holds them. Empty strings mean "untouched". */
export interface RuleDraft {
  readonly action: '' | 'permit' | 'deny'
  readonly protocol: string
  readonly source: MatchDraft
  readonly destination: MatchDraft
  readonly seqno: string
  readonly log: boolean
}

/**
 * The starting value for the Add-rule form. The destination starts {@link UNTOUCHED_MATCH} rather than
 * `any`: the extended side has no writable default (the client refuses a missing destination), and a
 * default of `any` would let a form nobody finished stage `permit ip any any`.
 */
export const EMPTY_RULE: RuleDraft = {
  action: '',
  protocol: 'ip',
  source: EMPTY_MATCH,
  destination: UNTOUCHED_MATCH,
  seqno: '',
  log: false,
}

/**
 * Validate and compose one rule line's body, mirroring `renderEntryBody` (resources/acl.ts) branch
 * for branch: action must be `permit`/`deny`; extended needs a protocol and a destination; standard
 * refuses both; `log` is the only trailing token this client writes.
 *
 * The checks run in the client's own ORDER so the first refusal a screen shows is the first refusal
 * the client would raise.
 */
export function ruleBody(type: AclType, draft: RuleDraft): { readonly body: string } | { readonly refusal: string } {
  if (draft.action !== 'permit' && draft.action !== 'deny') {
    return { refusal: `Choose permit or deny — the client's guard accepts exactly those two (assertAclAction, resources/acl.ts; upstream's regex class would accept any word starting with p, d or |, which is why this client narrowed it, divergence 4).` }
  }
  if (type === 'extended') {
    const protocol = protocolRefusal(draft.protocol)
    if (protocol !== undefined) return { refusal: protocol }
  }
  const source = matchRefusal('source', draft.source, type === 'standard')
  if (source !== undefined) return { refusal: source }
  if (type === 'extended') {
    // `matchRefusal` carries both client refusals for this side: the missing/untouched destination
    // (`acl.ts` refuses it: upstream formats the string None into its own line, divergence 9) and the
    // mask arm, which the extended reader would take for a destination.
    const destination = matchRefusal('destination', draft.destination, false)
    if (destination !== undefined) return { refusal: destination }
  }
  const parts: string[] = [draft.action]
  if (type === 'extended') parts.push(draft.protocol.trim())
  parts.push(matchText(draft.source))
  if (type === 'extended') parts.push(matchText(draft.destination))
  if (draft.log) parts.push('log')
  return { body: parts.join(' ') }
}

/**
 * Can this read-back rule be rewritten by the client's entry verbs? `operator` and `options` are read
 * but never re-emitted (divergence 9), so replacing such a rule would drop the port test or the
 * option tail from the line silently. The screen refuses the edit and leaves the rule readable.
 */
export function ruleReproducibility(entry: AclEntry): string | undefined {
  const carried: string[] = []
  if (entry.src.operator !== undefined) carried.push(`source operator ${quoted(entry.src.operator)}`)
  if (entry.dst?.operator !== undefined) carried.push(`destination operator ${quoted(entry.dst.operator)}`)
  if (entry.options !== undefined) carried.push(`option tail ${quoted(entry.options)}`)
  if (carried.length === 0) return undefined
  return `${quoted(ruleLine(entry))} carries ${carried.join(' and ')}. The client\u2019s entry verbs re-emit only the action, protocol, the two matches and \`log\` — a port operator or an option tail is read into the record and deliberately never written back (resources/acl.ts, divergence 9), so a replacement staged from this form would silently drop it. This screen leaves the rule exactly as the config has it: use Remove rule to take the whole line out, or type the replacement in yourself on the device. Deciding what 4.28 accepts for that tail is a capture question (M12 #14), not something this page can invent.`
}

// ====================================================================================================
// Read-back rendering (display + prefill for the Replace form)
// ====================================================================================================

/** One side of a read rule, as the config wrote it — including an operator the screen cannot write. */
export function matchDisplay(match: AclMatch): string {
  const base = match.kind === 'any'
    ? 'any'
    : match.kind === 'host'
      ? `host ${match.address ?? ''}`
      : match.prefixlen !== undefined
        ? `${match.address ?? ''}/${String(match.prefixlen)}`
        : match.mask !== undefined
          ? `${match.address ?? ''} ${match.mask}`
          : (match.address ?? '')
  return match.operator === undefined ? base : `${base} ${match.operator}`
}

/** The whole rule as one line of display text, in the order the config writes it. */
export function ruleLine(entry: AclEntry): string {
  const parts = [String(entry.seqno), entry.action]
  if (entry.protocol !== undefined) parts.push(entry.protocol)
  parts.push(matchDisplay(entry.src))
  if (entry.dst !== undefined) parts.push(matchDisplay(entry.dst))
  if (entry.log === true) parts.push('log')
  if (entry.options !== undefined) parts.push(entry.options)
  return parts.join(' ')
}

/**
 * Prefill the Replace form from a read rule. Only reachable through
 * {@link ruleReproducibility} passing, which guarantees no operator/options text is lost; a bare
 * address with neither a length nor a mask becomes the `prefix` arm with the length the client's own
 * netmask helper reports, because that is the only writable arm that can carry a plain quad.
 */
export function ruleDraftFromEntry(entry: AclEntry): RuleDraft {
  return {
    action: entry.action,
    protocol: entry.protocol ?? '',
    source: matchDraftFromMatch(entry.src),
    destination: entry.dst === undefined ? EMPTY_MATCH : matchDraftFromMatch(entry.dst),
    seqno: String(entry.seqno),
    log: entry.log === true,
  }
}

/** One read match → form fields (see {@link ruleDraftFromEntry} for the bare-address case). */
export function matchDraftFromMatch(match: AclMatch): MatchDraft {
  if (match.kind === 'any') return { ...EMPTY_MATCH, mode: 'any' }
  if (match.kind === 'host') return { mode: 'host', address: match.address ?? '', prefixlen: '', mask: '' }
  if (match.mask !== undefined) return { mode: 'wildcard', address: match.address ?? '', prefixlen: '', mask: match.mask }
  if (match.prefixlen !== undefined) return { mode: 'prefix', address: match.address ?? '', prefixlen: String(match.prefixlen), mask: '' }
  return { mode: 'prefix', address: match.address ?? '', prefixlen: String(maskToPrefixlen(match.address ?? '')), mask: '' }
}

// ====================================================================================================
// The mask/length helpers the client exports (PLAN.md §4 schedules them with this module)
// ====================================================================================================

/**
 * The netmask a prefix length means, straight from the client's own {@link prefixlenToMask}
 * (`acl.py:68-79`). Used ONLY for review copy — the staged line always carries `/len` exactly as the
 * operator wrote it, because that is the arm `addEntry` composes (`acl.test.ts:671`).
 */
export function netmaskForPrefixlen(prefixlen: number): string {
  return prefixlenToMask(prefixlen)
}

/**
 * What the client's {@link maskToPrefixlen} (`acl.py:55-65`, netaddr `netmask_bits`) makes of a mask
 * token, and whether that reading is faithful.
 *
 * This is the shape of acl.ts divergence 2: the helper counts NETMASK bits, so a standard-ACL
 * WILDCARD (`0.0.255.255`) answers `32` — one host — and a non-contiguous netmask such as
 * `255.0.255.0` also answers `32`. That is why the parser never converts a wildcard and this screen
 * keeps every mask exactly as the config wrote it. `faithful: false` is the honest signal: the number
 * exists, and it is not a prefix length for this token.
 */
export function maskReading(mask: string): { readonly prefixlen: number; readonly faithful: boolean } {
  const prefixlen = maskToPrefixlen(mask)
  return { prefixlen, faithful: prefixlenToMask(prefixlen) === mask }
}
