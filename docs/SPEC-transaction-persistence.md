# Spec: Transaction Persistence & Rollback (B4, #89)

> **Status: decisions RECORDED (DR-160, 2026-11-23) and the decided slices are shipping.** The
> owner answered all five decisions below; **DECISIONS DR-160** is the authority and this document
> is its spec detail (slices, shapes, copy rules). **C1** (name cap 64→256 configurable) shipped in
> PR #184 and **S2** (the explicit Save-to-startup action, with its S5 contract flip) shipped in
> PR #185. S1 was since captured (run 12, DR-161). The fences an answered slice did not reach — S4 rollback (the capture refused the verb) and
> commit-timer authoring (surfacing-only) — stay exactly where they are; an answered decision
> authorizes its own gated slice, not a blanket removal.

Issue: **#89** (the persistence/rollback half of the transaction center; S9/#79 is the
view/abort/preview half that shipped). This spec superseded the interim "running-config only,
Startup-config will never change from this screen" contract once the owner recorded the decisions
(DR-160); **S2 (PR #185) is what landed that flip** — Startup-config now changes only through the
separate confirmed Save-to-startup action, and DR-024's "running-config only" rule still governs
every commit. The un-shipped halves (S4 rollback) stay fenced pending their slice.

## Objective

Decide which of the now-device-verified persistence/rollback verbs the Transaction Center
(`#/sessions`) is allowed to expose, in what UI shape, with what confirm copy — so that
#89 can either ship its durable half or be closed as an explicit won't-do. The owner
re-affirmed authorization on **2026-11-23** for physical `copy running-config startup-config`,
`configure replace`, and rollback **so long as each is scripted and reviewable before
execution**. Note: that authorization was already exercised by the green hardware runs below
(DR-150, DR-158); re-affirmation does not mean "run it again," it means "the fence rationale
that said *never* may now become *when the owner says*."

## Verified facts (device answers already on record)

Every verdict below is captured evidence, cited to its recording. Container (cEOS-lab
4.28.14M) results are **not** hardware results (DR-043); the table marks which are which.

| Verb | 7050TX-64-R / 4.28.13.1M verdict | Evidence | cEOS verdict |
|---|---|---|---|
| `copy running-config startup-config` (client `copyRunningToStartup`/`writeMemory`) | **ACCEPTED** — 210-line baseline, `changedFromBaseline:true` on re-read (eAPI reply text empty; the reads are the proof) | `docs/evidence/persistence-hardware.json` (DR-150, 2026-11-21); re-accepted run 10 (DR-158) | ACCEPTED with full persistence flip (`unblock-persistence.ceos.json`) |
| `configure replace <file>` | **ACCEPTED** — snapshot → scratch-port (`Ethernet33`) marker commit → wholesale replace-back → self-restored | run 10 (`--verbs copy,rollback,replace`), DR-158 | verb exists, 1000 on absent source (grammar accepted) |
| `rollback clean-config` (session-scoped) | **EXISTS** — staged in a named session, `session.diff()` answered a 152-line would-be blast, aborted clean | DR-150; re-confirmed run 10 | 1002 at EXEC (session form only) |
| `commit timer` / `pendingCommitTimer` | device-confirmed: armed session lists `pendingCommitTimer` + `commitBy` (uptime clock); one per device; a second `configure session` opens while armed; unattended revert fires past deadline | `configure-session-commit-timer--hw-session-probe.json` (DR-137); `commit-timer-persistence.ceos.json` (DR-148) | same shape |
| `configure session <name>` length/charset | **container only:** accepted through 8192 chars (client's 64 is ours); device refuses `" ' \ \` # ;` with `Session name <x> is invalid.`; whitespace truncates-and-re-parses | — (HARDWARE half un-captured, operator-fence by design) | `session-grammar.ceos.json` (DR-156) |

**Still open on hardware (gated, NOT by authorization):**

- **`rollback <name>`** — never staged on the box. Measured reason (DR-158): ~7 s after the
  marker commit that `configure replace` the only intervening op, the completed-session slot
  no longer listed the marker, so the rollback step skipped (no target). Run 11 (DR-159) then
  read `sessions: {}` in BOTH forms with no reboot/commit/persistence-verb that day → recorded
  observation: *the one-slot completed store can empty between supervised days with no visible
  commit.* The `completedSlotHolds` field (added DR-158) is the instrument for a follow-up run
  to distinguish "replace cleared the slot" from "replace restored the store's snapshot."
  → This is a **slot-mechanism timing** unknown, not an authorization gap. See "Remaining
  capture" below.
- **`commit <intf> verify` / `revert <intf>`** (the confirm-or-reset arm of a held timer) —
  deliberately never composed; on cEOS re-entry is refused so the path is unreachable on the
  container. Never probed on the box.
- **The four DR-147 session-grammar families' hardware halves** — the container grammar lane
  refuses a device target *by design* (it opens whitespace-truncated, injection-shaped
  sessions). A hardware twin is its own risk review and is out of scope for B4.

## The stale fences this spec targets

`arista-webui/src/features/sessions/session-rules.ts` `DRAFT_FORBIDDEN_LINES` refuses these
verbs in the staged-draft textarea guard. Three carry rationales that the evidence above
**supersede** (quoted verbatim):

- `'configure replace'`: *"it needs per-platform captures before any UI may reach for it"* —
  the capture exists (DR-158). Rationale is stale **as a capture blocker**; the verb may still
  be a deliberate product exclude, but "we have no data" is no longer the reason.
- `rollback`: *"B4 out-of-scope pending capture of commit-timer semantics"* — timer semantics
  are now captured (DR-137/DR-148); session-scoped `rollback clean-config` exists on hardware.
- `'copy running-config startup-config'`: the DR-024 line is a **policy** statement, not a
  capture blocker, and stays true regardless — durability is explicit. This one is NOT stale;
  it's the standing contract any new slice must preserve (an explicit save action, never an
  implicit side effect of commit).

**Post-DR-160 state of these lines.** The `copy` line **stays** — decision 1(b) ships Save as a
first-class button calling the client verb, never a draft-textarea line, so the textarea guard's
job is unchanged (DR-160 §1). The `configure replace` line **stays** with its **rationale amended**
from the stale capture-blocker wording to the decided product exclude (DR-160 §2). The `rollback`
line **stays until S4 ships** — decision 3 wants rollback UI but capture-gated, so the draft guard
keeps refusing it in the meantime; its wording updates with the S4 slice, not before. Editing any
of these lines is a gated implementation step belonging to its slice's PR. The textarea guard for
`commit`/`abort`/`configure session`/`reload` is **not**
in scope — those are review-pipeline hijack guards, unrelated to persistence, and stay fenced.

## Boundaries (unchanged, reaffirmed)

- **Never:** implicit startup-config writes; a "save" that happens as a side effect of commit;
  any persistence verb reachable from the free-text draft textarea; a commit-timer edit control
  before the confirm-arm is captured; `configure replace` reachable while a session is open
  (the client already refuses this — `assertNoSessionConflict`).
- **Ask first (owner):** every physical persistence run; each `DRAFT_FORBIDDEN_LINES` removal;
  the features.md "Startup-config will never change" line flip.
- **Always:** identity gate (`DCS-7050TX-64-R` / `4.28.13.1M`) before any live write; unused-
  scratch-port check; DR-150 pre-write secret scan (running-config diffs are a credential
  surface wider than passwords — see the DR-150 ssh-key-comment incident); self-restoring
  sequence; every run dry-run-reviewable before `--go`.

## Owner decisions (ANSWERED 2026-11-23 — DR-160 is the record)

Each answer gates one implementation slice. The options framing is kept below because it is what
the decision was made against; the bold **Answer** lines are DR-160.

1. **Does the UI expose `copy running-config startup-config` at all?** Options:
   (a) never — running-config-only forever, startup is a console/CLI operator act (keeps DR-024
   strongest; #89 closes as won't-do for `copy`);
   (b) an explicit, separate **"Save to startup"** action on the Transaction Center, distinct
   from commit, with its own F4 confirm quoting that it persists the whole running-config
   (not just this transaction) to flash;
   (c) a post-commit prompt "also save to startup?" (rejected up front: it re-introduces the
   implicit-durability coupling DR-024 exists to prevent).
   → Recommend framing: (b) if the deployment wants a one-click save; (a) if startup is a
   deliberate change-control gate. Container/hardware both ACCEPT `copy`, so the blocker is
   purely product intent.
   **Answer: (b).** Explicit separate "Save to startup" action, own F4 confirm quoting the
   whole-running-config blast (DR-160 §1). Gates slice S2.

2. **Does the UI expose `configure replace`?** It is the highest-blast verb (wholesale
   running-config replace). Hardware ACCEPTED it (run 10), self-restoring. Options: never
   expose in the UI (keep it a scripted operator act, where it lives today); expose only behind
   a typed-echo confirm mirroring the capture lane's own `CONFIGURE REPLACE` echo gate.
   → The client refuses it while a session is open, so any UI affordance must be outside the
   staged-transaction flow entirely.
   **Answer: no UI.** Deliberate product exclude; stays the scripted operator act. The
   `session-rules.ts` rationale text is amended from stale-capture wording to decided-exclude
   (DR-160 §2). No slice.

3. **Rollback exposure.** `rollback clean-config` (whole running-config to clean) vs
   `rollbackToSession(name)` (to a named committed session). The latter is unusable until the
   one-slot `rollback <name>` mechanism is understood. Recommend: no UI rollback until the
   slot-mechanism capture below resolves what a rollback target name actually survives.
   **Answer: wanted, capture-gated.** Owner wants rollback-to-named-session; S1 (the
   `rollback <name>` slot-mechanism capture) must run first, S4 follows its verdict
   (DR-160 §3).

4. **Commit-timer UX.** The Transaction Center already *surfaces* a `pendingCommitTimer` row
   (PR #166) with its abort-with-revert exit. Do we add any *create/edit* timer control?
   Blocked on the un-captured `commit verify`/`revert` confirm arm. → Recommend: leave
   surfacing-only; no timer authoring control until that arm is captured.
   **Answer: surfacing-only, as recommended** (DR-160 §4). No slice.

5. **Session-name-limit editing** (`MAX_SESSION_NAME_LENGTH=64`): device accepts 8192; the
   64 is ours. Do we widen? This is a parser/client decision (the M10 #12 follow-up class),
   not B4 UI. → Likely belongs to the session-grammar hardware-half risk review, not #89.
   **Answer: widen to 256, configurable.** Cap at 256 (not the device's 8192) behind a
   client-configurable setting with a default; webui mirror in `capability-panel.ts` follows
   (DR-160 §5). Client slice, filed separately from #89.

## Slices (each gated on its decision + DECISIONS entry; build order)

| Slice | Depends on | Ships |
|---|---|---|
| S1 slot-mechanism capture | **RUN — 2026-11-23 run 12** (`docs/evidence/persistence-hardware.json`, DR-161) | slot survives ≥60 s with no `replace` (aging refuted; `replace` clears it); but `rollback <name>` REFUSED (1002 at the name token) → see S4 |
| S2 save-to-startup action | ✅ decided (DR-160 §1, option b) — **SHIPPED PR #185** | explicit `Save to startup` button + confirm copy + tests; DR-024 preserved (explicit, separate from commit) |
| ~~S3 configure-replace operator panel~~ | ❌ decided against (DR-160 §2) — rationale text amended in `session-rules.ts` in PR #185 | no UI |
| S4 rollback affordance | ⚠️ wanted (DR-160 §3); S1 captured — **premise in question** (DR-161): the device refuses `rollback <name>` (1002) though the slot holds; needs a hyphen-free-name disambiguation run before S4 is viable | the named-session verb has no confirmed device support yet |
| S5 features.md / contract flip | rides S2 — **SHIPPED PR #185** | the "Startup-config will never change" line is now conditional (only the confirmed Save changes it) |
| C1 name cap 64→256 configurable | ✅ decided (DR-160 §5) — **SHIPPED PR #184** | arista-api-client: constant → option, refusal copy, `capability-panel.ts` mirror, tests |

Each slice was implementable only after its DECISIONS entry (DR-160) recorded the owner's answer
to the matching question above. S2/S5 (#185) and C1 (#184) shipped on that basis; commit-timer
authoring stays surfacing-only per DR-160 §4. **S1 was captured (run 12, DR-161): the slot survives,
but `rollback <name>` is refused by the device, so S4's premise is now in question** pending the
hyphen-free-name disambiguation DR-161 records.

## Remaining capture (S1) — scripted, reviewable, operator-run

`rollback <name>` needs a completed session reliably present in the one-slot store at the
moment of the rollback. Proposed additions to `arista-api-client/src/persistence-hardware.live.test.ts`
/ `scripts/capture-hw-persistence.sh` (the existing DR-149 lane, which is already dry-run
reviewable and consent-gated):

- After a marker commit, **immediately** read `show configuration sessions detail` (before any
  intervening op) and again after the `completedSlotHolds` probe, to pin whether the slot
  empties within seconds or only across the replace window.
- Attempt `rollback <name>` for the just-committed marker **without** any intervening
  `configure replace`, to separate "replace clears the slot" from "the slot simply aged out."
- Abort-only where the diff is non-empty; self-restoring; the standard identity + scratch +
  pre-write-scan gates.

This is a **spec for a future supervised capture day**, drafted for review. Per the owner's
2026-11-23 rule it is scripted and reviewable; the agent does not execute it against the box.

## Out of scope of this spec

This document is the **spec + decision record**, not the implementation. The slices it specifies
shipped in their own PRs — C1 in #184, S2/S5 in #185 — and S4 ships only after the S1 capture.
The spec file itself never edits `session-rules.ts`, `TransactionCenter*.tsx`, or the client (those
edits live on the slice PRs), and the DR-147 session-grammar hardware halves stay a separate risk
review. This PR is docs-only: DR-160 + this spec.

## Related

DR-024 (durability is always explicit — the spine of decision 1), DR-137/DR-148 (commit-timer
device answers), DR-150 (`copy` hardware answer + the ssh-key/credential-surface incident),
DR-158 (`configure replace` hardware answer + the slot-sensitivity finding), DR-159 (the
one-slot-empties observation), DR-043 (container ≠ hardware), DR-149 (the owner permissive-
persistence authorization this re-affirms), #79/#141 (the view/staging halves that shipped).
