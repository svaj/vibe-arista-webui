/**
 * B3 (#88) step 2: the pure rules behind the SPANNING-TREE GLOBAL screen (`#/stp/global`) —
 * the global mode editor and the MST region editor the owner unblocked in DR-149. No React, no
 * client import at runtime; every composed string here is pinned by `stp-global-rules.test.ts`.
 *
 * ## The evidence each line is pinned to (SPEC-stp-global-editor.md, "Verified facts")
 *
 * This module is the repo's one deliberate CONVENTION DEVIATION (owner decision 2026-11-21): the
 * command text pins to CAPTURED ARTIFACTS, not to client verbs, because pyeapi never had
 * MST-region verbs and no client slice was authorized. Every constant below cites its capture:
 *
 * - `spanning-tree mode mstp` / `spanning-tree mode none` — hardware: boot mode is `mstp`
 *   (hw captures, DR-096 note); `none` staged FULL on the 7050TX-64-R (DR-141 round 2, run 9).
 * - `spanning-tree mode rapid-pvst` — STAGE-ACCEPTED on the 7050TX-64-R (2026-11-22 capture
 *   day, batch `unblock3-stp-rapid-pvst`, DR-159: the diff showed `-spanning-tree mode mstp` /
 *   `+spanning-tree mode rapid-pvst`, aborted, nothing committed). The COMMITTED flip + reverse
 *   stays a cEOS-lab 4.28.14M measurement (`docs/evidence/stp-mode-change.ceos.json`, DR-148);
 *   the mandatory in-form disclosure ({@link stpRapidPvstDisclosure}) carries that split. The
 *   camelCase `rapidPvst` belongs to `show` JSON only — the CONFIG line is hyphenated, as the
 *   capture sent it.
 * - `spanning-tree mst configuration` + `name …` + `revision …` + `instance … vlan …` —
 *   hardware: batch `unblock-stp-mst-region-grammar`
 *   (`arista-api-client/docs/hw-capture-unblock.draft.json`) staged the exact shape
 *   `LAB-UNBLOCK` / `1` / `instance 1 vlan 100,110` and aborted. The capture sent the child
 *   lines with leading whitespace; this screen stages them UNINDENTED, the same shape every
 *   interface-submode batch this app has staged on hardware uses (`submodeCommands`), because
 *   sequential in-submode application is the proven mechanism. The device diff stays the
 *   authority on what the block keeps.
 *
 * - `no instance <id>` / `no instance <id> vlan <ranges>` / `no name` / `no revision` —
 *   first on cEOS-lab 4.28.14M (`docs/evidence/unblock-grammar-ceos.json`, batch rea-q1..q4),
 *   then HARDWARE-CONFIRMED on the 7050TX-64-R (2026-11-22, batches `unblock3-stp-mst-remove-
 *   bare`/`-quad`/`unblock3-stp-mst-no-name-revision`, DR-159): all three shapes stage on this
 *   unit, and the add+remove pair nets to an EMPTY session diff — the device accepted both
 *   halves and the block came back unchanged. The screen stages the BARE `no instance <id>` —
 *   both captures showed the spellings stage identically, and the bare form cannot misquote the
 *   device's own VLAN-list spacing (it normalizes `vlan 100,110` to `vlan  100,110` in stored
 *   config — see {@link parseStpRegionSection}). The device diff stays the authority.
 *
 * ## What stays closed (the spec's Out of scope)
 *
 * No `no spanning-tree mode` / `default spanning-tree mode` arm (DR-096's client grammar is the
 * only unset story and this screen offers none); no mode value outside the three approved ones;
 * nothing here commits anything (the Transaction Center owns commit/abort, #141).
 */

/** The three mode values the owner approved for the editor (2026-11-21 intake). */
export type StpGlobalModeChoice = 'mstp' | 'none' | 'rapid-pvst'

export const STP_GLOBAL_MODES: readonly StpGlobalModeChoice[] = ['mstp', 'none', 'rapid-pvst']

export function isStpGlobalModeChoice(value: string): value is StpGlobalModeChoice {
  return (STP_GLOBAL_MODES as readonly string[]).includes(value)
}

/**
 * The mode-change line — spelling pinned to the committed cEOS flip
 * (`stp-mode-change.ceos.json`: `spanning-tree mode rapid-pvst`) and the hardware stage-abort of
 * `spanning-tree mode none` (DR-141 round 2). `rapid-pvst` is stage-accepted on this unit
 * (DR-159) but offered ONLY with its disclosure ({@link stpRapidPvstDisclosure}) — the COMMITTED
 * behavior is still the container measurement.
 */
export function stpModeLine(mode: StpGlobalModeChoice): string {
  return `spanning-tree mode ${mode}`
}

/** The section header the MST region block hangs under in the running-config (capture batch 6). */
export const STP_REGION_SECTION = 'spanning-tree mst configuration'

/** One `instance <id> vlan <ranges>` line — the capture's spelling (`instance 1 vlan 100,110`). */
export function stpRegionInstanceLine(id: string, vlans: string): string {
  return `instance ${id} vlan ${vlans}`
}

/**
 * The removal line for one mapping — the BARE `no instance <id>`, the spelling
 * `docs/evidence/unblock-grammar-ceos.json` rea-q2 staged (and rea-q1 proved the quad form
 * stages identically). Bare is deliberately chosen: it cannot misquote the device's own
 * double-space VLAN-list spelling, and the diff showed it nets the mapping out of the block.
 */
export function stpRegionNoInstanceLine(id: string): string {
  return `no instance ${id}`
}

/**
 * The region-edit batch WITHOUT the parent line: only the lines the operator changed, added, or
 * removed (EOS applies the block incrementally; the device diff is the proof). Removals ride the
 * capture-backed bare `no instance <id>` (rea-q2, unblock-grammar-ceos.json).
 */
export interface MstRegionDraft {
  /** The typed region name, or `undefined` when the operator left it untouched. */
  readonly name?: string
  /** The typed revision, or `undefined` when untouched. */
  readonly revision?: string
  /** Mapping rows the operator ADDED this session. */
  readonly instances: readonly { readonly id: string; readonly vlans: string }[]
  /** Instance ids whose mapping line the operator is REMOVING (each must be in the read). */
  readonly removeInstances?: readonly { readonly id: string }[]
}

/** The child lines a draft stages, in capture order: name, revision, added rows, then removals. */
export function stpRegionChildLines(draft: MstRegionDraft): readonly string[] {
  const lines: string[] = []
  if (draft.name !== undefined) lines.push(`name ${draft.name}`)
  if (draft.revision !== undefined) lines.push(`revision ${draft.revision}`)
  for (const row of draft.instances) lines.push(stpRegionInstanceLine(row.id, row.vlans))
  for (const row of draft.removeInstances ?? []) lines.push(stpRegionNoInstanceLine(row.id))
  return lines
}

/** True when a draft would stage nothing (the container refuses this in-form, at zero sessions). An empty string is "untouched", same as absent. */
export function stpRegionDraftIsEmpty(draft: MstRegionDraft): boolean {
  return (draft.name === undefined || draft.name === '') && (draft.revision === undefined || draft.revision === '') && draft.instances.length === 0 && (draft.removeInstances?.length ?? 0) === 0
}

// --- region read model (parsed from the chunked running-config section) -------------------------

/** One `instance … vlan …` line as the block states it — device tokens kept verbatim (DR-032). */
export interface MstRegionInstanceView {
  readonly id: string
  readonly vlans: string
}

/** The configured MST region, folded out of the section text. Absent fields were absent lines. */
export interface MstRegionView {
  readonly name?: string
  readonly revision?: string
  readonly instances: readonly MstRegionInstanceView[]
}

/**
 * Parse the `spanning-tree mst configuration` section body. Header line skipped; every body line
 * is matched against the three capture spellings; an unrecognised line is KEPT as an opaque count
 * (the view says "N line(s) this screen does not model") rather than dropped silently — the
 * region editor never re-states lines it did not parse.
 */
export function parseStpRegionSection(sectionText: string): MstRegionView & { readonly unmodelledLines: number } {
  const lines = sectionText
    .split('\n')
    .slice(1) // the header line itself
    .map((line) => line.trim())
    .filter((line) => line !== '')
  let name: string | undefined
  let revision: string | undefined
  const instances: MstRegionInstanceView[] = []
  let unmodelledLines = 0
  for (const line of lines) {
    const nameMatch = /^name (\S+)$/u.exec(line)
    const revisionMatch = /^revision (\S+)$/u.exec(line)
    // `vlan\s+` (two spaces allowed): the device NORMALIZES the stored line to
    // `instance 1 vlan  100,110` — double space — visible in both the hardware batch diff
    // (unblock-stp-mst-region-grammar) and the cEOS grammar capture. A single-space-only regex
    // would count the device's own line as unmodelled.
    const instanceMatch = /^instance (\S+) vlan\s+(\S+)$/u.exec(line)
    if (nameMatch !== null) name = nameMatch[1]
    else if (revisionMatch !== null) revision = revisionMatch[1]
    else if (instanceMatch !== null) instances.push({ id: instanceMatch[1], vlans: instanceMatch[2] })
    else unmodelledLines += 1
  }
  return {
    ...(name === undefined ? {} : { name }),
    ...(revision === undefined ? {} : { revision }),
    instances,
    unmodelledLines,
  }
}

// --- in-form validation (CLIENT grammar, explicitly not device fact — DR-057 keeps the say) -----

/**
 * Region name: 1-32 printable non-space characters. The bound is the IEEE/industry MST-config-name
 * shape and is marked UNVERIFIED-on-this-SKU (SPEC-stp-global-editor.md, Unknowns): a device that
 * accepts or refuses something else answers with its own `CommandError`, never a crash here.
 */
export function validateStpRegionName(value: string): string | undefined {
  if (value === '') return undefined
  if (!/^[\x21-\x7e]{1,32}$/u.test(value)) {
    return 'The MST region name must be 1-32 printable characters with no spaces (client-side shape check — the device has the final say).'
  }
  return undefined
}

/** Revision: integer 1-65535 (UNVERIFIED-on-this-SKU bound; the device is the authority). */
export function validateStpRegionRevision(value: string): string | undefined {
  if (value === '') return undefined
  if (!/^\d{1,5}$/.test(value) || Number(value) < 1 || Number(value) > 65535) {
    return 'The MST revision must be a whole number from 1 to 65535 (client-side shape check — the device has the final say).'
  }
  return undefined
}

/** Instance id: integer 0-64 (IEEE 802.1s instance-id shape; UNVERIFIED-on-this-SKU bound). */
export function validateStpInstanceId(value: string): string | undefined {
  if (!/^\d{1,2}$/.test(value) || Number(value) > 64) {
    return 'The MST instance id must be a whole number from 0 to 64 (IEEE 802.1s shape, client-side check — the device has the final say).'
  }
  return undefined
}

/** VLAN list: comma-separated single VLANs or `A-B` spans, every VLAN 1-4094 (capture sample: `100,110`). */
export function validateStpVlanRanges(value: string): string | undefined {
  if (value === '') return 'The VLAN list is required — an `instance … vlan …` line names at least one VLAN (capture spelling: `100,110`).'
  for (const part of value.split(',')) {
    const span = /^(\d{1,4})(?:-(\d{1,4}))?$/.exec(part.trim())
    if (span === null) {
      return `VLAN list part "${part}" is not a VLAN number or an A-B span — the capture's spelling is a comma list like \`100,110\` or a span like \`100-200\`.`
    }
    const low = Number(span[1])
    const high = span[2] === undefined ? low : Number(span[2])
    if (low < 1 || high > 4094 || low > high) {
      return `VLAN range "${part}" is out of shape — every VLAN must be 1-4094 and a span must not descend.`
    }
  }
  return undefined
}

// --- risk + confirm copy (DR-149: the confirm carries the CAPTURED facts, not adjectives) -------

/**
 * The measured blast sentence, pinned from `docs/evidence/stp-mode-change.ceos.json` (DR-148)
 * with the DR-043 scoping line. The numbers are the cEOS-lab container's; the copy says so.
 */
export const STP_MODE_BLAST_FACTS =
  'Re-initializes spanning-tree instances network-wide. On the measured cEOS-lab 4.28.14M container the mstp→rapidPvst flip took ~67 ms and MST0 was replaced by per-VLAN instances; expect a brief forwarding interruption on every VLAN. Container measurement — not measured on this 7050TX-64-R (DR-043).'

/** Mode → `none`: what it removes, stated without a fake measurement (never measured anywhere). */
export const STP_MODE_NONE_FACTS =
  'Disables spanning-tree on every port. Loop protection is gone network-wide until a mode is set again. Not measured on any target.'

/**
 * The mandatory `rapid-pvst` disclosure (owner decision 2026-11-21: offered, disclosed). The
 * 2026-11-22 capture day (DR-159) moved the first half to hardware fact — the unit STAGE-ACCEPTS
 * the line — so the residual uncertainty is the COMMITTED behavior, still container-only.
 */
export function stpRapidPvstDisclosure(): string {
  return '`rapid-pvst` is STAGE-ACCEPTED on this 7050TX-64-R (2026-11-22 capture day, DR-159 — the session diff showed the mode swap, aborted, nothing committed). The committed flip is measured on cEOS-lab 4.28.14M only (DR-148); its blast numbers stay a container proxy (DR-043).'
}

/** Region name/revision: the IEEE 802.1s forced-reconvergence sentence, marked not-measured-here. */
export const STP_REGION_IDENTITY_RISK =
  'Changing the MST region name or revision forces spanning-tree re-convergence on all MST instances (IEEE 802.1s behavior; not measured on this unit).'

/** Instance remap: narrower blast, same honesty. */
export const STP_REGION_INSTANCE_RISK =
  'Re-maps VLANs to MST instances; ports in the affected instances may re-converge (not measured on this unit).'

/**
 * What a staged `no instance <id>` removal does, stated from the grammar capture: the mapping
 * line nets OUT of the block, and the VLANs it named fall back to the default instance — the
 * fallback itself is NOT measured anywhere, so the copy says what the diff showed and no more.
 */
export const STP_REGION_REMOVAL_FACT =
  'Removes the `instance … vlan …` mapping line for that instance (the bare `no instance <id>` spelling staged on this 7050TX-64-R on 2026-11-22 and netted the line out of the block — DR-159; first proven on cEOS-lab 4.28.14M). The VLANs it named fall back to the default instance; that fallback is not measured on any target.'

/** The DR-149 informational note — a NOTE, not a gate: no hygiene check is required or offered. */
export const STP_FAR_END_NOTE =
  'This UI cannot see what is attached on the far end of any port. DR-149 decided this stays an informational note — no port-hygiene gate blocks a global STP change.'

/** The staged-line restatement every entry's risks open with (the S15 `readBack` pattern). */
export function stpGlobalReadBack(lines: readonly string[]): string {
  return `The staged lines: ${lines.map((line) => `\`${line}\``).join(' + ')} — byte-for-byte the capture-pinned spelling from stp-global-rules.ts; the device diff, not this screen, decides what running-config actually keeps.`
}

/** The risk list for a staged mode change. */
export function stpModeRisks(mode: StpGlobalModeChoice, lines: readonly string[]): readonly string[] {
  const blast = mode === 'none' ? STP_MODE_NONE_FACTS : STP_MODE_BLAST_FACTS
  return [stpGlobalReadBack(lines), blast, ...(mode === 'rapid-pvst' ? [stpRapidPvstDisclosure()] : []), STP_FAR_END_NOTE]
}

/** The risk list for a staged region edit. */
export function stpRegionRisks(draft: MstRegionDraft, lines: readonly string[]): readonly string[] {
  const identity = draft.name !== undefined || draft.revision !== undefined
  const removals = draft.removeInstances?.length ?? 0
  return [
    stpGlobalReadBack(lines),
    ...(identity ? [STP_REGION_IDENTITY_RISK] : []),
    ...(draft.instances.length > 0 ? [STP_REGION_INSTANCE_RISK] : []),
    ...(removals > 0 ? [STP_REGION_REMOVAL_FACT] : []),
    STP_FAR_END_NOTE,
  ]
}

/**
 * The extra hard-confirm dialog the Transaction Center runs per entry before commit (the #141
 * `confirmations` seam, Users-screen pattern). Mode changes and name/revision changes force
 * reconvergence, so they carry one; a pure instance remap ships risks only.
 */
export function stpModeConfirmation(mode: StpGlobalModeChoice): { title: string; body: string; label: string; subject: string } {
  const blast = mode === 'none' ? STP_MODE_NONE_FACTS : STP_MODE_BLAST_FACTS
  return {
    title: `Second confirm: spanning-tree mode ${mode}`,
    body: `${blast}${mode === 'rapid-pvst' ? ` ${stpRapidPvstDisclosure()}` : ''}`,
    label: `I accept the spanning-tree blast: commit mode ${mode}`,
    subject: `spanning-tree mode ${mode}`,
  }
}

export function stpRegionIdentityConfirmation(target: string): { title: string; body: string; label: string; subject: string } {
  return {
    title: `Second confirm: MST region ${target}`,
    body: STP_REGION_IDENTITY_RISK,
    label: 'I accept the MST region re-convergence: commit the region edit',
    subject: `MST region ${target}`,
  }
}
