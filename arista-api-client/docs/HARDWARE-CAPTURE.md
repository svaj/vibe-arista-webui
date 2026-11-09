# Hardware capture lane — the supervised 7050TX-64 session runbook

Status: **batch 1 EXECUTED and committed 2026-11-08** (PR #110 lane): 44 recordings + 9 device
negatives under `test/fixtures/recordings/7050tx-64-r-4.28.13.1M/`, identity-stamped and scrubbed —
as re-verified after the DR-133 fix (the first-write set leaked a running-config secret standing in
KEY position and the mgmt IP in the envelopes; regenerated from the original bytes, originals never
committed). Batches 2/3 (the reviewed config-session probes) remain to run. Container capture is a
different lane with different rules — see [CEOS.md](./CEOS.md) for that one.

Container capture is a different lane with different rules — see [CEOS.md](./CEOS.md) for that one.
Nothing here shares bytes with it: hardware captures land under
`test/fixtures/recordings/<slug>/`, where `targetSlug` derives the directory from the **device-reported**
model + version — `7050tx-64-4.28.13.1M/` for a base unit, `7050tx-64-r-4.28.13.1M/` for the `-R` unit
this lane actually has (`recording.ts:265`; `:294` refuses a file whose envelope disagrees with its
directory, which is what makes the crossover a throw, not a convention), while cEOS evidence lives in
`test/fixtures/live/ceos-4.28.14M/` + `recordings/ceos-4.28.14M/`.

## 1. Why the gates read the way they do

Addressing a physical switch is only allowed through `live-guard.ts`'s **hardware class**, which is
deliberately stricter than the lab class (#14 §3, DR-035(e) made two-way):

| Gate | Lab class (`lab`) | Hardware class (`hardware`) |
|---|---|---|
| host | loopback by default; switch hosts never | **no defaults at all** — the switch host must appear in `EAPI_ALLOW_HOSTS` |
| port | 8443 by default | **no defaults at all** — the port must be in both `EAPI_PORT` and `EAPI_ALLOW_PORTS` |
| transport | https; http with an explicit flag | **https only** — cleartext with operator credentials is refused even with the flag |
| model pin | must NOT be a `DCS-7050TX-64…` name | must be exactly one of `DCS-7050TX-64` / `DCS-7050TX-64-R` (`HARDWARE_MODEL_NAMES`, exact set — **DR-131**) |
| version pin | must be exactly `4.28.14M` | must be exactly `4.28.13.1M` (`HARDWARE_IMAGE_VERSION`) — no prefix, no "newer is fine": a fix release is a new pin decision (DR-116's never-widen rule cuts upward too) |
| consent | — | `EAPI_HW_CONSENT` must echo the model name — a wrong or unexpected box fails the echo. It binds the **variant**: a `DCS-7050TX-64` echo against a `…-R` pin is `EAPI_HW_CONSENT_MISMATCH`. |
| after all env gates | `matchesDeviceIdentity` compares the device's own `show version` answer against every pin — the last say belongs to the device, not the env | same — and that is how the 2026-11-08 session found the `-R` suffix: the env passed, the box said otherwise, nothing was captured. |

The env-vs-env checks and the device self-report are both required, so *either* alone being wrong
refuses the run. Loopback spellings are accepted for hardware sessions only when explicitly
allow-listed — legitimate for an `ssh -L` operator tunnel — and then a *lab* box masquerading over
the tunnel is caught by `matchesDeviceIdentity` (its `modelName` is not one of the pinned hardware
names — a cEOS answer is `EAPI_MODEL_MISMATCH`, never a near miss).

> **DR-132 — the lab corpus never writes a switch.** Pointing `npm run test:live` at a switch used to let
> the `live-*.live.test.ts` **scratch-write** families stage real lines on the declared scratch port
> (`default interface`, trunk/access writes) — only the DR-126 full-write families self-refused. Now
> `requireScratchInterface` refuses the hardware class outright (`EAPI_HARDWARE_WRITE_FENCE`) and only
> `src/hw-session-probe.live.test.ts` opts out, in code, behind its own consent chain. Lab-suite *reads*
> still run unless you scope the file list — see §3.

## 2. Preparing the switch side (by hand, as the operator)

1. Confirm the image: `show version` → `4.28.13.1M`, model `DCS-7050TX-64` **or** `DCS-7050TX-64-R`
   (the airflow variant the 2026-11-08 unit reported — DR-131; copy the string out of `show version` and
   use it verbatim for both `EAPI_ALLOW_MODEL` and the consent echo). If either differs, stop: this lane
   is pinned, and re-pinning is a DECISIONS.md change, not an env edit.
2. eAPI is already reachable (it has been, this whole project). Read the listener facts —
   `show management api http-commands` and `show management api http-commands https certificate` —
   these also feed §3 evidence. Do NOT change listener or ZTP state during this session;
   bootstrap/listener questions belong to #14 §2, not to a capture run.
3. Trust material — **the proven set is three variables, not a choice of two** (measured on the
   2026-11-08 unit: `subject=CN=self.signed`, `issuer=CN=self.signed`, and *no extensions at all*, so
   the eAPI certificate carries **no SAN** — the same shape as cEOS's `capi.pem`):

   ```sh
   # (a) the leaf, as a clean PEM: self-signed, so the leaf IS its own issuer/CA for verification
   openssl s_client -connect <host>:443 </dev/null 2>/dev/null \
     | openssl x509 -outform PEM > /tmp/eapi-<host>.pem
   export EAPI_CA_FILE=/tmp/eapi-192.168.1.254.pem      # path or inline PEM both work
   # (b) the pin — cross-check it against the file you just dumped, or you are pinning a different port
   openssl x509 -in /tmp/eapi-<host>.pem -noout -fingerprint -sha256
   export EAPI_FINGERPRINT='E6:A2:…:69:18'              # colons fine, quotes required
   # (c) the verification NAME — Node's own check has no IP SAN to match, so it needs the subject CN
   export EAPI_SERVER_NAME=self.signed
   ```

   Why each is needed, in the order they fail:
   - **Pin alone is not a trust anchor.** `resolveTlsConnect` keeps `rejectUnauthorized: true`
     (`transports/node-tls.ts`); `node-https.test.ts` pins that behaviour as
     "pinning a fingerprint without a `ca` does not bypass chain verification (pin ⊂ trust, never a
     replacement)". Against a self-signed device cert a pin-only run dies `TlsError: self signed
     certificate`. The cEOS harness sets `EAPI_CA_FILE` **and** `EAPI_FINGERPRINT` for the same reason
     (`scripts/ceos-lab.mjs:2690`).
   - **The pin must be the hex only.** OpenSSL prints `sha256 Fingerprint=AA:BB:…`; the `Fingerprint=`
     prefix is *not* stripped (`normalizeFingerprint` removes `0x` and `[\s:._-]` only), so pasting the
     whole line fails with `fingerprint must be 64 hex digits (SHA-256) or 40 hex digits (SHA-1)`.
     Colon-separated, spaces, dashes and dots are all accepted; 64 hex → SHA-256, 40 hex → SHA-1.
   - **A pin does not waive the name check.** With no SAN and an `EAPI_HOST` that is an IP, the run dies
     `Hostname/IP does not match certificate's altnames`. `EAPI_SERVER_NAME` carries the subject CN so
     Node's CN fallback has a chance — exactly what the lab harness derives mechanically
     (`ceos-lab.mjs:356-367`, injected at `:2693`). If the device CN is not DNS-shaped, that is a §3
     finding, not something to loosen around.
   - Keep the CLI reads too (`… https certificate`): they are §3 evidence, and `EAPI_CA_FILE` may equally
     be the switch's issuing CA if you prefer anchoring there — but then pin *that* cert's fingerprint,
     since the served leaf is what the transport compares.
4. Decide the one **scratch interface**: an unused front-panel port (`Ethernet1`–`Ethernet64`).
   Verify it yourself (cable out, no LAG member) — the runner also refuses at commit time if
   `show interfaces <i> status` answers `connected`/`errdisabled`, but the *declaration* is yours.
   Note what the declaration is now worth: with DR-132, naming a scratch port in a hardware env no longer
   authorises the lab suites to write it.
5. Clear stale sessions before you start. A run that died mid-batch leaves a named session pending on the
   switch *and* a DR-025 journal entry that refuses the next `configure terminal` with
   `cannot configure() in terminal mode while config session "…" is open`. From the CLI:

   ```
   show configuration sessions
   configure session <name> abort
   ```

   Names this lane leaves behind are recognisable: `hw-probe-<batch>` (this lane) and `m12c-sp-*` /
   `<suite>-<label>-r<runid>` (the lab corpus).
6. The capture user: an eAPI user with `network-api` role suffices for reads; if its role needs
   `enable`, also set `EAPI_ENABLE_PASS` (never in shell history — `read -rs`).

## 3. Running batch 1 — read-only inventory

From the repo root, with everything explicit (this is the point, not ceremony). The block below is the
shape the 2026-11-08 session verified: the first five attempts failed on the missing name check, and
with `EAPI_SERVER_NAME` set the switch answered `show version` on the first try:

```sh
export EAPI_LIVE=1
export EAPI_TARGET_CLASS=hardware
export EAPI_HOST=<switch-host>
export EAPI_ALLOW_HOSTS=<switch-host>      # must ALSO be allow-listed
export EAPI_PORT=443
export EAPI_ALLOW_PORTS=443
export EAPI_USER=<apiuser>
export EAPI_PASS_VAR=EAPI_HW_PW            # read -rs EAPI_HW_PW '<the password>'; never inline
export EAPI_ALLOW_MODEL=DCS-7050TX-64-R    # verbatim from `show version` — see §2.1 (DR-131)
export EAPI_ALLOW_VERSION=4.28.13.1M
export EAPI_HW_CONSENT=DCS-7050TX-64-R     # must echo the pin, variant included
export EAPI_CA_FILE=/tmp/eapi-<host>.pem   # the leaf PEM, self-signed (see §2.3)
export EAPI_FINGERPRINT='<sha256 hex, colons ok, no "Fingerprint=" label>'
export EAPI_SERVER_NAME=self.signed        # the cert has no SAN; without this every call dies in TLS
export EAPI_HW_SCRUB=<hostname>,<mgmt-ip>,<lab-domain>   # literals scrubbed from every value
export EAPI_HW_CAPTURE=1                   # THE write opt-in: files land, overwrite allowed
```

**Scope the run to the hardware files.** `npm run test:live` runs the whole live project — all 21 files —
and this lane shares that project with the lab corpus. Since DR-132 the lab suites can no longer write a
switch (their scratch families self-refuse with `EAPI_HARDWARE_WRITE_FENCE`), but their **read** cases
still run, and their expectations are pinned to container provisioning, so their output is not §3
evidence (DR-043). Batch 1 is one file:

```sh
npx vitest run -w arista-api-client --project live src/hw-inventory.live.test.ts
```

If you want the lab corpus against the switch deliberately as an extra read pass, run it separately and
keep its log out of the evidence commit; the CI shape excludes the hardware files the other way
(`test:live -- --exclude 'src/hw-*.live.test.ts'`, §5 row 230/DR-128(c)).

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
export EAPI_SCRATCH_INTERFACE=Ethernet<n>      # the port from step 2.4 (guard-checked, §2.5 first)
export EAPI_HW_PROBE_SPEC=$PWD/arista-api-client/docs/hw-session-probes.draft.json
export EAPI_HW_SESSION_PROBE=1                 # THE session opt-in
npx vitest run src/hw-session-probe.live.test.ts -w arista-api-client --project live
```

This is the **only** lane the guard lets mutate a switch: it states the exception in code
(`requireScratchInterface(target, { hardwareSessionProbe: true })`), and every other live suite gets
`EAPI_HARDWARE_WRITE_FENCE` from that same gate (DR-132). Keep the file-scoped command — batch 2/3 opens
real config sessions, and an unscoped run would also walk the lab corpus's reads over the same port.

Each batch opens `configure session hw-probe-<name>`, stages, records `session.diff()` +
`show configuration sessions[ detail]`, and **aborts** unless the batch is `allowCommit` — which
the parse fence only grants to scratch-only batches, and which additionally refuses at run time if
the scratch port is `connected`/`errdisabled`. Commits are never persisted (`copy run start` is
mechanically refused, DR-035(c)), and the draft's final `scratch-restore` batch returns the port to
its declared pre-session defaults, so the committed set is net-zero. One recording per batch lands
as `configure-session-<name>--hw-session-probe`.

**Batch refusals are answers, not crashes (DR-134):** if the device refuses a staged line (or the
diffs read) with a typed `EapiError`, the batch records the refusal, prints it, skips any commit for
that batch, and the loop continues to the next batch — EOS stops a staged batch at the refused line,
so the SPEC keeps one question per batch to keep the recordings granular (`docs/hw-session-probes.draft.json`
rev 3). A transport or state-machine failure still kills the run: half-captured switch evidence is
worse than none.

**A committed session's NAME is taken (DR-136).** The box keeps **one** completed session
(`maxSavedSessions: 1`, hardware-verified) and the name of the last commit sits in it. Re-opening that exact
name is refused — run 4 saw `Error [1000] … 'configure session hw-probe-scratch-description description
"…"' failed: could not run command` for a name run 2 had committed. The lane handles it: it tries the
canonical `hw-probe-<name>` first, prints and records the refusal (that IS §3 evidence about name reuse), and
retries the same batch under `hw-probe-<name>-<run tag>`; one batch still produces exactly one recording. On
the console, both shapes are covered by the §2.5 `hw-probe-*` grep, so a leftover from a retry is as visible
as a leftover from the canonical attempt.

**Post-batch reads never control the run (DR-135).** The scratch read-back after a commit and the
`show configuration sessions` post-state read refuse-and-log; they cannot cancel a committed batch's
recording and cannot stop the loop. The read-back command itself comes from `hwScratchReadBackCommand`
(`show running-config **interfaces** <intf>`, plural) because that is the only spelling this box takes:
the singular form answered `1002 % Incomplete token (at token 2: 'interface')` — and when the harness
still used it, that refusal landed one statement **after** a successful commit, so the port kept the
mutation, the batch's recording was lost, and the restore set never ran (first probe attempt, 2026-11-08:
`description HW-CAPTURE-PROBE` stayed on the scratch port).

**Resuming a stopped day:** `EAPI_HW_PROBE_ONLY=scratch-restore` (comma-separated batch names from the
reviewed spec) runs just those batches, in the spec's order. Use it when a run died mid-commit-set or
when the port already carries an earlier probe's line — replaying everything would then re-answer
questions against a dirty port. An unknown name is a hard refusal, never a silent skip. Before the
first resumed run, read the `STATE ON THE SWITCH RIGHT NOW` note in the spec's `$comment`.

```sh
# read the switch's own view of what is pending/committed BEFORE resuming (console, §2.5):
#   show configuration sessions detail
# then spend one abort-only batch doing the same read over eAPI:
EAPI_HW_PROBE_ONLY=session-lifecycle npx vitest run -w arista-api-client --project live src/hw-session-probe.live.test.ts
# then the batches still owed:
EAPI_HW_PROBE_ONLY=scratch-restore npx vitest run -w arista-api-client --project live src/hw-session-probe.live.test.ts
```

## 5. After the session

- The §3 checklist boxes in `docs/STATUS.md` get checked **only** against recorded files, each
  naming model/version verbatim (that is what unblocks DR-043's hardware gate on the UI contracts).
- The committed-tree suite (`recorder-node.test.ts`) is the last line: every recording under
  `test/fixtures/recordings/` is text-scanned for crypt(3) hashes, un-redacted `secret`/`enable
  password` payloads and private-key armour, and only doc-named slug directories are allowed — a
  review miss cannot survive `npm test` (DR-133; batch 1 found exactly such a miss, in KEY position
  of the running-config `cmds` object).
- Open items 4/5/7/8 and the licensing/TCAM/LAG questions get DECISIONS.md answers or explicit
  refusals — never container substitutions.
- Expect the directory name the device earned: `recordings/7050tx-64-r-4.28.13.1M/` for this unit, and
  `hw-inventory` prints case names/bytes/scrub-counts per case — review the `git diff` before committing,
  the JSON itself is the review.
- Re-read `show configuration sessions` on the switch after the run. Anything left pending is either a
  batch that died mid-flight (abort it from the CLI, §2.5) or the lane's own deliberate
  `hw-probe-<batch>` orphan experiment — the two are distinguished by the probe spec, not by luck.
- If the run refused: print the guard code, fix the env, re-run. Never loosen a pin to make a
  refusal go away; the pin *is* the finding if the device disagrees with it — which is precisely how
  DR-131 happened. The one legitimate change is a new exact entry in `HARDWARE_MODEL_NAMES` with a
  DECISIONS.md entry naming the evidence, and the refusal text tells you when that is the case.
