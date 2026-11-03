# Status — `arista-api-client`

Single source for "where are we". Update **in the same commit** that changes code, then update the
mirrored GitHub issue (see §4). Detailed task lists live in [PLAN.md](./PLAN.md); behaviour changes go
in [MIGRATION.md §5](./MIGRATION.md#5-semantic-divergences-worth-reviewing).

As of 2026-11-03: **M2, M4, M6 and M5 are implemented — every pyeapi transport has a TypeScript
equivalent, the `Node` command layer exists, EOS config text has a parity-proven parser, and change
safety (named + journaled sessions, a text diff, commit/abort, orphan recovery and explicit
durability) is in the client.** M4 (#6) merged as PR #22, so `src/command-layer.ts` and §5 rows 31–38
are live on `main`; M6 (#8) is complete and open as **PR #23**, which
now carries a merge of `origin/main`, so its review diff is only `src/config/` and the config ledger rows.
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
connection/profile bag — which is why every example still builds a `Transport` and hands it to `Node`.
**The open stack is #23 (M6, #8) → #24 (M3, #5) → #25 (M5, #7)**, in that review order: all three
branches sit on PR #23's base, and the MIGRATION §5 ledger is split across them by reservation — M6 owns
41–53, M3 owns 54–60, **M5 owns 61–70** (the 54–63 numbers this branch first wrote were shifted +7, and
nothing here forward-references 54–60 or 71–82), with rows 71–82 held for M7 (#9). M5 does **not** need
M3, and its `src/config-session.ts` deliberately does not import `src/config/`, so it can land on top of
#24 without touching either branch's source.

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
| M5 | Config sessions & change safety | `done` | 2026-11-03 | 2026-11-03 | [#7](https://github.com/svaj/vibe-arista-webui/issues/7) | Implementation complete, **open as [PR #25](https://github.com/svaj/vibe-arista-webui/pull/25) stacked on [#23](https://github.com/svaj/vibe-arista-webui/pull/23)** — [#24](https://github.com/svaj/vibe-arista-webui/pull/24) (M3) sits on the same base, so review order is #23 → #24 → #25. Owns **§5 rows 61–70** and **DR-047…DR-050** + open items 7–8. Shipped in `src/config-session.ts` + `src/node-session-journal.ts`: `node.configSession({ name?, description?, noCommit?, journal? })` → a `ConfigSession` handle (`run`/`commands`, `diff`, `showSessionConfig`, `validateChanges`, `commit({ persist? })`, `commitWithRevertTimer`, `confirmRevertTimer`, `abort`, `exit`, `rollbackCleanConfig`, `rollbackToSession`, `recordInJournal`, `state`/`isOpen`/`hasDiffBeenRead`) over `open \| diffed \| committed \| aborted \| lost` (**DR-025/DR-048**); the **DR-022/DR-047** default name `ui-<host>-p<pid>-<hex8>` (`generateSessionName`, from `Transport#address`, no pid in a browser) with `MAX_SESSION_NAME_LENGTH` + unsafe-token refusals because the name is spliced into `cmds[0]`; **every** batch re-attaches with `configure session <name>` first — the same insert as `client.py:687`; `diff()` states `format:'text'` on the request and forces `tolerateErrors:false`/`readOnly:false`, because the codec's 1003 repair re-issues the whole command list (`internal/wire.ts`) and inside a session that would apply a half-run changeset twice (DR-012, §5 row 64); `abort()`/`commit()` end the handle where pyeapi's `abort()` leaves `_session_name` set (`client.py:1023-1026`) and `exit()` detaches while keeping the journal record; `configure()`/`configureReplace()`/a second `configSession()` are refused by `assertNoSessionConflict` with 0 round trips, and pyeapi's silent reroute (`client.py:635-636`) is **not ported** (§7); `1006` → `SessionError('config locked')` naming the offending session plus `listSessions`/`abortSession`/`recoverOrphans` and `parseConfigurationSessions` (**DR-023** — pyeapi never mentions 1006, never runs `show configuration sessions`, and has no journal: verified by grep); the journal on both entries (`FileSessionJournal`/`SESSION_JOURNAL_PATH` behind `./node`, `createWebStorageJournal(storage)` + `SESSION_JOURNAL_STORAGE_KEY` in the browser; rebuilt from a key allow-list so `enablePassword` cannot ride along, **DR-011/DR-049**), with `olderThan` only computable from a journal record; `copyRunningToStartup`/`writeMemory` **never** implied by `commit()` and `commit({persist:true})` as its own second round trip (**DR-024**); `rollbackCleanConfig`/`rollbackToSession` (staged, returned uncommitted) and `configureReplace`; `validateChanges` on `{stopOnError:false, includeErrorDetail:true}` (**DR-016**) + `stopOnError` per operation. **Offline counts:** client 752 → **862** tests in 31 files — **106 new** (config-session.test.ts 78, node-session-journal.test.ts 28); webui 3/6 unchanged; coverage exit 0 at **97.49% stmts / 90.84% branch / 98.32% funcs / 98.34% lines**, `config-session.ts` 97.01 stmts / 88.92 branch, `node-session-journal.ts` 97.33 / 91.30; thresholds in `vitest.config.ts` untouched. **Upstream has no session tests at all**, so 106 is new work, not a port (§6). **Honest boundary (DR-050):** the specs pin the commands we send and the shapes we read. What the device *does* is image/manual-sourced — Arista's `CliPlugin/*.py` is absent from this workspace, so rows 61–70 name those classes **without** line numbers — and every such question is a §3 sweep line + open item 5/7/8: `commit timer` effect and confirm-or-reset, name length/charset, `description` quoting depth, `no-commit`/`rollback`/`copy run start` availability (1002-or-not) on the 7050TX-64, `maxOpenSessions`, and whether the sessions model carries a start time. **Not done on purpose:** no `verifyConfig`/dry-run (M11 #13) — hence no `dryRun()` exists — and no webui UI (M13 #15); `Node.section()`/`chunkConfig` pairing stays M7 (#9). |
| M6 | Text-config engine | `in-progress` | 2026-11-02 | — | [#8](https://github.com/svaj/vibe-arista-webui/issues/8) | implementation complete, **open as PR #23**; it branched off the M2 branch, so #23 now merges `origin/main` (which carries M4) to clear the conflict, and that merge also carries this board's bookkeeping. `src/config/` (`chunk`/`cache`/`section`/`ranges`/`text`): `_chunkify` port minus the `lru_cache` (DR-026 content-hash memo), `section()` `TypeError`→`NotFoundError` (DR-027), `get_block` → `undefined`, range helpers, CPython text primitives. Parity is **against upstream pyeapi, not a device**: `scripts/config-chunkify-oracle.py` (pyeapi `develop` 6816d9e) generated `test/fixtures/config/pyeapi-oracle.json`, `chunk.fixture.test.ts` diffs ordered entries and guards against oracle drift; the `.conf` inputs are hand-authored, so **device-captured 4.28 config text is still owed to M12 (#14)** and that PLAN box stays unticked (it is also the §3 sweep's config-text line). `src/config` 100% lines / 93.75% branch. Deliberately **no** `Node.chunkConfig`/`Node.section` wiring — that pairing is M7 (#9) |
| M7 | Resource framework | `not-started` | — | — | [#9](https://github.com/svaj/vibe-arista-webui/issues/9) | **blocked on M6 (#8)** — needs `src/config/` (PR #23); the §1 target `src/resources/base.ts` and the §6 wave-2 test-map rows are reviewed there, not here |
| M8 | `system` | `not-started` | — | — | [#10](https://github.com/svaj/vibe-arista-webui/issues/10) | needs M7 |
| M9 | `vlans` + `switchports` | `not-started` | — | — | [#11](https://github.com/svaj/vibe-arista-webui/issues/11) | needs M7 + M8; first demoable slice |
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
| *(framework)* | 224+304 | — | ~66 | — | n/a | n/a |

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
| [#5](https://github.com/svaj/vibe-arista-webui/issues/5) | M3 Connection profiles | `status:in-progress` |
| [#6](https://github.com/svaj/vibe-arista-webui/issues/6) | M4 `Node` command layer | closed (PR #22) |
| [#7](https://github.com/svaj/vibe-arista-webui/issues/7) | M5 Config sessions & change safety | `status:ready-for-review` ([PR #25](https://github.com/svaj/vibe-arista-webui/pull/25), stacked on [PR #23](https://github.com/svaj/vibe-arista-webui/pull/23); gate green in the worktree, CI pending; the base is PR #23's branch and PR #24 (`M3`) sits on that same base, so merge order is #23 → #24 → #25) |
| [#8](https://github.com/svaj/vibe-arista-webui/issues/8) | M6 Text-config engine | `status:ready-for-review` (PR #23) |
| [#9](https://github.com/svaj/vibe-arista-webui/issues/9) | M7 Resource framework | `status:blocked` (needs #23) |
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
