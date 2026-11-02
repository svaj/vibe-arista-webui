# Status — `arista-api-client`

Single source for "where are we". Update **in the same commit** that changes code, then update the
mirrored GitHub issue (see §4). Detailed task lists live in [PLAN.md](./PLAN.md); behaviour changes go
in [MIGRATION.md §5](./MIGRATION.md#5-semantic-divergences-worth-reviewing).

As of 2026-11-01: **planning complete, no code yet.** M0 is the next action.

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
| M0 | Workspace & package scaffolding | `not-started` | — | — | _(see §4)_ | package name undecided (**DR-020**) |
| M1 | Wire protocol core | `not-started` | — | — | | needs `test/fixtures/wire/*.json` authored |
| M2 | Transports | `not-started` | — | — | | depends on M1; cert pinning needs device fingerprint capture |
| M3 | Connection profiles | `not-started` | — | — | | |
| M4 | `Node` command layer | `not-started` | — | — | | |
| M5 | Config sessions & change safety | `not-started` | — | — | | commit-timer semantics unverified; investigate in cEOS, confirm target-sensitive behavior on hardware |
| M6 | Text-config engine | `not-started` | — | — | | capture cEOS 4.28 config text early, keep target-hardware fixtures separate |
| M7 | Resource framework | `not-started` | — | — | | |
| M8 | `system` | `not-started` | — | — | | |
| M9 | `vlans` + `switchports` | `not-started` | — | — | | first demoable slice |
| M10 | `interfaces` (base, ethernet, port-channel) | `not-started` | — | — | | split M10a–c |
| M11 | Capability probe + dry-run | `not-started` | — | — | | needs M5 + M9 |
| M12 | Live suite + fixtures + CI | `not-started` | — | — | | local cEOS image available; needs trusted privileged runner, provisioning/readiness/guards/cleanup; hardware lane separate |
| M13 | Consumption, docs, release | `not-started` | — | — | | includes opt-in Playwright cEOS lane once M12 harness and UI workflow exist |
| W2 | wave-2 modules | `backlog` | — | — | | 9 modules, 111 upstream unit tests to port |
| W3 | wave-3 modules | `backlog` | — | — | | `vrrp`/`bgp`/`ospf`/`routemaps`/VXLAN |

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
`kind:epic` / `kind:module` / `kind:infra` / `kind:question`.

| Issue | Milestone | Status |
|---|---|---|
| [#1](https://github.com/svaj/vibe-arista-webui/issues/1) | umbrella — plan of record | open |
| [#2](https://github.com/svaj/vibe-arista-webui/issues/2) | M0 Workspace & package scaffolding | open |
| [#3](https://github.com/svaj/vibe-arista-webui/issues/3) | M1 Wire protocol core | open |
| [#4](https://github.com/svaj/vibe-arista-webui/issues/4) | M2 Transports | open |
| [#5](https://github.com/svaj/vibe-arista-webui/issues/5) | M3 Connection profiles | open |
| [#6](https://github.com/svaj/vibe-arista-webui/issues/6) | M4 `Node` command layer | open |
| [#7](https://github.com/svaj/vibe-arista-webui/issues/7) | M5 Config sessions & change safety | open |
| [#8](https://github.com/svaj/vibe-arista-webui/issues/8) | M6 Text-config engine | open |
| [#9](https://github.com/svaj/vibe-arista-webui/issues/9) | M7 Resource framework | open |
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
