# Spec: VRRP Virtual-Router Viewer/Editor (#87, VRRP slice)

Status: shipped 2026-11-21 (the intake answers below; implementation per this spec — see DR-152).
The first per-protocol routing **editor** the DR-149
permissive blast policy + the #87 "each protocol = its own screen issue" rule unblock. Depends on
the shared transaction coordinator (#141) — this screen stages through it and owns no session.

## Objective

Give the single operator one screen to see every VRRP virtual router configured on the switch and
to create, edit, and delete them — staging through the shared transaction with a confirm that
states the failover blast honestly (it has never been measured on any target).

Today the read-only Routing screen (`#/routing`) renders the configured VRRP table
(`node.vrrp.getAll()`) and the `show vrrp` count, and `ROUTING_READ_ONLY_NOTE` says every routing
write is blocked behind #87's per-protocol blast review. This spec ships the **VRRP** half of that
review's outcome: a dedicated editor at `#/routing/vrrp`. OSPF, route-map, and BGP editors stay
out (BGP has no device read surface on this SKU; OSPF/route-map are separate slices).

Success looks like: the operator opens `#/routing/vrrp`, sees each `(interface, vrid)` group with
its enabled/priority/preempt/IP/description fields, creates a new group or edits/deletes an
existing one, and the Transaction Center confirm states plainly that a priority/preempt/enable
change can trigger a master switchover for that VLAN's default-gateway traffic, with the timing
**not measured on any target**.

## Approved Product Assumptions

Answered by the owner on 2026-11-21 (this spec's intake), on top of DR-149:

1. **Verb set: create + per-field edit + delete**, with a bounded field set per form (the
   recommended scope). Advanced fields (secondary IPs, tracked objects, BFD, ip-version,
   mac-address advertisement-interval, the three delays) are **read-only columns** in v1 — their
   client verbs exist but each adds blast surface; they land in a v2 only if asked for.
2. **Blast copy: honest unmeasured.** No VRRP failover blast has been measured on any target
   (unlike OSPF/STP), so the confirm says so and names the first real use as the measurement
   opportunity — facts, no invented numbers.
3. **Command text comes from the CLIENT's own dry-run seam** (`{ run: false }` on each setter,
   which returns the composed line). This is the strongest pin in the repo — NOT the raw-line
   capture-pinning the #88 MST-region editor had to use — because `vrrp.ts` is a fully ported
   module (W3c #51, DR-116–121) with a dry-run arm on every field setter. No client change.
4. **The modern/legacy command family is the client's job, not the screen's.** `vrrp.ts` detects
   the family from the device's own config text (DR-116) and composes `ipv4`/`priority-level`/
   `session description`/`disabled` on the modern arm. The hardware verdict is on record: the
   7050TX-64-R refuses legacy `vrrp N ip …` (names `vrrp ipv4` as the replacement) and ACCEPTS
   `vrrp 1 ipv4 …` (staged a real 12-line diff, aborted — DR-135 run 9 item 8). The screen never
   picks a family; it calls the client and the client picks.
5. From DR-149: the permissive blast policy protects *live traffic undisturbed*; commits stay
   running-config-only (DR-024); the device stays the authority (DR-057).

## Verified facts this spec builds on

| Fact | Class | Source |
| --- | --- | --- |
| `vrrp <n> ipv4 <addr>` on an SVI stages (12-line diff), aborted | hardware | `configure-session-vlan-interface-vrrp-ipv4--hw-session-probe.json`, DR-135 item 8 |
| legacy `vrrp <n> ip <addr>` REFUSED (`deprecated by 'vrrp ipv4'`) | hardware | `configure-session-vlan-interface-vrrp--hw-session-probe.json` |
| `show vrrp` answers `virtualRouters: []` (device-side element shape unmodelled) | both targets | `show-vrrp--hw-inventory.json`, `live/ceos-4.28.14M/show-vrrp.json` |
| the switch runs **zero** VRRP groups today; `ip routing` is off | hardware | hw running-config captures; DR-135 item (`-no ip routing`) |
| `node.vrrp.getAll()` / `get()` read the configured table fully | client | `resources/vrrp.ts` (W3c #51) |
| every field setter has a `{ run: false }` dry-run arm returning the composed line | client | `runCommand`/`runCommandList` (`vrrp.ts:560-568`); pins at `vrrp.test.ts:1070-1077` |
| `create()` has NO dry-run arm (always sends) — so the screen composes a create via the per-field dry-run setters in `_vrrp_set` order | client | `create`/`vrrpSet` (`vrrp.ts:580,912`); order pinned `vrrp.test.ts:404-424` |
| VRRP failover timing on this SKU | **UNVERIFIED** | — (honest unmeasured copy) |

## User Stories

- As an operator, I can see every configured virtual router — interface, VRID, enabled state,
  priority, preempt, primary IP, description — plus the advanced fields as read-only detail, with
  honest loading/error/empty states.
- As an operator, I can create a virtual router on an L3 interface (VRID + primary IPv4 + optional
  priority/description/preempt) and review the composed `interface …` batch + device diff before
  committing.
- As an operator, I can edit one field of an existing group (enable/disable, priority, description,
  preempt, advertise interval) without retyping the whole group.
- As an operator, I can delete a virtual router with a hard confirm naming the interface and VRID.
- As an operator, every write's confirm states that a master switchover may follow and that the
  timing is unmeasured on this unit — so I am not misled by a false number.
- As an operator, when a read fails I am told which read failed; the screen never renders a blank
  table as "no VRRP" when the read simply did not answer.
- As an operator, nothing on this screen commits; commit/abort belong to the Transaction Center.

## Scope

### In scope

- New route `#/routing/vrrp` + feature screen (`VrrpManager` container / `VrrpManagerView`
  presentation / `vrrp-rules.ts` pure rules), following the S8/S15/B3 container-presentation split.
- Reads: `node.vrrp.getAll()` (HARD — the configured table is the screen's subject);
  `node.ipinterfaces.getAll()` (SOFT — feeds the create-form's L3-interface candidate list);
  `node.show('vrrp')` (SOFT — the device-side count, the `#/routing` pattern);
  `node.show('version')` (silent soft identity chip).
- Create form: interface select (union of interfaces the `vrrp` table names and the `ipinterfaces`
  reader lists), VRID (non-negative integer, the client's `assertVrrpId` grammar mirrored), primary
  IPv4 (dotted-quad), optional priority (1-254), description, preempt toggle. Composed via the
  client's dry-run setters in `_vrrp_set` order (enable line first — `create` injects
  `enable:false`, reproduced).
- Edit form: pick an existing `(interface, vrid)`, change ONE field (enable/disable, priority,
  description, preempt, advertise interval). Composed via the matching dry-run setter.
- Delete: `no vrrp <vrid>` under the interface (the client's `delete` text), hard-confirm.
- Read-only detail for the advanced fields (secondary IPs, tracks, BFD, ip-version,
  mac-adv-interval, delays) so the operator sees what exists without the screen editing it.
- Staging through the shared coordinator; risks/review copy + a per-entry second confirm flow into
  the Transaction Center as for every migrated screen.
- `#/routing`'s VRRP panel gains a pointer to the editor (its "never edits them" copy retires);
  `ROUTING_READ_ONLY_NOTE` narrows to OSPF/route-map/BGP (VRRP is no longer blocked).
- Vitest coverage per "Testing strategy"; docs updates.

### Out of scope

- Any `arista-api-client` change.
- Editing the advanced fields (secondary IPs, tracks, BFD, ip-version, mac-adv-interval, delays) —
  read-only in v1.
- `default vrrp <vrid>` (the client's `setDefault`) — offered only if asked; delete covers removal.
- Committing on the feature screen; startup-config; `copy run start`; rollback/replace/timers (#89).
- OSPF / route-map / BGP editors (separate #87 slices).
- Toggling `ip routing` (the audit's #87 "Do Not Do" — never incidental).
- A cEOS VRRP blast lane (the owner chose honest-unmeasured copy over a pre-ship lane).

## Screen contract

### Reads

```
node.vrrp.getAll()          → Map<interface, Map<vrid, Vrrp>>   (HARD)
node.ipinterfaces.getAll()  → Map<interface, IpInterface>       (SOFT — create candidates)
node.show('vrrp')           → { virtualRouters: [] }            (SOFT — device count; shape unmodelled)
node.show('version')        → identity chip                     (silent soft)
```

- Empty `getAll()` is a normal ready state ("no interface section carries a `vrrp` line"), never
  an error — the switch runs zero groups today.
- `ipinterfaces` read failure: the create-form's interface list falls back to only the interfaces
  the `vrrp` table already names, with a named note; the table + edit/delete stay usable.
- `show vrrp` failure: the device-count chip mutes (the `#/routing` pattern), never blanks.

### Staged command lines (the whole write surface — every line from the client's dry-run seam)

The screen calls the client's setters with `{ run: false }` and stages the returned text under the
`interface <name>` parent (via `submodeCommands`). Modern-family spellings shown; the client emits
legacy on a legacy-spelled config.

```
Create (order = _vrrp_set; enable line always first — create injects enable:false):
  interface <name>
   vrrp <vrid> disabled | no vrrp <vrid> disabled      (enable arm; `disabled` modern / `shutdown` legacy)
   vrrp <vrid> ipv4 <addr>                              (only if a primary IP given)
   vrrp <vrid> priority-level <1-254>                   (only if priority given)
   vrrp <vrid> session description <text>               (only if description given)
   vrrp <vrid> preempt | no vrrp <vrid> preempt         (only if preempt chosen)

Edit (one field):
  interface <name>
   vrrp <vrid> <the one changed field's composed line>

Delete:
  interface <name>
   no vrrp <vrid>
```

- In-form validation mirrors the client's guards (grammar, not device bounds — DR-120): VRID
  non-negative integer; primary IPv4 dotted-quad (`^\d+\.\d+\.\d+\.\d+$`); priority 1-254;
  description non-empty when set. A device refusal surfaces as its own `CommandError` (DR-057).
- Creating a `(interface, vrid)` that already exists is refused in-form at zero appends (the client
  would re-property it; the screen sends the operator to Edit instead).
- All batches go through `stageLines` → coordinator; the screen opens no session.

### Risk/confirm copy (F4 + per-entry second confirm)

Create, delete, and the enable/priority/preempt edits are `destructive`; description and advertise-
interval edits carry risks only. The confirm body (pinned by tests):

- **Failover (create/delete/enable/priority/preempt):** "Changing this virtual router can trigger a
  VRRP master switchover for <interface>'s default-gateway traffic: the backup takes over the
  virtual IP and in-flight traffic for that VLAN's hosts is interrupted until it does. Failover
  timing is NOT measured on any target — the first real use on this unit is the measurement
  opportunity (no fabricated number). Container evidence does not establish this unit's behavior
  (DR-043)."
- **Delete adds:** "Removing `vrrp <vrid>` from <interface> deletes the whole group (IP, priority,
  timers, any tracked objects) — this cannot be undone from the running-config; a prior
  startup-config save would be the only recovery, and this screen never writes startup (DR-024)."
- **Create adds:** "This box runs `no ip routing` today (captured); a VRRP group on an SVI is
  configured state and does not by itself enable inter-VLAN routing."
- The far-end note (non-gating): "This UI cannot see what is attached on the far end of <interface>
  or whether a peer router holds the backup for this VRID."

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
  VrrpManager.tsx          container: reads, create/edit/delete forms, staging via coordinator
  VrrpManagerView.tsx      presentation: table, forms, read-only detail, notes
  vrrp-rules.ts            pure: candidate list, validation, risk copy, create-order helper
  vrrp-rules.test.ts       validators + copy pins
  VrrpManager.test.tsx     container: states, staging byte-for-byte, refusals
  routing-rules.ts         ROUTING_READ_ONLY_NOTE narrowed (VRRP no longer blocked)
  RoutingView.tsx          VRRP panel pointer to #/routing/vrrp
arista-webui/src/App.tsx   '/routing/vrrp' route + nav
docs/features.md           VRRP line annotated partial-shipped
docs/BLOCKED-ISSUES-AUDIT.md  #87: VRRP-slice-landed note
arista-api-client/docs/DECISIONS.md  DR entry: first routing editor via the client dry-run seam
```

## Code style

S15/B3 split; the rules module holds validation + copy, the container calls the client's dry-run
seam for text. Example of the composition seam (the pin that makes this screen stronger than #88's):

```ts
/**
 * The create batch, composed through the CLIENT's dry-run setters in `_vrrp_set` order (enable
 * line first — `create` injects `enable:false`, vrrp.ts:585). Every line is the client's own
 * text (`{ run: false }` returns it), never a string this screen wrote — the family
 * (ipv4/priority-level/session description vs legacy) is the client's config-text detection
 * (DR-116), inherited for free.
 */
async function composeCreate(vrrp: VrrpResource, iface: string, vrid: number, form: CreateForm) { … }
```

## Testing strategy

Vitest 5 + Testing Library + hand-built fake `Node` seams (query by role/label).

- **Rules (pure):** candidate union; validators (VRID/IP/priority/description) accept the client's
  own accepted shapes and reject the rest; failover/delete/create risk copy carries the unmeasured
  sentence + DR-043 line; the create-order helper emits enable-line-first.
- **Container:** renders the table from a fake `getAll()`; empty table is a ready state; HARD read
  failure fails the screen; SOFT `ipinterfaces` failure narrows the candidate list with a note;
  create stages the exact client-composed batch (fake setters return pinned text) with the
  failover second confirm; editing an existing group stages one line; delete stages
  `interface … / no vrrp N` with the delete confirm; creating an existing `(iface, vrid)` is
  refused at zero appends; the screen renders no commit/abort control.
- **App/nav:** `#/routing/vrrp` routes; `#/routing`'s VRRP panel points at the editor.
- **A11y:** forms label every input; the table is a `table` with headers; device-read results use
  the existing `aria-live` seams.

## Boundaries

### Always

- Compose command text through the client's `{ run: false }` setters (never a hand-written field
  line). **One documented exception:** `delete()` has no dry-run arm (it always sends), so the
  delete line is the client's own era-free literal `no vrrp <vrid>` — pinned at `vrrp.ts:588` /
  `vrrp.test.ts:508` — composed by `vrrpDeleteLine()` with that citation. It is the client's text,
  just not reachable through a dry-run call.
- Stage through the shared coordinator; commit/abort only in the Transaction Center.
- Show the device diff (via the Transaction Center) before commit; running-config-only (DR-024).
- Surface every device refusal as the device's own error text (DR-057); four states on every read.

### Ask first

- Editing an advanced field (secondary IPs / tracks / BFD / ip-version / delays).
- Offering `default vrrp` or any `no …` line the client does not already compose.
- Any `arista-api-client` change.

### Never

- Toggle `ip routing`, or stage any line that touches it.
- Commit a VRRP change on the physical switch merely to measure failover (the operator's deliberate
  product use is the only commit path).
- Fabricate a failover timing number.
- Persist staged lines outside the in-memory coordinator.

## Unknowns and how the design degrades

| Unknown (UNVERIFIED on 7050TX-64-R) | Degradation path |
| --- | --- |
| VRRP failover timing / switchover blast | Honest unmeasured copy; first real use is the measurement. |
| VRID max, priority bounds on this image | Client grammar only; device refusal is the answer. |
| Whether a VRRP group on a routed port (vs SVI) behaves the same | Candidate list is read-driven; device authoritative. |

Each first real device answer gets a DECISIONS entry (capture-on-first-use).

## Success criteria

1. `#/routing/vrrp` shows every configured group with all four states handled.
2. Create / edit / delete each stage exactly the client-composed lines; the screen cannot commit.
3. The confirm carries the honest failover sentence + DR-043 scoping, pinned by tests.
4. Creating an existing `(iface, vrid)` is refused at zero appends.
5. `#/routing` still renders no VRRP editor; its note points at the new screen.
6. No `arista-api-client` file changes in the PR.
7. `npm run typecheck && npm run lint && npm test && npm run build` green in `arista-webui/`.

## Open questions

None blocking. (Advanced-field editing and `default vrrp` are explicit v2 candidates, not
blockers.)
