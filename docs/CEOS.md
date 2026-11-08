# cEOS lab for integration, live, and browser E2E tests

## Status and scope

The local Arista distribution contains **cEOS-lab 4.28.14M** at
`/home/svaj/development/arista/cEOS/cEOS-lab-4.28.14M.tar`, with vendor installation
instructions in `cEOS-lab-README-generic.txt` in the same directory. The vendor README
uses 4.21.0F as an example; use the actual local image and version below.

This is the preferred **live** target for tests that need real EOS software.
(The physical 7050TX-64 is a different lane with stricter gates — its addressing rules, capture
catalog, probe-spec policy and session-day runbook live in
[`arista-api-client/docs/HARDWARE-CAPTURE.md`](../arista-api-client/docs/HARDWARE-CAPTURE.md),
DR-124/DR-125. Container answers never settle a hardware question, DR-043 — and since this month a
switch session can address the box only through the `hardware` guard class, never through a lab env.)
The harness (`scripts/ceos-lab.mjs`, npm `lab:*` + `fixtures:refresh`), the live guard,
and the recorder seam shipped under M12 (#14); the Playwright browser lane is still
separate opt-in work (#91). The recipe below mirrors what the harness automates and
was verified against this image on 2026-11-04 and 2026-11-07. Existing `npm test` runs
stay offline and must not start Docker or contact EOS.

| Target | What it can establish | What it cannot establish |
|---|---|---|
| MockTransport + recorded fixtures | Deterministic errors, parsers, command generation, UI states | Current EOS behavior |
| cEOS-lab 4.28.14M | Real eAPI/auth, JSON/text replies, config sessions, supported VLAN/interface operations, browser-to-proxy-to-EOS flows | Exact 4.28.13.1M behavior or 7050TX-64 hardware support |
| DCS-7050TX-64 / 4.28.13.1M | Exact target schemas, licensing, platform limits, physical interfaces and ASIC-dependent behavior | Disposable, unrestricted CI write target |

cEOS is real EOS software, not a mock switch. Passing a container test is not evidence
for hardware forwarding, throughput, optics/PHY, TCAM/FlexProfile, LAG limits, hardware
VXLAN support, or license availability on the physical switch. Keep target-specific
fixtures and capability results separate. Patch-release differences must be investigated,
not normalized away to make tests pass.

## Manual lab setup (trusted Linux host only)

Prerequisites: an authorized copy of the image, Docker with permission to run privileged
containers, sufficient host resources, and unused lab names/ports. Check the image's
architecture and host/kernel/cgroup compatibility during the first boot; the generic
README does not establish those requirements for this host.

**Security boundary:** the vendor recipe requires `--privileged`; this gives the container
extensive host access. Use a dedicated trusted lab host/runner. Never mount the Docker
socket or host credentials, use host networking, attach physical/production interfaces,
or run untrusted PR code on this runner. Image access is subject to Arista's terms:
do not commit or publicly redistribute the tar, imported image, signatures, or credentials.

The following is a manual recipe, not a command to run as part of this documentation
change. It intentionally creates one node; stop if any names already exist.

```bash
docker import /home/svaj/development/arista/cEOS/cEOS-lab-4.28.14M.tar ceosimage:4.28.14M
docker network create --subnet 172.31.77.0/24 vibe-ceos-mgmt   # any UNUSED pinned private /24
docker network create vibe-ceos-data1
docker network create vibe-ceos-data2
docker create --name=vibe-ceos --privileged \
  --network=vibe-ceos-mgmt --ip=172.31.77.10 \
  -p 127.0.0.1:8443:443 \
  -e INTFTYPE=eth -e ETBA=1 -e SKIP_ZEROTOUCH_BARRIER_IN_SYSDBINIT=1 \
  -e CEOS=1 -e EOS_PLATFORM=ceoslab -e container=docker \
  -i -t ceosimage:4.28.14M \
  /sbin/init systemd.setenv=INTFTYPE=eth systemd.setenv=ETBA=1 \
  systemd.setenv=SKIP_ZEROTOUCH_BARRIER_IN_SYSDBINIT=1 \
  systemd.setenv=CEOS=1 systemd.setenv=EOS_PLATFORM=ceoslab \
  systemd.setenv=container=docker
docker network connect vibe-ceos-data1 vibe-ceos   # BEFORE start — after create is fine
docker network connect vibe-ceos-data2 vibe-ceos
docker start vibe-ceos
docker inspect --format '{{with index .NetworkSettings.Networks "vibe-ceos-mgmt"}}{{.IPAddress}}/{{.IPPrefixLen}}{{end}}' vibe-ceos
docker exec -it vibe-ceos Cli
```

**NIC topology (settled 2026-11-07, docker 29.9.2, this image):** cEOS binds kernel
NICs to front-panel Ethernet ports **at boot only**. A node that boots with one NIC
presents ZERO Ethernet ports — `interface Ethernet…` stanzas are accepted as orphan
config and answered as `% Interface does not exist … until the module is inserted` —
and `docker network connect` on a RUNNING node inserts nothing. The two
`vibe-ceos-data*` bridges above therefore exist to give the configured-capture batch
(#62) real ports, and they must be attached **before** `docker start`. Attach exactly
ONE network (mgmt) at `docker create` and `connect` the data bridges afterwards
(verified 2026-11-07: three-attachment `docker create` made the published port
forward to an endpoint EOS had taken off the kernel — 30/30 ECONNRESET with the
EOS-side HTTPS server reported `running` — while the single-create + connect-before-
start shape, matching the vendor README, kept 10/10 TLS fingerprint probes on the
loopback port and survived a full representative-config commit). The second lesson
from the 2026-11-04 flap is also on record: eAPI `protocol https` is SHUT until
bootstrap, so probes before the user/API setup fail on ANY topology — bootstrap
first, then probe.

**Update (2026-11-08, DR-128(a)) — the vendor shape broke again on this host, and the harness no longer
asks Docker to publish at all.** After a WSL2 restart (same docker 29.9.2, kernel
6.18.33.2-microsoft-standard-WSL2), even this single-create + connect-before-start topology resolved
the `-p 127.0.0.1:<port>:443` proxy target to the container's **data1** bridge endpoint (visible in
the process table as `docker-proxy … -container-ip 172.19.0.2`), which cEOS owns as a front-panel
Ethernet NIC with no eAPI listener — every handshake reset at the Docker hop while EOS reported
`Hits: 0, Bytes in: 0`, and a host-direct TLS connect to the mgmt-bridge IP answered normally.
Docker's CLI cannot qualify `-p` with the container-side endpoint, so `up` creates the container
**without `-p`** and runs its own detached, run-owned relay (`scripts/eapi-port-forward.mjs`:
literal-loopback bind, byte-only — the pinned certificate verifies end-to-end through it — killed by
teardown behind a `/proc` cmdline ownership check, self-extinguishing on the run's state-file watch
plus max-life/idle limits). Probe refusals now print relay-vs-direct certificate peeks and the
forwarder's liveness, so the next host flap is attributed mechanically. A just-booted node's first
probes may also show `ECONNREFUSED` upstream while CApi binds; the bounded window absorbs it
(recovered at ~30 s in run 9).

**The second WSL2 lesson (same day, **DR-129**) — route *reconciliation* can void the bridge.**
This host runs WSL >=2.6 **mirrored-mode** networking (fingerprints: `iif ethN ipproto … lookup local`
policy rules, mirrored Windows adapters as `eth0..ethN`). In that mode Windows' HNS owns pieces of
`172.16.0.0/12`, and its route reconciliation can silently strip the connected route dockerd just
installed for a **freshly created** bridge: `docker network create --subnet 172.31.193.0/24` succeeds,
the bridge device exists with a carrier once the container attaches, yet `ip route get 172.31.193.10`
answers `via <LAN-gateway> dev ethN` — packets go to the physical network and every relay attempt
dies `EHOSTUNREACH`. It is per-subnet luck, not a per-octet rule: `.70/.132/.189` booted fine while
`.159/.193`-class subnets died, in two local runs **and** the first trusted `workflow_dispatch`
(actions run 42525119847, dispatched exactly this way). Stale `br-` devices + routes surviving WSL
restarts are the same phenomenon's leftovers (an earlier picker fix excludes CIDRs already in the
host's route/addr tables, which covers that class). The harness now defends mechanically: `up`
creates mgmt-bridge candidates — **`192.168.255.0/24` first**, then the documented `172.31.16-255` pool,
then a `10.177.16-255` fallback —
and keeps one only when its connected route is genuinely live per `ip route show` + `ip route get`
(`verifyMgmtBridgeRoute`), rm-ing and re-drawing otherwise (bounded, 40 tries, refusal cites the
reason list); during probing, two handshake deaths trigger a route re-check and a fast refusal with
reason `mgmt-route-lost-mid-run` instead of waiting out the timeout window, and a second check refuses
with `mgmt-path-owned-by-host-nat` when the route reads live but a **direct** connect to the mgmt IP
answers `EHOSTUNREACH`. Probe diagnostics print `route: live|BROKEN`. That second case is why the band
order matters: actions run 42528431866 verified `172.31.77.0/24` as `route: live` at create **and** at
refusal, still got 29 × `Client network socket disconnected before secure TLS` with EOS `Hits: 0` — a
route the kernel table vouches for can be HNS-eaten end-to-end — while the same host pinned to
`192.168.255.0/24` probes ready in 0.2 s. Treat a verified route as necessary, not sufficient. The
host-side fixes: `[wsl2] networkingMode=NAT` in
`%UserProfile%\.wslconfig` + `wsl --shutdown` (restarts this session; VS Code reconnects), or run the
`eos-lab` runner on a native Linux host, where the class does not exist. **Mirrored-mode WSL2 is not
a supported lab-runner host** unless NAT is set.

In EOS, inspect `show version`, `show interfaces status`, and
`show management api http-commands`. Confirm the actual management/data interface
mapping rather than assuming physical port counts or that Docker `eth1` is `Ethernet1`.
Allow several minutes for EOS agents to start. If ZTP blocks bootstrap, resolve it only
inside this disposable node; `zerotouch disable` can trigger a reboot, so reconnect and
recheck readiness before proceeding.

Configure a throwaway lab-only user interactively (replace `<lab-only-password>`; do not
reuse a switch or personal password, or save the transcript):

```text
enable
configure terminal
username eapi-test privilege 15 role network-admin secret <lab-only-password>
management api http-commands
   protocol https
   no shutdown
end
```

These bootstrap commands are verified on cEOS-lab 4.28.14M (2026-11-04/07 runs): the
user + `management api http-commands` pair above is sufficient for the harness path —
no `interface Management…` addressing is configured in EOS, because the Docker bridge
carries the management NIC's address and the published port is the only trusted entry
point. They are a provisioning exception to test-session rules and apply **only to the
disposable container**. Do not run `copy running-config startup-config`; bootstrap
afresh after recreating the lab. Do not enable plaintext HTTP or expose the
unauthenticated localhost API.

Establish HTTPS trust from the local container/CLI, not from an unverified network peer.
Inspect the configured certificate location (4.28.13.1M uses
`/persist/secure/capi.pem`), securely extract only its **public certificate**, and use
a trusted CA/certificate or pin with matching hostname/SAN validation. Do not copy the
whole PEM into artifacts: it may contain a private key. Do not globally disable TLS
verification; see [CONNECTIVITY.md](../arista-api-client/docs/CONNECTIVITY.md).

Readiness requires a successful **authenticated POST**, not just a running process or
an open port. Once a matching trusted certificate is configured, a manual probe is:

```bash
curl --fail-with-body --cacert /path/to/lab-public-ca.pem --user eapi-test \
  -H 'Content-Type: application/json-rpc' \
  -d '{"jsonrpc":"2.0","method":"runCmds","params":{"version":1,"format":"json","cmds":["show version"]},"id":"ceos-ready"}' \
  https://localhost:8443/command-api
```

`curl` prompts for the lab password. An HTTP 200 alone is insufficient: require no
JSON-RPC `error`, the expected result shape, cEOS model, and version **4.28.14M**.
Use a bounded readiness timeout; on failure, retain redacted Docker/EOS diagnostics
and fail the job rather than proceeding with fixtures or another switch.

**Capture transport caveat (2026-11-07, DR-123):** this host's docker (29.9.2) has been proven
unreliable port-forwarding to cEOS containers that hold more than one Docker network — and #62's
captured models REQUIRE the extra data NICs (boot-bound front-panel ports). Rather than fake the
lab, `fixtures` may now collect the same catalog through `docker exec <container> Cli -p 15`, stamping
`cliCapture` + transport + the eAPI refusal reason into every fixture envelope (identity guards
re-run first). The live test lane never takes that shortcut: readiness for LIVE suites still
means an authenticated POST, here included.

## Planned harness contract and safety

Use the API client's existing opt-in live lane
([TESTING.md](../arista-api-client/docs/TESTING.md)), with:

- `EAPI_LIVE=1`, explicit `EAPI_HOST`, `EAPI_USER`, and `EAPI_PASS` (or `EAPI_PASS_VAR`).
  The harness must support the published host/port, e.g. `localhost:8443`, without
  silently defaulting to port 443 or a real-switch profile. *(Shipped shape, DR-128(a): the
  endpoint is a **harness-owned loopback relay** to the container's pinned mgmt address — no
  Docker-published port — and the live child receives the full trust triple
  `EAPI_CA_FILE`+`EAPI_FINGERPRINT`+`EAPI_SERVER_NAME` because the cEOS certificate has no SAN.)*
- `EAPI_TARGET_CLASS=lab` for writes and `EAPI_SCRATCH_INTERFACE` discovered from the
  container's interfaces for interface writes.
- An exact allow-listed endpoint in the planned `test/device-allowlist.json`, including
  port and target kind (`ceos` versus hardware). Check `show version` against the
  expected model and exact image version as well as the existing 4.28 train guard.
  `EAPI_TARGET_CLASS=lab` alone does not prove a target is disposable.
- Named config sessions, test-owned VLANs/interfaces, no management-path mutations,
  no startup-config persistence, and `abort` in `finally` for every uncommitted session.
  Commit tests must undo running-config changes explicitly or discard their disposable
  container; abort cannot undo a committed session.
- Single-flight execution **per endpoint**, both between jobs and within Vitest/Playwright.
  Parallel jobs need separate containers, networks, and published ports.

Local opt-out reports an explicit skip reason. An explicitly requested CI cEOS/E2E job
must fail on missing image, credentials, readiness, trust, target mismatch, zero executed
tests, or teardown failure; it must never fall back to mocks or the physical switch.
Normal runs must not include the separate persistence-test exception in TESTING.md.

Record fixtures under `recordings/ceos-4.28.14M/` separately from
`recordings/7050tx-64-4.28.13.1M/`. Record exact version, model, image identity/checksum,
commands/format, and topology/interface mapping with each capture. Redact passwords,
enable input, keys, tokens, serials/MACs/addresses where identifying, and config secrets
before saving fixtures, logs, traces, or screenshots. Refresh is explicit and reviewed;
never overwrite hardware fixtures with cEOS recordings.

## Browser E2E and CI plan

1. Keep Vitest component tests mocked/offline. Add Playwright separately when the UI
   has an eAPI-backed workflow; no new runner is installed by this documentation change.
2. Provision cEOS, pass the readiness gate, then start the frontend with its loopback
   same-origin proxy targeting **only** the lab endpoint. Credentials stay in the proxy
   process, not browser storage or traces. Validate trusted upstream TLS.
3. Exercise browser → proxy → real eAPI: version/status read, VLAN/interface read,
   preview/diff → abort, and an isolated commit → read-back → cleanup cycle. Assert
   EOS state as well as UI messages. Test auth/unreachable/command errors explicitly;
   fault injection or mocks may supplement but do not count as real-cEOS coverage.
4. Report Playwright and API live results separately. A passing mock E2E run must not
   be labeled cEOS coverage. Capture redacted diagnostics before teardown on failure.
5. Initially use explicit trusted `workflow_dispatch` on a dedicated Linux runner with
   authorized image access. Keep ordinary PR checks offline. Any future automatic
   cEOS lane needs a trusted-code policy, image licensing/access review, and isolated
   privileged runner; never expose image/host credentials to fork PRs.
6. Cleanup in an always/finally path, including failed readiness or tests. Track resource
   ownership per run; remove only that run's containers/networks, not shared resources.

For the manual names above, after diagnostics are collected and only if this run created
them:

```bash
docker rm -f vibe-ceos
docker network rm vibe-ceos-data1 vibe-ceos-data2 vibe-ceos-mgmt
```

Do not use Docker-wide prune commands. Remove any run-owned secret files separately.
Retain an imported image only as an authorized local cache, never a public CI artifact.
Future two-node labs may test supported MLAG/routing control-plane behavior using isolated
Docker links, following the vendor recipe; they still do not validate physical-switch
forwarding or platform support.
