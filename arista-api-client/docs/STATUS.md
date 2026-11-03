# Status — `arista-api-client`

Single source for "where are we". Update **in the same commit** that changes code, then update the
mirrored GitHub issue (see §4). Detailed task lists live in [PLAN.md](./PLAN.md); behaviour changes go
in [MIGRATION.md §5](./MIGRATION.md#5-semantic-divergences-worth-reviewing).

As of 2026-11-03: **M2, M4, M6 and M7 are delivered — every pyeapi transport has a TypeScript equivalent, the
`Node` command layer exists, EOS config text has a parity-proven parser, and the resource framework that
wave-1 modules build on now exists.** M4 (#6) merged as PR #22, so `src/command-layer.ts` and §5 rows 31–38
are live on `main`; M6 (#8) is complete and open as PR #23, which now carries a merge of `origin/main`, so
its review diff is only `src/config/` and the config ledger rows. M7 (#9) is complete on
`agents/issue-9-m7-resource-framework`, branched off PR #23's tip (`a18c93d`): `src/resources/{types,base,
command-builder,validators,config-block,registry}.ts`, `src/internal/collections.ts`, the framework ledger
rows 71–82, DR-051–DR-054, and the **`Node` ↔ M6 config pairing PR #23 deferred** (`chunkConfig` /
`section` / `getBlock`, two DR-026 memos, one invalidation seam). It adds 139 tests (752 → **891** client
tests over #23's base) and no new dependency. M3 (#5) is open as PR #24 on the same base; M5 (#7) has a
branch on that base with no PR yet, so **#23 is still the only thing between `main` and M5/M7** — merging
it re-targets #24 and the M5/M7 branches onto `main`.
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
usable with no resource module, which is PLAN's M4 exit gate. `createNode()` in `src/index.ts` /
`src/node.ts` **still throws** — a `Node` is built from an explicit `Transport` until M3 defines the
connection/profile bag. **The next actions are merging #23, then M8 (#10, `system`)** — the first module
on the framework. Two framework pieces are still owed and both are named in M7's row below: the
framework's re-export through `src/index.ts`/`src/node.ts`, and the static `node.vlans`-style accessors
DR-006 promises, which need a module class to type them.

**Test infrastructure planning update:** local cEOS-lab **4.28.14M** and vendor install
instructions are now available under `/home/svaj/development/arista/cEOS/`.
Disposable cEOS is the preferred planned integration/live and browser E2E target;
see the [runbook](../../docs/CEOS.md) and DR-043. Provisioning, host compatibility,
eAPI readiness, and harness execution are **not yet validated**. Hardware remains
7050TX-64 / **4.28.13.1M**; its platform-specific sweep is still required.

---

## 1. Milestones

| ID | Milestone | Status | Started | Done | Issue | Blockers / notes |
|---|---|---|---|---|---|---|
| M0 | Workspace & package scaffolding | `done` | 2026-11-01 | 2026-11-01 | [#2](https://github.com/svaj/vibe-arista-webui/issues/2) | exit gate green from the repo root (typecheck/lint/test/build + webui imports by name, no path hacks); CI matrix is **22/24** because Vitest 5/jsdom 30 exclude Node 20. Package name still undecided (**DR-020**); `docs` script deferred (no generator chosen — M13 #15); placeholders only in `src/index.ts` / `src/node.ts` |
| M1 | Wire protocol core | `done` | 2026-11-01 | 2026-11-01 | [#3](https://github.com/svaj/vibe-arista-webui/issues/3) | codec in `src/internal/wire.ts` (pure, no I/O) + `src/errors.ts` + `src/types/eapi.ts`; DR-010/011/012/016/017 in; **27** hand-authored samples in `test/fixtures/wire/` driven by `src/internal/wire.fixture.test.ts` (message prose is synthetic until M12 #14 records captures); client coverage 98.98% stmts / 94.73% branch / 100% lines (thresholds 85/75/60); no transport yet, `WireSender` + `src/testing/fake-sender.ts` are the only send seam; no runtime `show()` yet — the type tests pin the `ShowReply<K>` map M4 (#6) implements it against; codec does not yet correlate the echoed response id with the request id, and `ProtocolError` does not carry an id — M2 (#4) decides both |
| M2 | Transports | `done` | 2026-11-01 | 2026-11-01 | [#4](https://github.com/svaj/vibe-arista-webui/issues/4) | all seven pyeapi transports ported (`src/transports/`), stacked on #19 for review; DR-002 browser-safety is enforced by `src/browser-safety.test.ts` in the unit project + CI — a **test** gate, not a literal step of `npm run build`; TLS behaviour is verified only against synthetic loopback certs, since the **device** fingerprint/TLS-version capture (STATUS §3, DECISIONS open items 3) is still outstanding |
| M3 | Connection profiles | `in-progress` | 2026-11-03 | — | [#5](https://github.com/svaj/vibe-arista-webui/issues/5) | unblocked by M2 (#4, merged) — the only front-door lane that `main` alone supports; lands `createNode()`/`createConnection()` and closes the placeholder that still throws |
| M4 | `Node` command layer | `done` | 2026-11-01 | 2026-11-02 | [#6](https://github.com/svaj/vibe-arista-webui/issues/6) | merged as PR #22 on 2026-11-03, after stacking on #19/#20 for review. `src/command-layer.ts` (pyeapi's `Node` class; `src/node.ts` stays the Node-runtime **entry**, so the docs' old `src/node.ts` target is corrected in MIGRATION §1) + `src/internal/variants.ts`. In: `runCommands`, `exec` (one entry per command, `{command, result, encoding, fellBack}`, no duplicate `response` key — DR-007), `show`/`showText` over the augmentable `ShowContracts` map, `getConfig` + the async config accessors (DR-005), memoised `getVersion()`, `configure` / `configureVariants` (DR-006), `setEnablePassword` + the `sendEnable: false` priv-15 shortcut (DR-009), `refresh()`, `close()`, config-mode refusal (`NotSupportedError`, `configure all <intf> …` exempt), short-answer pairing that names the command by its `cmd`, and no `MULTILINE:` rewrite (DR-015). **8 new §5 rows (31–38).** Out on purpose: config-session verbs and the DR-025 guard/serialisation (M5 #7), `section()`/`_chunkify` (M6 #8), `api()` (dropped, DR-006), `configSection()`, profiles/`createNode` (M3 #5). Offline only: 75 cases over `MockTransport` + `test/fixtures/show/` (synthetic), no device, no cEOS; client 529 → **618** tests; coverage 96.98% stmts / 90.86% branch / 97.64% lines (`command-layer.ts` 100% stmts/funcs) |
| M5 | Config sessions & change safety | `not-started` | — | — | [#7](https://github.com/svaj/vibe-arista-webui/issues/7) | **blocked on M6 (#8)** — PLAN deps are M4 + M6, and M6 is still open as PR #23. commit-timer semantics unverified; investigate in cEOS, confirm target-sensitive behavior on hardware |
| M6 | Text-config engine | `in-progress` | 2026-11-02 | — | [#8](https://github.com/svaj/vibe-arista-webui/issues/8) | implementation complete, **open as PR #23**; it branched off the M2 branch, so #23 now merges `origin/main` (which carries M4) to clear the conflict, and that merge also carries this board's bookkeeping. `src/config/` (`chunk`/`cache`/`section`/`ranges`/`text`): `_chunkify` port minus the `lru_cache` (DR-026 content-hash memo), `section()` `TypeError`→`NotFoundError` (DR-027), `get_block` → `undefined`, range helpers, CPython text primitives. Parity is **against upstream pyeapi, not a device**: `scripts/config-chunkify-oracle.py` (pyeapi `develop` 6816d9e) generated `test/fixtures/config/pyeapi-oracle.json`, `chunk.fixture.test.ts` diffs ordered entries and guards against oracle drift; the `.conf` inputs are hand-authored, so **device-captured 4.28 config text is still owed to M12 (#14)** and that PLAN box stays unticked (it is also the §3 sweep's config-text line). `src/config` 100% lines / 93.75% branch. Deliberately **no** `Node.chunkConfig`/`Node.section` wiring — that pairing is M7 (#9) **(delivered there: `chunkConfig`/`section`/`getBlock` on `Node`, MIGRATION §5 row 80)** |
| M7 | Resource framework | `done` | 2026-11-03 | 2026-11-03 | [#9](https://github.com/svaj/vibe-arista-webui/issues/9) | PLAN's "Entry point wiring" bullet is delivered here too: the framework is re-exported from `src/index.ts:152-175` and reaches `./node` through `src/node.ts:51`, pinned by `src/index.test.ts`; `RESOURCE_FACTORIES` intentionally ships empty until M8-M10 (#10-#12). | complete on `agents/issue-9-m7-resource-framework`, branched off PR #23's tip `a18c93d` (so it stacks on #23 and re-targets to `main` when #23 merges). `src/resources/`: `types.ts` (`CommandMode`/`CommandValue`/`CommandOptions`/`CommandInput`/`ResourceKey`/`ResourceTable`/`ResourceAttrs`), `base.ts` (`ResourceBase`, `Entity<T>`, `EntityCollection<T,K,A>`), `command-builder.ts` (`commandBuilder`, `submodeCommands`), `validators.ts` (`assertVlanId`/`isVlanId`, `assertInterfaceName`/`isInterfaceName`), `config-block.ts` (`parseConfigBlock`), `registry.ts` (`ResourceKinds`, `ResourceRegistry`, `RESOURCE_FACTORIES`, `createResourceRegistry`); plus `src/internal/collections.ts` (`toArray`, DR-054) and the **`Node` ↔ M6 pairing** PR #23 deferred (`chunkConfig`/`section`/`getBlock`, `NodeConfigOptions`, `node.resource`/`hasResource`, one `clearConfigChunks()` seam called from `configure()` and `refresh()` — DR-026/DR-027 end-to-end). `ResourceKinds` is **intentionally empty** (no wave-1 module yet, DR-052); `isvalidinterface`/`isvlan` are refused-strict validators (DR-053). Ledger: **§5 rows 71–82** (40 in-`src` citations renumbered off a private 64–75 band onto the reserved 71–82 band; nothing points at M3's 54–60 or M5's 61–70 from this tree), **DR-051–DR-054**, MIGRATION §1/§2/§3/§6 rows repaired. Offline: client **29 files / 752 tests → 36 files / 891 tests** (+139: `command-builder.test.ts` 45, `base.test.ts` 23, `command-layer.config.test.ts` 25, `validators.test.ts` 13, `registry.test.ts` 12, `config-block.test.ts` 12, `collections.test.ts` 9), webui unchanged at **3 files / 6 tests**. Client coverage **97.88% stmts / 92.04% branch** / 97.96% funcs / 98.29 lines; every file M7 touched or wired reports **100/100/100/100** (stmts/branch/funcs/lines) — `resources/{base,command-builder,config-block,registry,types,validators}.ts`, `internal/collections.ts` **and** `command-layer.ts` — which is why the v8 `text` reporter suppresses those rows (it hides any file or directory at 100% on all four metrics; the numbers are in the same run's summary block). The `src/resources/` threshold (`{lines:85, branches:80}`, `vitest.config.ts`) predates this milestone — from the M0 skeleton mirroring TESTING.md §2 — and `vitest.config.ts` is **byte-identical** to PR #23's tip on this branch: no threshold was added or lowered. PLAN's M7 exit gate ("M8 requires ≤30 lines of new plumbing") measured, not estimated: **19 lines** for a wired `Entity`, **43** for a wired `EntityCollection`, asserted (`≤30` / `≤45`) by the `exit gate` case in `src/resources/base.test.ts`. **Still owed by this milestone:** the framework is not re-exported through `src/index.ts`/`src/node.ts` (PLAN's M6 note handed that public-surface wiring to M7), so a package consumer cannot import `Entity`/`commandBuilder`/`parseConfigBlock` by name yet; `node.vlans`-style static accessors (DR-006) land with M8–M10; the `describeLine` `lstrip` question row 49 raised is deliberately **not** changed (row 81 explains, and pins the consequence); the interface-name regex is unverified on hardware (DECISIONS open item 7, M12 #14 captures) |
| M8 | `system` | `not-started` | — | — | [#10](https://github.com/svaj/vibe-arista-webui/issues/10) | **unblocked by M7 (#9)** — `Entity`, `commandBuilder`, `parseConfigBlock`, `toArray` and the `Node`↔config pairing are on the branch stacked on #23, and the measured cost of one module is **19 lines** of plumbing (`base.test.ts`). M8's own diff: `src/resources/system.ts` + one `ResourceKinds` row + one `RESOURCE_FACTORIES` entry. M7 did **not** re-export the framework from `src/index.ts`/`src/node.ts`, and `node.system` — the static accessor DR-006 promises — needs M8's class to type it, so either a M7 follow-up or M8 itself carries that wiring before any of it is reachable from `arista-webui`. `setBanner` needs the `{cmd, input}` multiline form (DR-015; row 74 refuses a newline inside one command string) |
| M9 | `vlans` + `switchports` | `not-started` | — | — | [#11](https://github.com/svaj/vibe-arista-webui/issues/11) | needs **M8 (#10)** first. M7 (#9) removed the framework as a blocker (entities, collections, `getAll()` → `ReadonlyMap`, the verb set, throwing validators, the registry, the `Node` config reads), so what stands between #11 and a demoable slice is: M8 proving `Entity` end-to-end; the framework **and** the module classes re-exported from `src/index.ts`/`src/node.ts` (still open after M7); `ResourceKinds` rows plus `RESOURCE_FACTORIES` entries supplied by real `Vlans`/`Switchports` classes (DR-052 leaves the map empty today); `assertVlanId` applied at M9's own call sites (the guard ships, nothing calls it yet); and reading config through the pairing, which inherits M6's pinned `describeLine` contract — `findValue(block.body, 'name')` answers `' PROD'`, quotes intact (MIGRATION §5 rows 49/81) — whose quoting rules are an M12 (#14) capture question. First demoable slice |
| M10 | `interfaces` (base, ethernet, port-channel) | `not-started` | — | — | [#12](https://github.com/svaj/vibe-arista-webui/issues/12) | needs M7 + M9; split M10a–c |
| M11 | Capability probe + dry-run | `not-started` | — | — | [#13](https://github.com/svaj/vibe-arista-webui/issues/13) | needs M5 + M9 |
| M12 | Live suite + fixtures + CI | `not-started` | — | — | [#14](https://github.com/svaj/vibe-arista-webui/issues/14) | local cEOS image available; needs trusted privileged runner, provisioning/readiness/guards/cleanup; hardware lane separate |
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
| `system` | 186 | 5 | 12 | — | — | — |
| `vlans` | 372 | 15 | 22 | — | — | — |
| `switchports` | 417 | 21 | 26 | — | — | — |
| `interfaces` | 1,101 | 72 | ~75 | — | — | — |
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
| *(framework)* | 224+304 | 10 loose upstream checks, none of them a spec: `abstract.py` has **no** suite (no `test/unit/test_abstract.py` in the clone), and the only upstream assertions touching framework behaviour are `test_api_autoloader` (`test_client.py:210-212`, asserts only non-`None`), 4 `test_make_iterable_*` (`test_utils.py:23-41`, none asserting a copy), 3 `isvlan` + 2 `isvalidinterface` (`test_api_vlans.py:51-58`, `test_api_interfaces.py:50-58`); **nothing** upstream calls `Node.section` or `get_block` | ~66 → **139 landed** (M7, #9) | `partial` — the framework itself (verbs, builders, registry, validators, `toArray`, the `Node` config reads) is shipped and pinned; it has no wave-1 consumer until M8 (#10), and it is not re-exported from the package entries yet | n/a | n/a |

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

- [ ] `show version` → exact `modelName`, `version`, `serialNum`, image
- [ ] `show license features` · `show license all` → which features are licensed (VXLAN/VRF/MLAG)
- [ ] `show management api http-commands` · `… https certificate` → listeners, TLS versions, cert to pin
- [ ] `show configuration sessions` → baseline orphan state before any test writes
- [ ] `show interface switchport`-equivalent / `show interfaces <Eth1> switchport` → DR-028/DR-029 shape
- [ ] `show hardware tcam profile` / `show system profile`-family → replace the 7050X/FlexProfile
      assumptions in [`docs/features.md`](../../docs/features.md)
- [ ] `show lag resources` → real LAG member limits (features.md row is 7050X-derived)
- [ ] `show session-config diffs` behaviour inside a scratch session + `commit timer` confirm semantics

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
| [#5](https://github.com/svaj/vibe-arista-webui/issues/5) | M3 Connection profiles | `status:in-progress` |
| [#6](https://github.com/svaj/vibe-arista-webui/issues/6) | M4 `Node` command layer | closed (PR #22) |
| [#7](https://github.com/svaj/vibe-arista-webui/issues/7) | M5 Config sessions & change safety | `status:blocked` (needs #23) |
| [#8](https://github.com/svaj/vibe-arista-webui/issues/8) | M6 Text-config engine | `status:ready-for-review` (PR #23) |
| [#9](https://github.com/svaj/vibe-arista-webui/issues/9) | M7 Resource framework | `status:ready-for-review` (implementation + docs complete on `agents/issue-9-m7-resource-framework`, offline gate green, stacks on #23) |
| [#10](https://github.com/svaj/vibe-arista-webui/issues/10) | M8 `system` | open |
| [#11](https://github.com/svaj/vibe-arista-webui/issues/11) | M9 `vlans` + `switchports` | open |
| [#12](https://github.com/svaj/vibe-arista-webui/issues/12) | M10 `interfaces` | open |
| [#13](https://github.com/svaj/vibe-arista-webui/issues/13) | M11 Capability probe + dry-run | open |
| [#14](https://github.com/svaj/vibe-arista-webui/issues/14) | M12 Live suite + fixtures + CI | open |
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
