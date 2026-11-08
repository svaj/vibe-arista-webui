# Changelog

All notable changes to `@devhax-heavy-industries/arista-eapi` are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows
[DECISIONS.md DR-040](./docs/DECISIONS.md#dr-040--versioning-changelog-breaking-changes): `0.x.y`
while pre-1.0, and **every deliberate divergence from upstream pyeapi gets its own row in
[MIGRATION.md §5](./docs/MIGRATION.md#5-semantic-divergences-worth-reviewing)** rather than a
surprise here — this file records what shipped, the migration map records what changed under you.

## [Unreleased]

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
