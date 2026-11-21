# Spec: OSPF process editor (#87, OSPF slice)

Status: shipped 2026-11-21 (the intake answers below; implementation per this spec — see DR-154).
The third per-protocol routing editor under #87's
"each protocol = its own screen issue" rule (VRRP shipped first — DR-152; route maps second —
DR-153). Depends on the shared transaction coordinator (#141) — this screen stages through it and
owns no session.

## Owner intake (2026-11-21, answered)

1. **Verb set: full lifecycle** — process create/delete, router-id set/clear, network add/remove,
   redistribution add/remove, shutdown/no-shutdown. (Recommended option chosen; "fields only" and
   "networks only" declined.)
2. **Area default: `0.0.0.0`** — the add-network form defaults the area to the dotted-quad, the one
   spelling this client's own reader reads back (divergence 4). Bare digits stay accepted, with the
   read-back invisibility disclosed in-form.
3. **Redistribution removal**: question skipped → the client-faithful default stands: removal sends
   the BARE `no redistribute <protocol>` (client divergence 10) and the confirm states what that
   single line may cover when the config holds several qualified lines for one protocol.

## Objective

Give the operator the OSPF process this client models — the FIRST `router ospf …` section of the
running-config — as a viewer/editor at `#/routing/ospf`: see the process identity, router-id,
networks, redistributions and shutdown state; stage every write the `ospf.ts` client can compose,
with confirm copy that quotes the ONLY measured OSPF blasts in the repo (the two-node cEOS lane)
for exactly what they measured. Today the box runs zero OSPF processes and `no ip routing`
(captured), so the screen's ready state is the empty one, and process create is the first verb an
operator would use.

Why this is safe to open now (DR-149 permissive policy): every write stages into the shared
transaction and is reviewed as a device diff in Transaction Center before commit; the confirm copy
carries the measured blast proxies; `ip routing` is never touched (the audit's #87 Do-Not-Do).

## Verified facts this screen stands on

| Fact | Source |
|---|---|
| `ospf.get()` answers ONE process — the first `router ospf …` section — or `undefined`; every submode write names that same first pid (no vrf arm) | `arista-api-client/src/resources/ospf.ts` (`get`, `configureOspf`, module divergence 7) |
| Client verbs and their exact texts: `create` → `router ospf <pid>[ vrf <name>]` (zero reads); `delete` → `no router ospf <pid>` after a read, NOTHING when absent; `setRouterId/unsetRouterId/defaultRouterId` → `router-id <v>` / `no router-id` / `default router-id`; `shutdown/noShutdown` → `shutdown` / `no shutdown`; `addNetwork/removeNetwork` → `network <n>/<m> area <a>` / `no network …`; `addRedistribution/removeRedistribution` → `redistribute <p>[ route-map <r>]` / bare `no redistribute <p>` | `ospf.ts` verb bodies; every text pinned by `ospf.test.ts` `sentScripts` (e.g. `['enable','configure terminal','router ospf 65000','router-id 3.3.3.3']`) |
| Submode batches are `[header, ...subcommands]` — the header opens the submode ONCE per verb call (`submodeCommands`, `command-builder.ts:160-171`). This is NOT the route-map shape (which repeats the header per statement) | `command-builder.ts`; `ospf.test.ts` two-line write pins |
| Process-id bound 1..65535 is pyeapi's own; the image's real range is a device answer | `ospf.ts` `assertProcessId` (divergence 5, DR-032) |
| Redistribution protocol allow-list is exactly `bgp, rip, static, connected`; widening to what 4.28 understands is a device-capture question | `ospf.ts` `REDISTRIBUTION_PROTOCOLS` (DR-032) |
| `area 0` (the client's write default) is INVISIBLE to the client's own networks reader (dotted-quad-only regex) — divergence 4, kept on purpose | `ospf.ts` module docs; `ospf.test.ts` pin |
| `no redistribute <p>` is the only negation the client sends, even against qualified lines — divergence 10; ANSWERED post-ship on cEOS (DR-155 grammar lane, rea-q6): the bare form DID remove a route-map-qualified line (container evidence, DR-043) | `ospf.ts` `removeRedistribution`; `docs/evidence/unblock-grammar-ceos.json` |
| Hardware grammar: `router ospf 1` + `router-id` + `passive-interface default` stage FULLY on the 7050TX-64-R (auto `max-lsa 12000` appears in the diff); aborted | DR-141 run 7 verdict (`DECISIONS.md`); batch `unblock-ospf-grammar` (`hw-capture-unblock.draft.json`) |
| Measured route blast (two-node cEOS-lab 4.28.14M): withdrawing B's loopback advertisement (`router ospf 1` + `no network 10.156.0.2/32 area 0`) removed A's route in **67 ms**, restore **6170 ms** | `docs/evidence/ospf-two-node.ceos.json` (`blast-route`); mechanism read from `ospf-two-node.live.test.ts:229-247` |
| Measured adjacency blast (same lane): removing B's TRANSIT network statement (`no network 10.155.0.0/30 area 0`) dropped the adjacency at A in **32636 ms**, reformed in **12279 ms** | same artifact (`blast-adjacency`); mechanism at `ospf-two-node.live.test.ts:253-275` — produced by a NETWORK-STATEMENT removal, NOT by `router ospf shutdown` |
| Both targets answer `show ip ospf` / `show ip ospf neighbor` (JSON shape cEOS-only; hardware captures are text-empty); neighbor ENTRY shape is unmodelled — count only | `src/eapi/show-contracts.ts` (`ShowIpOspfReply`, `ShowIpOspfNeighborReply`) |
| The box runs zero `router ospf` sections and `no ip routing` today | captured posture (audit #87; DR-135 run evidence) |

## Staged-lines contract (the pin story)

`ospf.ts` verbs are **send-only** — no `{ run: false }` dry-run arm (unlike `vrrp.ts`, DR-152). So
this screen follows the **DR-153 mirroring convention**: every staged line is byte-for-byte the text
the client's own verb sends, cited to its `ospf.ts` body and guarded by the same byte in
`ospf.test.ts`'s `sentScripts`. This is the StaticRoutes/Ntp/routemaps convention — NOT a DR-151
capture deviation. **No `arista-api-client` file changes in this PR.**

Batches (flat `string[]`, the coordinator owns `enable`/`configure terminal`):

| Verb | Staged lines |
|---|---|
| create | `router ospf <pid>` (+ ` vrf <name>` when given) — ONE line, no submode |
| delete process | `no router ospf <pid>` — ONE line |
| router-id set / clear | `router ospf <pid>` + `router-id <value>` / `no router-id` |
| shutdown / no-shutdown | `router ospf <pid>` + `shutdown` / `no shutdown` |
| network add / remove | `router ospf <pid>` + `network <n>/<m> area <a>` / `no network <n>/<m> area <a>` |
| redistribution add / remove | `router ospf <pid>` + `redistribute <p>[ route-map <r>]` / `no redistribute <p>` |

The header appears ONCE per batch (the client's `submodeCommands` shape) — unlike route-map
batches, which repeat it per statement.

Out of scope (stays closed): `default router-id` (the client has it; the VRRP/route-map precedent
keeps `default` arms out until asked); `passive-interface` (hardware-proven grammar but NO client
verb — inventing its text is exactly the DR-141 failure class); max-lsa, timers, area design,
virtual-links, prefix-lists, `auto-cost reference-bandwidth`, `ip routing` (never), multi-process
nodes (the client models one — the standing note says so, and the `show ip ospf` device panel may
reveal instances the config read does not: panels never merge).

## Screen & UX

`#/routing/ospf`, container `OspfManager.tsx` + pure `OspfManagerView.tsx` + pure `ospf-rules.ts`
(the S8/S15/B3 split). Reads:

- **HARD** `ospf.get()` — the process table. `undefined` is a NORMAL empty state (create enabled,
  every other form disabled); a failure is the error wall.
- **SOFT** `show('ip ospf')` — device instance rows (reuse `ospfDeviceRows` from `routing-rules`).
- **SOFT** `show('ip ospf neighbor')` — adjacency COUNT only (reuse `ospfNeighborSummary`; entry
  shape unmodelled).
- **SOFT** `show('routemaps')`→ `routemaps.getAll()` — used ONLY to annotate a redistribution
  route-map name that the config read does not list (a risk line, never a refusal; a failed read
  says "unknown"). The dangling-reference lesson (run 9: the device accepts dangling references at
  stage time) is stated, not blocked.
- **SOFT silent** `show('version')` — identity chip.

Panels: configured process (identity fields, networks table, redistributions table, shutdown
state); device side (`show ip ospf` instances + neighbor count, never merged); forms:

1. **Create process** — pid (digits, 1..65535 client bound, DR-032 note) + optional vrf name
   (`\w+`). Refused at zero appends when the read already shows a process.
2. **Delete process** — one button, hard confirm (the whole process: adjacencies, advertisements,
   redistributions).
3. **Router-id** — set (token grammar) / clear (`no router-id`). Refuses the already-said value;
   refuses clear when no router-id exists.
4. **Networks** — add: network + mask length + area (default `0.0.0.0`, bare digits accepted with
   the divergence-4 note "a line written with a bare area never appears in this table"); remove:
   picker over the READ networks (a `area 0`-written line is not pickable — the note says so and
   the console is the escape hatch).
5. **Redistributions** — add: protocol select (the client's four) + optional route-map name;
   remove: picker over read rows, composing the BARE negation with the divergence-10 sentence in
   the confirm.
6. **Shutdown state** — set / clear (two actions, one form). Refuses the already-said state.

Every form stages; nothing on this screen commits or aborts (#141).

## Risk / confirm copy (facts, not adjectives — DR-149)

- Every entry opens with the staged-line restatement (`ospfReadBack`) naming the mirroring.
- **Network removal** carries the most exact evidence in the repo, stated exactly: the measured
  67 ms withdrawal / 6170 ms restore WAS a `no network … area …` statement removal (two-node
  cEOS-lab 4.28.14M, container evidence, not this unit — DR-043).
- **Adjacency-killing verbs** (`shutdown`, process delete, transit-network removal) quote the
  32636 ms / 12279 ms adjacency blast and say plainly it was produced by removing a network
  statement, NOT by the command being staged.
- **Router-id change** states the mechanism (a live process changing its router-id re-forms
  adjacencies) and says the timing is NOT measured for this verb — no fabricated number.
- **Create** states the captured posture (`no ip routing`, zero processes) so a create is never
  mistaken for enabling routing; inertness of a bare process is a stated inference, not a
  measurement (the unreferenced-route-map precedent).
- **Redistribution add/remove** quotes the route blast (67/6170) as the closest measured
  advertisement change and names what the read cannot see.
- The route-map-name-not-in-config annotation is a risk line: "the running-config read does not
  name this map; the device accepts dangling references at stage time (captured, run 9) — whether
  it matters at redistribute time is the device's answer."
- The standing banner: single-process modeling (divergence 7 — reads AND writes address the first
  `router ospf` section), running-config-only commits (DR-024), `ip routing` never touched.

## Testing strategy

Vitest, jsdom, offline (the `RouteMapManager.test.tsx` harness shape):

- `ospf-rules.test.ts` — line builders byte-for-byte vs the `ospf.test.ts` pins (header ONCE per
  batch); validators mirroring the client guards (pid bound, vrf `\w+`, token grammar, mask digits,
  area digits-or-quad, protocol allow-list); already-said/exists refusal predicates; row flatteners;
  copy pins (67/6170/32636/12279 quoted with their mechanisms, "NOT by the command being staged",
  DR-043 scoping, divergence 4/10 sentences, confirmation titles/subjects).
- `OspfManager.test.tsx` — four states (HARD `ospf.get()` failure = error wall; `undefined` =
  normal empty with create enabled and everything else disabled; SOFT show failures mute their
  panels; no-proxy idles); every batch byte-for-byte; every zero-append refusal; the dangling
  route-map risk line appears (and says unknown when the routemaps read fails); no commit/abort
  controls; `configSession` never called by the screen.
- `App.test.tsx` — nav link 'OSPF' → `#/routing/ospf`, heading, EAPI_HOST alert, all staging
  buttons disabled.
- `Routing.test.tsx` — the `not offered on THIS screen` pins keep matching (prefix unchanged);
  the OSPF panel gains the editor pointer.

## Boundaries

- **Always**: stage-only; typed reads; four states; a11y (labelled inputs, tables with headers,
  `aria-live` results); every line cited to its client pin.
- **Ask first**: adding a `default` arm; widening the protocol list; any `arista-api-client`
  change; touching `passive-interface` (no client verb).
- **Never**: toggle `ip routing`; invent command text the client does not compose (DR-141);
  fabricate blast numbers; commit from this screen; contact a physical switch from tests.

## Success criteria

1. `#/routing/ospf` renders the four states honestly and stages every verb as the client's own
   byte-for-byte text (pinned).
2. Confirm copy quotes only the measured numbers, each with its true mechanism and DR-043 scoping.
3. Zero-append refusals for: create over an existing process, already-said router-id/shutdown,
   duplicate network/redistribution lines, clearing what does not exist.
4. Gate green: `npm run typecheck && npm run lint && npm test -- --run && npm run build` (webui) +
   client `docs:check`. No `arista-api-client` file changes in the PR.
5. Docs: this spec flipped to shipped, DR-154, `features.md` OSPF line annotated, audit
   OSPF-slice-landed block, #87 commented.
