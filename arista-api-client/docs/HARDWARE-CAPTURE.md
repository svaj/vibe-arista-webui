# Hardware capture lane — the supervised 7050TX-64 session runbook

Status: **implemented, never yet executed** — every byte of switch evidence this repo stores is
still `hardwareEvidence:"none"` (DR-043). This page exists for the one planned **switch session**
(#14 §3): the operator sits at/beside the DCS-7050TX-64 running **4.28.13.1M**, and the harness runs
its read-only inventory plus the reviewed config-session probes against it, live.

Container capture is a different lane with different rules — see [CEOS.md](./CEOS.md) for that one.
Nothing here shares bytes with it: hardware captures land under
`test/fixtures/recordings/7050tx-64-4.28.13.1M/` (`recording.ts` `TARGET_CLASSES`/`targetSlug`
make the crossover a throw, not a convention), while cEOS evidence lives in
`test/fixtures/live/ceos-4.28.14M/` + `recordings/ceos-4.28.14M/`.

## 1. Why the gates read the way they do

Addressing a physical switch is only allowed through `live-guard.ts`'s **hardware class**, which is
deliberately stricter than the lab class (#14 §3, DR-035(e) made two-way):

| Gate | Lab class (`lab`) | Hardware class (`hardware`) |
|---|---|---|
| host | loopback by default; switch hosts never | **no defaults at all** — the switch host must appear in `EAPI_ALLOW_HOSTS` |
| port | 8443 by default | **no defaults at all** — the port must be in both `EAPI_PORT` and `EAPI_ALLOW_PORTS` |
| transport | https; http with an explicit flag | **https only** — cleartext with operator credentials is refused even with the flag |
| model pin | must NOT be `DCS-7050TX-64` | must be exactly `DCS-7050TX-64` (`HARDWARE_MODEL_NAMES`) |
| version pin | must be exactly `4.28.14M` | must be exactly `4.28.13.1M` (`HARDWARE_IMAGE_VERSION`) — no prefix, no "newer is fine": a fix release is a new pin decision (DR-116's never-widen rule cuts upward too) |
| consent | — | `EAPI_HW_CONSENT` must echo the model name — a wrong or unexpected box fails the echo |
| after all env gates | `matchesDeviceIdentity` compares the device's own `show version` answer against every pin — the last say belongs to the device, not the env | same |

The env-vs-env checks and the device self-report are both required, so *either* alone being wrong
refuses the run. Loopback spellings are accepted for hardware sessions only when explicitly
allow-listed — legitimate for an `ssh -L` operator tunnel — and then a *lab* box masquerading over
the tunnel is caught by `matchesDeviceIdentity` (its `modelName` is not `DCS-7050TX-64`).

## 2. Preparing the switch side (by hand, as the operator)

1. Confirm the image: `show version` → `4.28.13.1M`, model `DCS-7050TX-64`. If either differs,
   stop: this lane is pinned, and re-pinning is a DECISIONS.md change, not an env edit.
2. eAPI is already reachable (it has been, this whole project). Read the listener facts —
   `show management api http-commands` and `show management api http-commands https certificate` —
   these also feed §3 evidence. Do NOT change listener or ZTP state during this session;
   bootstrap/listener questions belong to #14 §2, not to a capture run.
3. Trust material, both accepted forms:
   - `EAPI_FINGERPRINT`: the SHA-256 of the server certificate — get it from the CLI above
     (or `openssl s_client -connect <host>:443 </dev/null 2>/dev/null | openssl x509 -fingerprint -sha256 -noout` from a host that can reach it), or let the first refused run's error report peer vs pinned on a deliberate probe.
   - `EAPI_CA_FILE`: path to the device's CA PEM (the `https certificate` read shows the cert;
     the CA used to sign it lives in the switch's `end-entity` file — copy it down, do not trust
     the network path to fetch it).
4. Decide the one **scratch interface**: an unused front-panel port (`Ethernet1`–`Ethernet64`).
   Verify it yourself (cable out, no LAG member) — the runner also refuses at commit time if
   `show interfaces <i> status` answers `connected`/`errdisabled`, but the *declaration* is yours.
5. The capture user: an eAPI user with `network-api` role suffices for reads; if its role needs
   `enable`, also set `EAPI_ENABLE_PASS` (never in shell history — `read -rs`).

## 3. Running batch 1 — read-only inventory

From the repo root, with everything explicit (this is the point, not ceremony):

```sh
export EAPI_LIVE=1
export EAPI_TARGET_CLASS=hardware
export EAPI_HOST=<switch-host>
export EAPI_ALLOW_HOSTS=<switch-host>      # must ALSO be allow-listed
export EAPI_PORT=443
export EAPI_ALLOW_PORTS=443
export EAPI_USER=<apiuser>
export EAPI_PASS_VAR=EAPI_HW_PW            # read -rs EAPI_HW_PW '<the password>'; never inline
export EAPI_ALLOW_MODEL=DCS-7050TX-64
export EAPI_ALLOW_VERSION=4.28.13.1M
export EAPI_HW_CONSENT=DCS-7050TX-64
export EAPI_FINGERPRINT=<sha256-hex-from-step-2>   # or EAPI_CA_FILE=<path>
export EAPI_HW_SCRUB=<hostname>,<mgmt-ip>,<lab-domain>   # literals scrubbed from every value
export EAPI_HW_CAPTURE=1                   # THE write opt-in: files land, overwrite allowed
npm run test:live -w arista-api-client
```

`src/hw-inventory.live.test.ts` runs `HW_INVENTORY_CATALOG` (`src/testing/hw-capture.ts`) — every
family the cEOS lane captures **plus** the target-sensitive §3 shows (`show license features/all`,
`show hardware tcam[ profile]`, `show lag resources`, `show systems`, `show inventory`,
`show environment …`, `… http-commands https certificate`) — and writes one recording per case,
identity-envelope stamped, scrubbed **before** the bytes are committed: MACs wherever they appear
(not only under `*mac*` keys — the cEOS lane's known gap stays closed here), every serial-named
value, `secret sha512/md5` material, PEM blocks, and each `EAPI_HW_SCRUB` literal. Device refusals
(`1002`) are *recorded as the answer* (which commands the SKU supports is §3 evidence); transport
errors abort the run instead of leaving half-captured evidence.

Review the diff before committing: the run prints case names/bytes/scrub-counts only, the JSON
diffs show everything.

## 4. Running batches 2/3 — reviewed config-session probes

The staged commands are **not** typed at the switch: they live in
`docs/hw-session-probes.draft.json`, reviewed on the PR (mechanically validated at parse time —
forbidden families refused per §3; commit batches fenced to indented children of `interface
{{SCRATCH}}`), re-read by the operator on the session day.

```sh
# same environment as batch 1, then:
export EAPI_SCRATCH_INTERFACE=Ethernet44       # the port from step 2.4 (guard-checked)
export EAPI_HW_PROBE_SPEC=$PWD/arista-api-client/docs/hw-session-probes.draft.json
export EAPI_HW_SESSION_PROBE=1                 # THE session opt-in
npx vitest run src/hw-session-probe.live.test.ts -w arista-api-client --project live
```

Each batch opens `configure session hw-probe-<name>`, stages, records `session.diff()` +
`show configuration sessions[ detail]`, and **aborts** unless the batch is `allowCommit` — which
the parse fence only grants to scratch-only batches, and which additionally refuses at run time if
the scratch port is `connected`/`errdisabled`. Commits are never persisted (`copy run start` is
mechanically refused, DR-035(c)), and the draft's final `scratch-restore` batch returns the port to
its declared pre-session defaults, so the committed set is net-zero. One recording per batch lands
as `configure-session-<name>--hw-session-probe`.

## 5. After the session

- The §3 checklist boxes in `docs/STATUS.md` get checked **only** against recorded files, each
  naming model/version verbatim (that is what unblocks DR-043's hardware gate on the UI contracts).
- Open items 4/5/7/8 and the licensing/TCAM/LAG questions get DECISIONS.md answers or explicit
  refusals — never container substitutions.
- If the run refused: print the guard code, fix the env, re-run. Never loosen a pin to make a
  refusal go away; the pin *is* the finding if the device disagrees with it.
