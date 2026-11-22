# Unblock capture runbook (2026-11-15)

Purpose: one place that says, for each `status:blocked`-era Web-UI issue, **what to capture, with
which command, and what it does *not* prove.** This complements — it does not replace — the
[`HARDWARE-CAPTURE.md`](./HARDWARE-CAPTURE.md) runbook (physical 7050TX-64 lane) and
[`CEOS.md`](../../docs/CEOS.md) (container lane). The findings it feeds go to DECISIONS `## Open items
(need the device)` and STATUS §3.

## Why the split is cEOS-first
The operator (2026-11-15) ranked **cEOS above the device wherever possible** (runs unattended while
away), and authorized the device lane to *configure* VXLANs/VRFs/etc., scoped to "default traffic is
not affected." Consequence for the script design:

- **Reads + schema** that a container can answer → `capture-unblock-ceos.sh`.
- **Config-grammar verdicts** a container *cannot* answer because cEOS-lab refuses `ip routing` → the
  device, done as **stage-then-abort** (never committed) so forwarding is untouched → `capture-unblock-hw.sh`.
- **Persistence / whole-config verbs** (`copy run start`, `configure replace`, `rollback clean-config`)
  → **disposable container only**. Both the hardware fence (`HW_PROBE_FORBIDDEN`: rollback /
  configure-replace) and `assertNoPersistenceCommand` (`copy run start`, DR-035(c)) refuse these on a
  real unit, and "default traffic unaffected" does not license overwriting startup-config or replacing
  running-config. Captured by `scripts/capture-unblock-ceos.mjs` (run B inside `capture-unblock-ceos.sh`).

`ip routing` is **deliberately never toggled on the unit** by any script: it is saved `no ip routing`,
and flipping it is a forwarding change. Real-VRF/VXLAN *routing state* therefore stays an open device
question, captured only if you separately accept that specific global toggle.

## Command → issue map

| Where | Command | Issues advanced | Proves |
|---|---|---|---|
| cEOS | `bash scripts/capture-unblock-ceos.sh` (then re-run with `--go`) | #86 #87 #90 (schema), #88 (STP model exists) | the JSON field-set / command presence a UI reader binds on; container refusals recorded as negatives |
| cEOS | (runs inside the above) `scripts/capture-unblock-ceos.mjs` | #89 | the 4.28 **answer** to copy-run-start / configure-replace / rollback — container only, never a device verdict |
| device | `bash scripts/capture-unblock-hw.sh` (then `--go ...`) | #86 #87 #88 #90 | the **7050TX-64 verdict**: reads (`HW_INVENTORY_CATALOG` += vxlan/ospf/bgp/route-map/vrf) + staged-then-aborted config grammar from `docs/hw-capture-unblock.draft.json` |

Both scripts **default to DRY RUN** and print the exact plan; neither touches credentials inline (the
device password is `read -rs`).

## Per-issue unblock conditions (after these runs)
- **#86 VXLAN** — hardware read `show vxlan interface/vni/tunnel` present? + does `interface Vxlan1`
  stage (the unblock `unblock-vxlan-grammar` batch)? Combined with the captured `show license features`
  = `{active:[], missing:[]}` → either close as won't-ship or re-spec the VTEP fields.
- **#87 routing** — schema from cEOS (`show ip-ospf[-neighbor]`, `show bgp`, `show route-map`) +
  grammar verdict from the box. Neighbour **tables** are box-only. vrrp is already captured on both;
  per-protocol editors remain a blast-radius DECISIONS call after the captures land.
- **#88 STP mode editor** — a *guard-design* decision, not a capture; STP models already exist on both
  targets. The box adds `spanning-tree mode mst` / MST-region grammar (stage-abort only). Do **not**
  fold mode-change into the per-port guard screen (S15).
- **#89 transaction persistence** — container answers for the 3 verbs; the pending-session field set is
  already captured on both. `commit <intf> verify` / `revert <intf>` stay uncomposed on purpose.
- **#90 VRF manager** — **already un-tagged `status:blocked`**: `show license features` ran + `show vrf`
  captured + the operator's `Maximum number of VRFs allowed: 1023`. Interim read-only VRF column
  allowed; editor needs the box's `vrf`-grammar verdict (the unblock `unblock-vrf-grammar` batch).

## Honesty rules (unchanged, from the lanes these reuse)
- Container bytes never establish 7050TX-64 / 4.28.13.1M support (**DR-043**); device evidence lives in
  `test/fixtures/recordings/7050tx-64-r-4.28.13.1M/`, device probe verdicts as recordings there too,
  container evidence in `test/fixtures/live/` — `recording.ts:targetSlug` enforces the split.
- `show <command>` presence is **not** a licensing or feature claim (**DR-062**); `features.md` is still
  titled for the **7050X** (open item 6) — re-derive before promising modules to the UI.
- Every device batch in `hw-capture-unblock*.draft.json` is `allowCommit:false`; the harness records
  refusals (1002/1004) as answers and continues (**DR-134**), then **aborts** — verify each recording's
  post-state (`show configuration sessions`) is `sessions: {}` and grep the refreshed
  `show running-config` for probe strings before committing anything (run 7 did exactly this).
- **Probe text comes from the port, never from the author** (**DR-141**): every staged line must be a
  spelling a ported resource actually composes (cite the file:line in the batch `question`). Run 7's
  bare `vrf X`, `bgp router-id`, `spanning-tree mode mst` and `vxlan 10010` were invented and produced
  four bogus 1002s.

## Run log

| Day | Lane | Result |
|---|---|---|
| 2026-11-15 | hw `capture-unblock-hw.sh` attempt 1 | **silently skipped** (script bug: unexported password → `EAPI_PASS_VAR_UNSET`, both files skipped with exit 0). Fixed: exported `EAPI_HW_PW` + `guard_nothing_recorded` now fails loudly. Switch was never contacted (skip precedes TLS). |
| 2026-11-15 | cEOS `capture-unblock-ceos.sh` | Part A green (5 new schema fixtures; `show bgp`/`show vxlan interface|tunnel` refused → recorded negatives; 29 tracked files refreshed — verified environmental churn only). Part B first artifact dishonest (HTTP-200-error-object parsing bug) → child fixed to keep raw + self-redact. |
| 2026-11-15 | hw re-run | **run 7 complete**: 7/7 unblock batches all-abort, net-zero verified; 9 new reads + refreshed set landed; exposed the DR-140 text-form redaction gap (3 recordings regenerated). |
| 2026-11-16 | cEOS part B re-run | honest `unblock-persistence.ceos.json`: `copy run start` ACCEPTED + startup flip; `configure replace` exists; `rollback clean-config` exec = 1002. Band lottery note: with both decoys a `10.177.x` /24 can still ARP-fail — bounded retry (≤3) is normal, not a lane bug. |
| 2026-11-16 | hw run 8 (wrong spec silently re-defaulted to round 1) | **Re-confirmation only:** all 7 probe answers + every read verdict re-captured BYTE-IDENTICAL to run 7; 60 volatile inventory refreshes DISCARDED (`git restore`) to keep run 7 provenance. Trap closed in `capture-unblock-hw.sh`: `--spec1|--spec2` selector (DEFAULT is now round 2), resolved spec printed, missing spec = hard exit before prompts. One observation: STP topology-change counters moved between days — the live box changes independently of the probes. |
| 2026-11-22 | hw run 10 (inventory + round-2 re-confirm; persistence lane with `replace`) | **Re-confirmation + the DR-158 persistence answers.** 53 inventory refreshes, every key read zero-substantive-change; the 7 round-2 probe re-recordings byte-identical → RESTORED (run-8 precedent, run 9 provenance kept; the re-record's one gateway-literal scrub regression died with the restore). One real drift kept: `aaa authorization exec default local` in running+startup (operator change, startup mtime 2026-11-21). The persistence lane with `replace` named answered `configure replace` ACCEPTED on the box and measured the one-slot rotation after a replace (DR-158 — see DECISIONS + STATUS run-10 blockquote). Round-3 spec drafted (`hw-capture-unblock3.draft.json`, `--spec3 --scratch`), NOT executed. #159 CORS capture deliberately skipped (DR-149: pure evidence, gates nothing). |
| 2026-11-16 | hw run 9 (`hw-capture-unblock2.draft.json`) | **Round 2 EXECUTED — the final block of #86/#87/#88/#90 grammar evidence.** 5 FULL stages / 0 commits / all aborted, `sessions: {}` post-states: `vrf instance`+`rd` FULL (+ device auto `no ip routing vrf`); device calls `vrf definition` **deprecated**; interface `vrf NAME` = runtime 1000 `not configured` (existence is checked); BGP triple FULL (config alive, reads `% Not supported`); `spanning-tree mode none` FULL; `vxlan vlan N vni M` + `vxlan source-interface <intf>` FULL inside `interface Vxlan1`. **Open item 2 DECIDED: VXLAN grammar-present/feature-absent → #86 not shipping; #90 editor grammar proven.** One diff-context line surfaced the LAN gateway (`ip name-server 192.168.1.1`) — new file re-scrubbed with the gateway literal; **`--scrub` must include default-gateway + LAN-DNS from now on.** |

Still owed after run 10 (run 9's list narrowed): the round-3 grammar questions (`--spec3`: rapid-pvst stage, MST-region removals, subinterface context — DRAFTED, awaiting a supervised day), the #89 session name-shape/`no-commit` HARDWARE halves (the container grammar lane's fence refuses a device target by design; a hardware twin is its own risk review), and the `rollback <name>` slot-mechanism follow-up (the `completedSlotHolds` observation, DR-158). Run 9's #88 guard-design DECISIONS landed (DR-149); run 9's #89 persistence answers landed (DR-150 + DR-158's `replace`); cEOS `show bgp summary|neighbors` fixtures — **settled negative on 2026-11-18**: #154 added `router bgp 65001` to `provisionStaging` (run lab-1841022-612e1d committed it — see the `show bgp` catalog notes), and the reads STILL answer unreachable when configured (eAPI 1000; Cli `{"errors":["Not supported"]}`), so no configured-BGP fixture is producible on this image. The old "add `router bgp` to `provisionStaging`" step is DONE — what remains for #87's BGP tab is a spec decision built on that double negative, not another probe. Optional operator call: re-scrub sweep of pre-2026-11-16 committed captures to add the `192.168.1.1` literal (RFC1918 gateway/DNS occurrences since run 1; no credentials).

**Open item 6 note:** the run-7 re-record sharpened the negatives — `show hardware tcam[ profile]`
answer `Unavailable command (not supported on this hardware platform)`, `show systems` answers
`Invalid input` — the features.md re-derive stays open, now with exact device wording to cite.
