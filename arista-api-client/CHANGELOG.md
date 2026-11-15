# Changelog

All notable changes to `@devhax-heavy-industries/arista-eapi` are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows
[DECISIONS.md DR-040](./docs/DECISIONS.md#dr-040--versioning-changelog-breaking-changes): `0.x.y`
while pre-1.0, and **every deliberate divergence from upstream pyeapi gets its own row in
[MIGRATION.md §5](./docs/MIGRATION.md#5-semantic-divergences-worth-reviewing)** rather than a
surprise here — this file records what shipped, the migration map records what changed under you.

## [Unreleased]

### Changed — `vlans.delete(1)` now refuses instead of sending `no vlan 1` (2026-11-15; #122, DECISIONS DR-139, §5 row 240)
- `VlansResource.delete` throws `NotSupportedError` for id 1 **before a config transaction opens**.
  `create(1)`/`setDefault(1)` and the read path are unchanged — the shared `assertVlanId` keeps its
  `1..4094` range because those arms legitimately name the default VLAN (the carve-out is delete-only,
  and DR-059 keeps reads guarded by nothing but the device). Whether the device rejects `no vlan 1` is
  an uncaptured M12 question (#122 open question 1), quoted nowhere as a device claim (DR-043); this
  is DR-005 refuse-don't-soften posture, not an EOS observation.
- Consumer note: a script that reached `node.vlans.delete(1)` now gets a client-side refusal naming the
  policy. The lower-level `configSession` seam is untouched for anyone who specifically wants to learn
  the device's answer under a supervised session.
- webui S2 (`VlanManagement`): the screen's own VLAN 1 guard stays; its copy flipped from "the client
  does not refuse it" to belt-and-braces wording now that both lanes refuse (#72 follow-through).

### Evidence — the cEOS 4.28.14M capture catalog refreshed in place; the wave-1 fixtures contract closes from both ends (2026-11-09; §5 row 239, DR-138)
- `npm run fixtures:refresh -- --yes` (run `lab-1637825-9bbb4b`) rewrote all 30 files under
  `test/fixtures/live/ceos-4.28.14M/` — 24 JSON answers + 6 text-form mates, no name changes,
  `+276/−276`: bootstrap rotation (`runId`/`capturedAt`/per-boot TLS fingerprint) plus live counters. Six
  commands answered invalid and stay probe-note negatives (the row-237 both-transports family plus
  `show platform overview`) — never empty files.
- Transport: the eAPI probe refused with the named root cause `mgmt-path-owned-by-host-nat` (WSL2
  mirrored-mode networking owns the pinned `192.168.255.0/24` on this machine), so the DR-123 `auto`
  fallback collected via `docker exec <run-owned container> Cli -p 15` with identity guards re-applied
  per file. `docs/CEOS.md` gained the §Host-route reconciliation section the shipped script text already
  points at (that pointer was dangling — fixed), plus refresh cards naming both batches.
- Shape audit re-derived from the captures, not the console: the LABGRP trunk-group claim (row 225), the
  provisioned routes in `show ip route`, and the `lab-pending-capture` sessions listing all still hold.
  cEOS's `ip routing` verdict stays refused in container shapes — noted against the hardware fact (DR-136)
  so neither is ever quoted for the other target (DR-043).

### Evidence — probe run 6: the first CLEAN full pass, and the scratch port is finally net-zero (2026-11-09 09:48; DR-137 close + §5 row 238)
- 17/17 batches with #114's code and spec rev 5: 0 opener refusals, 5 commits, 0 harness faults, `DONE` printed,
  suite green — all 17 probe recordings refreshed under `recordings/7050tx-64-r-4.28.13.1M/`.
- **The `description HW-CAPTURE-PROBE` + `mtu 9214` the lane owed since run 2 is PAID**: the rev-5 restore
  committed, its session diff removed exactly those two lines, and the post-restore read-back in the capture is a
  bare `interface Ethernet22` — an empty stanza, verified from the recording (the run-5 lesson: console prints are
  claims; this time they agree).
- New device answer: a **0-line-diff (no-op) commit is ACCEPTED** and still parks the session name — three scratch
  batches re-staged values the port already carried, diffed empty, committed anyway (DR-137's rotation semantics
  reconfirmed: `scratch-mtu` and `scratch-switchport-restore-order` opened canonically right after
  `scratch-description` parked, because each new commit displaces the saved entry).
- `commit-timer` reproduced run 5 end-to-end; `commitBy` uptime continuity (704038 → 743985 ≈ the 11 h between the
  two wall-clock starts) corroborates the uptime-clock interpretation.
- Slot after run 6: `hw-probe-scratch-restore` (last plain commit) — a re-run refuses-and-retries exactly that one
  opener. Both run-5 harness fixes (`hwReadBackOutput`, the `'<batch>'` summary crash) are now proven on hardware.

### Fixed — probe run 5, the first full pass: two lane-print defects that contradicted the recordings, and one invented restore token (2026-11-08; DR-137 + §5 row 237)
- `docs/hw-session-probes.draft.json` (rev 5): `scratch-restore` is now exactly `no description` + `no mtu` —
  the two lines the box itself staged cleanly inside the very session that refused the next token, and the
  exact inverse of everything run 5 actually committed. The rev-3/4 line `switchport mode auto` was this
  repo invention; the SKU answered `1002 Invalid input (at token 2: 'auto')`, DR-134 skip-commit rule
  correctly left the batch uncommitted — and for the third run in a row the scratch port stayed dirty
  (`description HW-CAPTURE-PROBE` + `mtu 9214` today). Pins: the restore batch command array is asserted
  equal, and no batch anywhere may contain a `switchport mode auto` line.
- `src/testing/hw-capture.ts`: new `hwReadBackOutput(item)` — `node.exec` answers one item PER command
  (the composed `enable` owns one) and wraps each reply under `result`; the lane `textOf` read `.output`
  at the wrapper level, so EVERY post-commit read-back print lied through run 5 ("scratch block
  0 line(s); markers … none" over recordings holding three-line stanzas, and the honest-looking
  `startup HWPROBE-TIMER=absent` was an empty-string artifact). Pinned with shapes copied from the run 5
  captures; the two conclusions that happened to survive (revert fired; no persistence) were re-derived
  from the recordings, which is the only reason they were kept.
- `src/hw-session-probe.live.test.ts`: the opener-refusals summary no longer builds an example retry name
  by CALLING `hwProbeRetrySessionName('<batch>', runTag)` — the doc placeholder reached the validating
  builder and threw in the final print of an otherwise-complete 17/17 run (all 17 recordings had already
  been written; the exit code 1 was our tail, not the switch). The pending-state warning now matches the
  label this box actually uses (`pendingCommitTimer`, deadline in `commitBy` on an uptime clock), not the
  §3 prose spelling `pending-revert`.
- Timed-commit behaviour on the box — recorded, this time correctly: `commit timer 00:02:00` ACCEPTED; the
  armed session lists on the PLAIN `show configuration sessions`; a second session opened normally over
  eAPI while armed (the earlier "expect a refusal" note in the spec comment is superseded by the capture);
  startup-config never saw the marker; the revert fired unattended, restoring exactly the session own
  diff; and afterwards BOTH session listings report `sessions: {}` — an auto-reverted commit frees the
  one completed-NAME slot (DR-136 parking applies to plain commits; the slot rotates per commit).
- `resources/vrrp.ts`: the modern arm is now hardware-answered in both directions — legacy `vrrp <id> ip`
  refused at the write AND modern `vrrp 1 ipv4 169.254.90.7` staged-and-diffed in `vlan-interface-vrrp-ipv4`
  (aborted per the grammar contract, DR-043).

### Changed — probe run 4's two failures, and five more grammar answers from the box (2026-11-08; DR-136 + §5 row 236)
- `src/testing/hw-capture.ts`: a config-session **name is a one-slot device resource**. The box keeps ONE
  completed session (`maxSavedSessions: 1`) and run 2's commit parked `hw-probe-scratch-description`
  there, so run 4's attempt to re-open that exact name was refused (`Error [1000] … could not run command`) — a
  committed probe batch would otherwise be unprobeable for the life of that saved entry. New
  `hwProbeSessionName()` / `hwProbeRetrySessionName(name, runTag)` / `hwProbeRunTag()`: the harness tries the
  canonical name first, records the refusal as §3 evidence, and retries the batch under
  `hw-probe-<name>-<tag>` (same prefix, still inside `assertSessionName`'s charset and the 64-character
  cap). Case names stay batch-keyed, so one batch is still exactly one recording.
- `src/hw-session-probe.live.test.ts`: `closeHandle()` replaces the bare `abort()` — a handle this client has
  marked `lost` has no session behind it, and `abort()` on it throws this package's own DR-023
  `SessionError`. Uncaught, that killed run 4 **after** the device had answered, discarding
  `scratch-description`'s captured refusals and skipping the restore set for the second time
  (`description HW-CAPTURE-PROBE` is still committed on the scratch port). Refused aborts are recorded with a
  pointer to the runbook's console check; non-`EapiError` faults still kill the run. Both names' refusals now
  accumulate instead of overwriting, and refusal text keeps 500 characters — the old 160/200 caps cut the
  run-5 answer mid-token (`[errors: ['Cannot`) and forced the cause to be inferred from the session table.
- `parseHwProbeSpec` refuses a staged **session-exec verb** (`commit …` / `revert …` / `abort` / `copy …`) in
  a spec's `commands`, in commit and abort batches alike: those act on the session immediately, and per
  DECISIONS DR-081 the `<intf>` form implicitly saves to startup-config — a write no spec line is reviewable
  for. Commit lifecycle is `allowCommit` and the new `commitWithRevertTimer: "HH:MM:SS"` field (validated
  against this client's own timer grammar; `00:00:00` refused, since EOS answers
  `Time value cannot be zero.`). Fence and timer rules mutation-checked: removing the verb rule fails only its
  own test; removing the timer block also breaks the spec-vs-parser coupling pin.
- STATUS.md §3's `commit timer` line (open item 5) moves into this lane with the `commit-timer` batch: the
  lane arms it through `ConfigSession#commitWithRevertTimer` (`config-session.ts:856`), reads the session
  table, asks whether an armed timer blocks another `configure session`, reads `show startup-config` for
  staged marker, then — for a timer of five minutes or less — sits out the deadline and re-reads the scratch
  interface, so the recording answers whether the revert fires by itself. The
  `commit <intf> verify` / `revert <intf>` confirm-and-cancel arm is deliberately unasked: this repo has
  never composed that pair for a device and DR-135 is what an invented spelling cost. Test budget for the file
  is now 15 min (override with `EAPI_HW_PROBE_TEST_TIMEOUT_MS`).
- Evidence: 11 probe recordings refreshed/added on `DCS-7050TX-64-R` / `4.28.13.1M` (and the `vlans-vrrp-iprouting`
  recording that rev 3 superseded was removed). Newly answered on the box: the `vlan <id>` **block** form stages
  where the one-line `vlan <id> name` does not; a **dangling SVI** stages (`interface Vlan4090` + address while
  the VLAN existed only in the same staged set); `ip routing` stages, and the diff showed the switch running
  `no ip routing` today; and `vrrp <n> ip <addr>` is refused with `Unavailable command (This command is
  deprecated by 'vrrp ipv4')` — the device naming the modern arm this client composes on >= 4.21.3, hence the
  new `vlan-interface-vrrp-ipv4` batch. `configure session <name> description "…"` round-trips verbatim
  including the quotes.

### Changed — the second supervised switch day: what the box answered, and the read that stranded a commit (2026-11-08; DR-135 + §5 row 235)
- `src/hw-session-probe.live.test.ts`: reads that happen **after** a batch has closed (the scratch
  read-back following a `commit`, and the `show configuration sessions[ detail]` post-state read) can no
  longer control the run. A typed `EapiError` there is logged and collected, the committed batch still
  writes its recording, and the loop continues. Run 2 proved the cost of the old shape: the read-back
  killed the harness one statement after a SUCCESSFUL commit, so that batch's evidence was lost, the
  restore set never ran, and `description HW-CAPTURE-PROBE` stayed committed on the scratch port.
  If the recording write itself fails after a commit, the harness now prints which restore batch to run.
- `src/testing/hw-capture.ts` `hwScratchReadBackCommand()`: the post-commit read-back is
  `show running-config **interfaces** <intf>` — plural, device-verified. This unit answers the singular
  spelling with `1002 % Incomplete token (at token 2: 'interface')`; Arista's own system suite writes
  the plural everywhere. Pinned offline so a run card cannot reintroduce the singular form.
- New `EAPI_HW_PROBE_ONLY=<batch names>` resume filter (`selectHwProbeBatches`): a switch day that
  stopped partway can run just the batches still owed, in the reviewed spec's order; an unknown batch
  name is a hard refusal, never a silent skip.
- `docs/hw-session-probes.draft.json` rev 3: the `vlans-vrrp-iprouting` batch — the one rev 2 left
  multi-question — is split into `vlan-inline-name` / `vlan-block-form` / `vlan-interface-ip` /
  `vlan-interface-vrrp` / `ip-routing`, because the device refused its FIRST line (`vlan 4090 name …`
  → `Invalid input (at token 2: 'name')`: the inline form is not this SKU's grammar) and EOS staged
  nothing behind it. `scratch-restore` is now pinned to include `no description` so the commit set is
  net-zero even after an interrupted day.
- Device answers captured on the `-R` unit and committed as seven
  `configure-session-*--hw-session-probe` recordings: `switchport mode trunk`,
  `no switchport` + an address, `switchport trunk group HWGRP` (open item 4's verb half — trunk groups
  DO exist on this SKU) and `channel-group 999 mode active` (with the implicit `interface
  Port-Channel999` in the diff) all stage clean; `switchport trunk allowed vlan only …` is refused
  (bare spelling commits), so the `only` keyword is a documented non-support on this box.

### Changed — hw-session-probe records device refusals instead of dying on them (2026-11-08; DR-134 + §5 row 234)
- `src/hw-session-probe.live.test.ts`: a batch-level `1002`/`1004` from staging (or from the
  `show session-config diffs` read) is now recorded as that batch's answer and the batch loop
  continues — matching what `hw-inventory` always did — instead of throwing and making every later
  batch unreachable. The first executed probe run proved the cost: the SKU's `1002` for
  `switchport trunk allowed vlan only 10,20` (real finding: the `only` keyword does not exist on this
  box's CLI, while the bare spelling committed fine the same day through the lab corpus) silently
  killed trunk-group, routed-conversion, VRRP and the whole commit set. Non-`EapiError` faults still
  kill the run; an `allowCommit` batch that came back with a refusal never commits — it aborts and
  records.
- `docs/hw-session-probes.draft.json` rev 2: one question per batch (the switchport-modes batch
  became `switchport-l2-baseline` / `trunk-allowed-only` / `routed-conversion`), and the committed
  `scratch-restore` batch drops `no switchport` — it would have stranded the scratch port routed
  instead of net-zero L2. Both rules are now pinned by the spec's machine-check test.

### Fixed — the hardware scrubber missed key-position secrets in the batch-1 captures (2026-11-08; DR-133 + §5 row 233)
- `sanitizeHwRecording`/`redactHwValue` (`src/testing/hw-capture.ts`) now scrub object **keys** with the
  same rule chain as values (collision-safe renaming) and the identity envelope's free-text fields
  (`endpoint`/`topology`/`image`; the `targetSlug`/`modelName`/version match fields stay verbatim).
  EOS answers `show running-config` in JSON as an object keyed by the config line, so the first executed
  hardware capture — 44 recordings from the `-R` unit, 9 device negatives — carried a live
  `username … secret sha512 $6$…` hash in the two running-config files and the management IP in all 44
  envelopes. The 44 files are regenerated from the original device bytes through the fixed code; the
  pre-fix copies were never committed and live only on the session host.
- New committed-tree guard (`recorder-node.test.ts`): every recording under `test/fixtures/recordings/`
  is now text-scanned for crypt(3) hashes, un-redacted `secret`/`enable password` payloads, and
  private-key armour — placeholders pass, real material fails `npm test`. Guard mutation-checked.
- `live-client`'s startup-config memo assertion, previously pinned to the container's
  "no startup-config → two wire asks", now conditions on the device's answer (a real switch has one:
  memoised, one ask). The client rule it pins is unchanged.

### Changed — the hardware capture lane, from the first supervised 7050TX-64 sessions (2026-11-08; DR-131/DR-132 + §5 row 232)
- `live-guard.ts` `HARDWARE_MODEL_NAMES` is now the **exact set** `DCS-7050TX-64` / `DCS-7050TX-64-R`:
  the unit in front of the first session answered `show version` with the `-R` spelling, so a fully
  gated run refused at `matchesDeviceIdentity` and captured nothing (the guard worked; the pin set was
  the stale part). Exact members only — `-RR`, `DCS-7050TX-64 R`, `DCS-7050TX-6` stay refused, and a
  base-pinned run still refuses a `-R` box. Evidence for this unit files under
  `test/fixtures/recordings/7050tx-64-r-4.28.13.1M/`, since `targetSlug` derives the directory from what
  the device reported.
- **Live-lane behaviour change:** `requireScratchInterface(target, options?)` now refuses the
  `hardware` target class with `EAPI_HARDWARE_WRITE_FENCE` unless the caller states
  `{ hardwareSessionProbe: true }` — which only `src/hw-session-probe.live.test.ts` does, behind its own
  consent chain. Before this, an unscoped `npm run test:live` against a switch let the **lab** corpus
  stage real lines on the declared scratch port (`switchport mode trunk`, trunk allowed/native,
  `default interface Ethernet22`); only the DR-126 full-write families self-refused. Nothing was ever
  persisted (`copy run start` stays mechanically refused), and the exempt lane's name vetting is
  unchanged. Both guards are mutation-checked.
- `docs/HARDWARE-CAPTURE.md` corrected against measured device behaviour: the trust set is three
  variables, not a choice of two — the eAPI cert is `CN=self.signed` with **no SAN**, so a fingerprint
  pin alone still dies on chain verification and an IP host additionally needs `EAPI_SERVER_NAME`; the
  pin parser accepts OpenSSL's colon form but not its printed `Fingerprint=` label; batch 1/2/3 are now
  scoped to their own files; and a `show configuration sessions` cleanup step was added for sessions a
  dead run leaves behind.

### Fixed — resource readers the first EXECUTED live corpus found wrong (cEOS-lab 4.28.14M, 2026-11-08; DR-128 + §5 row 230)
- `vrrp`: `preemptDelayMin` / `preemptDelayReload` now read from the line the device actually keeps —
  4.28.14M folds both seconds onto ONE line (`vrrp N preempt delay minimum 150 reload 0`, each single-half
  write preserving the other), while the ported upstream regexes end-anchored each half and returned
  undefined on the very device those writes succeeded against. Upstream's own `$`-anchored regexes never
  met a real device; parity was kept for the writes only.
- `bgp.neighbors`: only the BARE `neighbor X next-hop-self` line votes the knob. 4.28.14M renders
  `no neighbor X next-hop-self receive-only`, `… source-interface` and `… received-evpn-routes
  route-type ip-prefix` as standing negative sub-feature lines — a shape-anchored probe was voting
  `nextHopSelf` false even immediately after a successful positive write.
- Live-lane behavior (not library API): the lab endpoint is now a run-owned literal-loopback byte relay
  instead of a Docker-published port (DR-128(a)), the live child receives the full TLS trust triple
  `EAPI_CA_FILE`+`EAPI_FINGERPRINT`+`EAPI_SERVER_NAME` (DR-128(b) — required because cEOS serves a
  SAN-less `CN=self.signed` certificate), and the CI live job EXCLUDES the two hardware-capture runners
  rather than counting them as skips (DR-128(c)).
- Lab-harness bring-up (DR-129, §5 row 231): the mgmt bridge subnet is create-verified-retried against the
  live host's route table, the candidate pool leads with the uncontested `192.168.255.0/24` band, and the
  readiness probe fast-fails `mgmt-route-lost-mid-run` / `mgmt-path-owned-by-host-nat` instead of burning
  the whole window — with relay-vs-direct peeks and `route: live|BROKEN` in the refusal diagnostics.

## [0.1.0] — 2026-11-08

First stamped release of the port. The public surface is the `exports` of `index.ts` (browser-safe
core) and `node.ts` (Node-only transports/profiles/TLS material), plus the `testing`/`node/testing`
harness entries (DR-021/DR-002) — `src/internal/**` is not API (DR-040).

### Added — protocol + client core (M1–M7)
- JSON-RPC wire layer over `runCmds`: request-id policy (DR-017), timeout budget (DR-019), redaction
  of enable inputs on every logging path (DR-011), per-command error envelopes surfaced as typed
  errors with the device's own codes (DR-010), and the `1003 → format:'text'` fallback reported
  explicitly as `fellBack` instead of pyeapi's silent re-send (DR-012).
- Transports: `https` (strict TLS by default, cert pinning + CA + optional SNI), `http` with an
  explicit insecure opt-in gate, cookie-session kinds, Node-only `unix` / `http-local` /
  client-certificate kinds — each with its own trust preconditions (DR-013/DR-014/DR-018).
- `eapi.conf` profiles: parser + store that keep problems as values (issue objects carry line
  numbers), the Node search path (`$EAPI_CONF`, `~/.eapi.conf`, `/mnt/flash/eapi.conf`), tags, and a
  `createNodeFor`-style lookup that never silently falls back to localhost (DR-038, §5 rows 55–59).
- `Node` command layer: `runCommands/exec/configure/configureVariants`, cached config reads with
  `refresh()`/`autorefresh` semantics, `section()`/`getBlock()`/`chunkConfig()` over one memoized
  parse per write (DR-026/DR-030), the resource registry (DR-006/DR-052), typed `version` parsing.
- Config sessions: named, journaled, with an explicit state machine (`open/diffed/committed/aborted/
  lost/finished`), `diff()` forced to text, `validateChanges()` dry-run via the device's
  `verifyConfig`, orphan recovery scoped to the name prefix (DR-022/DR-023/DR-024/DR-025).
- Text-config engine (M6): section-aware chunker, keyword/value extractors with line-boundary
  refusal (`{ cmd, input }` is the only multiline form — DR-015), and the shared
  `parseConfigBlock` field-map shape (M7) — its keyword extractors `valueAfterKeyword`/
  `valuesAfterKeyword` are public via the index entry as of the 0.1.0 wrap-up.

### Added — resources (M8–M11, wave 2, wave 3)
`system`, `vlans`, `switchports`, the M10a interface facade (`BaseInterface` + per-kind grammar),
`users`, `ntp`, `acl` (standard/extended), `varp`, `stp`, `ipinterfaces`, `vrfs`, `staticroute`,
`mlag`, `ospf`, `bgp`, `routemaps`, `vrrp` — each ported verb-for-verb against pyeapi's command
texts with our divergences owned in the ledger rows they cite. Argument guards reject what pyeapi
would interpolate (`assertVlanId('20')` etc., DR-053). Capability probing (`probeCommands`) runs
candidate CLI inside a throwaway session that always aborts; support verdicts are a client-side
cache the caller invalidates — no hard-coded feature matrix (DR-032/DR-033).

### Added — testing + evidence lanes (M12)
- `testing` entry: `MockTransport` (production parse/ids under test), `createFakeNode`, wire-level
  fakes, and the recorder/replay pair with an identity envelope that **separates container from
  hardware evidence mechanically** (DR-043: a cEOS recording cannot be filed as a 7050TX-64
  fixture; `targetSlug` enforces it).
- The cEOS-lab harness (`lab:up|probe|run|fixtures`): disposable 4.28.14M containers, pinned
  identity/fingerprint, provisioned capture runs, live-suite child env with explicit consent,
  `--no-full-write` scratch-only mode, `--capture-via` transport fallback for the fixtures lane only
  (DR-122/DR-123). 30 redacted capture files committed; a further 19-command hardware inventory
  catalog is built and waiting for its first switch session (DR-124/DR-125,
  `docs/HARDWARE-CAPTURE.md`).
- Live guards: `EAPI_LIVE` opt-in with a printed skip reason per unmet condition (DR-034), two
  target classes (`lab` loopback-only by default; `hardware` with no defaults at all, https-only,
  exact SKU/image pins, consent echo), read-only + scratch gates, persistence ban mechanical at
  every write seam (DR-035/DR-126).
- The full `test/system/*` live corpus (17 suite files, 250 cases) compiled, gated, and
  collection-verified; device execution is pending the first green lab/CI run (see below).

### Documentation guarantees
- `docs/PLAN.md` / `STATUS.md` / `MIGRATION.md` (229 ledger rows) / `DECISIONS.md` (DR-001…DR-127 at this stamp)
  are the source of truth for what is ported, diverged, or blocked.
- **`npm run docs:check`** (and unit-project inclusion): every TypeScript fence in `docs/USAGE.md`
  is extracted, wrapped with ambient declarations for the prose's free variables, and type-checked
  by the real `tsc` against `src/` — docs can no longer drift from the shipped surface.

### Known limitations at this stamp
- The package is **private** (`private: true`); no npm publish of 0.1.0 was performed. The
  `v0.1.0` tag is local per the release decision.
- No physical 7050TX-64 captures exist yet: every committed `recordings/` file is a container
  capture or a hand-authored example clearly marked as such; hardware support claims stay open
  items (DR-043, STATUS §3).
- The first *executed* device run of the live suite corpus is pending (trusted CI runner not yet
  registered; this host's docker flake documented in row 228).
- `ShowContracts` ships with **no default members by design** — typed `show()` is an augmentation
  surface (USAGE §4); the webui's own augmentations live in `arista-webui/src/eapi/show-contracts.ts`
  (4 of 5 screens' shapes; `lag` waits on a hardware capture).
- M10b/M10c (per-interface write grammar completion) and the Playwright cEOS E2E lane remain
  open on their issues (#12, #91).

[Unreleased]: https://github.com/svaj/vibe-arista-webui/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/svaj/vibe-arista-webui/releases/tag/v0.1.0
