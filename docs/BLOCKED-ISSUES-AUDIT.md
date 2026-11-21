# Blocked Issue Audit (2026-11-19)

This audit covers the open `status:blocked` Web UI issues on 2026-11-19: #87, #88, #89, and #159. It separates stale evidence blockers from real remaining gates and names the command an operator can run next.

## Evidence-run results (2026-11-20, cEOS-lab 4.28.14M)

All three container lanes this audit asked for have now run GREEN on disposable cEOS via
`scripts/run-blocked-evidence.sh` (harness bugs found and fixed by the runs themselves —
peer-bridge double-create and a forwarder watchdog race in `scripts/ceos-lab.mjs`):

| Lane | Artifact | Result |
|---|---|---|
| #87 two-node OSPF | `docs/evidence/ospf-two-node.ceos.json` | 4 passed. Adjacency formed; route blast withdraw 67 ms / restore 6170 ms; adjacency blast drop 32636 ms / reform 12279 ms |
| #88 STP mode change | `docs/evidence/stp-mode-change.ceos.json` | 4 passed / 1 skipped. Boot `mstp` → committed `rapid-pvst` answers camelCase `rapidPvst`; mode change replaces MST0 with per-VLAN instances; flip 67 ms, reverse-stable 81 ms; sessions net-zero |
| #89 commit timers | `docs/evidence/commit-timer-persistence.ceos.json` | 6 passed / 2 skipped (device-bound name-shape stubs, by design). `pendingCommitTimer` + `commitBy` listed; unattended revert fired (122 s); re-entry refused (`% Cannot enter session … (pending commit timer)`) so the confirm path is UNREACHABLE on the container; exactly one pendingCommitTimer per device; a later session opens fine while a timer is armed |

Device facts the runs corrected in the suites: EOS reports the STP protocol camelCase (`rapidPvst`,
not `rapid_pvst`); `configure session <name> abort` (exec mode, `node.abortSession`) DOES end a
pendingCommitTimer session and reverts its diff. Container facts only — DR-043 still applies to
every hardware claim.

Agent-side implementations landed alongside the evidence: #88's operational STP panel
(`show spanning-tree` soft read), #87's read-only Routing status screen
(`arista-webui/src/features/routing/`), and #89's `pendingCommitTimer` surfacing in the
TransactionCenter session rows. #159's hardware CORS capture script
(`scripts/capture-hardware-cors.sh` + `cors-hardware.live.test.ts`) is ready for an operator run.

## Summary

| Issue | Capture status | Agent can unblock now? | Operator-dependent remainder |
|---|---|---|---|
| #87 Routing editors | Hardware/cEOS read + grammar evidence is largely complete; BGP monitoring is a confirmed hardware/platform negative | Re-scope and split issue offline; prepare read-only OSPF/route-map specs | OSPF/L2 blast evidence on a proven two-node cEOS host, then deployment/blast-radius policy decision |
| #88 STP global mode | STP/detail captures and `mstp`/`none` grammar are complete | Re-scope blocker to guard design and split MST-region policy | cEOS mode-change blast on a valid container host, then reconvergence/drain/MST-region owner decision |
| #89 Transaction persistence | Session fields, timers, and cEOS persistence answers are captured; client/UI transaction staging is no longer the blocker | Re-scope remaining issue to verified persistence rollback/policy | cEOS timer/name mechanics on a valid host; physical save/replace/rollback still requires an explicit operator authorization decision |
| #159 Browser-direct static mode | Exact CORS command/model support is known, but hardware preflight is not captured | Write the reversible evidence runner and static-mode security spec questions | Exact-origin hardware CORS capture, browser trust decision, and a credential-placement waiver/story |

## #87: Routing Config Editors

### What Is Already Settled

- The physical DCS-7050TX-64-R / 4.28.13.1M and cEOS captures include VRRP, OSPF, route-map, and routing-related models.
- OSPF config composition staged successfully on hardware in abort-only sessions.
- BGP config composition staged successfully on hardware, but `show bgp summary` and `show bgp neighbors` answer `% Not supported` on the target. A BGP status tab has no device read surface on this SKU.
- Route-map JSON/model evidence exists.
- The saved hardware posture is `no ip routing`; the audit does not toggle it.

### What I Can Unblock Without Assistance

- Rewrite #87 as protocol-specific scopes instead of one umbrella editor.
- Close or explicitly remove BGP status from the target-scope plan while retaining config grammar as future licensed-target work.
- Prepare read-only OSPF and route-map requirements now that the model blockers are stale.
- Run no physical routing command and make no deployment claim.

### What Still Needs a Run or Decision

**RUN DONE 2026-11-20.** The two-node OSPF lane ran green (`docs/evidence/ospf-two-node.ceos.json`):
adjacency formed, route blast 67 ms withdrawn / 6170 ms restored, adjacency blast 32636 ms dropped /
12279 ms reformed. The read-only Routing status screen shipped. The remaining owner decision is
deployment posture and per-protocol blast policy. A green lab does not establish how this single
physical switch's routing is allowed to fail.

**VRRP SLICE LANDED 2026-11-21.** DR-149's permissive policy + the "each protocol = its own screen"
rule unblocked the first per-protocol editor: `#/routing/vrrp` (`VrrpManager` + `VrrpManagerView` +
`vrrp-rules.ts`, `docs/SPEC-vrrp-editor.md`). Create/edit/delete of IPv4 virtual routers, bounded
field set (advanced fields read-only), every command line composed through the CLIENT's dry-run
seam (`{ run: false }` on each `node.vrrp` setter — the strongest pin in the repo, no convention
deviation unlike DR-151; the one literal exception is the client-pinned `no vrrp <n>` delete line).
The failover confirm is honest-unmeasured copy (owner intake 2026-11-21: no VRRP blast has been
measured on any target; no fabricated number). `ip routing` stays untouched. OSPF, route-map, and
BGP editors remain open slices (BGP also has no device read surface on this SKU).

**ROUTE-MAP SLICE LANDED 2026-11-21.** The second per-protocol editor: `#/routing/routemaps`
(`RouteMapManager` + `RouteMapManagerView` + `routemap-rules.ts`, `docs/SPEC-routemap-editor.md`,
DR-153). Full clause lifecycle — create, match/set statement-list replace (the client's diff),
description (the clear-then-set pair), continue set/clear, clause delete — staging through the #141
coordinator. The `routemaps` client is SEND-ONLY (no dry-run arm like `vrrp.ts` has), so every
staged line mirrors the client's own `routemaps.test.ts`-pinned verb text — the established
StaticRoutes/Ntp convention, NOT a DR-151-style capture deviation. Match/set keywords are free
text, device-authoritative (owner intake 2026-11-21; only `set community <v:v>` is
hardware-proven — batch `unblock-route-map-grammar`). The confirm states the SOFT `ospf.get()`
reference status in three arms (referenced / no-visible-reference / read-failed-treat-as-
referenced) and quotes the two-node withdrawal proxy (67 ms / 6170 ms) as what it is: a container
advertisement withdrawal, NOT a route-map edit (DR-043). Inertness of an unreferenced map stays a
stated inference, never a measurement. `ip routing` stays untouched. OSPF and BGP editors remain
open slices (BGP additionally has no device read surface on this SKU).

### Do Not Do

- Do not toggle `ip routing` on the physical switch as an incidental probe.
- ~~Do not commit OSPF/BGP/VRRP or redistribution changes on hardware.~~ (Narrowed by DR-149: the
  owner's permissive policy protects live traffic undisturbed; incidental commits are still out, but
  the operator's deliberate, confirm-gated product use — e.g. committing a staged VRRP change from
  `#/routing/vrrp` — is the only commit path and is allowed.)
- Do not represent a configured cEOS route model as 7050TX behavior (DR-043).

## #88: STP Global Mode Editor

### What Is Already Settled

- `show spanning-tree` and detail captures exist.
- The client-supported physical mode values (`mstp` and `none`) have staged/aborted evidence.
- The remaining blocker is no longer command presence or a missing model.

### What I Can Unblock Without Assistance

- Reword #88 to a reconvergence guard-design issue.
- Keep per-port STP guards separate from global mode mutation.
- Specify a mode-change warning and transaction confirmation contract without claiming a decision.

### What Still Needs a Run or Decision

**RUN DONE 2026-11-20.** The disposable STP blast lane ran green
(`docs/evidence/stp-mode-change.ceos.json`): the suite committed and restored a cEOS mode change
(`mstp` → `rapid-pvst`, answer spelling camelCase `rapidPvst` — a device-fact fix), MST0 was
replaced by per-VLAN instances, flip 67 ms / reverse-stable 81 ms, sessions net-zero. The
operational STP panel shipped in the webui. The owner still must decide:

1. what reconvergence/drain warning is sufficient;
2. whether an optional port-hygiene gate is required;
3. whether MST region name/revision/instance mapping is exposed in the same editor or a separate slice.

**SPEC + BUILD DONE 2026-11-21.** All three were answered in DR-149 (facts-at-confirm; no hygiene
gate; same editor), the intake settled the build shape (mode set includes `rapid-pvst` with a
container-only-acceptance disclosure; new route `#/stp/global`; webui-only raw-line composition —
no client slice), and `docs/SPEC-stp-global-editor.md` shipped with the screen: `StpGlobal` +
`StpGlobalView` + the capture-pinned `stp-global-rules.ts`, staging through the #141 coordinator
with DR-149 blast-fact confirms. `#/stp` keeps zero mode controls (its note now points at the new
route). The recorded convention deviation (command text pinned to captures, not client verbs) is
DR-151. What stays open on the device: `rapid-pvst` acceptance on the 7050TX-64-R (the disclosure
+ refusal fallback cover it until a run answers), region reconvergence timing on this SKU, and the
`no instance …` removal spelling (removals stay a console operation).

### Do Not Do

- Do not commit a global STP mode change on the physical switch merely to answer a CLI question.
- Do not fold global mode mutation into the per-port guard screen.

## #89: Transaction Persistence / Rollback

### What Is Already Settled

- Pending-session fields and maximum session counts are captured on both target classes.
- Physical commit-timer acceptance/revert behavior and later-session behavior have recordings.
- A cEOS run already established: `copy running-config startup-config` accepts, `configure replace` reaches the file operation for an absent path, and EXEC `rollback clean-config` refuses.
- #141's app-wide running-config transaction workflow is implemented independently; it does not save to startup or expose rollback/timers.

### What I Can Unblock Without Assistance

- Keep the UI contract running-config-only and documented.
- Re-scope #89 around persistence policy and exact remaining verbs instead of old capture gaps.
- Keep session-name client bounds distinct from any future device-bound discovery.

### What Still Needs a Run or Decision

**RUN DONE 2026-11-20.** The disposable timer suite ran green
(`docs/evidence/commit-timer-persistence.ceos.json`, DR-148): the container accepts
`commit timer`, lists `pendingCommitTimer` + `commitBy`, an unattended revert fires (~122 s),
re-entry into an armed session is refused (so the confirm path is unreachable on the container —
the captured exit is exec-mode abort, which reverts the diff), exactly one pendingCommitTimer per
device, and a later session opens fine while a timer is armed. The TransactionCenter now surfaces
the armed-timer semantics in its session rows. The run does not answer or authorize physical
`copy running-config startup-config`, `configure replace`, or rollback behavior.

**RUN DONE 2026-11-21 (HARDWARE, owner-executed).** The persistence lane —
`scripts/capture-hw-persistence.sh` + `persistence-hardware.live.test.ts`, built after DR-149
recorded the owner's authorization ("the copy run start is fine, a minimal change can be run via
configure replace and rollback… so long as its scripted and I can review prior to executing it") —
ran green on the physical 7050TX-64-R (`docs/evidence/persistence-hardware.json`, DR-150):
`copy running-config startup-config` ACCEPTED on the box (210-line startup, mtime flip),
session-scoped `rollback clean-config` EXISTS on 4.28.13.1M (152-line staged diff, aborted clean),
scratch `Ethernet33` verified unused before any write and left clean. `configure replace` and
`rollback <name>` remain unexercised on hardware — not named in that run's verbs; the
authorization stands for a future `--verbs copy,rollback,replace` run. The run also caught the
ssh-key-comment redaction gap (DR-150).

## #159: Browser-Direct Static Mode / CORS

### What Is Already Settled

- `cors allowed-origin <exact origin>` exists in the model and command vocabulary for this release family.
- Existing hardware captures show CORS disabled / an empty origin list.
- The current relay mode correctly keeps credentials in the Vite process, but it does not solve a static-browser deployment.

### What I Can Unblock Without Assistance

- Add a reversible, exact-origin hardware evidence runner.
- Define the static-mode spec gates and refuse wildcard CORS, disabled TLS, or browser certificate-pin workarounds.
- Keep direct-browser mode out of implementation until the credential/trust decisions are explicit.

### Supervised Evidence Run

First inspect the exact plan:

```bash
scripts/capture-hardware-cors.sh
```

In a supervised physical-switch session, pass the exact origin and TLS trust material, then use `--go`. The script requires a typed model echo, a typed origin echo, and runs `cors-hardware.live.test.ts`, which:

1. verifies exact model/version;
2. checks the origin was absent;
3. commits `cors allowed-origin <exact origin>`;
4. sends a browser-shaped OPTIONS preflight and an authenticated JSON-RPC POST;
5. commits `no cors allowed-origin <exact origin>` in `finally`;
6. verifies the exact origin was removed;
7. writes `arista-api-client/docs/evidence/cors-hardware.json` only after cleanup.

The test does not use `all` or `*`, does not disable TLS verification, and does not print credentials.

### Decisions This Run Cannot Make

- Basic auth in browser JavaScript/local storage still conflicts with DR-027. Hardware CORS evidence does not solve credential placement.
- The browser/OS must trust the self-signed or CA-signed device certificate; a Node pin is not a browser UI decision.
- 4xx CORS behavior and user-facing auth failure still need an explicit UX contract.

## Suggested Issue Actions

Updated 2026-11-20 after the green lanes and the agent-side implementations:

- #87: retain `status:blocked` only for the owner deployment/blast-radius decision. The lane ran green, the read-only Routing status screen shipped (`arista-webui/src/features/routing/`), and BGP stays a recorded negative. Update body to split BGP read-negative, OSPF/route-map review, and owner deployment decision.
- #88: retain `status:blocked` only for the guard-design owner decisions (reconvergence warning, port-hygiene gate, MST-region scope). The blast evidence and the operational STP panel landed.
- #89: retain `status:blocked` for the physical persistence authorization decision only. Remove stale capture claims, link `docs/evidence/commit-timer-persistence.ceos.json` (DR-148), and name the physical save/replace/rollback authorization explicitly as the sole remaining gate.
- #159: retain `status:blocked`; the CORS hardware capture (`scripts/capture-hardware-cors.sh`) is ready for a supervised operator run — label it evidence only, then move to a security/spec review rather than implementation.

## Owner decisions (2026-11-20/21, recorded as DR-149)

All four gates above were answered by the owner:

- **#87 — PERMISSIVE blast policy with one hard line:** "as long as live traffic on my production
  switch is not interfered with, I'm okay with whatever you do." Lab blast scales become confirm
  disclosure, not blockers; the scratch-port discipline and running-config-only contract stay as
  strict as they are because they protect exactly that line.
- **#88 — guard design settled:** F4 confirm carrying the captured blast facts (flip ~67 ms,
  per-VLAN instance replacement, brief interruption on every VLAN, DR-043 scoping); NO port-hygiene
  gate (informational note only); MST region name/revision/instance-mapping in the SAME editor as
  the mode change. The mode editor opens only when that combined spec lands.
- **#89 — persistence verbs AUTHORIZED** ("copy run start is fine, a minimal change can be run via
  configure replace and rollback... so long as its scripted and I can review prior to executing
  it"). The lane is `arista-api-client/src/persistence-hardware.live.test.ts` +
  `scripts/capture-hw-persistence.sh`: dry-run default, printed plan before any consent prompt,
  `replace` requires explicit naming plus its own typed echo, self-restoring plan, rollback verbs
  abort-only. The operator runs it; the typed consents ARE the review gate.
- **#159 — NO stored credentials:** the owner rejects browser-held credentials ("Those shouldn't be
  stored..."). EOS basic-auth over CORS cannot honor that posture (a browser can only send
  `Authorization:` from script-visible sources), so direct-browser/static mode stays
  unimplemented; the relay mode (password in the Vite process only) is the endorsed shape. The
  hardware CORS capture remains available as pure evidence. Run steps: see
  `scripts/capture-hardware-cors.sh --help` (supervised session, exact origin + TLS material,
  typed model/origin consents, `--go`).

## Current Local Run Result

On 2026-11-19 this host reported `kernel.unprivileged_bpf_disabled=0`, so container start is no longer blocked by the former BPF `2` gate. A real STP evidence attempt then reached cEOS bootstrap but failed at the management path on a pinned `10.177.179.0/24` bridge: the connected route existed, ARP for the container IP was `FAILED`, and the endpoint answered `EHOSTUNREACH`. The harness tore the run down.

**Resolved 2026-11-20.** After a host reboot cleared the stale per-/24 HNS route poisoning, all three lanes ran GREEN on this host with the band defaults now in `scripts/run-blocked-evidence.sh` (`192.168.255` single-node, `10.177` split-band two-node) and the two `scripts/ceos-lab.mjs` harness fixes of DR-148 (peer-bridge double-create, provisional state file for the forwarder watchdog). Artifacts: `docs/evidence/{ospf-two-node,stp-mode-change,commit-timer-persistence}.ceos.json`. No further container run is needed for any of the three issues.

No issue should be closed merely because a cEOS command accepted. Container evidence never settles physical 7050TX-64 behavior (DR-043).
