/**
 * #87 (VRRP slice): the pure rules behind the VRRP virtual-router editor
 * (`#/routing/vrrp`). No React, no fetches, no device handles — the command TEXT is composed by
 * the CONTAINER calling the client's own dry-run seam, and this module owns the plan parsing,
 * the validation grammar, the candidate list, the row mapping, and every risk/confirm string.
 *
 * ## Why this screen's lines are stronger-pinned than #88's (SPEC-vrrp-editor.md, assumption 3)
 *
 * `vrrp.ts` is a fully ported module (W3c #51, DR-116–121) with a `{ run: false }` dry-run arm on
 * every field setter (`runCommand`/`runCommandList`, vrrp.ts:560-568) that RESOLVES TO the composed
 * line without sending it. The container calls those setters and stages their text — the
 * modern/legacy family choice (`ipv4`/`priority-level`/`session description`/`disabled` vs the
 * legacy spellings) is the client's config-text detection (DR-116), inherited for free. The
 * hardware verdict stands behind the modern arm: `vrrp 1 ipv4 …` staged a real 12-line diff on the
 * 7050TX-64-R (aborted; DR-135 run 9 item 8) while legacy `vrrp 1 ip …` was REFUSED as deprecated.
 *
 * ONE documented literal lives here ({@link vrrpDeleteLine}): `delete()` has no dry-run arm (it
 * always sends, vrrp.ts:588), so the delete line is the client's own era-free literal — pinned at
 * vrrp.ts:588 / vrrp.test.ts:508 — not a string this screen invented. Everything else comes back
 * from a `{ run: false }` call.
 *
 * ## What stays closed (the spec's Out of scope)
 *
 * No advanced-field editing (secondary IPs, tracks, BFD, ip-version, mac-adv-interval, delays are
 * read-only columns); no `default vrrp` arm; no `no vrrp <n> <field>` negation lines the client
 * does not compose through its value arms; nothing here touches `ip routing` (the audit's #87
 * "Do Not Do"); nothing here commits (the Transaction Center owns commit/abort, #141).
 */
import type { Node, Vrrp, VrrpResource, VrrpVridTable } from '@devhax-heavy-industries/arista-eapi'

/** The six field setters this screen composes through — the client's dry-run seam, nothing more. */
export type VrrpSetterSeam = Pick<VrrpResource, 'setEnable' | 'setPrimaryIp' | 'setPriority' | 'setDescription' | 'setPreempt' | 'setTimersAdvertise'>

/** The `interface <name>` parent every batch is framed under (the `submodeCommands` convention). */
export function vrrpParentLine(interfaceName: string): string {
  return `interface ${interfaceName}`
}

/**
 * The delete line — the ONE literal this screen composes by hand, because `delete()` has no
 * dry-run arm (it always sends, vrrp.ts:588). The text is the client's own era-free literal
 * (`vrrp_str = "no vrrp %d"`, pyeapi vrrp.py:436; client vrrp.ts:588; pin vrrp.test.ts:508).
 */
export function vrrpDeleteLine(vrid: number): string {
  return `no vrrp ${String(vrid)}`
}

// ------------------------------------------------------------------------------------------------
 // Validation — mirrors the CLIENT's guards (grammar, not device bounds; DR-120). A value that
 // passes these may still be refused by the device; that refusal is the device's own answer
 // (DR-057), surfaced verbatim at commit time.
// ------------------------------------------------------------------------------------------------

/** The client's `assertVrrpId`: a non-negative integer. Mirrored as a string-grammar check. */
export function validateVrrpId(value: string): string | undefined {
  if (value.trim() === '') return 'A VRID is required — every VRRP line this screen stages names the virtual router by its id.'
  if (!/^\d+$/u.test(value)) return `VRID \`${value}\` is not a non-negative integer — the client's own guard (assertVrrpId) refuses anything else, so this screen never sends it.`
  return undefined
}

/** The client's `IPV4_GRAMMAR` (vrrp.ts, `^\d+\.\d+\.\d+\.\d+$`) — dotted-quad only. */
export function validateVrrpAddress(label: string, value: string): string | undefined {
  if (value.trim() === '') return `${label} is required — a virtual router without its address line is not what this form creates.`
  if (!/^\d+\.\d+\.\d+\.\d+$/u.test(value)) return `${label} \`${value}\` is not a dotted-quad IPv4 address — the client's grammar (IPV4_GRAMMAR) refuses anything else, so this screen never sends it.`
  return undefined
}

/** The client's `assertIntRange('priority', …, 1, 254)` (vrrp.ts:655). */
export function validateVrrpPriority(value: string): string | undefined {
  if (!/^\d+$/u.test(value)) return `Priority \`${value}\` is not a whole number — the client's guard (assertIntRange 1-254) refuses anything else.`
  const n = Number(value)
  if (n < 1 || n > 254) return `Priority ${String(n)} is outside 1-254 — the client's guard (assertIntRange at vrrp.ts:655) refuses anything outside that range, so this screen never sends it.`
  return undefined
}

/** The client's `assertIntRange('timers_advertise', …, 1, 255)` (setTimersAdvertise). */
export function validateVrrpAdvertiseInterval(value: string): string | undefined {
  if (!/^\d+$/u.test(value)) return `Advertisement interval \`${value}\` is not a whole number — the client's guard (assertIntRange 1-255) refuses anything else.`
  const n = Number(value)
  if (n < 1 || n > 255) return `Advertisement interval ${String(n)} is outside 1-255 — the client's guard refuses anything outside that range, so this screen never sends it.`
  return undefined
}

/** The client's `commandBuilder` value rules: no empty/whitespace value, no line boundary (DR-015). */
export function validateVrrpDescription(value: string): string | undefined {
  if (value.trim() === '') return 'A description needs a value — an empty one would read back as the bare command, and the client refuses it (DR-037). Use the Edit form only to set text.'
  if (/[\r\n]/u.test(value)) return 'A description must not contain a line boundary — one command line per staged command (DR-015).'
  return undefined
}

// ------------------------------------------------------------------------------------------------
 // Create — plan parsing. The composed ORDER is the client's `_vrrp_set` sequence restricted to
 // the fields this form offers (enable, primaryIp, priority, description, preempt — order pinned
 // at vrrp.test.ts:404-424); the enable line is ALWAYS first, because `create` injects
 // `enable: false` when the caller omits it (vrrp.ts:585, pyeapi vrrp.py:413-414) — reproduced.
// ------------------------------------------------------------------------------------------------

export interface VrrpCreateDraft {
  readonly interfaceName: string
  readonly vrid: string
  readonly primaryIp: string
  /** '' = leave the field out of the batch (no line staged). */
  readonly priority: string
  /** '' = no description line. */
  readonly description: string
  /** '' = no preempt line (device default applies). */
  readonly preempt: string
  /** `'disabled'` (the `create` default) or `'enabled'` — the enable line is always composed. */
  readonly startState: string
}

export interface VrrpCreatePlan {
  readonly interfaceName: string
  readonly vrid: number
  /** false → `vrrp <n> disabled` (modern family); true → `no vrrp <n> disabled`. */
  readonly enable: boolean
  readonly primaryIp: string
  readonly priority?: number
  readonly description?: string
  readonly preempt?: boolean
}

export type VrrpCreateOutcome = { readonly plan: VrrpCreatePlan } | { readonly refusal: string }

export function parseVrrpCreateDraft(draft: VrrpCreateDraft): VrrpCreateOutcome {
  if (draft.interfaceName === '') return { refusal: 'Choose the interface the virtual router lives on — this screen never guesses one; the candidate list comes from the device reads.' }
  const vridRefusal = validateVrrpId(draft.vrid)
  if (vridRefusal !== undefined) return { refusal: vridRefusal }
  const ipRefusal = validateVrrpAddress('Primary IPv4 address', draft.primaryIp)
  if (ipRefusal !== undefined) return { refusal: ipRefusal }
  if (draft.priority !== '') {
    const priorityRefusal = validateVrrpPriority(draft.priority)
    if (priorityRefusal !== undefined) return { refusal: priorityRefusal }
  }
  if (draft.description !== '') {
    const descriptionRefusal = validateVrrpDescription(draft.description)
    if (descriptionRefusal !== undefined) return { refusal: descriptionRefusal }
  }
  if (draft.startState !== 'disabled' && draft.startState !== 'enabled') {
    return { refusal: 'Choose the start state — `create` always carries an enable line (it injects `enable: false` when omitted, vrrp.ts:585), so this form states which one it stages.' }
  }
  return {
    plan: {
      interfaceName: draft.interfaceName,
      vrid: Number(draft.vrid),
      enable: draft.startState === 'enabled',
      primaryIp: draft.primaryIp,
      ...(draft.priority === '' ? {} : { priority: Number(draft.priority) }),
      ...(draft.description === '' ? {} : { description: draft.description }),
      ...(draft.preempt === '' ? {} : { preempt: draft.preempt === 'yes' }),
    },
  }
}

/**
 * The create batch, composed through the CLIENT's dry-run setters in `_vrrp_set` order (enable
 * line first). Every line is the client's own text — `{ run: false }` returns it without sending
 * (vrrp.ts:560-568) — and the family spelling is the client's config-text detection (DR-116),
 * inherited for free.
 */
export async function composeVrrpCreateLines(setters: VrrpSetterSeam, plan: VrrpCreatePlan): Promise<readonly string[]> {
  const lines: string[] = []
  lines.push(await setters.setEnable(plan.interfaceName, plan.vrid, plan.enable, { run: false }))
  lines.push(await setters.setPrimaryIp(plan.interfaceName, plan.vrid, { value: plan.primaryIp, run: false }))
  if (plan.priority !== undefined) lines.push(await setters.setPriority(plan.interfaceName, plan.vrid, { value: plan.priority, run: false }))
  if (plan.description !== undefined) lines.push(await setters.setDescription(plan.interfaceName, plan.vrid, { value: plan.description, run: false }))
  if (plan.preempt !== undefined) lines.push(await setters.setPreempt(plan.interfaceName, plan.vrid, { value: plan.preempt, run: false }))
  return lines
}

// ------------------------------------------------------------------------------------------------
 // Edit — one field of an existing group. The field set is the bounded v1 set (spec intake 1);
 // the advanced fields have no arm here on purpose.
// ------------------------------------------------------------------------------------------------

export type VrrpEditField = 'enable' | 'priority' | 'description' | 'preempt' | 'timersAdvertise'

/** Field metadata for the edit form: label, value-input kind, and the composed-line preview. */
export const VRRP_EDIT_FIELDS: readonly { value: VrrpEditField; label: string; kind: 'boolean' | 'number' | 'text' }[] = [
  { value: 'enable', label: 'Enabled state (admin up/down)', kind: 'boolean' },
  { value: 'priority', label: 'Priority (1-254)', kind: 'number' },
  { value: 'preempt', label: 'Preempt', kind: 'boolean' },
  { value: 'description', label: 'Description', kind: 'text' },
  { value: 'timersAdvertise', label: 'Advertisement interval (1-255 s, read-only elsewhere — edit only here)', kind: 'number' },
]

export function isVrrpEditField(value: string): value is VrrpEditField {
  return VRRP_EDIT_FIELDS.some((field) => field.value === value)
}

export interface VrrpEditDraft {
  /** `<interface>/<vrid>` as the picker spells it. */
  readonly target: string
  readonly field: string
  readonly value: string
}

/** Discriminated so composition never needs a non-null assertion. */
export type VrrpEditPlan =
  | { readonly interfaceName: string; readonly vrid: number; readonly field: 'enable' | 'preempt'; readonly value: boolean }
  | { readonly interfaceName: string; readonly vrid: number; readonly field: 'priority' | 'timersAdvertise'; readonly value: number }
  | { readonly interfaceName: string; readonly vrid: number; readonly field: 'description'; readonly value: string }

export type VrrpEditOutcome = { readonly plan: VrrpEditPlan } | { readonly refusal: string }

/** Split the picker's `<interface>/<vrid>` value. Interface names never carry `/` (Vlan10, Ethernet1). */
export function parseVrrpGroupTarget(target: string): { interfaceName: string; vrid: number } | undefined {
  const slash = target.indexOf('/')
  if (slash <= 0) return undefined
  const vrid = target.slice(slash + 1)
  if (!/^\d+$/u.test(vrid)) return undefined
  return { interfaceName: target.slice(0, slash), vrid: Number(vrid) }
}

export function parseVrrpEditDraft(draft: VrrpEditDraft): VrrpEditOutcome {
  const target = parseVrrpGroupTarget(draft.target)
  if (target === undefined) return { refusal: 'Choose the virtual router to edit — the picker lists every (interface, VRID) pair this read answered.' }
  if (!isVrrpEditField(draft.field)) return { refusal: 'Choose which single field to change — this screen stages exactly one field line per edit.' }
  if (draft.field === 'enable' || draft.field === 'preempt') {
    if (draft.value !== 'true' && draft.value !== 'false') return { refusal: `Choose the new ${draft.field === 'enable' ? 'enabled state' : 'preempt state'} — yes or no.` }
    return { plan: { ...target, field: draft.field, value: draft.value === 'true' } }
  }
  if (draft.field === 'priority') {
    const refusal = validateVrrpPriority(draft.value)
    if (refusal !== undefined) return { refusal }
    return { plan: { ...target, field: draft.field, value: Number(draft.value) } }
  }
  if (draft.field === 'timersAdvertise') {
    const refusal = validateVrrpAdvertiseInterval(draft.value)
    if (refusal !== undefined) return { refusal }
    return { plan: { ...target, field: draft.field, value: Number(draft.value) } }
  }
  const refusal = validateVrrpDescription(draft.value)
  if (refusal !== undefined) return { refusal }
  return { plan: { ...target, field: 'description', value: draft.value } }
}

/** The one-line edit batch, composed through the matching dry-run setter. */
export async function composeVrrpEditLine(setters: VrrpSetterSeam, plan: VrrpEditPlan): Promise<string> {
  switch (plan.field) {
    case 'enable': return setters.setEnable(plan.interfaceName, plan.vrid, plan.value, { run: false })
    case 'preempt': return setters.setPreempt(plan.interfaceName, plan.vrid, { value: plan.value, run: false })
    case 'priority': return setters.setPriority(plan.interfaceName, plan.vrid, { value: plan.value, run: false })
    case 'timersAdvertise': return setters.setTimersAdvertise(plan.interfaceName, plan.vrid, { value: plan.value, run: false })
    case 'description': return setters.setDescription(plan.interfaceName, plan.vrid, { value: plan.value, run: false })
  }
}

/**
 * The already-says guard: staging the value the running-config already carries is a no-op line,
 * refused at zero appends (the StpGlobal mode-guard pattern). `undefined` current (no line) never
 * matches a requested value, so first-time writes always pass.
 */
export function vrrpEditAlreadySays(current: Vrrp | undefined, plan: VrrpEditPlan): boolean {
  if (current === undefined) return false
  switch (plan.field) {
    case 'enable': return current.enable === plan.value
    case 'preempt': return current.preempt === plan.value
    case 'priority': return current.priority === plan.value
    case 'timersAdvertise': return current.timersAdvertise === plan.value
    case 'description': return current.description === plan.value
  }
}

// ------------------------------------------------------------------------------------------------
 // Reads → rows and candidates.
// ------------------------------------------------------------------------------------------------

/**
 * The create form's interface candidates: the union of interfaces the `vrrp` table already names
 * and the ones the SOFT `ipinterfaces` reader lists (L3 interfaces). `l3 === undefined` means the
 * soft read FAILED — the list narrows to the table's own names, with the named note rendered by
 * the view. Device order is preserved: table names first, then L3-only names.
 */
export function vrrpCandidateInterfaces(configured: readonly string[], l3: readonly string[] | undefined): readonly string[] {
  if (l3 === undefined) return configured
  const seen = new Set(configured)
  return [...configured, ...l3.filter((name) => !seen.has(name))]
}

/** One configured group, flattened for display. Advanced fields render as stated strings, never edited. */
export interface VrrpManagerRow {
  readonly interfaceName: string
  readonly vrid: number
  readonly enabled: string
  readonly priority: string
  readonly preempt: string
  readonly primaryIp: string
  readonly description: string
  // Read-only advanced detail (v1 shows these, never edits them — spec intake 1).
  readonly secondaryIps: string
  readonly advertiseInterval: string
  readonly macAdvInterval: string
  readonly ipVersion: string
  readonly tracks: string
  readonly bfdIp: string
  readonly delays: string
}

const NONE = '(none)'

/** Flatten the configured table into display rows, device order preserved. */
export function vrrpManagerRows(table: ReadonlyMap<string, VrrpVridTable>): readonly VrrpManagerRow[] {
  const rows: VrrpManagerRow[] = []
  for (const [interfaceName, vrids] of table) {
    for (const [vrid, vrrp] of vrids) {
      rows.push({
        interfaceName,
        vrid,
        enabled: vrrp.enable ? 'enabled' : 'disabled',
        priority: vrrp.priority === undefined ? '(no priority line)' : String(vrrp.priority),
        preempt: vrrp.preempt ? 'yes' : 'no',
        primaryIp: vrrp.primaryIp ?? '(no ip line)',
        description: vrrp.description === '' ? NONE : vrrp.description,
        secondaryIps: vrrp.secondaryIp.length === 0 ? NONE : vrrp.secondaryIp.join(', '),
        advertiseInterval: vrrp.timersAdvertise === undefined ? NONE : `${String(vrrp.timersAdvertise)} s`,
        macAdvInterval: vrrp.macAddrAdvInterval === undefined ? NONE : String(vrrp.macAddrAdvInterval),
        ipVersion: vrrp.ipVersion === undefined ? NONE : String(vrrp.ipVersion),
        tracks: vrrp.track.length === 0 ? NONE : vrrp.track.map((t) => `${t.name} ${t.action}${t.amount === undefined ? '' : ` ${String(t.amount)}`}`).join('; '),
        bfdIp: vrrp.bfdIp === null ? '(bare bfd ip line)' : vrrp.bfdIp === '' ? NONE : vrrp.bfdIp,
        delays: formatDelays(vrrp),
      })
    }
  }
  return rows
}

function formatDelays(vrrp: Vrrp): string {
  const parts: string[] = []
  if (vrrp.preemptDelayMin !== undefined) parts.push(`preempt minimum ${String(vrrp.preemptDelayMin)}`)
  if (vrrp.preemptDelayReload !== undefined) parts.push(`preempt reload ${String(vrrp.preemptDelayReload)}`)
  if (vrrp.delayReload !== undefined) parts.push(`reload ${String(vrrp.delayReload)}`)
  return parts.length === 0 ? NONE : parts.join(', ')
}

// ------------------------------------------------------------------------------------------------
 // Risk / confirm copy (SPEC-vrrp-editor.md, "Risk/confirm copy"). Facts, not adjectives (DR-149):
 // the failover blast is measured on disposable cEOS-lab containers ONLY (DR-157, run
// lab-1926138-47bd56) — the copy cites those numbers AS container evidence and never presents
// them as this unit's behavior (DR-043). Hardware timing stays unmeasured; no fabricated number.
// ------------------------------------------------------------------------------------------------

/** The staged-line restatement every entry's risks open with (the S15 `readBack` pattern). */
export function vrrpReadBack(lines: readonly string[]): string {
  return `The staged lines: ${lines.map((line) => `\`${line}\``).join(' + ')} — byte-for-byte the text the client's own dry-run setters composed with { run: false }; the device diff, not this screen, decides what running-config actually keeps.`
}

/**
 * The failover blast — container-measured (DR-157, run lab-1926138-47bd56: a two-node cEOS-lab
 * pair where disabling the master's group promoted the backup in 70 ms — an immediate release,
 * not a master_down expiry — and re-enabling let the master preempt back at 3391 ms, ≈ the
 * master_down interval at default timers). The numbers are cited AS container evidence; the
 * hardware timing stays unmeasured (DR-043).
 */
export function vrrpFailoverFacts(interfaceName: string): string {
  return `Changing this virtual router can trigger a VRRP master switchover for ${interfaceName}'s default-gateway traffic: the backup takes over the virtual IP and in-flight traffic for that VLAN's hosts is interrupted until it does. The only measured VRRP blast (two-node cEOS-lab 4.28.14M: the backup promoted 70 ms after the master disabled its group; the master preempted back 3391 ms after re-enable) is container evidence, not measured on this unit (DR-157, DR-043) — this unit's own timing stays unmeasured, and its first real use is the measurement opportunity.`
}

/** What a delete removes — the whole group, unrecoverable from running-config. */
export function vrrpDeleteFacts(interfaceName: string, vrid: number): string {
  return `Removing \`vrrp ${String(vrid)}\` from ${interfaceName} deletes the whole group (IP, priority, timers, any tracked objects) — this cannot be undone from the running-config; a prior startup-config save would be the only recovery, and this screen never writes startup (DR-024).`
}

/** The captured `no ip routing` state, stated so a create is not mistaken for enabling routing. */
export const VRRP_CREATE_IP_ROUTING_NOTE =
  'This box runs `no ip routing` today (captured); a VRRP group on an SVI is configured state and does not by itself enable inter-VLAN routing. This screen never touches `ip routing` (#87 Do-Not-Do).'

/** Why an advertisement-interval edit carries risks but no second confirm (spec: risks only). */
export function vrrpAdvertiseIntervalRisk(): string {
  return 'Changing the advertisement interval changes how quickly peers declare this master down and how long a preempt-back takes — on the measured container pair (cEOS-lab 4.28.14M, default 1 s timers) the preempt-back settled at 3391 ms, roughly the master_down interval; container evidence, not this unit (DR-157, DR-043).'
}

/** The far-end note (non-gating, the DR-149 informational pattern). */
export function vrrpFarEndNote(interfaceName: string): string {
  return `This UI cannot see what is attached on the far end of ${interfaceName} or whether a peer router holds the backup for this VRID.`
}

export function vrrpCreateRisks(lines: readonly string[], interfaceName: string): readonly string[] {
  return [vrrpReadBack(lines), vrrpFailoverFacts(interfaceName), VRRP_CREATE_IP_ROUTING_NOTE, vrrpFarEndNote(interfaceName)]
}

/** True when an edit field can move the master and therefore forces the second confirm. */
export function vrrpEditForcesConfirm(field: VrrpEditField): boolean {
  return field === 'enable' || field === 'priority' || field === 'preempt'
}

export function vrrpEditRisks(lines: readonly string[], interfaceName: string, field: VrrpEditField): readonly string[] {
  return [
    vrrpReadBack(lines),
    ...(vrrpEditForcesConfirm(field) ? [vrrpFailoverFacts(interfaceName)] : []),
    ...(field === 'timersAdvertise' ? [vrrpAdvertiseIntervalRisk()] : []),
    vrrpFarEndNote(interfaceName),
  ]
}

export function vrrpDeleteRisks(lines: readonly string[], interfaceName: string, vrid: number): readonly string[] {
  return [vrrpReadBack(lines), vrrpFailoverFacts(interfaceName), vrrpDeleteFacts(interfaceName, vrid), vrrpFarEndNote(interfaceName)]
}

/** The shape the coordinator's per-entry `confirmations` seam takes (TransactionConfirmation). */
export interface VrrpConfirmation {
  readonly title: string
  readonly body: string
  readonly label: string
  readonly subject: string
}

/** The second confirm for create and the master-moving edits (enable/priority/preempt). */
export function vrrpFailoverConfirmation(interfaceName: string, vrid: number, what: string): VrrpConfirmation {
  return {
    title: `Second confirm: VRRP ${what} on ${interfaceName} (vrid ${String(vrid)})`,
    body: vrrpFailoverFacts(interfaceName),
    label: `I accept the VRRP failover blast: commit the ${what} on ${interfaceName}`,
    subject: `vrrp ${String(vrid)} on ${interfaceName}`,
  }
}

/** The hard second confirm for a delete — failover plus whole-group-deletion facts. */
export function vrrpDeleteConfirmation(interfaceName: string, vrid: number): VrrpConfirmation {
  return {
    title: `Second confirm: delete vrrp ${String(vrid)} on ${interfaceName}`,
    body: `${vrrpFailoverFacts(interfaceName)} ${vrrpDeleteFacts(interfaceName, vrid)}`,
    label: `I accept deleting the whole group: commit the delete on ${interfaceName}`,
    subject: `no vrrp ${String(vrid)} on ${interfaceName}`,
  }
}

/** Named reason when the SOFT `ipinterfaces` read failed — the candidate list narrows, per spec. */
export const VRRP_L3_READ_UNAVAILABLE_NOTE =
  'The `ipinterfaces.getAll()` read did not answer on this device, so the create form can only offer the interfaces the VRRP table already names. This is a read failure on this device right now, not a claim that no other L3 interface exists — reload to retry. The table, edit, and delete forms are unaffected.'

/** The standing banner: what this screen is and what it never does. */
export const VRRP_EDITOR_STANDING_NOTE =
  'This screen edits VRRP virtual routers — the most traffic-impacting per-interface state on a default gateway. The only measured VRRP failover blast is the two-node cEOS-lab lane (backup promoted in 70 ms, preempt-back in 3391 ms — container evidence, not this unit, DR-157/DR-043), and every confirm cites it as exactly that. Writes stage into the shared transaction; the device diff is reviewed in Transaction Center before that commit, which touches running-config only (DR-024). `ip routing` is never touched (#87 Do-Not-Do).'

/** Narrow seam alias used by the container's props. */
export type VrrpManagerNode = Pick<Node, 'vrrp' | 'ipinterfaces' | 'show' | 'configSession'>
