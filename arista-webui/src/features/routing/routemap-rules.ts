/**
 * #87 (route-map slice): the pure rules behind the route-map clause editor
 * (`#/routing/routemaps`). No React, no fetches, no device handles — every composed line here is
 * byte-for-byte the text the CLIENT's own verb would send, cited to its `routemaps.ts` line and
 * its `routemaps.test.ts` pin.
 *
 * ## Why this screen mirrors instead of calling (SPEC-routemap-editor.md, assumption 3)
 *
 * `routemaps.ts` verbs are **send-only** — unlike `vrrp.ts` (DR-152's dry-run seam), there is no
 * `{ run: false }` arm to ask for the composed text. So the screen stages the same line sequence
 * the client would send: the clause header (`routemaps.ts:614`), the replace-diff sequence
 * (`replaceStatements`, `routemaps.ts:465-502` — removals first in CURRENT order, additions
 * second in INPUT order, the header repeated before EVERY body line exactly as upstream opens the
 * clause per statement, `routemaps.py:247-255`), the clear-then-set description pair
 * (`setDescription`, `routemaps.ts:552-560`, upstream pin `test_api_routemaps.py:134-139`), and
 * the single-line create/delete headers (`:403-406` / `:414-417`). This is the established
 * StaticRoutes/Ntp convention for send-only client surfaces — every line is a client-verb text
 * pinned by a client test, so mirroring IS the pin (NOT a DR-151-style capture deviation).
 *
 * ## What stays closed (the spec's Out of scope)
 *
 * No `default route-map` / `default continue` / `default description` arm (the client has them;
 * the VRRP precedent keeps them out until asked); no invented match/set vocabulary (free text,
 * device-authoritative per owner intake 2026-11-21 — only `set community 65000:1` is
 * hardware-proven, batch `unblock-route-map-grammar`); nothing here touches `ip routing` (the
 * audit's #87 Do-Not-Do); nothing here commits (the Transaction Center owns commit/abort, #141).
 */
import type { OspfState, RoutemapAction, RoutemapEntry, RoutemapEntryAttrs } from '@devhax-heavy-industries/arista-eapi'

/** One clause's identity — the triple the client's `requireClause` names (routemaps.ts:619+). */
export interface RoutemapClauseRef {
  readonly name: string
  readonly action: RoutemapAction
  /** Digits-only, as the reader captures it (`(\d+)`, routemaps.py:112). */
  readonly seqno: string
}

// ------------------------------------------------------------------------------------------------
 // Line builders — each cites the client verb whose text it mirrors.
// ------------------------------------------------------------------------------------------------

/** The clause header line — the client's `clauseHeader` (routemaps.ts:614-616), verbatim shape. */
export function routemapClauseHeaderLine(clause: RoutemapClauseRef): string {
  return `route-map ${clause.name} ${clause.action} ${clause.seqno}`
}

/**
 * The create batch — the client's `create()` (routemaps.ts:403-406): ONE bare header line, no
 * read first, submode not entered (upstream `:161-179` — "regardless if the routemap exists or
 * not"; the device opens the clause when asked to configure it).
 */
export function routemapCreateLines(clause: RoutemapClauseRef): readonly string[] {
  return [routemapClauseHeaderLine(clause)]
}

/**
 * The delete batch — the client's `delete()` (routemaps.ts:414-417): one top-level
 * `no route-map NAME ACTION SEQNO` line, no submode. Deleting the LAST clause of a name deletes
 * the name (a route-map exists only through its clauses — the client's documented semantics).
 */
export function routemapDeleteLines(clause: RoutemapClauseRef): readonly string[] {
  return [`no ${routemapClauseHeaderLine(clause)}`]
}

/**
 * The replace-match/set batch — byte-for-byte the client's `replaceStatements` sequence
 * (routemaps.ts:465-502, DR-113 order-stability): removals FIRST in current order
 * (`no match X` / `no set X`), additions SECOND in input order, the clause header repeated
 * before EVERY body line (upstream opens the clause per statement, routemaps.py:247-255).
 * An empty diff yields `[]` — exactly what the client sends nothing for (`:501`); the caller
 * refuses that at zero appends rather than staging an empty batch.
 */
export function routemapReplaceLines(
  clause: RoutemapClauseRef,
  keyword: 'match' | 'set',
  current: readonly string[],
  wanted: readonly string[],
): readonly string[] {
  const header = routemapClauseHeaderLine(clause)
  const wantedSet = new Set(wanted)
  const currentSet = new Set(current)
  const commands: string[] = []
  for (const statement of current) {
    if (wantedSet.has(statement)) continue
    commands.push(header, `no ${keyword} ${statement}`)
  }
  for (const statement of wanted) {
    if (currentSet.has(statement)) continue
    commands.push(header, `${keyword} ${statement}`)
  }
  return commands
}

/**
 * The description batch — the client's `setDescription` (routemaps.ts:552-560): the clear-then-set
 * PAIR, header before each line (`['route-map …', 'no description', 'route-map …', 'description
 * <value>']`), the ordering upstream's own value test pins (`test_api_routemaps.py:134-139`).
 */
export function routemapDescriptionLines(clause: RoutemapClauseRef, value: string): readonly string[] {
  const header = routemapClauseHeaderLine(clause)
  return [header, 'no description', header, `description ${value}`]
}

/** The continue-set batch — the client's `setContinue` (routemaps.ts:527-535): header + `continue <n>`. */
export function routemapSetContinueLines(clause: RoutemapClauseRef, value: string): readonly string[] {
  return [routemapClauseHeaderLine(clause), `continue ${value}`]
}

/** The continue-clear batch — the client's `unsetContinue` (routemaps.ts:538-540): header + `no continue`. */
export function routemapUnsetContinueLines(clause: RoutemapClauseRef): readonly string[] {
  return [routemapClauseHeaderLine(clause), 'no continue']
}

// ------------------------------------------------------------------------------------------------
 // Validation — mirrors the client's guards (grammar, not device bounds; DR-120). A value that
 // passes these may still be refused by the device; that refusal is the device's own answer
 // (DR-057), surfaced verbatim at commit time.
// ------------------------------------------------------------------------------------------------

/** The client's `assertRoutemapName` (routemaps.ts:262-269): one token, no config-marker prefix. */
export function validateRoutemapName(value: string): string | undefined {
  if (value.trim() === '') return 'A route-map name is required — the clause header names the map as one token.'
  if (/\s/u.test(value)) return `Route-map name \`${value}\` carries whitespace — the reader parses the whole name as one \`\\S+\` token (routemaps.py:103), so this screen never sends a name that would parse as a different clause.`
  if (value.startsWith('!') || value.startsWith('no ') || value.startsWith('route-map')) return `Route-map name \`${value}\` begins with a config marker/keyword — it would collide with the indent-0 section-key space the reader separates clauses by (routemaps.py:103).`
  if (hasControlCharacter(value)) return 'A route-map name must not carry a control character — it would break the config line this client reads back.'
  return undefined
}

/** The client's `assertRoutemapAction` (routemaps.ts:271+): the documented pair only. */
export function validateRoutemapAction(value: string): string | undefined {
  if (value !== 'permit' && value !== 'deny') return `Action \`${value}\` is not \`permit\` or \`deny\` — this client's vocabulary is the documented pair (DR-032: an action beyond them is a device question, and this screen never composes one).`
  return undefined
}

/** The client's `assertRoutemapSeqno` (DIGITS_ONLY): the reader captures `(\\d+)` (routemaps.py:112). */
export function validateRoutemapSeqno(value: string): string | undefined {
  if (value.trim() === '') return 'A sequence number is required — the clause is addressed by (name, action, seqno).'
  if (!/^\d+$/u.test(value)) return `Sequence \`${value}\` is not digits — the reader captures the seqno as \`(\\d+)\` (routemaps.py:103, :112), so a looser value composes a line no clause read will find. Whether a step of 10 is enforced is the device's answer (DR-032).`
  return undefined
}

/** The client's `assertContinueValue` (routemaps.ts:527+): a positive integer. */
export function validateRoutemapContinueValue(value: string): string | undefined {
  if (!/^\d+$/u.test(value) || Number(value) < 1) return `Continue value \`${value}\` is not a positive integer — the client's guard (upstream routemaps.py:316-318) refuses anything else, so this screen never sends it.`
  return undefined
}

/** The client's `assertStatement` (routemaps.ts:359+): non-empty, single line, no control chars. */
export function validateRoutemapStatement(value: string, keyword: 'match' | 'set'): string | undefined {
  if (value.trim() === '') return `An empty ${keyword} statement composes \`${keyword} \`, which the reader's \`^\\s+${keyword}\\s(.+)$\` never matches back (routemaps.py:141/:145) — omit the statement instead.`
  if (/[\r\n]/u.test(value)) return `A ${keyword} statement must be a single line — one command per line, and the reader anchors each \`${keyword}\` to its own body line.`
  if (hasControlCharacter(value)) return `A ${keyword} statement must not carry a control character — it would break the config line this client reads back.`
  return undefined
}

/** The client's `assertRoutemapDescription`: non-empty, single line (same line-boundary rule). */
export function validateRoutemapDescription(value: string): string | undefined {
  if (value.trim() === '') return 'A description needs a value — an empty one would read back as the bare command (DR-037).'
  if (/[\r\n]/u.test(value)) return 'A description must not contain a line boundary — one command line per staged command (DR-015).'
  if (hasControlCharacter(value)) return 'A description must not carry a control character — it would break the config line this client reads back.'
  return undefined
}

function hasControlCharacter(value: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /[\u0000-\u001F\u007F]/u.test(value)
}

// ------------------------------------------------------------------------------------------------
 // Draft parsing.
// ------------------------------------------------------------------------------------------------

export interface RoutemapClauseDraft {
  readonly name: string
  readonly action: string
  readonly seqno: string
}

export type RoutemapClauseOutcome = { readonly clause: RoutemapClauseRef } | { readonly refusal: string }

export function parseRoutemapClauseDraft(draft: RoutemapClauseDraft): RoutemapClauseOutcome {
  const nameRefusal = validateRoutemapName(draft.name)
  if (nameRefusal !== undefined) return { refusal: nameRefusal }
  const actionRefusal = validateRoutemapAction(draft.action)
  if (actionRefusal !== undefined) return { refusal: actionRefusal }
  const seqnoRefusal = validateRoutemapSeqno(draft.seqno)
  if (seqnoRefusal !== undefined) return { refusal: seqnoRefusal }
  return { clause: { name: draft.name, action: draft.action as RoutemapAction, seqno: draft.seqno } }
}

/** The picker's `<name>/<action>/<seqno>` value. Names may carry `/`, so parse from the RIGHT. */
export function parseRoutemapClauseTarget(target: string): RoutemapClauseRef | undefined {
  const match = /^(.+)\/(permit|deny)\/(\d+)$/u.exec(target)
  if (match === null) return undefined
  return { name: match[1], action: match[2] as RoutemapAction, seqno: match[3] }
}

export function routemapClauseTarget(clause: RoutemapClauseRef): string {
  return `${clause.name}/${clause.action}/${clause.seqno}`
}

/** The textarea's one-per-line draft list: split, trim, drop empties (validated per statement). */
export function parseRoutemapStatementList(text: string): readonly string[] {
  return text.split('\n').map((line) => line.trim()).filter((line) => line !== '')
}

/** Validate every draft statement; returns the first refusal, if any. */
export function validateRoutemapStatementList(statements: readonly string[], keyword: 'match' | 'set'): string | undefined {
  for (const statement of statements) {
    const refusal = validateRoutemapStatement(statement, keyword)
    if (refusal !== undefined) return refusal
  }
  return undefined
}

// ------------------------------------------------------------------------------------------------
 // Reads → rows and references.
// ------------------------------------------------------------------------------------------------

/** One clause, flattened for display. Statements arrive as the reader parsed them, device order. */
export interface RoutemapManagerRow {
  readonly name: string
  readonly action: string
  readonly seqno: string
  readonly matchStatements: string
  readonly setStatements: string
  readonly continueValue: string
  readonly description: string
}

const NONE = '(none)'

/** The clause nesting one map name resolves to — `getAll()` answers `ReadonlyMap<name, RoutemapEntry>`
 * (`routemaps.ts:346`), so this is that value type. Named because a `ReadonlyMap` alias carries no
 * numeric index signature, so an inline `RoutemapEntry[number]`-style projection is not legal (tsc TS2537). */
export type RoutemapClauses = RoutemapEntry

/** Flatten the `name → action → seqno` table into display rows, device order preserved. */
export function routemapManagerRows(table: ReadonlyMap<string, RoutemapClauses>): readonly RoutemapManagerRow[] {
  const rows: RoutemapManagerRow[] = []
  for (const [name, byAction] of table) {
    for (const [action, clauses] of byAction) {
      for (const [seqno, attrs] of clauses) {
        rows.push({
          name,
          action,
          seqno: String(seqno),
          matchStatements: attrs.match.length === 0 ? NONE : attrs.match.join('; '),
          setStatements: attrs.set.length === 0 ? NONE : attrs.set.join('; '),
          continueValue: attrs.continue === undefined ? NONE : String(attrs.continue),
          description: attrs.description === undefined ? NONE : attrs.description,
        })
      }
    }
  }
  return rows
}

/** The attrs for one clause, or `undefined` when the read does not list it. */
export function routemapClauseAttrs(table: ReadonlyMap<string, RoutemapClauses>, clause: RoutemapClauseRef): RoutemapEntryAttrs | undefined {
  return table.get(clause.name)?.get(clause.action)?.get(Number(clause.seqno))
}

/**
 * What the SOFT `ospf.get()` read can establish about one map: which `redistribute … route-map
 * <name>` lines name it. `ospf === undefined` with a SUCCESSFUL read means no OSPF process exists
 * (a normal state — the check ran and found nothing); a FAILED read is the `unknown` arm, decided
 * by the caller via {@link RoutemapReference}.
 */
export function routemapReferencingProtocols(ospf: OspfState, name: string): readonly string[] {
  return ospf.redistributions.filter((r) => r.routeMap === name).map((r) => r.protocol)
}

/** The three reference arms the confirm copy uses (SPEC-routemap-editor.md, "Risk/confirm copy"). */
export type RoutemapReference =
  | { readonly status: 'referenced'; readonly protocols: readonly string[] }
  | { readonly status: 'unreferenced' }
  | { readonly status: 'unknown' }

/**
 * Decide the arm: read FAILED → unknown (the copy says to treat the map as referenced); no OSPF
 * process (a normal `undefined`) → unreferenced (the check ran); else whatever the
 * redistributions name.
 */
export function routemapReference(name: string, ospf: OspfState | undefined, ospfReadFailed: boolean): RoutemapReference {
  if (ospfReadFailed) return { status: 'unknown' }
  if (ospf === undefined) return { status: 'unreferenced' }
  const protocols = routemapReferencingProtocols(ospf, name)
  return protocols.length === 0 ? { status: 'unreferenced' } : { status: 'referenced', protocols }
}

// ------------------------------------------------------------------------------------------------
 // Risk / confirm copy (SPEC-routemap-editor.md). Facts, not adjectives (DR-149): the closest
 // measured route blast is the two-node cEOS withdrawal (67 ms / 6170 ms) and it was NOT a
 // route-map edit — the copy says exactly that, scoped container-only (DR-043). No invented
 // numbers, and inertness stays a stated inference, never a measurement.
// ------------------------------------------------------------------------------------------------

/** The staged-line restatement every entry's risks open with (the S15 `readBack` pattern). */
export function routemapReadBack(lines: readonly string[]): string {
  return `The staged lines: ${lines.map((line) => `\`${line}\``).join(' + ')} — byte-for-byte the line sequence the client's own routemaps verbs compose (mirrored per routemap-rules.ts citations); the device diff, not this screen, decides what running-config actually keeps.`
}

/** The referenced arm: live policy, with the container-only proxy quoted. */
export function routemapReferencedFacts(name: string, protocols: readonly string[]): string {
  return `The OSPF reader saw \`redistribute ${protocols.join(' / ')} route-map ${name}\` — this map is active policy on this switch, and changing it can withdraw or re-admit redistributed routes. The closest measured route blast (two-node cEOS-lab 4.28.14M: withdrawal 67 ms, restore 6170 ms) was a committed advertisement withdrawal, NOT a route-map edit — container evidence, not measured on this unit (DR-043).`
}

/** The unreferenced arm: what the check covered, and the inference it may not overstate. */
export const ROUTEMAP_UNREFERENCED_FACTS =
  'No reference this UI can see names this map (the OSPF reader found no `redistribute … route-map <name>`; interface policies and BGP are invisible to this unit\u2019s reads). Unreferenced route-map config is inferred inert \u2014 that inference is not measured on any target.'

/** The unknown arm: the reference read failed; treat as live policy. */
export const ROUTEMAP_UNKNOWN_REFERENCE_FACTS =
  'The OSPF reference check did not answer on this device, so this screen cannot say whether the map is live policy. Treat it as referenced.'

/** What a delete removes — including the last-clause-deletes-the-name semantics. */
export function routemapDeleteFacts(clause: RoutemapClauseRef): string {
  return `Deleting \`${routemapClauseHeaderLine(clause)}\` removes that clause; deleting the LAST clause of \`${clause.name}\` deletes the name (a route-map exists only through its clauses — the client's documented semantics). This cannot be undone from the running-config; a prior startup-config save would be the only recovery, and this screen never writes startup (DR-024).`
}

/** The far-end note (non-gating, the DR-149 informational pattern). */
export const ROUTEMAP_FAR_END_NOTE =
  'This UI cannot see interface-attached policies, BGP (unmodelled on this SKU), or any other reference surface beyond the OSPF reader\u2019s redistribute lines.'

/** The reference-status sentence for a clause, whichever arm the read supports. */
export function routemapReferenceFacts(reference: RoutemapReference, name: string): string {
  switch (reference.status) {
    case 'referenced': return routemapReferencedFacts(name, reference.protocols)
    case 'unreferenced': return ROUTEMAP_UNREFERENCED_FACTS
    case 'unknown': return ROUTEMAP_UNKNOWN_REFERENCE_FACTS
  }
}

export function routemapEditRisks(lines: readonly string[], reference: RoutemapReference, name: string): readonly string[] {
  return [routemapReadBack(lines), routemapReferenceFacts(reference, name), ROUTEMAP_FAR_END_NOTE]
}

export function routemapDeleteRisks(lines: readonly string[], reference: RoutemapReference, clause: RoutemapClauseRef): readonly string[] {
  return [routemapReadBack(lines), routemapReferenceFacts(reference, clause.name), routemapDeleteFacts(clause), ROUTEMAP_FAR_END_NOTE]
}

/** The shape the coordinator's per-entry `confirmations` seam takes (TransactionConfirmation). */
export interface RoutemapConfirmation {
  readonly title: string
  readonly body: string
  readonly label: string
  readonly subject: string
}

/** The second confirm for create / replace / continue edits — the reference arm is the body. */
export function routemapEditConfirmation(what: string, clause: RoutemapClauseRef, reference: RoutemapReference): RoutemapConfirmation {
  return {
    title: `Second confirm: route-map ${what} ${clause.name} ${clause.action} ${clause.seqno}`,
    body: routemapReferenceFacts(reference, clause.name),
    label: `I accept the route-policy blast: commit the ${what} on ${clause.name}`,
    subject: `route-map ${clause.name} ${clause.action} ${clause.seqno}`,
  }
}

/** The hard second confirm for a delete — reference arm plus the whole-clause loss. */
export function routemapDeleteConfirmation(clause: RoutemapClauseRef, reference: RoutemapReference): RoutemapConfirmation {
  return {
    title: `Second confirm: delete route-map ${clause.name} ${clause.action} ${clause.seqno}`,
    body: `${routemapReferenceFacts(reference, clause.name)} ${routemapDeleteFacts(clause)}`,
    label: `I accept deleting the clause: commit the delete on ${clause.name}`,
    subject: `no route-map ${clause.name} ${clause.action} ${clause.seqno}`,
  }
}

/** Named reason when the SOFT `ospf.get()` read failed — the references panel mutes, per spec. */
export const ROUTEMAP_OSPF_READ_UNAVAILABLE_NOTE =
  'The `ospf.get()` reference read did not answer on this device, so the references panel is muted and every confirm states it cannot say whether a map is live policy (treat maps as referenced). This is a read failure on this device right now, not a claim that no OSPF process exists — reload to retry. The clause table and all forms are unaffected.'

/** The standing banner: what this screen is and what it never does. */
export const ROUTEMAP_EDITOR_STANDING_NOTE =
  'This screen edits route-map clauses — route policy that, once referenced by a redistribution or interface policy, decides which routes are advertised. The reference panel states what the OSPF reader could see; no route-map blast has been measured on this unit, so every confirm quotes the container-only proxy and says so. Writes stage into the shared transaction; the device diff is reviewed in Transaction Center before that commit, which touches running-config only (DR-024). `ip routing` is never touched (#87 Do-Not-Do).'
