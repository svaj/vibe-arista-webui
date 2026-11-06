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

Wave-2 **lane A** is delivered on its branch (refs #16): `src/resources/users.ts` + `ntp.ts` with registry/Node wiring (rows 150-157, DR-089-091); gate 56 files / 1,799 tests, all five legs green; PR opens with merge-order note A-B-C-D. #35 #36 flip to status:ready-for-review at PR time; issues NOT closed until merge.

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
| M12 | Live suite + fixtures + CI | `in-progress` | 2026-11-03 | — | [#14](https://github.com/svaj/vibe-arista-webui/issues/14) | **Partial delivery as [PR #29](https://github.com/svaj/vibe-arista-webui/pull/29)** — #14 stays open. Shipped: recorder seam at the transport with double-pass redaction + write/load leakage assertion (`src/testing/recording.ts`/`recorder-node.ts`, DR-064), the live-guard consent matrix with mutation-tested refusals incl. the 9 new non-lab-target cases (DR-065, §5 rows 110/111), the cEOS harness lifecycle (`scripts/ceos-lab*.mjs`, `lab:*` scripts, DR-066) verified end-to-end post-reboot incl. the TLS-pin cross-check, and the repo's first 9 REAL redacted cEOS captures with provenance envelopes (§5 row 113). **Still owed on #14:** the `*.live.test.ts` port of pyeapi `test/system/*` (read-mostly ~60 + scratch-write cycles, device policy incl. named sessions), the `fixtures:refresh` script wiring, the trusted `workflow_dispatch` CI job, and EVERYTHING §3's hardware sweep asks. Container evidence ≠ 7050TX evidence (DR-043) — unchanged and enforced in file metadata. |
| M13 | Consumption, docs, release | `not-started` | — | — | [#15](https://github.com/svaj/vibe-arista-webui/issues/15) | includes opt-in Playwright cEOS lane once M12 harness and UI workflow exist |
| W2 | wave-2 modules | `backlog` | — | — | [#16](https://github.com/svaj/vibe-arista-webui/issues/16) | 9 modules, **139** upstream unit tests (users 22, acl 32, stp 21, mlag 7, varp 17, ipinterfaces 11, vrfs 10, staticroute 8, ntp 11 — AST count, superseding the stale 186/111 figures in older notes); needs M10 |
| W3 | wave-3 modules | `backlog` | — | — | [#17](https://github.com/svaj/vibe-arista-webui/issues/17) | 4 upstream test files, **78** methods (vrrp 23, bgp 22, routemaps 18, ospf 15); VXLAN deferred (the 7050TX-64 capability is unverified — open item) |

Status vocabulary: `not-started` · `in-progress` · `blocked:<reason>` · `done` · `backlog` ·
`dropped:<reason>`.

---

## 2. Module parity board

Parity = "all pyeapi verbs exist, generate the same commands, and the ported unit tests pass".

| Module | pyeapi LOC | upstream unit tests | planned ours | parity | fixtures recorded | live suite |
|---|---|---|---|---|---|---|
| `system` | 186 | 5 | 12 → **41 landed** (M8, #10) | `complete (offline)` — all 5 upstream methods ported with their command texts verbatim; the divergences are owned at §5 rows 83-90 | none yet — M12 (#14) owns any capture; unit evidence only | — |
| `vlans` | 372 | 15 | 22 → **45 landed** (M9, #11) | `complete (offline)` — all 15 ported, command texts verbatim; malformed-value *answers* deliberately not ported (DR-059); ranged headers fan out (row 96) | none yet — M12 (#14) | — |
| `switchports` | 417 | 21 | 26 → **43 landed** (M9, #11) | `complete (offline)` — all 21 ported verbatim incl. the `allowed vlan 1,2,3-5,6,7` pin; divergence rows 91/94-98; DR-029 closed at the key (row 96) | none yet — M12 (#14); `show interfaces switchport` json model blocked on open item 4 | — |
| `interfaces` | 1,101 | 72 | ~75 → **113 landed** in the M10a slice (#12) | `partial (offline)` — M10a's half (`Interfaces`, `BaseInterface`, `isvalidinterface`: upstream `test_api_interfaces.py:48-171`, `:186-224`) ported with its command texts verbatim and the divergences at §5 rows 99-106; `EthernetInterface` (upstream `:174+`), `PortchannelInterface` (`:305+`) and `VxlanInterface` (`:429+`) are M10b/M10c/M10d | the `show interfaces status` JSON this client reads is the cEOS-lab recording (row 106, DR-069); PLAN's 48-port 4.28 config fixture and any hardware capture stay M12 (#14) | — |
| `users` | 328 | 22 | ~28 | — | — | — |
| `acl` | 303 | 32 | ~35 | — | — | — |
| `stp` | 367 | 21 | ~24 | — | — | — |
| `mlag` | 302 | 7 | ~15 | — | — | plan two-node cEOS where supported; physical validation still needs a peer switch |
| `varp` | 213 | 17 | ~20 | — | — | — |
| `ipinterfaces` | 268 | 11 | ~14 | — | — | — |
| `vrfs` | 343 | 10 | ~16 | — | — | — |
| `staticroute` | 384 | 8 | ~18 | — | — | — |
| `ntp` | 208 | 11 | ~14 | — | — | — |
| `ospf` | 362 | 15 | ~20 | — | — | — |
| `bgp` | 341 | 22 | ~28 | — | — | — |
| `routemaps` | 357 | 18 | ~22 | — | — | — |
| `vrrp` | 1,493 | 23 | ~40 | — | — | — |
| *(framework)* | 224+304 | 10 loose upstream checks, none of them a spec: `abstract.py` has **no** suite (no `test/unit/test_abstract.py` in the clone), and the only upstream assertions touching framework behaviour are `test_api_autoloader` (`test_client.py:210-212`, asserts only non-`None`), 4 `test_make_iterable_*` (`test_utils.py:23-41`, none asserting a copy), 3 `isvlan` + 2 `isvalidinterface` (`test_api_vlans.py:51-58`, `test_api_interfaces.py:50-58`); **nothing** upstream calls `Node.section` or `get_block` | ~66 → **139 landed** (M7, #9) | `complete (offline)` — the framework itself (verbs, builders, registry, validators, `toArray`, the `Node` config reads) is shipped, pinned, re-exported from both package entries (PR #26), and has its **first consumer**: M8's `system` (#10) landed inside the measured 19-line entity plumbing budget | n/a | n/a |

Upstream totals for reference: **436 unit** test methods, **284 system** test methods, ~9.0 k LOC of
source (pyeapi 1.0.4-rc0).

---

## 3. Device sweep — the one job that unblocks several milestones

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

- [ ] `show version` → exact `modelName`, `version`, `serialNum`, image
- [ ] `show license features` · `show license all` → which features are licensed (VXLAN/VRF/MLAG)
- [ ] `show management api http-commands` · `… https certificate` → listeners, TLS versions, cert to pin
- [ ] `show configuration sessions` → baseline orphan state before any test writes
- [ ] `show interface switchport`-equivalent / `show interfaces <Eth1> switchport` → DR-028/DR-029 shape
- [ ] `show hardware tcam profile` / `show system profile`-family → replace the 7050X/FlexProfile
      assumptions in [`docs/features.md`](../../docs/features.md)
- [ ] `show lag resources` → real LAG member limits (features.md row is 7050X-derived)
- [ ] `show session-config diffs` behaviour inside a scratch session + `commit timer` confirm semantics
- [ ] `configure session <name>` boundaries: the longest accepted name and the character set (our
      `MAX_SESSION_NAME_LENGTH` and refusals are **this port's** bounds, not a captured device limit)
      → open item 7
- [ ] `configure session <name> description "…"` quoting depth (embedded `"`, `#`, `;`, backslash), and
      whether `no-commit` is accepted or answered `1002` on the 7050TX-64 → open item 8
- [ ] which of `copy running-config startup-config`, `rollback clean-config [ { groups } ]`,
      `rollback <name>` and `configure replace <url>` answer `1002`/`1004` per platform (cEOS first, then
      target — the class of gap DR-042 warns about)
- [ ] `commit timer` behaviour: does a held timer block a later session, and does a second `commit` before
      the deadline confirm or reset the revert? (the handler is native below the image's Python; never
      inspected here) → open item 5
- [ ] `show configuration sessions` / `show configuration sessions detail` captured verbatim: confirm the
      field set `ConfigSessionSummary` models, whether `maxOpenSessions`/`maxSavedSessions` are present, and
      whether any start-time field exists (`recoverOrphans({ olderThan })` depends on the journal until it
      does) → §5 row 70
- [ ] `show session-config` and `show session-config diffs` as **recorded fixtures**: neither has one today
      — `diff()` is pinned only by the mock pair in `config-session.test.ts`, and
      `test/fixtures/show/show-configuration-sessions--pending-orphans.json` is hand-authored until M12 (#14)
      replaces it

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
| [#14](https://github.com/svaj/vibe-arista-webui/issues/14) | M12 Live suite + fixtures + CI | `status:in-progress` — partial: recorder + live-guard + cEOS harness + 9 captures as [PR #29](https://github.com/svaj/vibe-arista-webui/pull/29); the `test/system/*` live port, CI live job and hardware sweep remain |
| [#15](https://github.com/svaj/vibe-arista-webui/issues/15) | M13 Consumption, docs, release | open |
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
