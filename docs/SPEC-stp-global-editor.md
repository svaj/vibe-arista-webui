# Spec: STP Global Mode + MST Region Editor (#88)

Status: draft for review (2026-11-21). Implements the guard design the owner settled in DR-149 for
issue B3 (#88). Depends on the shared transaction coordinator shipped by #141
(`docs/SPEC-transaction-staging.md`) — this screen stages through it and owns no session lifecycle.

## Objective

Give the single operator one screen to (a) change the switch's global spanning-tree mode
(`mstp` / `none` / `rapid-pvst`) and (b) view and edit the MST region configuration
(`spanning-tree mst configuration`: name, revision, instance-to-VLAN map) — with a confirmation
step that carries the **captured blast facts** instead of adjectives, per DR-149.

Today the S15 screen (`#/stp`) renders the mode line read-only and refuses any mode control
(`STP_MODE_EDIT_NOTE`), because #88 was blocked on the guard-design decision. DR-149 settled it:
F4-confirm carrying the cEOS blast measurements, **no** port-hygiene gate (informational note
only), MST region fields in the **same** editor as the mode change. The per-port guard screen
stays exactly as it is — this spec adds a second screen, it does not fold the two together
(the audit's "Do Not Do" for #88 stands).

Success looks like: the operator opens `#/stp/global`, sees the device's current mode and region
block, stages a mode change or a region edit into the shared transaction, and the Transaction
Center's confirm dialog states the measured consequence ("brief forwarding interruption on every
VLAN; on the measured cEOS-lab 4.28.14M container the mstp→rapidPvst flip took ~67 ms and MST0
was replaced by per-VLAN instances") before anything is committed.

## Approved Product Assumptions

Answered by the owner on 2026-11-21 (this spec's intake), on top of DR-149:

1. **Mode value set: `mstp`, `none`, AND `rapid-pvst` are offered.** `mstp` and `none` are
   hardware-verified on the 7050TX-64-R (boot mode is `mstp`; `spanning-tree mode none` staged
   FULL, DR-141 round 2). `rapid-pvst` is offered with an explicit, in-form disclosure that its
   acceptance is proven on **cEOS-lab 4.28.14M only** (the committed flip, DR-148) and not yet on
   this unit; if the device refuses, the refusal surfaces as the device's own `CommandError`
   (DR-057) — a refusal is an answer, never a crash and never a silent retry.
2. **Placement: a new route `#/stp/global`** ("Spanning-tree global"), separate from the per-port
   `#/stp` screen. Navigation gains one entry; the two screens never mix sources or controls.
3. **Grammar home: Web-UI-only raw-line composition** (owner's explicit choice). No
   `arista-api-client` change: the screen composes command LINES whose spelling is pinned to the
   hardware capture batch `unblock-stp-mst-region-grammar`
   (`arista-api-client/docs/hw-capture-unblock.draft.json`) and the cEOS blast artifact — never
   invented. See "Convention deviation" below.
4. From DR-149: the confirm copy quotes the captured measurements with the DR-043 scoping line
   (facts, not adjectives); there is **no** port-hygiene/drain gate — an informational note about
   far-end devices is the most the screen asserts; commits stay running-config-only (DR-024).
5. From DR-096: the client's `STP_MODES` write grammar (`mstp`/`none`) is **unchanged**. The
   screen does not call `node.stp.setMode()`; it stages raw lines, so offering `rapid-pvst` here
   does not widen the client's guarded verb set. A future client-side widening still needs its
   own probe-backed decision.

## Convention deviation (recorded, per the repo's "raise conflicts explicitly" rule)

Every existing write screen composes command text that mirrors a **client-pinned verb**
(`stp.test.ts` `sentAsText` batches and the like). This screen composes lines with **no client
verb behind them** — pyeapi never had MST-region verbs, and the owner chose not to add a client
slice. Mitigations this spec requires:

- Every composed string is traceable to a captured artifact (the hardware grammar batch or the
  cEOS blast recording), cited in a comment next to the constant — the same evidence discipline,
  pointed at captures instead of client pins.
- The composition lives in one pure module (`stp-global-rules.ts`) with pinned unit tests, so the
  strings are reviewable in one place exactly as client pins are.
- If a client MST-region slice is ever added (read parser + composed verbs), the screen switches
  to it and this note is retired. Until then the deviation is deliberate, not drift.

## Verified facts this spec builds on

| Fact | Class | Source |
| --- | --- | --- |
| Boot mode on the unit is `spanning-tree mode mstp` | hardware | DR-096 note / hw captures |
| `spanning-tree mode none` stages FULL (aborted) | hardware | DR-141 round 2 (run 9) |
| `spanning-tree mst configuration` + `name LAB-UNBLOCK` + `revision 1` + `instance 1 vlan 100,110` stages (aborted) | hardware | DR-141 round 1, batch `unblock-stp-mst-region-grammar` |
| `spanning-tree mode rapid-pvst` commits and reverses; protocol answers camelCase `rapidPvst`; flip ~67 ms, reverse-stable ~81 ms; MST0 replaced by per-VLAN instances | cEOS-lab 4.28.14M only | `docs/evidence/stp-mode-change.ceos.json`, DR-148 |
| `node.stp.get()` answers `mode` verbatim from the chunked running-config | client | `resources/stp.ts`, DR-096 |
| `node.chunkConfig()` / `node.section(pattern)` read the running-config sections | client | `command-layer.ts` (`chunkConfig`/`section`) |
| `show spanning-tree` JSON carries **no** region name/revision/digest fields (cEOS capture) | cEOS capture | `test/fixtures/live/ceos-4.28.14M/show-spanning-tree.json` |
| `rapid-pvst` acceptance, region reconvergence behavior, and region field bounds on the 7050TX-64-R | **UNVERIFIED** | — (design degrades per "Unknowns" below) |

## User Stories

- As an operator, I can see the switch's current spanning-tree mode and its MST region block
  (name, revision, instance→VLAN map) on one screen, read from the device, with honest
  loading/error/empty states.
- As an operator, I can stage a mode change to `mstp`, `none`, or `rapid-pvst`; the form names the
  blast in measured facts before I stage, and the Transaction Center confirm repeats it before
  commit.
- As an operator, I can stage an MST region edit (set/change name, revision, and instance-to-VLAN
  mappings) and see the device's own diff in the Transaction Center before committing.
- As an operator, when I choose `rapid-pvst` I am told plainly that this value's acceptance is
  proven on a container, not on my switch, and that a device refusal is the expected fallback.
- As an operator, when the region read or the mode read fails, the screen says which read failed
  and keeps the rest usable — never a blank panel, never a "not supported" claim.
- As an operator, nothing on this screen commits anything; commit and abort belong to the
  Transaction Center (#141 contract, unchanged).

## Scope

### In scope

- New route `#/stp/global` + feature screen (`StpGlobal` container / `StpGlobalView` presentation /
  `stp-global-rules.ts` pure rules), following the S8/S15 container-presentation split.
- Reads: `node.stp.get()` for the mode (hard read — it is the parsed running-config, same copy as
  `#/stp`); `node.chunkConfig()` for the `spanning-tree mst configuration` section (soft read —
  its failure mutes only the region panel, with a named-failure note).
- Mode-change form: current mode displayed verbatim; target select over exactly
  `mstp | none | rapid-pvst`; per-value consequence copy; `rapid-pvst` carries the
  container-only-acceptance disclosure.
- MST region form: name, revision, and instance-to-VLAN mapping rows; staged as one
  `spanning-tree mst configuration` parent + child lines; in-form shape validation (client
  grammar, marked as such); device remains the authority on acceptance (DR-057).
- Staging through the shared transaction coordinator (`transaction.append` / `stageLines`), with
  the screen's risks/review copy flowing into the Transaction Center as they do for every migrated
  screen.
- Informational (non-gating) note: mode changes and region name/revision changes re-init STP;
  this UI cannot see far-end attachments (DR-149: note, not gate).
- Retirement/replacement of `STP_MODE_EDIT_NOTE` on `#/stp`: the static "blocked pending #88"
  copy becomes a pointer to `#/stp/global` (a test pins that `#/stp` still renders **no** mode
  control of its own).
- Vitest coverage per "Testing Strategy"; docs updates (features.md lines, audit doc, DECISIONS
  entry for the raw-line deviation + any device answers the first real use produces).

### Out of scope

- Any `arista-api-client` change (no MST-region resource, no `STP_MODES` widening, no new
  `ShowContracts` keys).
- Committing on the feature screen; startup-config; `copy run start`; rollback/replace/timers
  (#89's lane owns those).
- Per-port STP controls (S15, unchanged), port-hygiene gates (rejected by DR-149), BPDU filtering.
- Reading MST instances operationally (`StpInstances` stays upstream's stub — the existing
  `STP_INSTANCES_NOTE` stays honest; the region panel reads **config**, not operational state).
- Hardware probe lanes for `rapid-pvst` acceptance or region reconvergence timing (the screen's
  disclosure + the device's refusal channel cover these until someone runs one).
- Wildcards: no `spanning-tree mode <anything else>`, no `no spanning-tree mode` /
  `default spanning-tree mode` arms (DR-096's client grammar stays the only "unset" story, and
  this screen offers none).

## Screen contract

### Reads

```
node.stp.get()        → settings.mode  (hard; verbatim token, DR-096 read side)
node.chunkConfig()    → sections['spanning-tree mst configuration']  (soft)
node.show('version')  → identity chip  (silent soft, existing pattern)
```

- `settings.mode === undefined` renders "the running-config carries no `spanning-tree mode` line"
  (DR-027 not-found semantics) — not "default", not a guess.
- Region section absent renders "no MST region configured" with the form offering to create the
  first block. Present renders name/revision/instance rows **verbatim** (open strings, DR-032).
- Soft region read failure: panel replaced by a named-failure note; the mode form stays usable.

### Staged command lines (the whole write surface)

Pinned spellings — parent line first, children in operator order; every line byte-identical to a
capture (`hw-capture-unblock.draft.json` batch 6; `stp-mode-change.ceos.json`):

```
spanning-tree mode mstp | spanning-tree mode none | spanning-tree mode rapid-pvst

spanning-tree mst configuration
 name <operator-name>
 revision <operator-revision>
 instance <id> vlan <ranges>        (one line per mapping row)
```

- Region edits stage the parent + only the lines the operator changed/added/removed (EOS applies
  the block incrementally; the device diff is the proof of what changed — the screen never stages
  a `no …` line it has not captured). Mapping **removal** landed post-v1 via the DR-155 grammar
  lane: `no instance <id> vlan <ranges>` and bare `no instance <id>` both staged on cEOS-lab
  4.28.14M and netted the mapping out of the block (`docs/evidence/unblock-grammar-ceos.json`,
  rea-q1/q2, aborted); the screen stages the BARE form (it cannot misquote the device's own
  double-space VLAN-list spelling), per-row from the read block only. `no name`/`no revision`
  staged too (rea-q3/q4) but stay unoffered — no owner ask. Hardware acceptance of the removal
  spellings is still an open device question (DR-043); the risk line says so.
- In-form validation (client grammar, explicitly *not* device fact): name = 1–32 printable
  non-space tokens; revision = integer 1–65535; instance id = integer 0–64 (IEEE 802.1s
  instance id); VLAN ranges = `<1-4094>` / comma lists / `A-B` spans. Bounds marked
  `UNVERIFIED-on-this-SKU` in code comments; a device refusal still surfaces as `CommandError`.
- All staged batches go through the existing `stageLines` → coordinator path; the screen opens no
  session itself.

### Risk/confirm copy (F4, `useConfirm`)

Mode change and any region change are `destructive`. The staged-entry risks and the Transaction
Center confirm body carry (wording pinned by tests):

- mode → `mstp` / `rapid-pvst`: "Re-initializes spanning-tree instances network-wide. On the
  measured cEOS-lab 4.28.14M container the mstp→rapidPvst flip took ~67 ms and MST0 was replaced
  by per-VLAN instances; expect a brief forwarding interruption on every VLAN. Container
  measurement — not measured on this 7050TX-64-R (DR-043)."
- mode → `none`: "Disables spanning-tree on every port. Loop protection is gone network-wide
  until a mode is set again. Not measured on any target."
- `rapid-pvst` adds: "Acceptance of this value is proven on cEOS-lab 4.28.14M only; this unit may
  refuse it — a refusal changes nothing."
- region name/revision: "Changing the MST region name or revision forces spanning-tree
  re-convergence on all MST instances (IEEE 802.1s behavior; not measured on this unit)."
- region instance map: "Re-maps VLANs to MST instances; ports in affected instances may
  re-converge (not measured on this unit)."
- The informational far-end note (non-gating): "This UI cannot see what is attached on the far
  end of any port." (DR-149: note, not gate.)

## Commands

```bash
npm run typecheck
npm run lint
npm test -w arista-webui -- --run src/features/stp
npm test -w arista-webui -- --run src/App.test.tsx
npm run build
```

## Project structure

```
arista-webui/src/features/stp/
  StpGlobal.tsx            container: reads, forms state, staging via coordinator
  StpGlobalView.tsx        presentation: mode card, region panel/forms, notes
  stp-global-rules.ts      pure: line composition, validation, risk copy (all pins here)
  stp-global-rules.test.ts pinned strings + validators
  StpGlobal.test.tsx       container: states, staging, error paths
  Stp.test.tsx / StpView.tsx  STP_MODE_EDIT_NOTE → pointer copy update
arista-webui/src/App.tsx   '/stp/global' route entry + nav item
docs/features.md           MSTP / Rapid-PVSTP / MST–PVST interop lines annotated
docs/BLOCKED-ISSUES-AUDIT.md  #88 section: spec-landed status
arista-api-client/docs/DECISIONS.md  DR entry: raw-line deviation + first-use device answers
```

## Code style

Follows the S15 split exactly; the rules module is the single pin site:

```ts
/**
 * The mode-change line — spelling pinned to the committed cEOS flip
 * (`docs/evidence/stp-mode-change.ceos.json`: `spanning-tree mode rapid-pvst`) and the
 * hardware stage-abort of `spanning-tree mode none` (DR-141 round 2). `rapid-pvst` is
 * OFFERED with a container-only-acceptance disclosure (owner decision 2026-11-21).
 */
export function stpModeLine(mode: StpGlobalModeChoice): string {
  return `spanning-tree mode ${mode}`
}
```

## Testing strategy

Vitest 5 + Testing Library + hand-built fake `Node` seams (existing pattern; query by role/label).

- **Rules (pure):** every composed line pinned byte-for-byte; validators accept the capture's own
  sample (`LAB-UNBLOCK` / `1` / `instance 1 vlan 100,110`) and reject shape violations at zero
  sessions; risk copy contains the measured numbers and the DR-043 scoping sentence.
- **Container:** renders mode + region from fakes; region-read failure mutes only the region panel
  (mode form still stages); absent mode line renders the not-found copy; absent region renders
  "no MST region configured"; staging a mode change appends exactly one coordinator entry with
  the pinned line and risks; `rapid-pvst` renders the disclosure before staging; a device
  `CommandError` on a later commit is surfaced by the Transaction Center path (no screen-local
  commit exists to test — pin that the screen renders no commit button).
- **App/nav:** `#/stp/global` routes to the screen; `#/stp` still renders no mode control (the
  existing pin, updated to the new pointer copy).
- **A11y:** forms label every input; the mode select's option text carries the consequence;
  region rows are a `table` with headers; device-read results announce via the existing
  `aria-live` seams.

## Boundaries

### Always

- Stage through the shared coordinator; commit/abort only in the Transaction Center.
- Show the device's diff (via the Transaction Center) before any commit; running-config-only
  (DR-024), success copy says startup was not changed.
- Surface every device refusal as the device's own error text (DR-057); four states handled on
  both reads.
- Keep composed strings in `stp-global-rules.ts` with capture citations.

### Ask first

- Adding any `no spanning-tree …` / `default spanning-tree …` line (uncaptured spelling).
- Widening the mode set beyond the three approved values.
- Any client (`arista-api-client`) change to make this screen's life easier.

### Never

- Commit a mode change on the physical switch merely to answer a CLI question (audit #88 "Do Not
  Do" — the operator's deliberate product use is the only commit path).
- Fold a mode/region control into the per-port `#/stp` screen.
- Claim hardware acceptance of `rapid-pvst`, or claim region reconvergence timings we have not
  measured on this unit.
- Persist staged lines outside the in-memory coordinator.

## Unknowns and how the design degrades

| Unknown (UNVERIFIED on 7050TX-64-R) | Degradation path |
| --- | --- |
| `rapid-pvst` acceptance | Disclosure in-form; device refusal surfaces as `CommandError`; nothing applied. |
| Region name/revision bounds, instance-id max | Client-grammar validation only; device is authority; refusal changes nothing. |
| Region-change reconvergence on this SKU | Copy says "not measured on this unit"; no timing claimed. |
| `no instance …` removal spelling | Captured on cEOS (DR-155, container-scoped copy); hardware acceptance answered by the first real removal's diff or refusal. |

Each first real device answer gets a DECISIONS entry (the capture-on-first-use discipline the
persistence lane used).

## Success criteria

1. `#/stp/global` shows the device's mode and region block with all four states handled.
2. A mode change and a region edit each stage exactly the pinned lines into the shared
   transaction; the screen itself cannot commit.
3. The confirm copy carries the measured blast facts + DR-043 scoping, pinned by tests.
4. `rapid-pvst` is selectable only with its disclosure visible.
5. `#/stp` still renders no mode control; the two screens share no controls or state.
6. No `arista-api-client` file changes in the PR.
7. `npm run typecheck && npm run lint && npm test && npm run build` green in `arista-webui/`.

## Open questions

None blocking. (Removal-line grammar, `rapid-pvst` hardware acceptance, and region bounds are
tracked as Unknowns above with explicit degradation, not as spec blockers.)
