# Spec (DRAFT): Transaction Persistence & Rollback (B4, #89)

> **Status: DRAFT for owner review — nothing here is implemented.** This document does not
> change code, does not remove any fence, and does not add a UI control. It exists because the
> device evidence that gated B4 has landed, so the remaining blockers on #89 are **product
> decisions the owner must record**, not captures. The fence that keeps these verbs out of the
> UI stays exactly where it is until a DECISIONS entry authorizes each slice below.

Issue: **#89** (the persistence/rollback half of the transaction center; S9/#79 is the
view/abort/preview half that shipped). This spec supersedes the interim "running-config only,
Startup-config will never change from this screen" contract **only after** the owner approves
a slice — until then DR-024's contract is the enforced steady state and this file changes
nothing.

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

**These lines must not be edited as part of drafting this spec.** Each verb's removal from
`DRAFT_FORBIDDEN_LINES` is a gated implementation step that requires its own DECISIONS entry
(see Slices). The textarea guard for `commit`/`abort`/`configure session`/`reload` is **not**
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

## Owner decisions this spec surfaces (NOT decisions it makes)

The owner records a DECISIONS entry answering each; each answer gates one implementation slice.

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

2. **Does the UI expose `configure replace`?** It is the highest-blast verb (wholesale
   running-config replace). Hardware ACCEPTED it (run 10), self-restoring. Options: never
   expose in the UI (keep it a scripted operator act, where it lives today); expose only behind
   a typed-echo confirm mirroring the capture lane's own `CONFIGURE REPLACE` echo gate.
   → The client refuses it while a session is open, so any UI affordance must be outside the
   staged-transaction flow entirely.

3. **Rollback exposure.** `rollback clean-config` (whole running-config to clean) vs
   `rollbackToSession(name)` (to a named committed session). The latter is unusable until the
   one-slot `rollback <name>` mechanism is understood. Recommend: no UI rollback until the
   slot-mechanism capture below resolves what a rollback target name actually survives.

4. **Commit-timer UX.** The Transaction Center already *surfaces* a `pendingCommitTimer` row
   (PR #166) with its abort-with-revert exit. Do we add any *create/edit* timer control?
   Blocked on the un-captured `commit verify`/`revert` confirm arm. → Recommend: leave
   surfacing-only; no timer authoring control until that arm is captured.

5. **Session-name-limit editing** (`MAX_SESSION_NAME_LENGTH=64`): device accepts 8192; the
   64 is ours. Do we widen? This is a parser/client decision (the M10 #12 follow-up class),
   not B4 UI. → Likely belongs to the session-grammar hardware-half risk review, not #89.

## Slices (each gated on its decision + DECISIONS entry; build order)

| Slice | Depends on | Ships |
|---|---|---|
| S1 slot-mechanism capture | owner run | closes the `rollback <name>` timing unknown (see below) |
| S2 save-to-startup action | decision 1=b | explicit `Save to startup` button + confirm copy + tests; DR-024 preserved (explicit, separate from commit) |
| S3 configure-replace operator panel | decision 2 | typed-echo-gated, session-conflict-aware; likely a separate screen, not the draft textarea |
| S4 rollback affordance | decision 3 + S1 | only after the target-name survival is known |
| S5 features.md / contract flip | S2 at minimum | the "Startup-config will never change" line becomes conditional |

No slice is implementable from this draft alone; each needs a DECISIONS entry recording the
owner's answer to the matching question above.

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

## Non-goals of this draft

- Implementing any of the above.
- Editing `session-rules.ts`, `TransactionCenter*.tsx`, or the client.
- Closing or re-labeling #89 (label change waits on the owner's decision answers).
- The DR-147 session-grammar hardware halves (separate risk review).

## Related

DR-024 (durability is always explicit — the spine of decision 1), DR-137/DR-148 (commit-timer
device answers), DR-150 (`copy` hardware answer + the ssh-key/credential-surface incident),
DR-158 (`configure replace` hardware answer + the slot-sensitivity finding), DR-159 (the
one-slot-empties observation), DR-043 (container ≠ hardware), DR-149 (the owner permissive-
persistence authorization this re-affirms), #79/#141 (the view/staging halves that shipped).
