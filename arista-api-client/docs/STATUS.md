# Status — `arista-api-client`

Single source for "where are we". Update **in the same commit** that changes code, then update the
mirrored GitHub issue (see §4). Detailed task lists live in [PLAN.md](./PLAN.md); behaviour changes go
in [MIGRATION.md §5](./MIGRATION.md#5-semantic-divergences-worth-reviewing).

As of 2026-11-03: **M1-M6 are implemented and merged** — every pyeapi transport has a TypeScript
equivalent, the `Node` command layer exists, `eapi.conf` profiles plus the option-bag factories give the
package a real front door, EOS config text has a parity-proven parser, and change safety (named +
journaled sessions, a text diff, commit/abort, orphan recovery and explicit durability) is in the client.**
PR #25 (M5, #7) merged on 2026-11-03, so `src/config-session.ts` and `node.configSession()` are on `main` too. **PR #22 (M4, #6), PR #23 (M6, #8) and PR #24 (M3, #5) are merged into `main`** —
`src/command-layer.ts`, `src/config/` and the profile layer, with §5 rows 31-38, 41-53 and 54-60.
The package (M0) builds, lints, tests and type-checks from the repo root, and `arista-webui` imports it
by name. The wire core (M1) stays pure: `src/types/eapi.ts` carries the `runCmds` contracts and the
`WireSender` seam, `src/internal/wire.ts` encodes/decodes envelopes with no I/O, `src/errors.ts` holds
the DR-010 code set and DR-011 redaction contract, and the 27 hand-authored samples in
`test/fixtures/wire/` are driven by `src/internal/wire.fixture.test.ts` (all message prose is still
synthetic until M12 #14 records captures). M2 added `src/transports/`: one `Transport` abstraction over
the codec, `FetchTransport` in the browser entry and the six Node senders (`https`, `http`,
`https-client-cert`, `session`, `unix`, `http-local`) behind `./node`, with DR-013 trust options, DR-014
local-transport warnings, DR-018 cookie sessions, DR-019 retry rules, DR-017 response-id correlation and
`MockTransport` for offline tests. M4 added `src/command-layer.ts` (pyeapi's `Node` class, minus what
other milestones own) and `src/internal/variants.ts`: read-only work against a mocked switch is now fully
usable with no resource module, which is PLAN's M4 exit gate. M3 (#5, merged as [PR #24](https://github.com/svaj/vibe-arista-webui/pull/24)) landed that bag: `createNode()`/`createConnection()` in `src/index.ts` take an explicit connection or a profile plus `store`, and `./node` adds the `eapi.conf` file search (DR-038).
**PR #27 (M8, #10) and PR #28 (M9, #11) merged into `main` on 2026-11-04 (`f77ed72`, `ec92f9d`)** — `src/resources/{system,vlans,switchports}.ts` with their shared `config-block.ts` extractors, §5 rows 83-90 + 91-98 and DR-055-060 are on `main`, closing the "synthetic until M12" era for those modules' command pins. The MIGRATION §5 ledger on `main` is contiguous **1-38 + 41-98** (rows 39-40, DR-003 and DR-031 stay deliberately unused); the reserved bands held — **41-53 M6, 54-60 M3, 61-70 M5, 71-82 M7, 83-90 M8, 91-98 M9** — and the next open is **#29 (this lane, M12 #14, partial)**, claiming §5 rows **107-114** + DR-064-066: rows **99-106** (+overflow **123-130**) now belong to **M10 (#12)**, rows **115-122** + DR-061-063 to **M11 (#13)**, so every future §6 entrance appends cleanly in any merge order. M7, M8 and M9 all edited `command-layer.ts`/`index.ts`/`node.ts`/`registry.ts` additively; this branch touches none of them. The cEOS harness was re-verified after a fresh boot on 2026-11-04: `lab:up -> lab:probe -> lab:down` exit 0, authenticated eAPI on the published port, zero leftovers (a multi-NIC endpoint-selection flake surfacing as 30/30 ECONNRESET was diagnosed and single-attached at the patch site — see `scripts/ceos-lab.mjs` and §5 row 112).

**M10a (#12) is delivered on its branch** — `src/resources/interfaces.ts` (the `Interfaces` facade,
`BaseInterface`'s verbs, and DR-031's hybrid read over `show interfaces status`) plus the per-kind name
grammar that replaces row 76's regex (`INTERFACE_GRAMMAR`, **DR-067**/DR-068), wired through
`validators.ts`, `registry.ts`, `Node.interfaces` and both package entries. It claims §5 rows **99-106**
and **DR-067-069**, and it carries the repo's first reader written against a **recording of that exact
command**: this branch merges PR #29's
`test/fixtures/live/ceos-4.28.14M/show-interfaces-status.json` in and reads `interfaceStatuses` /
`linkStatus` first, keeping pyeapi's sibling-command spellings as a labelled fallback (**DR-069**) — the
guess was wrong and the capture caught it. Branch gate: **49 files / 1,474 client tests** (+113 over the
merged suite), coverage 98.14 st / 92.66 br / 99.35 fn / 98.83 ln, `interfaces.ts` 100 % stmts/branches/
funcs/lines, `src/resources/` 99.85 / 99.73 / 100 / 100. **M10 is `in-progress`, not done:** PLAN's exit
gate is LAG/LACP end-to-end, which needs M10b (`EthernetInterface`) and M10c (`PortchannelInterface`) —
rows **123-130** and **DR-070+** stay reserved for them, and `interface Ethernet1` creation remains a typed
refusal that names M10b as its owner. **M10b/M10c are delivered on their branch** (superseding that
reserve sentence: they claimed §5 rows **125-132** + **DR-075-080**, with rows 123-124 and DR-070-074
declared-skipped; M11's PR takes 115-122 + DR-061-063 and must merge FIRST to keep the §5 table
ascending). Ethernet sflow/flowcontrol/vrf and the Port-Channel members/mode/minimum-links/LACP family
ride DR-068 as field groups — members from the config relation by decision, the `all-ports` scrape as a
separate verb (**DR-075**); branch gate: **49 files / 1,556 client tests** (+82 specs), all-files
98.22 st / 93.0 br / 99.39 fn / 98.92 ln, `interfaces.ts` 99.48 / 98.11 / 100 / 100. **M10 is still
`in-progress`, not done:** the `68..9214` MTU-bound box and the 48-port fixture `getAll()` await the
M12 (#14) §3 capture, and M10d/Vxlan stays deferred to wave 3.

**M12a (#14, live suite + write policy) is delivered on its
branch** — §5 rows **135-142** + **DR-081-084**: four live suites (9 device-facing specs) that ran
against a real cEOS-lab 4.28.14M (readiness finding recorded in the band: the guard's EXACT-version
pin cannot match the image's engineering-build suffix, so the suites hard-fail every model/train
refusal and tolerate ONLY the suffix-driven mismatch, guard untouched), plus `src/testing/live-session-policy.ts`
closing DR-035's write side — named session, always-abort finally, persistence ban, no scratch port
inferred — with an offline MockTransport matrix. Branch gate: **50 files / 1,481 client tests**, all
files 98.14 st / 92.75 br / 99.35 fn / 98.83 ln; live files skip loudly offline. The lab run left its
container up for the orchestrator's teardown (verified zero leftovers afterwards) — flagged so the
next live-CI job never relies on manual cleanup.

**M12b (#14, CI + fixture-refresh plumbing) is delivered on its
branch** — §5 rows **143-149** + **DR-085-088**: `fixtures:refresh` as an explicit-consent, run-owned
chain (refuses BEFORE any docker call without confirmation, DR-085); the PR job's coverage step +
artefact upload; `scripts/dist-smoke.mjs` (dependency-free) plus a node-20 leg proving the artifact,
not the dev tooling (DR-087, closing ci.yml's own promise); and the never-yet-executed
`workflow_dispatch` cEOS live job with its per-endpoint lock and no-fake-green summary assertion
(DR-086/DR-088). Branch gate: **49 files / 1,474 client tests** — identical to the merged suite:
this lane adds NO unit tests (its diff is YAML + `.mjs` scripts, outside the unit coverage set); the
refusal paths were exercised by hand, and the live job's first CI run is itself a review item.

**M12c (#14, live tranche 2 — wave-1 fixture half) is delivered on this branch**: the capture catalog
becomes a reviewable `CAPTURE_CATALOG` (20 noted entries, §5 rows 184-188) and the lab was run for
real on 2026-11-06 (`runId lab-811108-5dcd01`): **16 committed captures**, the M12b nine re-captured
under a hardened redactor plus seven new — `show running-config` and `show running-config all` in
BOTH formats (the first device-backed config text for the M6/M9/M10 parsers), full `show interfaces`,
`show interfaces switchport` (settles the command-exists half of the DR-018/DR-029 open item: the
model answers, empty because the container has no L2 port), and `show port-channel 1 all-ports` (the
exact `getMembers` text). Credential scrubbing now also rewrites `cmds`-map KEYS collision-safely and
zeroes MAC-shaped values under `*mac*` keys at any depth (DR-104 — the old patterns would have
committed a real `$6$…` hash); every request rides the client's own `enable`-prepend framing because
bare `show running-config` answers 1002 on this image (DR-103); refusals stay negative results,
never files (DR-105). ~15 `test/system` method ports land in the two live suites (§5 row 189, every
method+line re-verified against the pinned `6816d9e` clone). Branch gate offline: **63 files /
2,040 client tests** — identical to merged main, this lane adds NO unit tests — with the 5 live files
(20 specs) skipping loudly via `--project live`, coverage green, zero lab leftovers verified
(`lab:down` + bare docker greps). Container evidence ≠ 7050TX evidence (DR-043), unchanged.

Wave-2 **lane A** is delivered on its branch (refs #16): `src/resources/users.ts` + `ntp.ts` with registry/Node wiring (rows 150-157, DR-089-091); gate 56 files / 1,799 tests, all five legs green; PR opens with merge-order note A-B-C-D. #35 #36 flip to status:ready-for-review at PR time; issues NOT closed until merge.


Wave-2 **lane C** is delivered on its branch (refs #16): `stp.ts` + `ipinterfaces.ts` with wiring (rows 167-174; DR-096/097 delivered, DR-098 declared skipped). The ledger pass corrected 20+ stale test_api_stp.py citations in stp.ts comments and REPORTED BRIEF-ASSERTED upstream bugs that DO NOT EXIST at 6816d9e (dict-leak, vrf-form gate, on-default, >367-line refs) - trust only row-content verified in-tree. Gate 56 / 1,825 green.

Wave-2 **lane D** is delivered on its branch (refs #16): `vrfs.ts`, `staticroute.ts`, `mlag.ts` (+wiring). rows 175-183, DR-099-102 (three-digit DRs land here for the first time - verified). Gate 57 / 1,802, coverage green. First dispatch of this lane returned a model error and wrote nothing; the retry authored everything incl. repairing a mid-file truncation (c3c6449-equivalent on this branch); mlag set_mlag_id deviation is rowed, read it before approving.

Wave-3 **lane A** is delivered on its branch (refs #17): `src/resources/ospf.ts` + `bgp.ts` with registry/Node wiring — `ospf` entity like `system`/`ntp`, `BgpNeighbors` as the entity's sub-collection, NOT a registry row (rows 191-202, DR-106-110); gate 65 files / 2,103 client tests, all five legs green; per the wave-3 negative-control protocol `ospf` flipped out of the `has()`/`hasResource()`/`registered:` exemplar slots to `vrrp` on this branch and `switchports.test.ts`'s `bgp` exemplar moved with it. PRs open with merge-order note A-B-C; #48 #49 flip to status:ready-for-review at PR time; issues NOT closed until merge.

Wave-3 **lane B** delivers on its branch (refs #17): `src/resources/routemaps.ts` (first TRIPLE-identity resource — name+action+seqno, DR-111) plus M10d `VxlanInterface` as the per-kind field group of `interfaces.ts`, closing the tranche #12 deferred (rows 203-212, DR-111-115). VXLAN is shipped pyeapi-faithful with ZERO support claims — 7050TX-64 VXLAN capability stays a probe/open-item question (DR-033: the honesty lives in a row + DR, not code comments). The branch PRE-STAGES lane A by merge (f10f660) so registry/wiring is already unioned in merge order; this tree's negative control stands at `vrrp` until lane C. PRs merge after A; #50 #52 flip to status:ready-for-review at PR time; issues NOT closed until merge.

Wave-3 **lane C** is delivered on its branch (refs #17): `src/resources/vrrp.ts` — pyeapi's largest unported module (1,493 LOC), `_vrrp_set` and the PLAN-named `vrconf_format` ported as part of the module's typed surface (rows 213-224, DR-116-121; branch coverage 87.43→**100** after the divergence-pinning round). Process note: this lane's round-2 dispatch returned a malformed tool blob leaving a WIP checkpoint (f05dbfb) whose spaced-track pin asserted the WRONG side; the follow-up settled it against upstream (`tid` triple `"%s   %s   %s"` at vrrp.py:1115 re-split by `re.match(r'(\S+)\s+(\S+)\s+(\S+)'` at :1148/:1164 — multi-word track names COLLAPSE, impl faithful, test fixed). The branch PRE-STAGES lanes A and B by merge (A→B at f10f660, stacked B→C at e8756e7): the combined tree is the final wave state — gate 67 files / 2,236 client tests + webui 3/8, all five legs green. Merge-order bookkeeping done during staging: every `registered:`/`names()` listing is the seventeen-row union, and the negative control is **`pim`** permanently (no pyeapi module; the `switchports.test.ts` exemplar was moved vrrp→pim because `vrrp` landed here). PRs merge after A and B; #51 flips to status:ready-for-review at PR time; issue NOT closed until merge.

**M11 (#13) is delivered on its branch** — the non-`runCmds` differentiators: `Node.verifyConfig()` /
`getCompletions()` / `getCommandHelp()` ride a validated `WIRE_METHODS` table over the new optional
`Transport#callMethod` seam, and faking them with `runCmds` is refused as unsafe, not inconvenient
(**DR-061**, §5 rows 115-117); `src/capabilities.ts` probes candidate commands in a throwaway named
config session with an abort guaranteed on every path and a seven-verdict taxonomy in which ONLY a
`1002` may ever say *unavailable* (**DR-062**, rows 118-121); `createCapabilityCache` keys answers by
endpoint + candidates + `batchSize` with a 15-minute TTL and never stores an inconclusive run
(**DR-063**, row 122). It claims §5 rows **115-122** + **DR-061-063** — the reservation from this
lane's merged note, and it FILLS the apparent 061-063 DECISIONS gap on purpose (reserved, never
skipped). Branch gate: **53 files / 1,647 client tests** (webui 3 / 8), coverage 97.85 st / 92.07 br /
98.84 fn / 98.63 ln, `capabilities.ts` 93.39 / 81.62 / 90.9 / 96.41 against the root-level gate.
Supersedes the `123-130` / `DR-070+` reserve sentence above: the open lanes' FINAL bands are M11 this
branch 115-122 / DR-061-063; M10b/c 125-132 / DR-075-080; M12a 135-142 / DR-081-084; M12b 143-149 /
DR-085-088; declared skips 123-124, 133-134, DR-070-074; safe merge order M11 -> M10b/c -> M12a -> M12b.

**Test infrastructure planning update:** local cEOS-lab **4.28.14M** and vendor install
instructions are now available under `/home/svaj/development/arista/cEOS/`.
Disposable cEOS is the preferred planned integration/live and browser E2E target;
see the [runbook](../../docs/CEOS.md) and DR-043. Provisioning, host compatibility and authenticated
eAPI readiness were **validated post-reboot on 2026-11-04** by this lane's harness (§5 row 112); the
hardware sweep below stays open whatever cEOS answers. Hardware remains
7050TX-64 / **4.28.13.1M**; its platform-specific sweep is still required.

---

## 1. Milestones

| ID | Milestone | Status | Started | Done | Issue | Blockers / notes |
|---|---|---|---|---|---|---|
| M0 | Workspace & package scaffolding | `done` | 2026-11-01 | 2026-11-01 | [#2](https://github.com/svaj/vibe-arista-webui/issues/2) | exit gate green from the repo root (typecheck/lint/test/build + webui imports by name, no path hacks); CI matrix is **22/24** because Vitest 5/jsdom 30 exclude Node 20. Package name still undecided (**DR-020**); `docs` script deferred (no generator chosen — M13 #15); placeholders only in `src/index.ts` / `src/node.ts` |
| M1 | Wire protocol core | `done` | 2026-11-01 | 2026-11-01 | [#3](https://github.com/svaj/vibe-arista-webui/issues/3) | codec in `src/internal/wire.ts` (pure, no I/O) + `src/errors.ts` + `src/types/eapi.ts`; DR-010/011/012/016/017 in; **27** hand-authored samples in `test/fixtures/wire/` driven by `src/internal/wire.fixture.test.ts` (message prose is synthetic until M12 #14 records captures); client coverage 98.98% stmts / 94.73% branch / 100% lines (thresholds 85/75/60); no transport yet, `WireSender` + `src/testing/fake-sender.ts` are the only send seam; no runtime `show()` yet — the type tests pin the `ShowReply<K>` map M4 (#6) implements it against; codec does not yet correlate the echoed response id with the request id, and `ProtocolError` does not carry an id — M2 (#4) decides both |
| M2 | Transports | `done` | 2026-11-01 | 2026-11-01 | [#4](https://github.com/svaj/vibe-arista-webui/issues/4) | all seven pyeapi transports ported (`src/transports/`), stacked on #19 for review; DR-002 browser-safety is enforced by `src/browser-safety.test.ts` in the unit project + CI — a **test** gate, not a literal step of `npm run build`; TLS behaviour is verified only against synthetic loopback certs, since the **device** fingerprint/TLS-version capture (STATUS §3, DECISIONS open items 3) is still outstanding |
| M3 | Connection profiles | `done` | 2026-11-03 | 2026-11-03 | [#5](https://github.com/svaj/vibe-arista-webui/issues/5) | merged as [PR #24](https://github.com/svaj/vibe-arista-webui/pull/24) on 2026-11-03 (`cbf37a4`): `src/profiles.ts`, `src/internal/{eapi-conf,conf-builder}.ts`, `src/node-profiles.ts`, the upstream `eapi.conf` fixtures and §5 rows 54-60 are on `main`, and `createNode()`/`createConnection()` are real. |
| M4 | `Node` command layer | `done` | 2026-11-01 | 2026-11-02 | [#6](https://github.com/svaj/vibe-arista-webui/issues/6) | merged as PR #22 on 2026-11-03, after stacking on #19/#20 for review. `src/command-layer.ts` (pyeapi's `Node` class; `src/node.ts` stays the Node-runtime **entry**, so the docs' old `src/node.ts` target is corrected in MIGRATION §1) + `src/internal/variants.ts`. In: `runCommands`, `exec` (one entry per command, `{command, result, encoding, fellBack}`, no duplicate `response` key — DR-007), `show`/`showText` over the augmentable `ShowContracts` map, `getConfig` + the async config accessors (DR-005), memoised `getVersion()`, `configure` / `configureVariants` (DR-006), `setEnablePassword` + the `sendEnable: false` priv-15 shortcut (DR-009), `refresh()`, `close()`, config-mode refusal (`NotSupportedError`, `configure all <intf> …` exempt), short-answer pairing that names the command by its `cmd`, and no `MULTILINE:` rewrite (DR-015). **8 new §5 rows (31–38).** Out on purpose: config-session verbs and the DR-025 guard/serialisation (M5 #7), `section()`/`_chunkify` (M6 #8), `api()` (dropped, DR-006), `configSection()`, profiles/`createNode` (M3 #5). Offline only: 75 cases over `MockTransport` + `test/fixtures/show/` (synthetic), no device, no cEOS; client 529 → **618** tests; coverage 96.98% stmts / 90.86% branch / 97.64% lines (`command-layer.ts` 100% stmts/funcs) |
| M5 | Config sessions & change safety | `done` | 2026-11-03 | 2026-11-03 | [#7](https://github.com/svaj/vibe-arista-webui/issues/7) | merged as [PR #25](https://github.com/svaj/vibe-arista-webui/pull/25) on 2026-11-03 (`67a1485`): `src/config-session.ts` (the DR-025 state machine, diff, commit/abort, orphan recovery, durability verbs) + `src/node-session-journal.ts` behind `./node`, §5 rows 61-70 and DR-047-050 are on `main`. |
| M6 | Text-config engine | `done` | 2026-11-02 | 2026-11-03 | [#8](https://github.com/svaj/vibe-arista-webui/issues/8) | merged as [PR #23](https://github.com/svaj/vibe-arista-webui/pull/23) on 2026-11-03 (`6426756`): `src/config/` (chunkify, section, cache, text) and §5 rows 41-53 are on `main`. |
| M7 | Resource framework | `done` | 2026-11-03 | 2026-11-03 | [#9](https://github.com/svaj/vibe-arista-webui/issues/9) | merged as [PR #26](https://github.com/svaj/vibe-arista-webui/pull/26) on 2026-11-03 (`a2785c7`): the `src/resources/` framework (entities, command builder, config-block parser, validators, registry) + §5 rows 71-82 and DR-051-054 are on `main`. PLAN's **"Entry point wiring"** bullet shipped with it: the framework re-exports from `src/index.ts` and reaches `./node` through `src/node.ts`, pinned by `src/index.test.ts`. Merged offline suite on `main`: **42 files / 1,086 tests**, coverage 97.66 st / 91.31 br / 99.15 fn / 98.49 ln. |
| M8 | `system` | `done` | 2026-11-03 | 2026-11-04 | [#10](https://github.com/svaj/vibe-arista-webui/issues/10) | the first wave-1 module on the M7 framework: `src/resources/system.ts` (hostname / `ip routing` / EOF-terminated banners) + 41 specs, the first `ResourceKinds` row + `RESOURCE_FACTORIES.system` + the first static accessor `node.system` (closing DR-006's deferred half), exports through both entries. **Merged as [PR #27](https://github.com/svaj/vibe-arista-webui/pull/27) on 2026-11-04 (`f77ed72`)** with §5 rows 83-90 and DR-055-057 on `main`. Branch gate: **43 files / 1,127 client tests** (+41 over merged `main`), coverage 97.75 st / 91.55 br / 99.19 fn / 98.54 ln. Every rule EOS could contradict ships labelled "client-side, unverified on hardware, M12 (#14) to capture" (DR-057). |
| M9 | `vlans` + `switchports` | `done` | 2026-11-03 | 2026-11-04 | [#11](https://github.com/svaj/vibe-arista-webui/issues/11) | `vlans` + `switchports` + two shared keyword extractors in `config-block.ts` (DR-058 settles the rows 49/81 gap at the keyword; `src/config/**` untouched). **Stacked on the M8 branch and merged as [PR #28](https://github.com/svaj/vibe-arista-webui/pull/28) on 2026-11-04 (`ec92f9d`)**, after #27. §5 rows 91-98, DR-058-060 are on `main`. Branch gate: **45 files / 1,228 client tests** (+101 over merged `main`: 45 vlans, 43 switchports, 13 extractors), coverage 98.02 st / 92.20 br / 99.30 fn / 98.71 ln; `config-block.ts` back to 100/100 as M7 shipped it. **Exit gate, honestly:** the client half (list VLANs, assign an access port, diff-before-commit *data*) is delivered; the **webui half is recorded as M13 (#15) consumption work** in the PR body, not claimed. PLAN's `trunk groups` capability-probe gate stays unticked with reason — M11 (#13) is unimplemented; the verbs ship, the capability claim waits for the probe. |
| M10 | `interfaces` (base, ethernet, port-channel) | `in-progress` | 2026-11-04 | — | [#12](https://github.com/svaj/vibe-arista-webui/issues/12) | needs M7 + M9; split M10a–c. **M10a landed** — the `Interfaces` facade + `BaseInterface` verbs + the hybrid read + the per-kind name parser: `src/resources/interfaces.ts`, `validators.ts`'s `INTERFACE_GRAMMAR` (**DR-067** replaces row 76's regex), §5 rows **99-106**, **DR-067-069**. Branch gate: **49 files / 1,474 client tests** (+113 over the merged suite), coverage 98.14 st / 92.66 br / 99.35 fn / 98.83 ln, `interfaces.ts` 100 % on all four, `src/resources/` 99.85 / 99.73 / 100 / 100. Open: M10b (`EthernetInterface`: sflow / flowcontrol / vrf) and M10c (`PortchannelInterface`: members / LACP) — PLAN's exit gate (LAG end-to-end) closes only with M10c; rows **123-130** + **DR-070+** stay reserved for them |
| M11 | Capability probe + dry-run | `not-started` | — | — | [#13](https://github.com/svaj/vibe-arista-webui/issues/13) | needs M5 + M9 |
| M12 | Live suite + fixtures + CI | `done` | 2026-11-03 | 2026-11-09 | [#14](https://github.com/svaj/vibe-arista-webui/issues/14) | **Partial delivery as [PR #29](https://github.com/svaj/vibe-arista-webui/pull/29)** — #14 stays open. Shipped: recorder seam at the transport with double-pass redaction + write/load leakage assertion (`src/testing/recording.ts`/`recorder-node.ts`, DR-064), the live-guard consent matrix with mutation-tested refusals incl. the 9 new non-lab-target cases (DR-065, §5 rows 110/111), the cEOS harness lifecycle (`scripts/ceos-lab*.mjs`, `lab:*` scripts, DR-066) verified end-to-end post-reboot incl. the TLS-pin cross-check, and the repo's first 9 REAL redacted cEOS captures with provenance envelopes (§5 row 113). M12a then shipped the four `*.live.test.ts` suites + write policy (PR #33, rows 135-142), M12b the `fixtures:refresh` chain and the (still UNEXECUTED) `workflow_dispatch` live job (PR #34, rows 143-149). **M12c** (this branch) extends the recorded catalog to the wave-1 half: 20-entry `CAPTURE_CATALOG`, **16 committed captures** incl. running-config both formats in both transports, hardened structural redaction, and ~15 `test/system` method ports (§5 rows 184-190, DR-103-105). **#62's configured-container batch then landed on this branch (2026-11-07):** `lab:up` now boots two data bridges so front-panel Ethernet ports actually exist (cEOS binds NICs at boot only), provisions a representative L2/L3 config through the staged-then-committed named session `lab-provision` (transcript error→line attribution, tolerated probes, `show vlan` apply-verification, abort on fatal) and leaves a zero-change `lab-pending-capture` session pending so `show configuration sessions` has a session to list; the catalog is now **31 entries** and `test/fixtures/live/ceos-4.28.14M/` holds **30 captures** — 14 new families (ip-access-lists, ip-interface-brief json+text, ip-route, ntp×2, port-channel-dense, configuration-sessions[+detail], spanning-tree[+detail], vrf, vrrp, port-channel-detail) and the empty-`interfaceStatuses`/`switchports`/`portChannels` rot is fixed on configured ports; `show lag`/`port-channel summary`/`access-lists` stay recorded negatives, and the sessions field set answers `maxOpenSessions: 5`/`maxSavedSessions: 1` **for the container only** (§5 row 225, **DR-122**). This host's docker 29.9.2 port-flakes on multi-endpoint cEOS containers, so the fixtures lane gained `--capture-via=auto|eapi|cli` — a Cli-exec collector that re-runs the identity guards and stamps `cliCapture`/transport in every envelope — **fixtures only**; DR-124/125 split later moved the switch captures into hardware-guarded live runners. **DR-128 then superseded the published-port requirement itself on this host (2026-11-08): after a WSL2 restart docker resolved the publish to the run's data1 bridge, so `up` runs its own literal-loopback byte relay + hands the live child the trust triple `EAPI_CA_FILE`+`EAPI_FINGERPRINT`+`EAPI_SERVER_NAME` (the cEOS cert has NO SAN); probe refusals self-attribute the broken hop.** **FIRST EXECUTED CORPUS same day (§5 row 230):** the full `*.live.test.ts` suite ran against the run-owned node — final CI-shape pass (run 12: `test:live -- --exclude 'src/hw-*.live.test.ts'`) **`Tests 249 passed (249)` / `Test Files 19 passed (19)`, exit 0, 202.9 s**, with `assert-live-run.mjs --min-passed 1 --check-secrets` exiting 0 on the teed log (the local `test:live` target adds the 2 hardware-runner skips, 251/249), after triaging 14 executed-run failures: two client reader bugs found by real writes (`vrrp` single-line `preempt delay minimum X reload Y` fold; `bgp` rendered `next-hop-self` sub-feature negatives voting the knob false) plus device-default-body re-pins across bgp (`maximum-paths 1 ecmp 128` pair materialisation + the max≤ecmp CLI refusal), vrrp (10-line default body incl. permanent `ipv4 0.0.0.0`), staticroute (rendered `tag 0`) and stp (upstream's edge arm re-types itself to `auto`; new permanent grammar pin), and a fixture hygiene fix (committed named sessions cannot be re-entered → unique session names). **Still owed on #14:** the trusted CI live job on a registered `[self-hosted, linux, eos-lab]` runner + `workflow_dispatch` (the job's child command shape is now PROVEN by an executed log; it has simply never been dispatched), and EVERYTHING §3's hardware sweep asks. Container evidence ≠ 7050TX evidence (DR-043) — unchanged and enforced in file metadata. **M12 CLOSED 2026-11-09 — all seven #14 boxes verified** (per-box evidence in the issue's close-out comment). The "everything §3 asks" sentence above is now history: the sweep RAN, 2026-11-07→09, probe runs 1-6 on the 7050TX-64-R over PRs #110-#115 — **61 hardware captures** (40 JSON + 4 text inventory, 17 reviewed probe batches), open item 4's verb half, the session-name REUSE boundary (DR-136: the one completed-session slot rotates; a reverted timer commit frees its name), VRRP modern-vs-legacy settled (DR-136/DR-137), and the `commit timer` question answered end-to-end (DR-137: armed `pendingCommitTimer` with uptime-clock `commitBy`, no eAPI block, no startup persistence, revert fires unattended and session-scoped). **Run 6 closed CLEAN and NET-ZERO** — Ethernet22's stanza is back empty, proven from the restore recording rather than the console (the run-5 lesson). The deliberately-deferred families (second-`commit`-confirm pair, name-shape/charset boundary, quote depth, `no-commit`, bare `show session-config`) stay unasked BY DESIGN and are named in §3's close-out blockquote. Same day, the cEOS capture catalog was regenerated by the named script — `lab-1637825-9bbb4b`, 30/30 files in place (row 239, **DR-138**; this host's WSL2 mirrored stack owns the pinned mgmt /24, so refreshes ride the DR-123 named fallback with per-envelope provenance). What remains is not owed to #14: the trusted `ceos-live` CI job stays wired-until-dispatched by design — dispatching it on the registered lab runner is an operator act, and box 7's shipped contract (dispatch-only, labelled runner, per-endpoint concurrency, zero stored secrets) holds. |
| M13 | Consumption, docs, release | `in-progress` | 2026-11-07 | — | [#15](https://github.com/svaj/vibe-arista-webui/issues/15) | **PR #56** delivered the webui half of the proxy wiring box (DR-036) plus the reviewable VLAN-assignment screen. **This lane** publishes the screen `show` contracts: `arista-webui/src/eapi/show-contracts.ts` augments `ShowContracts` with `version` / `'interfaces status'` / `vlan` / `mlag` from recorded captures (pins in `show-contracts.test.ts`), and `SwitchManager` now renders a typed `show version` identity chip. `lag` held until a capture exists (STATUS §3). **E-wrap 2026-11-08 (row 229, DR-127):** the docs-test box is live (`docs:check` + unit-project fence compilation; drift from its first run fixed in-repo), `CHANGELOG.md` + **0.1.0** + local `v0.1.0` tag executed per DR-040, and DR-020 is closed (scoped name kept, publish still off). Board stays `in-progress` on exactly two deferred items: the cEOS Playwright lane (moved to #91, webui scope) and the `lag` contract (waits on the #14 §3 hardware capture). |
| W2 | wave-2 modules | `backlog` | — | — | [#16](https://github.com/svaj/vibe-arista-webui/issues/16) | 9 modules, **139** upstream unit tests (users 22, acl 32, stp 21, mlag 7, varp 17, ipinterfaces 11, vrfs 10, staticroute 8, ntp 11 — AST count, superseding the stale 186/111 figures in older notes); needs M10 |
| W3 | wave-3 modules | `backlog` | — | — | [#17](https://github.com/svaj/vibe-arista-webui/issues/17) | 4 upstream test files, **78** methods (vrrp 23, bgp 22, routemaps 18, ospf 15); VXLAN deferred (the 7050TX-64 capability is unverified — open item) |

Status vocabulary: `not-started` · `in-progress` · `blocked:<reason>` · `done` · `backlog` ·
`dropped:<reason>`.

---

## 2. Module parity board

Parity = "all pyeapi verbs exist, generate the same commands, and the ported unit tests pass".

| Module | pyeapi LOC | upstream unit tests | planned ours | parity | fixtures recorded | live suite |
|---|---|---|---|---|---|---|
| `system` | 186 | 5 | 12 → **41 landed** (M8, #10) | `complete (offline)` — all 5 upstream methods ported with their command texts verbatim; the divergences are owned at §5 rows 83-90 | none yet — M12 (#14) owns any capture; unit evidence only | ✅ `live-system.live.test.ts (reads + 7 DR-126 full-write cases incl. the set_* flip)` |
| `vlans` | 372 | 15 | 22 → **45 landed** (M9, #11) | `complete (offline)` — all 15 ported, command texts verbatim; malformed-value *answers* deliberately not ported (DR-059); ranged headers fan out (row 96) | none yet — M12 (#14) | ✅ `live-vlans.live.test.ts (2 reads + 13 write arms on EAPI_SCRATCH_VLAN)` |
| `switchports` | 417 | 21 | 26 → **43 landed** (M9, #11) | `complete (offline)` — all 21 ported verbatim incl. the `allowed vlan 1,2,3-5,6,7` pin; divergence rows 91/94-98; DR-029 closed at the key (row 96) | none yet — M12 (#14); `show interfaces switchport` json model blocked on open item 4 | ✅ `live-switchports.live.test.ts (reads + scratch-port write cycles)` |
| `interfaces` | 1,101 | 72 | ~75 → **113 landed** in the M10a slice (#12) | `partial (offline)` — M10a's half (`Interfaces`, `BaseInterface`, `isvalidinterface`: upstream `test_api_interfaces.py:48-171`, `:186-224`) ported with its command texts verbatim and the divergences at §5 rows 99-106; `EthernetInterface` (upstream `:174+`), `PortchannelInterface` (`:305+`) and `VxlanInterface` (`:429+`) are M10b/M10c/M10d | the `show interfaces status` JSON this client reads is the cEOS-lab recording (row 106, DR-069); PLAN's 48-port 4.28 config fixture and any hardware capture stay M12 (#14) | ✅ `live-interfaces.live.test.ts (M10a slice + 8 PortChannel DR-126 arms; Vxlan writes NOT ported — DR-115 lab-only rule stands)` |
| `users` | 328 | 22 | ~28 | — | — | ✅ `live-users.live.test.ts (13)` |
| `acl` | 303 | 32 | ~35 | — | — | ✅ `live-acl.live.test.ts (20)` |
| `stp` | 367 | 21 | ~24 | — | — | ✅ `live-stp.live.test.ts (13)` |
| `mlag` | 302 | 7 | ~15 | — | — | ✅ `src/live-mlag.live.test.ts: single-node shape reads only; all 20 write methods ledger-refused per the #64/#84 domain rule (physical pair still owed)` |
| `varp` | 213 | 17 | ~20 | — | — | ✅ `live-varp.live.test.ts (15; Vlan2001 SVI block it owns)` |
| `ipinterfaces` | 268 | 11 | ~14 | — | — | ✅ `live-ipinterfaces.live.test.ts (9; +SVI arms on Vlan2001/2002)` |
| `vrfs` | 343 | 10 | ~16 | — | — | ✅ `live-vrfs.live.test.ts (14)` |
| `staticroute` | 384 | 8 | ~18 | — | — | ✅ `live-staticroute.live.test.ts (7; TEST-NET-1 space, ip-routing probe per DR-122)` |
| `ntp` | 208 | 11 | ~14 | — | — | ✅ `live-ntp.live.test.ts (11)` |
| `ospf` | 362 | 15 | ~20 | — | — | ✅ `live-ospf.live.test.ts (11)` |
| `bgp` | 341 | 22 | ~28 | — | — | ✅ `live-bgp.live.test.ts (22 — ported from the UNIT corpus: upstream has no test/system/test_api_bgp.py, §6)` |
| `routemaps` | 357 | 18 | ~22 | — | — | ✅ `live-routemaps.live.test.ts (19)` |
| `vrrp` | 1,493 | 23 | ~40 | — | — | ✅ `live-vrrp.live.test.ts (20; eAPI-1002 read arms report the recorded negative, DR-122)` |
| *(framework)* | 224+304 | 10 loose upstream checks, none of them a spec: `abstract.py` has **no** suite (no `test/unit/test_abstract.py` in the clone), and the only upstream assertions touching framework behaviour are `test_api_autoloader` (`test_client.py:210-212`, asserts only non-`None`), 4 `test_make_iterable_*` (`test_utils.py:23-41`, none asserting a copy), 3 `isvlan` + 2 `isvalidinterface` (`test_api_vlans.py:51-58`, `test_api_interfaces.py:50-58`); **nothing** upstream calls `Node.section` or `get_block` | ~66 → **139 landed** (M7, #9) | `complete (offline)` — the framework itself (verbs, builders, registry, validators, `toArray`, the `Node` config reads) is shipped, pinned, re-exported from both package entries (PR #26), and has its **first consumer**: M8's `system` (#10) landed inside the measured 19-line entity plumbing budget | n/a | n/a |

Upstream totals for reference: **436 unit** test methods, **284 system** test methods, ~9.0 k LOC of
source (pyeapi 1.0.4-rc0).

---

## 3. Device sweep — the one job that unblocks several milestones

> **2026-11-08 (hardware lane, DR-124/DR-125).** The 7050TX-64 half of this sweep finally has an
> addressing path: `live-guard.ts` gained a **hardware** class (no default host/port, https-only,
> exact `DCS-7050TX-64`/`4.28.13.1M` pins, `EAPI_HW_CONSENT` model echo, device self-report still
> decides), and `src/hw-inventory.live.test.ts` + `src/hw-session-probe.live.test.ts` execute the
> read-only batch and the reviewed session probes, writing scrubbed evidence under
> `test/fixtures/recordings/7050tx-64-4.28.13.1M/` (operator runbook: [HARDWARE-CAPTURE.md](./HARDWARE-CAPTURE.md)).
> **The lane is built, not run** — zero switch bytes are committed, and none of the boxes below
> changes state until the supervised session happens.

> **2026-11-08 (first supervised attempts, DR-131/DR-132).** The lane was addressed twice and **still
> captured nothing** — which is the guard doing its job. (1) With every env gate satisfied, the unit
> answered `show version` with `modelName "DCS-7050TX-64-R"` and `EAPI_MODEL_MISMATCH` refused the run:
> the pin set is now the exact pair `DCS-7050TX-64` / `DCS-7050TX-64-R` (open item 1's spelling half —
> this box and the recorded fixture stay open, and evidence for this unit lands under
> `recordings/7050tx-64-r-4.28.13.1M/`). The unit's `version` answered `4.28.13.1M`, so the image pin
> below is confirmed. (2) The eAPI certificate is `CN=self.signed` with **no extensions/SAN**, so a
> hardware run needs `EAPI_CA_FILE` + `EAPI_FINGERPRINT` + `EAPI_SERVER_NAME` — the pin is not a trust
> anchor and does not waive the name check (`transports/node-tls.ts`). (3) The runbook's unscoped
> `npm run test:live` staged real lines on the scratch port from the **lab** corpus
> (`switchport mode trunk` / trunk allowed+native / `default interface`), so the lab lane's scratch gate
> now refuses the hardware class (`EAPI_HARDWARE_WRITE_FENCE`, DR-132); batch 1 runs one file. Nothing in
> this paragraph checks a box: it records what the first attempts proved about the lane, and the
> read-only sweep still has to happen on a pinned run.

> **2026-11-08, later (batch 1 EXECUTED — DR-133).** The scope fix + `-R` pin landed (PR #109) and
> `hw-inventory` ran: **44 recordings under `recordings/7050tx-64-r-4.28.13.1M/`, 9 device negatives
> recorded-as-answers** (`show systems`, `show environment {,temperature,cooling,last}`,
> `show hardware tcam[ profile]`, `show lag resources`, `show port-channel detail` → `invalid command`
> on this unit; `show startup-config` answered **`unconverted command` in JSON form** and the
> text-form re-read produced the file — a DR-042-class json/text split, first seen on hardware). Pre-commit
> review then caught the DR-133 redaction miss (a live `secret sha512 $6$…` hash survives as a running-config
> **key**; the mgmt IP sat in all 44 `identity.endpoint` envelopes); the scrubber now walks keys and the
> envelope, the 44 files were regenerated from the original bytes through the fixed code, and
> `recorder-node.test.ts` text-scans every committed recording for credential residue on every `npm test`.
> Device facts worth naming: `tlsProtocol: ["1.0","1.1","1.2"]` (open item 3 — the image's "stale-looking"
> TLS default is EXACTLY what this unit answers), listener shape `management api http-commands` on 443
> with http/localhost/unix servers off, license tables report **zero optional features** (`active: []`,
> `missing: []`, `features: {}`), baseline `show configuration sessions` = `sessions: {}`,
> `maxOpenSessions: 5` / `maxSavedSessions: 1` — hardware agrees with the cEOS field set — while the
> `detail` form listed the earlier committed lab-lane session `m12a-intf-clear-Ethernet22`
> (`state: completed`, `completedTime` present: the device keeps finished sessions up to the save cap;
> the `m12c-sp-*` name from the refused run never reached the device at all). And the switchport capture
> keys several ports as **`Ethernet52/1` / `Ethernet52/3`-style split names — the `EAPI_SCRATCH_INTERFACE`/
> `assertInterfaceName` all-digit grammar would REJECT ports this device reports as real interfaces
> (open item 7 now has device evidence; M10's parser must widen to the discriminated union accordingly).

> **2026-11-08, later (session probes EXECUTED — run 2, DR-134 then DR-135).** Eight of the eleven
> reviewed batches reached the box and **7 probe recordings landed** under
> `recordings/7050tx-64-r-4.28.13.1M/configure-session-*--hw-session-probe.json`. Device answers
> captured: inside a named session the SKU stages `switchport` + `switchport mode trunk`,
> `no switchport` + `ip address …/31` (L2→routed conversion works in a session),
> `switchport trunk group HWGRP` (**open item 4's verb half: trunk groups exist on this unit**), and
> `channel-group 999 mode active` — whose diff also shows the device creating the implicit
> `interface Port-Channel999` block. Refused, recorded as the answer: `switchport trunk allowed vlan
> only 10,20` → `Invalid input (at token 4: 'only')` (the bare spelling commits — DR-042's class on
> hardware), and `vlan 4090 name X` → `Invalid input (at token 2: 'name')`, so the inline
> `vlan <id> name` one-liner is NOT this box's grammar and the VLAN/SVI/VRRP/`ip routing` questions
> behind it were never asked (that batch is what rev 3 splits into five one-question batches).
> Named-session grammar answered as a side effect: every batch opened
> `configure session hw-probe-<name> description "…"` with feature-text in the description and the
> device accepted it, and `show configuration sessions detail` shows `state/commitUser/completedTime`
> with `maxOpenSessions: 5` / `maxSavedSessions: 1` — the same field set the container answers.
> **The run also exposed a harness bug that cost the day (DR-135):** after `scratch-description`
> COMMITTED, the runner's own read-back used the singular `show running-config interface …`; the box
> answers `1002 % Incomplete token (at token 2: 'interface')` (the plural `show running-config
> interfaces <intf>` is what it takes, and what Arista's own system suite writes). That throw happened
> one statement after a successful write, so the batch's recording was lost, the restore set never
> ran, and **the switch currently carries `description HW-CAPTURE-PROBE` on Ethernet22** — the first
> resumed command is `EAPI_HW_PROBE_ONLY=scratch-restore`. Post-batch reads are now refuse-and-log, the
> spelling lives in `hwScratchReadBackCommand()`, and `EAPI_HW_PROBE_ONLY` makes a stopped day
> resumable. No box below flips from run 2 alone: the commit set and the session-grammar family
> (items 5/7/8) still have to complete on the box.

> **2026-11-08, run 4 (PR #112 code, spec rev 3, DR-136).** Eleven batches answered; this commit carries
> **11 probe recordings** (six refreshed from the earlier probe run plus five new single-question batches:
> `vlan-inline-name`, `vlan-block-form`, `vlan-interface-ip`, `vlan-interface-vrrp`, `ip-routing`) and removes
> the run-2 `vlans-vrrp-iprouting` file, whose batch the split replaced — its one useful answer (`vlan 4090
> name X` refused at token `name`) survives as `vlan-inline-name`, so no evidence is lost by the rename. Device
> answers: the `vlan 4090` **block** form with an indented `name` stages (the one-line `vlan 4090 name X`
> does not); a **dangling SVI** stages inside a session (`interface Vlan4090` + `ip address` while
> VLAN 4090 existed only in that same staged set); `ip routing` stages, and its diff showed `+ip routing`
> replacing **`no ip routing`**, i.e. routing is OFF on this switch today; `switchport trunk group HWGRP`
> staged again; and `vrrp 1 ip <addr>` was refused with the answer this client cares about most:
> `Unavailable command (This command is deprecated by 'vrrp ipv4') (at token 2: 'ip')` — the box names the
> modern arm that `src/resources/vrrp.ts:618` already composes on `>= 4.21.3`, so the hardware sentence for
> §3's VRRP line is "modern spelling or nothing", and rev 4 asks that spelling in
> `vlan-interface-vrrp-ipv4`. The run then stopped at `scratch-description` for a **new** reason: the box
> refused to re-open that name, because run 2's commit parked it in the single completed-session slot
> (`maxSavedSessions: 1`, and `show configuration sessions detail` still showed it `state: completed`) — a
> config-session name is a one-slot resource for the name's owner, not a free identifier. The harness made
> it worse: the refusal path called `abort()` on the handle the model had marked `lost`, this client's own
> DR-023 `SessionError` escaped, and the restore set was skipped a second time (so **Ethernet22 still
> carries `description HW-CAPTURE-PROBE`**). Fixed in DR-136: `hwProbeSessionName`/`hwProbeRetrySessionName`
> (canonical name refused → recorded as evidence → batch retried under a run-scoped name, one recording per
> batch either way), `closeHandle()` aborts only a live handle and never lets a refused abort end the run,
> and refusal text is no longer truncated mid-token. §3's `commit timer` question moved into this lane with
> the `commit-timer` batch (`commitWithRevertTimer`), armed through the client's own timed-commit verb and
> fenced to the scratch port; the `commit <intf> verify`/`revert <intf>` arm stays unasked until that
> first answer lands, because composing it from an unread signature is what DR-135 cost a day over.

> **2026-11-08, run 5 (PR #113 merged as `4b8b5ca`, spec rev 4, DR-137).** The first pass where **all 17
> batches reached the switch**: every batch produced a recorded answer, four committed, and DR-136's retry
> proved itself — `hw-probe-scratch-description` refused its opener with the reason now on record verbatim
> (`Cannot enter session hw-probe-scratch-description (already completed)`, inside `Error [1000]`), and the
> batch committed seconds later as `hw-probe-scratch-description-mw8pujyw`. The revert timer answered
> end-to-end (`configure-session-commit-timer--hw-session-probe.json`): `commit timer 00:02:00` ACCEPTED;
> the armed session lists on the **plain** table as `state: "pendingCommitTimer"` with its deadline in
> `commitBy` (uptime clock) + `completedTime` (epoch); a second `configure session` OPENED normally while
> the timer armed (eAPI — REV 4 expected a refusal, the box corrected us); the staged marker never reached
> `show startup-config`; and past the deadline the revert fired on its own, restoring exactly that
> session's own diff — after which the entry was gone from BOTH listing forms, i.e. a revert frees the
> one completed-name slot (parking is plain-commits-only, and the store rotates on each new commit — run 5's
> later canonical openers all opened cleanly). `vrrp 1 ipv4 <addr>` was ACCEPTED (staged + diffed on a
> dangling SVI, then aborted — §3's VRRP line closes as legacy-refused / modern-accepted, matching
> `resources/vrrp.ts`). My rev 3/4 restore batch's `switchport mode auto` line WAS refused (1002 token 2:
> `auto`) — invented tokens again — so the restore skipped its commit a third day and **the scratch port
> still carries `description HW-CAPTURE-PROBE` + `mtu 9214`**. Spec rev 5 makes the restore exactly
> `no description` + `no mtu` (the two lines the box itself staged cleanly in that refused session, and the
> exact inverse of everything actually committed), with pins so invented-restore lines can never return. Two
> harness bugs surfaced because THE RECORDINGS CONTRADICTED THE PRINTS: the summary crashed an otherwise
> complete 17/17 run by interpolating a placeholder into `hwProbeRetrySessionName('<batch>', …)`, and every
> post-commit read-back print lied (`node.exec` items wrap replies under `result`, and the composed
> `enable` gets its own item) — now `hwReadBackOutput`, exported and pinned. **Run 6: the FULL spec**
> (completed-session slot empty, every canonical opener free; the rev-5 restore runs last and returns the
> port to the empty pre-probe stanza the run-1 inventory captured; expect ~4 min inside `commit-timer`).

> **2026-11-09, run 6 (main at `548f594` = #114 merged, spec rev 5): the first CLEAN pass — 17/17 batches,
> 5 commits, 0 opener refusals, 100% green, `DONE` printed.** The run card above executed exactly as
> planned and the read-back prints (now honest — `hwReadBackOutput`) agree with the captures for the first
> time: commit batches returned `scratch block 3 line(s); markers still on the port: HW-CAPTURE-PROBE /
> HWPROBE-TIMER`, and after `scratch-restore` committed, the port block read **1 line — a bare
> `interface Ethernet22`**: the two lines the probe lane owed since run 2 are gone, and that is
> recording-verified (the restore session's diff removed exactly `description HW-CAPTURE-PROBE` +
> `mtu 9214`), not inferred from the console like the run-5 lesson demanded. §3's device sweep on this
> box is therefore DONE except the deliberately-deferred families. New answers run 6 added: a **0-line
> (no-op) commit is ACCEPTED** — `scratch-description`, `scratch-mtu` and `scratch-switchport-restore-order`
> re-staged values the port already carried (run 5 left them), diffed 0 lines, and committed anyway,
> parking their names like any commit (`configure-session-scratch-description--hw-session-probe.json`
> embeds the 0-line diff plus the `state: completed` entry); DR-137's rotation reconfirmed (each later
> canonical opener worked because the fresh commit displaced the last saved entry); commit-timer reproduced
> end-to-end (same `pendingCommitTimer`, `commitBy` 743985 vs run 5's 704038 on the uptime clock — the
> ~11 h gap matches the two wall-clock runs almost exactly, which corroborates the uptime reading); the
> `commit-timer` block-check refused nothing again. **Switch state now:** Ethernet22's stanza is EMPTY
> (net-zero debt paid), `no ip routing` remains the saved state, no pending sessions, and the single
> completed-session slot holds **`hw-probe-scratch-restore`** — the last plain commit — so the next
> scratch run's `scratch-restore` opener will refuse once and retry under the run tag. Remaining device
> §3 asks (all deferred-by-design): the second-`commit`-confirms-or-resets half of item 5 (needs the
> `commit <intf> verify`/`revert <intf>` pair, which this repo still refuses to compose unread), the
> longest-name/charset session boundary and description quote-depth + `no-commit` (items 7/8 — adversarial
> names/descriptions do not belong on the one-scratch-port licence), and the bare `show session-config`
> form (still missing). A further full run is optional from here: the sweep's open lines cannot be
> answered by re-running rev 5.

Run the software/schema subset against cEOS first and store captures under
`test/fixtures/recordings/ceos-4.28.14M/`; repeat target-sensitive checks on the
7050TX-64 under `recordings/7050tx-64-4.28.13.1M/`. Keep exact version/model metadata,
redact recordings, and never use container output to settle physical licensing, TCAM,
LAG limits, or hardware feature support. This feeds M6 fixtures and
[DECISIONS.md open items](./DECISIONS.md#open-items-need-the-device).
All discovery below is read-only **except the final scratch-session experiment**,
which needs explicit authorization on hardware and unconditional cleanup.

> **2026-11-04 (M12, PR #29).** The *read-only discovery batch on cEOS* now runs for real and is
> captured: `scripts/ceos-lab.mjs` provisions run-scoped, guards target-class/lab, polls EOS (not
> Docker) readiness, cross-checks the TLS pin endpoint-vs-container, and records nine redacted
> captures with the identity+redaction envelope of §5 rows 108/113 under
> `arista-api-client/test/fixtures/live/ceos-4.28.14M/` (`show version[+text]`,
> `interfaces status[+text]`, `vlan`, `mlag`, `lldp neighbors`, `management api
> http-commands[+text]` — covering the listener/version half of the third bullet below **for the
> container only**). None of that checks a box here: every line under this section asks the
> 7050TX-64, and DR-043 is enforced inside each file (`hardwareEvidence:"none"`). The write-cycle
> cases and the `test/system/*` port also stay open with #14.

> **2026-11-07 (#62).** The cEOS-side *fixture* prerequisites this sweep leans on are now in:
> the configured-container re-capture (run `lab-1899774-8d6173`, §5 row 225, DR-122) recorded 14 new
> command families and repaired the empty-model rot. Two sentences here now have a cEOS half worth
> naming — `show interfaces switchport json` answers populated groups for a configured port on the
> container, and `show configuration sessions` reports `maxOpenSessions`/`maxSavedSessions` with no
> start-time key in a listed session — but **no box below changes state**: every line asks the
> 7050TX-64, and container answers never settle one (DR-043). Capture mechanics (provisioning,
> pending-session trick, `--capture-via` transport fallback per DR-123) live in
> [scripts/ceos-lab.mjs](../../scripts/ceos-lab.mjs) and docs/CEOS.md.

- [x] `show version` → exact `modelName`, `version`, `serialNum`, image — **captured on the `-R` unit**
      (2026-11-08, `show-version[+detail]--hw-inventory(-text)`: `modelName DCS-7050TX-64-R`,
      `version 4.28.13.1M`, `internalVersion 4.28.13.1M-41622611.428131M`; serial present but
      `<hw-redacted-serial>` per the lane's asset policy — the field set and format are the evidence,
      the number deliberately is not) — DR-131/DR-133
- [x] `show license features` · `show license all` → which features are licensed (VXLAN/VRF/MLAG) —
      **captured**; this unit reports **no optional features at all** (`active: []`, `missing: []`,
      `features: {}`): nothing licensable is installed, which leans open item 2 toward "Vxlan never
      on this unit" — the config-level probe (a `vxlan interface` attempt in the §3 scratch session)
      is what closes the sentence
- [x] `show management api http-commands` · `… https certificate` → listeners, TLS versions, cert to pin —
      **captured**: `tlsProtocol: ["1.0","1.1","1.2"]` (the `HttpServiceConstants` default is confirmed
      live, not stale on this unit), https server on 443 running / http / localhost / unix servers
      `running: false, configured: false` (the DR-036 config style on this switch is
      `management api http-commands`), the certificate read returns the PEM (redacted at write —
      fingerprint pinning rides `EAPI_FINGERPRINT`, §3 TLS note above)
- [x] `show configuration sessions` → baseline orphan state before any test writes — **captured**:
      `sessions: {}` (clean — the refused run's name never reached the device), `maxOpenSessions: 5`,
      `maxSavedSessions: 1`; the `detail` form adds `state/commitUser/completedTime` and keeps completed
      sessions visible up to the cap
- [x] `show interface switchport`-equivalent / `show interfaces <Eth1> switchport` → DR-028/DR-029 shape
      — **captured** 2026-11-08 (`show-interfaces-switchport--hw-inventory`: 66-port `switchports` map,
      per-port `{enabled, switchportInfo}` — the DR-029 read shape on real hardware; the global form is
      what the catalog runs, and it answers per-port records inside it. Open item 4's `trunk group`
      support sentence moves to the §4 probe batch, since no configured group exists to read.)
- [ ] `show hardware tcam profile` / `show system profile`-family → replace the 7050X/FlexProfile
      assumptions in [`docs/features.md`](../../docs/features.md) — **answered as negatives on 11-08:**
      `show hardware tcam`, `show hardware tcam profile` and `show systems` are `invalid command` on
      this unit (`hw-inventory` recorded them); `show version --detail` answered and carries the
      hardware block, so the replacement matrix must be re-derived from the SKU page plus that
      capture — the ALE `hardware tcam` spelling from the image notes does NOT exist on this box
- [ ] `show lag resources` → real LAG member limits (features.md row is 7050X-derived) — **answered
      as a negative on 11-08:** `show lag resources` is `invalid command` on this unit (recorded);
      `show port-channel detail` likewise, while `show port-channel dense` captured — the member-limit
      row must come from the SKU datasheet, not this command
- [ ] `show session-config diffs` behaviour inside a scratch session + `commit timer` confirm semantics
      **(diffs half captured on the box 2026-11-08: every `hw-session-probe` case file embeds a
      replayable `show session-config diffs` exchange — a staged no-op answers a 0-line diff, and the
      accepted lines show up as `+` lines including the implicit `interface Port-Channel999` block that
      `channel-group 999 mode active` creates; refused lines appear in NO diff, which is how the `only`
      and inline-`vlan name` refusals were proven to have staged nothing. `commit timer` was ANSWERED by
      run 5's `commit-timer` recording (DR-137): armed state `pendingCommitTimer` with `commitBy` on the
      box's uptime clock, no eAPI block on a second session, no `startup-config` persistence, and a
      session-scoped revert that fires unattended. Only the second-`commit`-confirms-or-resets half stays
      unasked by design.)**
- [ ] `configure session <name>` boundaries: the longest accepted name and the character set (our
      `MAX_SESSION_NAME_LENGTH` and refusals are **this port's** bounds, not a captured device limit)
      → open item 7
      **(new device limit 2026-11-08, and it is about REUSE not shape: the box keeps ONE completed session
      (`maxSavedSessions: 1`) and re-opening the exact name that committed into it was refused — run 5 put
      the reason verbatim on record (`Cannot enter session hw-probe-scratch-description (already
      completed)`, inside `Error [1000] … could not run command`) while a fresh (run-tagged) name was
      accepted seconds later. The store is a ROTATING one-slot window: a later commit displaces the prior
      completed entry (run 5's other canonical openers all opened cleanly for that reason), and a
      revert-auto-fired entry removes itself and frees its name (DR-136 + DR-137; the probe lane retries
      under `hw-probe-<name>-<run tag>` because of it). Longest-accepted-name and charset boundaries are still
      uncaptured on purpose: answering them means committing an adversarially-named session, which one
      designated scratch interface does not license.)**
- [ ] `configure session <name> description "…"` quoting depth (embedded `"`, `#`, `;`, backslash), and
      whether `no-commit` is accepted or answered `1002` on the 7050TX-64 → open item 8
      **(half answered 2026-11-08, and the earlier cautious sentence here was wrong: the plain form DOES
      round-trip. Every batch opened `configure session hw-probe-<name> description "<free text with / + :
      spaces>"`, and the completed entry read back from `show configuration sessions detail` as
      `"commit round-trip on the designated scratch port: descri"` — quotes preserved, i.e. the device stores
      the CLI token as `quoteDescription` sent it, which is the behavior that family of tests assumes.
      Still owed: an embedded `"`/`#`/`;`/backslash inside the description, and `no-commit`. Neither is
      probed by the scratch-session spec: probing quote depth means committing a session whose name or
      description is adversarial, which "one designated scratch interface" does not license.)**
- [ ] which of `copy running-config startup-config`, `rollback clean-config [ { groups } ]`,
      `rollback <name>` and `configure replace <url>` answer `1002`/`1004` per platform (cEOS first, then
      target — the class of gap DR-042 warns about)
- [ ] `commit timer` behaviour: does a held timer block a later session, and does a second `commit` before
      the deadline confirm or reset the revert? (the handler is native below the image's Python; never
      inspected here) → open item 5
      **(moved into the probe lane 2026-11-08, DR-136: a timer is armed only by a COMMIT, so the question
      belongs to the lane that may commit the scratch port. The reviewed spec's `commit-timer` batch arms it
      through this client's own `ConfigSession#commitWithRevertTimer` (`config-session.ts:856`) and then reads
      the session table, asks whether the armed timer blocks a second `configure session`, reads
      `show startup-config` for the staged marker (DR-035(c)'s persistence question, asked rather than
      assumed) and sits out the deadline to re-read the port. **ANSWERED by run 5**
      (`configure-session-commit-timer--hw-session-probe.json`, DR-137): the SKU arms the timer
      (`state: "pendingCommitTimer"`, deadline `commitBy` on an uptime clock), a second `configure session`
      is NOT refused over eAPI while it runs, the change lives in running-config but never in
      `show startup-config`, and the revert fires unattended — the entry then disappears from both session
      listings, freeing its name slot. Still unasked on purpose: whether a second `commit` before the
      deadline confirms or resets the revert. The `commit <intf> verify` / `revert <intf>`
      confirm-and-cancel pair is deliberately unasked: this repo has never composed that pair for a device,
      and DR-135 is what an invented spelling on this box costs.)**
- [x] `show configuration sessions` / `show configuration sessions detail` captured verbatim: confirm the
      field set `ConfigSessionSummary` models, whether `maxOpenSessions`/`maxSavedSessions` are present, and
      whether any start-time field exists (`recoverOrphans({ olderThan })` depends on the journal until it
      does) → §5 row 70 — **captured on the box 2026-11-08** (`show-configuration-sessions--hw-inventory.json`,
      `show-configuration-sessions-detail--hw-inventory.json`, and the post-state read of every probe batch):
      `maxOpenSessions: 5` / `maxSavedSessions: 1`, entries carry
      `instances/state/commitUser/description/completedTime` and **no start-time key** — so `olderThan` keeps
      depending on the journal here too — and the two forms differ in a way the model must respect:
      the plain form answers `sessions: {}` while a completed session is still listed by `detail`.
      The field set itself matches the cEOS answer (DR-122), which is a comparison, not a container settling
      it: the caps happen to agree at 5/1 on this unit.
- [ ] `show session-config` and `show session-config diffs` as **recorded fixtures**: neither has one today
      — `diff()` is pinned only by the mock pair in `config-session.test.ts`, and
      `test/fixtures/show/show-configuration-sessions--pending-orphans.json` is hand-authored until M12 (#14)
      replaces it
      **(progress 2026-11-08, DR-134/DR-136: every `hw-session-probe` case file embeds the replayable
      `show session-config diffs` exchange for its batch, and on the box the diffs are no longer only the
      0-line no-op baseline — `switchport mode trunk`, `no switchport` + `ip address …/31`,
      `switchport trunk group HWGRP`, `channel-group 999 mode active` (with the implicit
      `interface Port-Channel999` block), `vlan 4090` + indented `name`, a dangling `interface Vlan4090` +
      address, and `ip routing` (whose hunk shows `-no ip routing`, i.e. routing is off on this switch today)
      all produced real staged diffs that were then aborted. Refused lines appear in NO diff, which is how the
      `only`-keyword and inline-`vlan name` refusals were proven to have staged nothing. Still missing: the
      bare `show session-config` (no `diffs`) form, and the commit-timer behaviour now queued in this lane.)**

Suggested first command batch (no writes):

```json
{"jsonrpc":"2.0","method":"runCmds","id":"sweep-1","params":{"version":1,"format":"json","cmds":[
  "show version","show license features","show management api http-commands",
  "show configuration sessions","show lag resources","show hardware tcam profile"]}}
```

---

## 4. GitHub issue mirror

One issue per milestone + two tracking issues (wave 2, wave 3), each body carrying that milestone's
task/test checklist from [PLAN.md](./PLAN.md). Labels: `area:api-client`, plus
`kind:epic` / `kind:module` / `kind:infra` / `kind:question`, plus exactly one work-state label —
`status:in-progress` (an agent has a worktree open on it), `status:ready-for-review` (implementation
done, PR open, gate green, CI green), `status:blocked` (dependency or decision outstanding). The label
is the work state; the §1 table `in-progress`/`done` cell mirrors it, and this table mirrors the issue
*number*, not the state.

| Issue | Milestone | Status |
|---|---|---|
| [#1](https://github.com/svaj/vibe-arista-webui/issues/1) | umbrella — plan of record | open |
| [#2](https://github.com/svaj/vibe-arista-webui/issues/2) | M0 Workspace & package scaffolding | closed (PR #18) |
| [#3](https://github.com/svaj/vibe-arista-webui/issues/3) | M1 Wire protocol core | closed (PR #19) |
| [#4](https://github.com/svaj/vibe-arista-webui/issues/4) | M2 Transports | closed (PR #20) |
| [#5](https://github.com/svaj/vibe-arista-webui/issues/5) | M3 Connection profiles | closed (PR #24) |
| [#6](https://github.com/svaj/vibe-arista-webui/issues/6) | M4 `Node` command layer | closed (PR #22) |
| [#7](https://github.com/svaj/vibe-arista-webui/issues/7) | M5 Config sessions & change safety | closed (PR #25) |
| [#8](https://github.com/svaj/vibe-arista-webui/issues/8) | M6 Text-config engine | closed (PR #23) |
| [#9](https://github.com/svaj/vibe-arista-webui/issues/9) | M7 Resource framework | closed (PR #26) |
| [#10](https://github.com/svaj/vibe-arista-webui/issues/10) | M8 `system` | closed (PR #27) |
| [#11](https://github.com/svaj/vibe-arista-webui/issues/11) | M9 `vlans` + `switchports` | closed (PR #28) |
| [#12](https://github.com/svaj/vibe-arista-webui/issues/12) | M10 `interfaces` | open — M10a (facade + `BaseInterface` + per-kind grammar, §5 rows 99-106, DR-067-069) on its branch; M10b/M10c open (rows 123-130, DR-070+ reserved) |
| [#13](https://github.com/svaj/vibe-arista-webui/issues/13) | M11 Capability probe + dry-run | open |
| [#14](https://github.com/svaj/vibe-arista-webui/issues/14) | M12 Live suite + fixtures + CI | **CLOSED 2026-11-09: all seven boxes verified** (per-box evidence comment on the issue) — partial: recorder + live-guard + cEOS harness as [PR #29](https://github.com/svaj/vibe-arista-webui/pull/29), live tranches 1-2 (suites, `fixtures:refresh`, job wiring); the #62 configured re-capture batch brings **30 live captures** and the provisioned-capture harness onto this branch (§5 row 225, DR-122/DR-123); the hardware capture **lane is now built** — `EAPI_TARGET_CLASS=hardware` guard gates, `hw-inventory`/`hw-session-probe` runners, reviewed probe spec, runbook [HARDWARE-CAPTURE.md](./HARDWARE-CAPTURE.md) (§5 row 226, DR-124/DR-125) — its first **executed** switch session is what this list and every §3 box still need; also remain, but the **port itself is done** (§5 row 228): 14 suite files new + 3 extended over the D1 gates — the live project is up to 21 files / 250 cases, all compiling/collecting/skipping-loudly; what this lane still owes is the first **executed** device run (four `lab:run` chains here all died to the DR-123 host port-RST; see row 228's execution paragraph: the first executed corpus landed 2026-11-08, row 230) and the supervised switch session for the hardware sweep — the latter RAN 2026-11-07..09 (probe runs 1-6, PRs #110-#115: 61 hardware captures, DR-130..DR-137, run 6 CLEAN and net-zero recording-verified), and the cEOS catalog was regenerated by the named script the same day (`lab-1637825-9bbb4b`, row 239, DR-138, PR #116). The deferred §3 families remain unasked BY DESIGN (named in the M12 board row); the one remaining act is the operator's dispatch of `ceos-live` on the registered lab runner — wiring is done, nothing is owed to this epic |
| [#62](https://github.com/svaj/vibe-arista-webui/issues/62) | Configured-device capture batch (show-model gaps the UI screens need) | closed (PR #98; §5 row 225) — provisioning + 31-entry catalog + 30 captures + `--capture-via` fallback landed on main 2026-11-08 |
| [#15](https://github.com/svaj/vibe-arista-webui/issues/15) | M13 Consumption, docs, release | closed (PR #103, 0.1.0) — client-side items done; Playwright lane deferred to #91 by decision, `lag` contract gated on the #14 §3 hardware session |
| [#16](https://github.com/svaj/vibe-arista-webui/issues/16) | W2 wave-2 module backlog | open |
| [#17](https://github.com/svaj/vibe-arista-webui/issues/17) | W3 wave-3 module backlog | open |

Create/refresh them with `node arista-api-client/scripts/create-issues.mjs` (idempotent: updates the
existing issue when the title already exists; `--dry-run` to preview, `--print-table` to regenerate the
table above).

The cEOS changes are recorded in the local plan only; the GitHub issue mirror has not
been refreshed for this documentation update. Refresh it using the active role's
authenticated identity per the repository identity rule, not ambient credentials.

---

## 5. Conventions for keeping this file true

- A milestone flips to `done` only when its [PLAN.md](./PLAN.md) definition-of-done items are all
  checked (including the coverage threshold and the MIGRATION.md row update).
- `blocked:` must name what unblocks it (a decision, a device sweep line, another milestone).
- Anything the device sweep disproves gets a line here **and** a superseding entry in
  [DECISIONS.md](./DECISIONS.md) — never an edit to the old decision text.
