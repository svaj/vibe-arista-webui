# Spec: Route-map clause editor (#87, route-map slice)

Status: shipped 2026-11-21 (the intake answers below; implementation per this spec — see DR-153).
The second per-protocol routing editor under #87's
"each protocol = its own screen issue" rule (VRRP shipped first — DR-152). Depends on the shared
transaction coordinator (#141) — this screen stages through it and owns no session.

## Objective

Give the single operator one screen to see every route-map clause configured on the switch and to
create clauses, replace their `match`/`set` statement lists, set description/continue, and delete
clauses — staging through the shared transaction with a confirm that states, as fact, whether the
map is referenced by anything this UI can see.

Today the read-only Routing screen (`#/routing`) renders the configured clause table
(`node.routemaps.getAll()`) and the `show route-map` count, and `ROUTING_READ_ONLY_NOTE` names
route maps among the still-blocked editors. This spec ships the **route-map** half of the
per-protocol review's outcome: a dedicated editor at `#/routing/routemaps`. The OSPF editor and
BGP (unmodelled on this SKU) stay out.

Success looks like: the operator opens `#/routing/routemaps`, sees each `(name, action, seqno)`
clause with its match/set counts and description, creates a clause or edits/deletes one, and the
Transaction Center confirm states plainly whether the OSPF reader saw a `redistribute … route-map
<name>` reference for this map (or says it could not check), with the closest measured route-blast
proxy quoted and scoped as container-only (DR-043).

## Approved Product Assumptions

Answered by the owner on 2026-11-21 (this spec's intake), on top of DR-149:

1. **Verb set: full clause lifecycle** (the recommended scope): create clause (bare header line),
   replace the match list, replace the set list, set description, set/unset continue, delete
   clause. The `default route-map` / `default continue` / `default description` arms stay out (the
   VRRP precedent — `setDefault` exists in the client; offered only if asked).
2. **Statement input: free text, device-authoritative.** One statement per row (the client's shape
   guards mirrored: non-empty, single line, no control characters). The *vocabulary* — which
   `match ip address …` / `set community …` keywords this SKU accepts — is the device's answer at
   commit (DR-057); only `set community 65000:1` is hardware-proven here, and inventing a keyword
   list would be fabrication.
3. **Command text mirrors the CLIENT's test-pinned composition** (`routemaps.test.ts`
   `sentScripts` pins). Unlike VRRP, `routemaps.ts` verbs have **no dry-run arm** (every verb
   sends), so the screen composes the same raw lines the client would send — the established
   StaticRoutes/Ntp convention for send-only client surfaces, NOT a DR-151-style deviation: every
   line shape here is a client-verb text, pinned by a client test, mirrored in `routemaps.ts`
   itself. No client change.
4. From DR-149: permissive blast policy with the live-traffic line; commits stay running-config-only
   (DR-024); the device stays the authority (DR-057).

## Verified facts this spec builds on

| Fact | Class | Source |
| --- | --- | --- |
| `route-map LAB-UNBLOCK permit 10` + `set community 65000:1` staged (3-line diff), aborted | hardware | `configure-session-unblock-route-map-grammar--hw-session-probe.json` (DR-141 batch) |
| `show route-map` answers `routeMaps: {}` on hardware, positive JSON on cEOS; entry shape modelled | both targets | `show-route-map--hw-inventory.json`, `live/ceos-4.28.14M/show-route-map.json` |
| this box runs ZERO route maps and zero OSPF processes today; `ip routing` is off | hardware | running-config captures; the audit's #87 posture |
| the closest measured route blast: withdraw 67 ms / restore 6170 ms (loopback advertisement withdrawn via a committed session — NOT a route-map edit) | cEOS only | `docs/evidence/ospf-two-node.ceos.json`, `ospf-two-node.live.test.ts:228-247` |
| `node.routemaps.getAll()` reads `name → action → seqno → {match[], set[], continue?, description?}` fully | client | `resources/routemaps.ts` (W3c #52) |
| create/delete/setMatch/setSet/setContinue/unsetContinue/setDescription compose their texts in-module, always send | client | `routemaps.ts:403-560`; pins `routemaps.test.ts` (`sentScripts`) |
| the replace-verb diff: removals first (current order, `no match X`), then additions (input order, `match X`), clause header repeated before EVERY body line | client | `replaceStatements` (`routemaps.ts:465-502`), DR-113 order-stability |
| description write = clear-then-set pair (`no description` then `description <value>`, header first) | client | `setDescription` (`routemaps.ts:552-560`), upstream pin `test_api_routemaps.py:134-139` |
| route-map effect on forwarding on this unit while unreferenced | **UNVERIFIED** (inference: inert config) | — (copy states the inference, never a measurement) |

## User Stories

- As an operator, I can see every configured clause — name, action, seqno, match/set statements,
  continue, description — plus what the device's own `show route-map` count says, with honest
  loading/error/empty states.
- As an operator, I can create a clause on a new or existing map (name + permit/deny + seqno) and
  see the single composed line before it stages.
- As an operator, I can replace a clause's match list or set list by editing a draft row list; the
  staged batch is the client's diff (removals-first `no …` lines, then additions), not a rewrite.
- As an operator, I can set a clause description (the clear-then-set pair) and set or clear its
  continue value.
- As an operator, I can delete one clause with a hard confirm; deleting the last clause of a name
  deletes the name (the client's own semantics, stated in the copy).
- As an operator, every confirm states the reference status the OSPF read could establish
  (`redistribute … route-map <name>`), or says the reference check could not run — so I know
  whether this edit can move live routes.
- As an operator, creating a clause that already exists is refused at zero appends.
- As an operator, nothing on this screen commits; commit/abort belong to the Transaction Center.

## Scope

### In scope

- New route `#/routing/routemaps` + feature screen (`RouteMapManager` container /
  `RouteMapManagerView` presentation / `routemap-rules.ts` pure rules), the S8/S15/B3 split.
- Reads: `node.routemaps.getAll()` (HARD — the clause table is the subject); `node.ospf.get()`
  (SOFT — the reference detector: `redistributions[].routeMap`); `node.show('route-map')` (SOFT —
  device count, the `#/routing` pattern); `node.show('version')` (silent identity chip).
- Forms: create clause; replace match list; replace set list; set description; set/unset continue;
  delete clause. All composed as the client's own line sequences (mirrored, cited per line).
- A references panel per map: which OSPF redistributions name it (from the SOFT read), or the
  named note that the check could not run.
- Staging through the shared coordinator; risks/review copy + per-entry second confirm into the
  Transaction Center as for every migrated screen.
- `#/routing`'s route-map panel gains a pointer to the editor; `ROUTING_READ_ONLY_NOTE` narrows to
  OSPF/BGP (route maps are no longer blocked).
- Vitest coverage per "Testing strategy"; docs updates.

### Out of scope

- Any `arista-api-client` change.
- `default route-map` / `default continue` / `default description` arms.
- Prefix-lists, access-lists-as-match-vocabulary, community-set objects — the statement text is
  free-form; those resources are their own screens if ever asked for.
- The OSPF editor (later #87 slice) and BGP (no device read surface on this SKU).
- Committing on the feature screen; startup-config; rollback (#89).
- Toggling `ip routing` (the audit's #87 "Do Not Do" — never incidental).

## Screen contract

### Reads

```
node.routemaps.getAll() → Map<name, Map<action, Map<seqno, RoutemapEntryAttrs>>>  (HARD)
node.ospf.get()         → OspfState | undefined  (SOFT — redistributions[].routeMap = references;
                                                  undefined = no OSPF process, a normal state)
node.show('route-map')  → { routeMaps: {} }      (SOFT — device count; shape modelled, count renders)
node.show('version')    → identity chip          (silent soft)
```

- Empty `getAll()` is a normal ready state ("no `route-map` section exists"), never an error — the
  box runs zero route maps today.
- `ospf.get()` failure: the references panel mutes with a named note and every confirm's reference
  sentence switches to its "could not check" arm. The clause table and all forms stay usable.
- `show route-map` failure: the count chip mutes (the `#/routing` pattern), never blanks.

### Staged command lines (the whole write surface — every line mirrors a client-verb composition)

`routemaps.ts` verbs always send, so the screen stages the same FLAT line sequences the client
would (the clause header line IS the submode entry, repeated per body statement — no
`submodeCommands` framing, unlike the VRRP interface batches). Line-by-line citations live in
`routemap-rules.ts`; the client pins are `routemaps.test.ts` `sentScripts` assertions.

```
Create clause (client create(), routemaps.ts:403 — one bare header line):
  route-map <name> <permit|deny> <seqno>

Replace match/set (client replaceStatements, routemaps.ts:465-502 — header before EVERY line,
removals first in current order, then additions in input order):
  route-map <name> <action> <seqno>
  no match <removed statement>          (one per removal, current order)
  route-map <name> <action> <seqno>
  match <added statement>               (one per addition, input order)
  (set arms identical with `set` / `no set`)

Set description (client setDescription, routemaps.ts:552 — clear-then-set pair, upstream-pinned):
  route-map <name> <action> <seqno>
  no description
  route-map <name> <action> <seqno>
  description <value>

Set continue (client setContinue): … + `continue <positive integer>`
Unset continue (client unsetContinue): … + `no continue`

Delete clause (client delete(), routemaps.ts:414 — one top-level line, no submode):
  no route-map <name> <action> <seqno>
```

- In-form validation mirrors the client's guards (grammar, not device bounds — DR-120): name
  non-empty, no whitespace, not starting `!`/`no `/`route-map`, no control chars; action
  `permit|deny`; seqno digits-only; continue positive integer; statements/description non-empty
  single lines. A device refusal surfaces as its own `CommandError` (DR-057).
- Creating a `(name, action, seqno)` the read already lists is refused at zero appends (the client
  header line would re-open the clause; the operator means the edit forms).
- A replace whose diff is empty (draft list equals the current list) is refused at zero appends —
  the client itself sends nothing for a no-op diff (`routemaps.ts:501`); the screen refuses rather
  than staging an empty batch.
- All batches go through `stageLines` → coordinator; the screen opens no session.

### Risk/confirm copy (F4 + per-entry second confirm)

Delete is always `destructive` + hard confirm; create, match/set replace, continue set/unset carry
the second confirm; description edits carry risks only. The confirm body states the reference
status as read fact:

- **Referenced:** "The OSPF reader saw `redistribute <protocol> route-map <name>` — this map is
  active policy on this switch, and changing it can withdraw or re-admit redistributed routes. The
  closest measured route blast (two-node cEOS-lab 4.28.14M: withdrawal 67 ms, restore 6170 ms) was
  a committed advertisement withdrawal, NOT a route-map edit — container evidence, not measured on
  this unit (DR-043)."
- **Unreferenced (check ran):** "No reference this UI can see names this map (the OSPF reader
  found no `redistribute … route-map <name>`; interface policies and BGP are invisible to this
  unit's reads). Unreferenced route-map config is inferred inert — that inference is not measured
  on any target."
- **Unknown (read failed):** "The OSPF reference check did not answer on this device, so this
  screen cannot say whether the map is live policy. Treat it as referenced."
- **Delete adds:** "Deleting the LAST clause of a name deletes the name (the client's documented
  semantics — a route-map exists only through its clauses). This cannot be undone from the
  running-config; a prior startup-config save would be the only recovery, and this screen never
  writes startup (DR-024)."
- The far-end note (non-gating): "This UI cannot see interface-attached policies, BGP (unmodelled
  on this SKU), or any other reference surface beyond the OSPF reader's redistribute lines."

## Commands

```bash
npm run typecheck
npm run lint
npm test -w arista-webui -- --run src/features/routing
npm test -w arista-webui -- --run src/App.test.tsx
npm run build
```

## Project structure

```
arista-webui/src/features/routing/
  RouteMapManager.tsx       container: reads, the six forms, staging via coordinator
  RouteMapManagerView.tsx   presentation: clause table, references panel, forms, notes
  routemap-rules.ts         pure: validation, diff composition, line builders + citations, copy
  routemap-rules.test.ts    validators + byte-for-byte line pins + copy pins
  RouteMapManager.test.tsx  container: states, staging byte-for-byte, refusals
  routing-rules.ts          ROUTING_READ_ONLY_NOTE narrowed (route maps no longer blocked)
  RoutingView.tsx           route-map panel pointer to #/routing/routemaps
arista-webui/src/App.tsx    '/routing/routemaps' route + nav
docs/features.md            Route maps line annotated partial-shipped
docs/BLOCKED-ISSUES-AUDIT.md #87: route-map-slice-landed note
arista-api-client/docs/DECISIONS.md  DR entry: second routing editor; the send-only-client mirroring convention
```

## Code style

S15/B3 split; the rules module owns validation, the diff, and every line builder (each citing its
`routemaps.ts` line + test pin); the container calls nothing on the device except the reads.
Example of the diff mirror (the pin that keeps this honest without a dry-run arm):

```ts
/**
 * The replace-match/set batch — byte-for-byte the client's `replaceStatements` sequence
 * (routemaps.ts:465-502, pinned by routemaps.test.ts sentScripts): removals first in CURRENT
 * order, additions second in INPUT order, the clause header repeated before EVERY body line
 * (upstream opens the clause per statement — routemaps.py:247-255). The screen stages what the
 * client would send; the client's verbs are send-only, so this mirroring IS the pin (the
 * StaticRoutes/Ntp convention — NOT a DR-151 deviation: every line is a client-verb text).
 */
export function routemapReplaceLines(clause: RoutemapClauseRef, keyword: 'match' | 'set', current: readonly string[], wanted: readonly string[]): readonly string[]
```

## Testing strategy

Vitest 5 + Testing Library + hand-built fake `Node` seams (query by role/label).

- **Rules (pure):** validators (name/action/seqno/continue/statement grammar mirror the client
  refusals); the replace diff is byte-for-byte the client sequence (header-per-line, removals
  first, additions second) on a mixed add/remove fixture; description = the clear-then-set pair;
  create/delete single lines; empty-diff yields the refusal, not an empty batch; the three
  reference-status copy arms; the delete last-clause sentence.
- **Container:** renders the clause table from a fake `getAll()`; empty table is a ready state;
  HARD read failure fails the screen; SOFT `ospf.get()` failure mutes the references panel and
  switches confirms to the unknown arm; create stages one line with the reference-status confirm;
  match-list replace stages the exact diff batch; description stages the pair; continue set/unset
  stage their lines; delete stages `no route-map …` with the hard confirm; creating an existing
  clause and a no-op replace are refused at zero appends; the screen renders no commit/abort
  control.
- **App/nav:** `#/routing/routemaps` routes; `#/routing`'s route-map panel points at the editor.
- **A11y:** forms label every input; tables are `table`s with headers; draft-row Add buttons are
  `type="button"` (the #88 lesson: a submit inside the staging form would trigger staging).

## Boundaries

### Always

- Compose every line as the client's own verb text, citing the `routemaps.ts` line and its
  `routemaps.test.ts` pin at the builder (send-only client → mirroring is the convention).
- Stage through the shared coordinator; commit/abort only in the Transaction Center.
- Show the device diff (via the Transaction Center) before commit; running-config-only (DR-024).
- Surface every device refusal as the device's own error text (DR-057); four states on every read.
- State the reference status as read fact (referenced / unreferenced-in-what-this-UI-can-see /
  unknown) — never claim inertness as a measurement.

### Ask first

- Any `default …` arm (`default route-map`, `default continue`, `default description`).
- Editing what OTHER resources reference (adding an OSPF-redistribution editor changes the
  reference detector's completeness).
- Any `arista-api-client` change.

### Never

- Toggle `ip routing`, or stage any line that touches it.
- Commit a route-map change on the physical switch merely to measure a blast (the operator's
  deliberate product use is the only commit path).
- Fabricate a keyword vocabulary or a blast number.
- Persist staged lines outside the in-memory coordinator.

## Unknowns and how the design degrades

| Unknown (UNVERIFIED on 7050TX-64-R) | Degradation path |
| --- | --- |
| Route-map blast when referenced by live policy | Reference-status facts at confirm + the container-only proxy; first real referenced edit is the measurement. |
| Which match/set keywords this SKU accepts | Free text; device refusal is the answer (DR-057). |
| Whether other (invisible) reference surfaces name a map | The copy names exactly what the check covers; unknown reads degrade to "treat as referenced". |
| seqno step conventions (10-step?) | Client grammar only (digits); device authoritative. |

Each first real device answer gets a DECISIONS entry (capture-on-first-use).

## Success criteria

1. `#/routing/routemaps` shows every configured clause with all four states handled.
2. Create / replace-match / replace-set / description / continue / delete each stage exactly the
   client-mirrored lines; the screen cannot commit.
3. The confirm carries the reference-status arm + the DR-043-scoped proxy sentence, pinned by tests.
4. Creating an existing clause and a no-op replace are refused at zero appends.
5. `#/routing` still renders no route-map editor; its note points at the new screen.
6. No `arista-api-client` file changes in the PR.
7. `npm run typecheck && npm run lint && npm test && npm run build` green in `arista-webui/`.

## Open questions

None blocking. (`default …` arms and prefix-list resources are explicit v2 candidates.)
