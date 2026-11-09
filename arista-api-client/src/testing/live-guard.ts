/**
 * Live-target guards — M12 (#14), the single opt-in gate in front of every `*.live.test.ts` file.
 *
 * DR-034 (`docs/DECISIONS.md:251-254`) is the rule this implements: a live suite runs only when
 * `EAPI_LIVE=1` **and** the endpoint/credentials are configured, and otherwise
 * "reports `skipped: <reason>` and the run still passes". A silent skip is the failure mode, so this
 * module returns a **reason** rather than a boolean, and `liveSkipReason()` is what a test file prints
 * before calling `describe.skipIf`.
 *
 * DR-035 (`docs/DECISIONS.md:256-263`) and DR-043 (`docs/DECISIONS.md:316-350`) add the target-class
 * and evidence-separation half: a live run must declare its class — `EAPI_TARGET_CLASS=lab` for the
 * disposable container (loopback-only by default) or `EAPI_TARGET_CLASS=hardware` for the physical
 * switch (#14 §3, gated strictly: named host **and** port in the allow-lists, https only, exact
 * `4.28.13.1M`/`DCS-7050TX-64` pins, and a model echo in `EAPI_HW_CONSENT`). Both classes must name
 * the exact endpoint/port rather than inherit a switch profile, and both pin the model + image version
 * they are talking to — because "container results establish only the tested software behavior, not
 * the physical platform's" (DR-043), and the reverse separation matters just as much. The cEOS-side
 * checklist that produced the lab gates is `docs/CEOS.md:121-131`: an allow-listed endpoint *including
 * port and target kind*, `show version` checked against the expected model **and** the exact image
 * version, plus "no silently defaulting to port 443 or a real-switch profile" (`docs/CEOS.md:123-124`).
 *
 * ## Deliberate shape choices
 * - **Pure function of an injected env.** `resolveLiveEnv(env)` never reads `process.env` itself and
 *   never performs I/O, so all 22 refusal paths are unit-tested offline
 *   (`src/testing/live-guard.test.ts`, in the `unit` project — never in `live`, so a green
 *   `npm run test:live` keeps meaning "no device test ran").
 * - Refusals are **data** (`{ ok: false, code, reason }`), not exceptions and not `EapiError`
 *   subclasses: a guard refusal is not a wire condition, and PLAN.md:393 asks for the refusal paths to
 *   be testable, which is cheaper with values than with a new error class. `code` values are
 *   env-var-shaped identifiers (they double as the test names) — they are **not** eAPI error codes.
 * - **The password never appears in a reason.** Every message that could echo a value names the
 *   variable instead (`EAPI_PASS_VAR=EAPI_LAB_PW is unset`), never its contents.
 *
 * Not here on purpose: container provisioning, readiness polling and `test/device-allowlist.json`
 * (PLANNED at `docs/CEOS.md:127`, first written by the sibling M12 lane). Until that file exists, the
 * endpoint allow-list below is coded: the lab class defaults to loopback + the published lab port; the
 * hardware class has **no** defaults at all — every hardware endpoint element must be stated, so a
 * half-configured lab env can never reach a switch, only an explicitly assembled hardware env can.
 */

import { isInterfaceName } from '../resources/validators'
import type { HttpTransportOptions, HttpsTransportOptions } from '../transports/contract'

/**
 * The image this repo's lab lane is pinned to: `docs/CEOS.md:5-6` (the supplied cEOS-lab tar) and
 * PLAN.md:393 ("exact 4.28.14M for this cEOS image"). `docs/CEOS.md:113` repeats it for readiness.
 * A lab run whose `EAPI_ALLOW_VERSION` is not this string is refused rather than trusted, because the
 * other pinned version in this repository — 4.28.13.1M — is the **hardware** target (DR-043).
 */
export const CEOS_LAB_IMAGE_VERSION = '4.28.14M'

/** The existing major.minor guard from docs/TESTING.md:148 ("other than `4.28`"). */
export const DEFAULT_VERSION_TRAIN = '4.28'

/**
 * The exact hardware model names this project targets, spelled as its own fixture spells the base one
 * (`test/fixtures/show/show-version--4.28.13.1M-dcs-7050tx-64.json:5`). Naming the set lets the guard
 * refuse the `EAPI_TARGET_CLASS=lab` + hardware-model pairing instead of discovering it later.
 *
 * `DCS-7050TX-64-R` was added by the first supervised switch session (2026-11-08): the unit answered
 * `show version` with exactly that string, so the base pin refused the run with `EAPI_MODEL_MISMATCH`
 * **before a single byte was captured** — the guard worked as designed, and the device (not the env)
 * had the last say (DR-131). `-R` is the airflow variant of the same board, so addressing it belongs in
 * this lane; that answer settles DECISIONS open item 1's spelling question and nothing else.
 *
 * The set is a list of EXACT names, never a prefix or suffix rule: accepting `-R` does not admit
 * `DCS-7050TX-64-RR`, and any other suffix (or a `-SSD` class variant) is a new pin decision
 * (DR-043/DR-116 never-widen). Adding a member changes *addressing* only — it is not a feature,
 * TCAM or licensing claim, which stay open items 2/4/6 (DR-043).
 */
export const HARDWARE_MODEL_NAMES: readonly string[] = ['DCS-7050TX-64', 'DCS-7050TX-64-R']

/**
 * Hosts a lab run may address. The lab target is reached through a Docker-published port on this
 * machine (`docs/CEOS.md:109`, `https://localhost:8443/command-api`), so loopback spellings are the
 * whole default list: a switch hostname cannot match it, which is the enforcement point for DR-043's
 * "never fall back to hardware".
 */
export const LAB_LOOPBACK_HOSTS: readonly string[] = ['127.0.0.1', 'localhost', '::1', 'ip6-localhost', 'host.docker.internal']

/**
 * Ports a lab run may use by default — the published cEOS port from `docs/CEOS.md:109`/`:123`.
 * 443 and 80 are **absent on purpose**: they are the real-switch spellings, and `docs/CEOS.md:123-124`
 * forbids the harness from silently defaulting to 443. Extend deliberately with `EAPI_ALLOW_PORTS`
 * (comma-separated) when a job publishes a different one; parallel jobs need separate published ports
 * per `docs/CEOS.md:136`.
 */
export const LAB_ALLOWED_PORTS: readonly number[] = [8443]

/** Request path eAPI is served on; `contract.ts:62` `DEFAULT_HTTP_PATH`, spelled out to avoid inheriting a profile's path. */
export const LAB_ENDPOINT_PATH = '/command-api'

/** The disposable-target class a live run declares (DR-035(e), PLAN.md:394). */
export const LAB_TARGET_CLASS = 'lab' as const

/**
 * The physical-switch class (#14 §3, added 2026-11-08). DR-043 always *separated* hardware evidence
 * from container results — `recording.ts:144` already carries `'hardware'` in `TARGET_CLASSES` — what
 * was missing was a way to **address** one without falling through to a lab-shaped run. The hardware
 * gates below are deliberately stricter than the lab gates (echoed-model consent, no default host or
 * port, https only, exact image pin, model allow-list): an addressed switch must never look like it
 * was reached by accident. Mutation stays behind `requireScratchInterface` + the session tools; this
 * class does not weaken anything DR-035/DR-043 already refuses (`copy run start`, insecure TLS,
 * implicit 443).
 */
export const HARDWARE_TARGET_CLASS = 'hardware' as const

/**
 * The exact switch image this lane pins, spelled as the fixture spells it
 * (`test/fixtures/show/show-version--4.28.13.1M-dcs-7050tx-64.json`). Like every pin here: exact —
 * a fix release (4.28.13.2M) is a *different* pin decision, not a prefix match (DR-043/DR-116's
 * "never widen").
 */
export const HARDWARE_IMAGE_VERSION = '4.28.13.1M'

/**
 * The consent token for hardware addressing (`EAPI_HW_CONSENT`). The value must **echo the model
 * name**, which makes an accidental hardware run impossible while still being cheap to type at an
 * intentional switch session — the operator is proving "I know what box is on the other end", and a
 * wrong box fails the echo (compared against `EAPI_ALLOW_MODEL` exactly).
 */
export const HARDWARE_CONSENT_VARIABLE = 'EAPI_HW_CONSENT'

/** Transports the host harness can reach. `unix`/`http-local` would mean "on the switch itself". */
export const LIVE_TRANSPORT_KINDS: readonly ('https' | 'http')[] = ['https', 'http']

/** Every way this guard can refuse. Distinct codes, because the reason string is the operator's output. */
export type LiveRefusalCode =
  | 'EAPI_LIVE_MISSING'
  | 'EAPI_LIVE_NOT_1'
  | 'EAPI_HOST_MISSING'
  | 'EAPI_HOST_MALFORMED'
  | 'EAPI_HOST_NOT_ALLOWED'
  | 'EAPI_USER_MISSING'
  | 'EAPI_PASS_MISSING'
  | 'EAPI_PASS_VAR_UNSET'
  | 'EAPI_TARGET_CLASS_MISSING'
  | 'EAPI_TARGET_CLASS_UNSUPPORTED'
  | 'EAPI_HW_CONSENT_MISSING'
  | 'EAPI_HW_CONSENT_MISMATCH'
  | 'EAPI_ALLOW_MODEL_NOT_HARDWARE'
  | 'EAPI_HW_VERSION_NOT_PIN'
  | 'EAPI_PORT_MISSING'
  | 'EAPI_PORT_INVALID'
  | 'EAPI_PORT_NOT_ALLOWED'
  | 'EAPI_TRANSPORT_NOT_ALLOWED'
  | 'EAPI_INSECURE_HTTP_REFUSED'
  | 'EAPI_ALLOW_MODEL_MISSING'
  | 'EAPI_ALLOW_VERSION_MISSING'
  | 'EAPI_LAB_VERSION_NOT_IMAGE'
  | 'EAPI_LAB_MODEL_IS_HARDWARE'
  | 'EAPI_TLS_TRUST_MISSING'
  | 'EAPI_INSECURE_TLS_REFUSED'
  | 'EAPI_SCRATCH_INTERFACE_MISSING'
  | 'EAPI_SCRATCH_INTERFACE_INVALID'
  | 'EAPI_SCRATCH_INTERFACE_NOT_ETHERNET'
  | 'EAPI_HARDWARE_WRITE_FENCE'
  | 'EAPI_SCRATCH_VLAN_MISSING'
  | 'EAPI_SCRATCH_VLAN_INVALID'
  | 'EAPI_LAB_FULL_WRITE_MISSING'
  | 'EAPI_FULL_WRITE_NOT_LAB'
  | 'EAPI_LAB_WRITE_FORBIDDEN'
  | 'EAPI_MODEL_MISMATCH'
  | 'EAPI_VERSION_MISMATCH'
  | 'EAPI_VERSION_TRAIN_MISMATCH'
  | 'EAPI_PERSISTENCE_REFUSED'

/** A refusal, as data: `code` for the test, `reason` for the human output line. */
export interface LiveRefusal {
  readonly ok: false
  readonly code: LiveRefusalCode
  /** Human-readable, secret-free. Printed after `skipped:` by DR-034, or thrown by an explicit CI job. */
  readonly reason: string
}

/** A fully accepted live target. `password` is held here and nowhere else; nothing renders it. */
export interface LiveTarget {
  readonly ok: true
  readonly transport: 'https' | 'http'
  readonly host: string
  readonly port: number
  readonly path: string
  readonly username: string
  /** Cleartext credential, kept only to build transport options. Use {@link describeLiveTarget} for logs. */
  readonly password: string
  /** Which gate profile authorized this endpoint — 'hardware' targets carry stricter pins (see HARDWARE_TARGET_CLASS). */
  readonly targetClass: typeof LAB_TARGET_CLASS | typeof HARDWARE_TARGET_CLASS
  /** The exact `modelName` this run requires (DR-043 separation). */
  readonly allowModel: string
  /** The exact `version` this run requires, e.g. `4.28.14M`. */
  readonly allowVersion: string
  /** major.minor ceiling from docs/TESTING.md:148; `EAPI_ALLOW_TRAIN`, default `4.28`. */
  readonly versionTrain: string
  /** Set only when `EAPI_SCRATCH_INTERFACE` names a valid `Ethernet<index>` (DR-035(b), PLAN.md:394). */
  readonly scratchInterface?: string | undefined
  /**
   * The one spare VLAN the lab lane may create/rename/delete (`EAPI_SCRATCH_VLAN`, #14 D-phase). Raw
   * digits as given — shape is enforced by `requireScratchVlan` at use time, same split as the scratch
   * interface: env collects, the gate decides.
   */
  readonly scratchVlan?: string | undefined
  /** Trust material for the lab cert (a PEM path or inline PEM — see `transports/node-tls.ts`). */
  readonly ca?: string | undefined
  /** Certificate pin, SHA-256/SHA-1 hex (`transports/contract.ts:167`). */
  readonly fingerprint?: string | undefined
  /** SNI name when the published port forwards from a different name. */
  readonly serverName?: string | undefined
}

export type LiveResolution = LiveTarget | LiveRefusal

/** The env this guard reads: any string-keyed record, so a test can pass a literal object. */
export type LiveEnv = Readonly<Record<string, string | undefined>>

function refusal(code: LiveRefusalCode, reason: string): LiveRefusal {
  return { ok: false, code, reason }
}

/** Absent-or-blank becomes `undefined`, so `EAPI_HOST='  '` is the same refusal as an unset var. */
function envValue(env: LiveEnv, name: string): string | undefined {
  const raw = env[name]
  if (typeof raw !== 'string') return undefined
  const trimmed = raw.trim()
  return trimmed === '' ? undefined : trimmed
}

/** List-shaped env (`EAPI_ALLOW_PORTS=8443,9443`) → trimmed, non-empty entries. */
function envList(env: LiveEnv, name: string): string[] {
  const raw = env[name]
  if (typeof raw !== 'string') return []
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
}

/**
 * Print an env value only when it still looks like what its own variable is supposed to hold.
 *
 * Reasons are printed on the operator's console and pasted into CI logs, and several refusal paths exist
 * precisely because someone put a value in the wrong slot (`EAPI_PORT=hunter2`). DR-011 covers test
 * output, so a value that fails its variable's own shape is described (length + kind) rather than
 * repeated: `hunter2` is identifier-shaped, but it is not a port, so it never gets printed here.
 */
type ValueKind = 'flag' | 'number' | 'pin'
const VALUE_SHAPES: Readonly<Record<ValueKind, RegExp>> = {
  flag: /^[01a-zA-Z]{1,8}$/u,
  number: /^\d{1,5}$/u,
  /** An EOS model or version pin: digits, dots and the `M`/`F` train suffix — never punctuation. */
  pin: /^[0-9A-Za-z][0-9A-Za-z.+-]{0,47}$/u,
}

function safeLabel(value: string, kind: ValueKind): string {
  return VALUE_SHAPES[kind].test(value) ? JSON.stringify(value) : `<${String(value.length)} chars withheld: not a valid ${kind}`
}

/**
 * Exact match, case-insensitively and whitespace-trimmed — and **nothing looser**.
 *
 * The distinction is the point of DR-043: `EAPI_ALLOW_VERSION=4.28.13` must not authorize
 * `4.28.13.1M`, and `4.28.14M` must not authorize `4.28.14Mv1` or `4.28.13.1M`. Prefix/`includes()`
 * semantics are what let a version check pass for the wrong device, so they are refused here in
 * favour of string equality after normalisation.
 */
export function matchesExactly(actual: string, expected: string): boolean {
  return actual.trim().toLowerCase() === expected.trim().toLowerCase()
}

/** The `<loopback|name>` forms accepted for a host, with any IPv6 brackets removed and lower-cased. */
function normalizeHost(raw: string): { readonly host: string } | { readonly bad: string } {
  if (/[\s/@]/u.test(raw)) return { bad: 'it contains a space, `@` (credential-in-host) or `/` (a path)' }
  const unbracketed = raw.startsWith('[') && raw.endsWith(']') ? raw.slice(1, -1) : raw
  if (/:/u.test(unbracketed) && !unbracketed.includes('%')) return { bad: 'it spells a port; use EAPI_PORT for the port' }
  return { host: unbracketed.toLowerCase() }
}

/**
 * Read and validate the live environment. Every refusal path is distinct, so `npm run test:live` on a
 * half-configured machine says *which* half is missing (DR-034) instead of "skipped".
 *
 * Accepted variables — `EAPI_LIVE`, `EAPI_HOST`, `EAPI_PORT`, `EAPI_PATH`, `EAPI_USER`, `EAPI_PASS`,
 * `EAPI_PASS_VAR`, `EAPI_TRANSPORT`, `EAPI_TARGET_CLASS`, `EAPI_ALLOW_MODEL`, `EAPI_ALLOW_VERSION`,
 * `*EAPI_ALLOW_TRAIN`, `EAPI_ALLOW_HOSTS`, `EAPI_ALLOW_PORTS`, `EAPI_CA_FILE`, `EAPI_FINGERPRINT`,
 * `EAPI_SERVER_NAME`, `EAPI_SCRATCH_INTERFACE`, `EAPI_ALLOW_INSECURE_HTTP`, and for
 * `EAPI_TARGET_CLASS=hardware` also `EAPI_HW_CONSENT` (must echo the model name, DR-035(e)/#14 §3).
 * Read-but-validated-late (the gate at use time decides): `EAPI_SCRATCH_INTERFACE`,
 * `EAPI_SCRATCH_VLAN` (#14 D-phase spare VLAN for the full-write lab lane, DR-126).
 *
 * `EAPI_PASS` vs `EAPI_PASS_VAR`: `EAPI_PASS_VAR` names **another variable** holding the secret, which
 * keeps the value out of this process's own environment dump and out of a CI `--env` list
 * (PLAN.md:393). `EAPI_PASS` wins when both are set, so an operator can override a lab script ad hoc;
 * precedence is asserted in `live-guard.test.ts` rather than left to chance.
 */
export function resolveLiveEnv(env: LiveEnv): LiveResolution {
  // --- 1. the opt-in itself (DR-034) ---------------------------------------------------------------
  const live = env['EAPI_LIVE']
  if (live === undefined || live.trim() === '') {
    return refusal('EAPI_LIVE_MISSING', 'EAPI_LIVE is not set — the live lane is opt-in only (DR-034); ordinary npm test never touches a device')
  }
  if (live.trim() !== '1') {
    return refusal('EAPI_LIVE_NOT_1', `EAPI_LIVE=${safeLabel(live, 'flag')} — only "1" opts in (DR-034); a value like "true" is a typo, not consent`)
  }

  // --- 2. credentials (DR-034) ---------------------------------------------------------------------
  const rawHost = envValue(env, 'EAPI_HOST')
  if (rawHost === undefined) {
    return refusal('EAPI_HOST_MISSING', 'EAPI_HOST is not set — name the target host (a lab run: typically localhost; a hardware run: the switch itself), docs/CEOS.md:121-124')
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(rawHost)) {
    return refusal(
      'EAPI_HOST_MALFORMED',
      'EAPI_HOST spells a URL (it has a scheme) — give the bare host in EAPI_HOST and the published port in EAPI_PORT, because silently splitting a URL is how a run ends up on the default 443 (docs/CEOS.md:123-124). The value is not echoed: a URL is also where a credential hides',
    )
  }
  const host = normalizeHost(rawHost)
  if ('bad' in host) return refusal('EAPI_HOST_MALFORMED', `EAPI_HOST is not a bare host: ${host.bad} (value not echoed — that spelling is how a password gets printed)`)

  const username = envValue(env, 'EAPI_USER')
  if (username === undefined) return refusal('EAPI_USER_MISSING', 'EAPI_USER is not set — an unauthenticated live run cannot tell an auth failure from a dead target')

  const password = envValue(env, 'EAPI_PASS')
  const passVar = envValue(env, 'EAPI_PASS_VAR')
  let secret: string | undefined = password
  if (secret === undefined) {
    if (passVar === undefined) {
      return refusal('EAPI_PASS_MISSING', 'neither EAPI_PASS nor EAPI_PASS_VAR is set — a live run needs an authenticated readiness check (docs/CEOS.md:96-97)')
    }
    secret = envValue(env, passVar)
    if (secret === undefined) {
      return refusal('EAPI_PASS_VAR_UNSET', `EAPI_PASS_VAR=${passVar} names a variable that is unset or empty (the name is safe to print; the value is not)`)
    }
  }

  // --- 3. target class (DR-035/DR-043) --------------------------------------------------------------
  const targetClass = envValue(env, 'EAPI_TARGET_CLASS')
  if (targetClass === undefined) {
    return refusal('EAPI_TARGET_CLASS_MISSING', 'EAPI_TARGET_CLASS is not set — a live run must declare its class: "lab" for the disposable container, "hardware" for the physical switch (each with its own gate profile), DR-035(e)/PLAN.md:394/#14 §3')
  }
  if (targetClass !== LAB_TARGET_CLASS && targetClass !== HARDWARE_TARGET_CLASS) {
    return refusal(
      'EAPI_TARGET_CLASS_UNSUPPORTED',
      `EAPI_TARGET_CLASS=${safeLabel(targetClass, 'pin')} is refused: a live run must name a class this guard knows — ${JSON.stringify(LAB_TARGET_CLASS)} (a disposable lab target) or ${JSON.stringify(HARDWARE_TARGET_CLASS)} (the physical switch, with the stricter §3 gates below), DR-035/DR-043. EAPI_TARGET_CLASS=lab alone is not proof either (docs/CEOS.md:130) — the endpoint and version pins also have to hold`,
    )
  }
  const hardware = targetClass === HARDWARE_TARGET_CLASS

  // --- 4. exact endpoint allow-list (DR-043, docs/CEOS.md:127-129) ----------------------------------
  // For a hardware target the loopback defaults are off the table entirely: the switch host has to be
  // *named*, which is also what makes "the lab harness accidentally wrote to the production switch"
  // structurally impossible (DR-043's crossover guard, run from the other side).
  const allowedHosts = [...(hardware ? [] : LAB_LOOPBACK_HOSTS), ...envList(env, 'EAPI_ALLOW_HOSTS').map((entry) => entry.toLowerCase())]
  if (!allowedHosts.includes(host.host)) {
    return refusal(
      'EAPI_HOST_NOT_ALLOWED',
      hardware
        ? `EAPI_HOST=${JSON.stringify(host.host)} is not an allow-listed hardware host — name the switch itself in EAPI_ALLOW_HOSTS (or the planned test/device-allowlist.json, docs/CEOS.md:127). Loopback spellings are the lab lane's defaults only; the "never fall back" guard (DR-043) cuts both ways`
        : `EAPI_HOST=${JSON.stringify(host.host)} is not an allow-listed lab host (${allowedHosts.join(', ')}; extend with EAPI_ALLOW_HOSTS or the planned test/device-allowlist.json, docs/CEOS.md:127) — this is the "never fall back to the physical switch" rule (DR-043)`,
    )
  }

  const rawPort = envValue(env, 'EAPI_PORT')
  if (rawPort === undefined) {
    return refusal('EAPI_PORT_MISSING', 'EAPI_PORT is not set — the harness must not silently default to 443 or to a real-switch profile (docs/CEOS.md:123-124). The lab endpoint is a Docker-published port, e.g. 8443')
  }
  if (!/^\d+$/u.test(rawPort)) {
    return refusal('EAPI_PORT_INVALID', `EAPI_PORT is not a decimal port number (${safeLabel(rawPort, 'number')}). If that is a password, it belongs in EAPI_PASS (or in the variable EAPI_PASS_VAR names)`)
  }
  const port = Number(rawPort)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    return refusal('EAPI_PORT_INVALID', `EAPI_PORT=${rawPort} is outside 1-65535`)
  }
  const allowedPorts = [...(hardware ? [] : LAB_ALLOWED_PORTS), ...envList(env, 'EAPI_ALLOW_PORTS').map((entry) => Number(entry)).filter((entry) => Number.isInteger(entry))]
  if (!allowedPorts.includes(port)) {
    return refusal(
      'EAPI_PORT_NOT_ALLOWED',
      hardware
        ? `EAPI_PORT=${String(port)} is not an allow-listed hardware port — a switch endpoint is named exactly, port included: put it in BOTH EAPI_PORT and EAPI_ALLOW_PORTS (docs/CEOS.md:127-128; there is deliberately no default 443 for a physical target)`
        : `EAPI_PORT=${String(port)} is not an allow-listed lab port (${allowedPorts.join(', ')}; extend with EAPI_ALLOW_PORTS) — a lab endpoint is named exactly, port included (docs/CEOS.md:127-128)`,
    )
  }
  const rawPath = envValue(env, 'EAPI_PATH') ?? LAB_ENDPOINT_PATH
  if (!rawPath.startsWith('/')) {
    return refusal('EAPI_HOST_MALFORMED', `EAPI_PATH=${JSON.stringify(rawPath)} must start with "/"`)
  }

  // --- 5. transport kind + cleartext gate (DR-008) ---------------------------------------------------
  const transport = (envValue(env, 'EAPI_TRANSPORT') ?? 'https') as 'https' | 'http'
  if (!LIVE_TRANSPORT_KINDS.includes(transport)) {
    return refusal(
      'EAPI_TRANSPORT_NOT_ALLOWED',
      `EAPI_TRANSPORT=${safeLabel(transport, 'pin')} is refused: a host-side lab run reaches the container over https (or http on loopback). unix/http-local exist only on the switch itself (contract.ts:132-160)`,
    )
  }
  if (transport === 'http' && hardware) {
    return refusal('EAPI_INSECURE_HTTP_REFUSED', 'EAPI_TRANSPORT=http is refused for a hardware target even with EAPI_ALLOW_INSECURE_HTTP=1 — cleartext credentials against a switch a person is standing next to is not a knob this lane exposes (DR-008, #14 §3)')
  }
  if (transport === 'http' && env['EAPI_ALLOW_INSECURE_HTTP']?.trim() !== '1') {
    return refusal('EAPI_INSECURE_HTTP_REFUSED', 'EAPI_TRANSPORT=http needs EAPI_ALLOW_INSECURE_HTTP=1 — cleartext eAPI is a deliberate opt-in, and the lab recipe keeps the API on TLS (DR-008, docs/CEOS.md:88-89)')
  }

  // --- 6. model/version pins (DR-043) ----------------------------------------------------------------
  const allowModel = envValue(env, 'EAPI_ALLOW_MODEL')
  if (allowModel === undefined) {
    return refusal('EAPI_ALLOW_MODEL_MISSING', 'EAPI_ALLOW_MODEL is not set — the run must name the exact model it expects, not merely reach something (docs/CEOS.md:128-129)')
  }
  const allowVersion = envValue(env, 'EAPI_ALLOW_VERSION')
  if (allowVersion === undefined) {
    return refusal('EAPI_ALLOW_VERSION_MISSING', `EAPI_ALLOW_VERSION is not set — pin the exact image version, e.g. ${CEOS_LAB_IMAGE_VERSION} for this cEOS lab (PLAN.md:393)`)
  }
  if (hardware) {
    // The switch lane's own §3 gates (DR-035(e), #14): the model must be this project's SKU, the image
    // pin exact, and the operator's consent echo the model — each refusal distinct so an accidental
    // half-configured hardware env names the missing piece instead of reaching a switch.
    if (!HARDWARE_MODEL_NAMES.some((model) => matchesExactly(allowModel, model))) {
      return refusal(
        'EAPI_ALLOW_MODEL_NOT_HARDWARE',
        `EAPI_ALLOW_MODEL=${safeLabel(allowModel, 'pin')} is not this project's hardware model (${HARDWARE_MODEL_NAMES.join(', ')}) — #14 §3 pins switch evidence to that SKU; any other box is a different pin decision, not this lane`,
      )
    }
    if (!matchesExactly(allowVersion, HARDWARE_IMAGE_VERSION)) {
      return refusal(
        'EAPI_HW_VERSION_NOT_PIN',
        `EAPI_ALLOW_VERSION=${safeLabel(allowVersion, 'pin')} cannot be a hardware pin: switch evidence here is pinned to ${HARDWARE_IMAGE_VERSION} exactly (DR-043/DR-116 — "never widen" applies upward too: 4.28.13.2M is a new decision, not a prefix match)`,
      )
    }
    const consent = envValue(env, HARDWARE_CONSENT_VARIABLE)
    if (consent === undefined) {
      return refusal(
        'EAPI_HW_CONSENT_MISSING',
        `${HARDWARE_CONSENT_VARIABLE} is not set — addressing a physical switch requires the operator to echo its model name in a second variable (DR-035(e)); the pin this run must echo is EAPI_ALLOW_MODEL=${safeLabel(allowModel, 'pin')}`,
      )
    }
    if (!matchesExactly(consent, allowModel)) {
      return refusal(
        'EAPI_HW_CONSENT_MISMATCH',
        `${HARDWARE_CONSENT_VARIABLE} does not echo EAPI_ALLOW_MODEL — the echo is deliberate: a wrong or unexpected box fails here instead of accepting someone's leftover lab env (DR-035(e))`,
      )
    }
  } else {
    if (!matchesExactly(allowVersion, CEOS_LAB_IMAGE_VERSION)) {
      return refusal(
        'EAPI_LAB_VERSION_NOT_IMAGE',
        `EAPI_ALLOW_VERSION=${safeLabel(allowVersion, 'pin')} cannot be a lab pin: the disposable cEOS-lab image in this workspace is ${CEOS_LAB_IMAGE_VERSION} (docs/CEOS.md:5-6), and the pin for 4.28.13.1M belongs to the 7050TX-64 lane (DR-043 keeps those fixtures and evidence separate)`,
      )
    }
    if (HARDWARE_MODEL_NAMES.some((model) => matchesExactly(allowModel, model))) {
      return refusal(
        'EAPI_LAB_MODEL_IS_HARDWARE',
        `EAPI_ALLOW_MODEL=${safeLabel(allowModel, 'pin')} is the physical switch's model name, which cannot be the expected model of a lab target (DR-043: container results are not 7050TX-64 evidence) — declare EAPI_TARGET_CLASS=hardware if a switch really is the target`,
      )
    }
  }

  // --- 7. TLS trust (DR-013, docs/CEOS.md:96-103) ----------------------------------------------------
  const ca = envValue(env, 'EAPI_CA_FILE')
  const fingerprint = envValue(env, 'EAPI_FINGERPRINT')
  const serverName = envValue(env, 'EAPI_SERVER_NAME')
  if (env['EAPI_INSECURE_TLS']?.trim() === '1') {
    return refusal('EAPI_INSECURE_TLS_REFUSED', 'EAPI_INSECURE_TLS=1 is refused — the lab recipe says "Do not globally disable TLS verification" (docs/CEOS.md:99). Use EAPI_CA_FILE or EAPI_FINGERPRINT')
  }
  if (transport === 'https' && ca === undefined && fingerprint === undefined) {
    return refusal(
      'EAPI_TLS_TRUST_MISSING',
      'neither EAPI_CA_FILE nor EAPI_FINGERPRINT is set — the device cert must be trusted or pinned before an authenticated probe (docs/CEOS.md:96-103, DR-013). A TLS failure that cannot be told from an auth failure makes every later result uninterpretable',
    )
  }

  // --- 8. scratch handles (only when the caller asks for them; see requireScratchInterface/requireScratchVlan) ---
  const scratchInterface = envValue(env, 'EAPI_SCRATCH_INTERFACE')
  const scratchVlan = envValue(env, 'EAPI_SCRATCH_VLAN')

  return {
    ok: true,
    transport,
    host: host.host,
    port,
    path: rawPath,
    username,
    password: secret,
    targetClass: hardware ? HARDWARE_TARGET_CLASS : LAB_TARGET_CLASS,
    allowModel,
    allowVersion,
    versionTrain: envValue(env, 'EAPI_ALLOW_TRAIN') ?? DEFAULT_VERSION_TRAIN,
    ...(scratchInterface === undefined ? {} : { scratchInterface }),
    ...(scratchVlan === undefined ? {} : { scratchVlan }),
    ...(ca === undefined ? {} : { ca }),
    ...(fingerprint === undefined ? {} : { fingerprint }),
    ...(serverName === undefined ? {} : { serverName }),
  }
}

/**
 * The reason a live suite prints when it skips (DR-034's `skipped: <reason>`), or `undefined` when the
 * environment is complete. Same content either way: a misconfigured opt-in reads as a refusal, so
 * nobody mistakes "not configured" for "configured and passing".
 */
export function liveSkipReason(env: LiveEnv): string | undefined {
  const resolution = resolveLiveEnv(env)
  return resolution.ok ? undefined : resolution.reason
}

/** Unwrap a resolution inside a live test body: reaching the body means the guard already accepted it. */
export function unwrapLiveTarget(resolution: LiveResolution): LiveTarget {
  if (!resolution.ok) throw new Error(`live target refused: ${resolution.reason}`)
  return resolution
}

/**
 * Log-safe rendering (DR-011 applies to test output too). The password lives in exactly one field of
 * {@link LiveTarget} and this function deliberately never touches it.
 */
export function describeLiveTarget(target: LiveTarget): string {
  const trust = target.fingerprint !== undefined ? 'pinned' : target.ca !== undefined ? 'ca' : 'none'
  return [
    `${target.transport}://${target.host}:${String(target.port)}${target.path}`,
    `user=${target.username}`,
    `targetClass=${target.targetClass}`,
    `model=${target.allowModel}`,
    `version=${target.allowVersion}`,
    `train=${target.versionTrain}`,
    `tls=${trust}`,
    ...(target.scratchInterface === undefined ? [] : [`scratch=${target.scratchInterface}`]),
    ...(target.scratchVlan === undefined ? [] : [`scratchVlan=${target.scratchVlan}`]),
  ].join(' ')
}

/**
 * The option bag for `createNode`/`createTransport`, built only from an accepted target — so a live
 * test cannot accidentally re-add `dangerouslyDisableTlsVerification` or a switch profile
 * (DR-013/DR-043). Returned as a plain record; the caller picks the entry point (`./node` for TLS
 * trust material).
 */
export function liveTransportOptions(target: LiveTarget): HttpsTransportOptions | HttpTransportOptions {
  if (target.transport === 'http') {
    return {
      kind: 'http',
      host: target.host,
      port: target.port,
      path: target.path,
      username: target.username,
      password: target.password,
    }
  }
  return {
    kind: 'https',
    host: target.host,
    port: target.port,
    path: target.path,
    username: target.username,
    password: target.password,
    ...(target.ca === undefined ? {} : { ca: target.ca }),
    ...(target.fingerprint === undefined ? {} : { fingerprint: target.fingerprint }),
    ...(target.serverName === undefined ? {} : { serverName: target.serverName }),
  }
}

/** The two device-reported strings the identity guard needs — a subset of `VersionProperties`. */
export interface ReportedIdentity {
  readonly version: string
  readonly modelName: string
}

/**
 * Compare what the device *says* against what the guard *requires* — the readiness assertion
 * docs/CEOS.md:113/128-129 asks for, kept pure so it is testable offline.
 *
 * Three distinct refusals: model (`EAPI_MODEL_MISMATCH`), the major.minor train from
 * docs/TESTING.md:148 (`EAPI_VERSION_TRAIN_MISMATCH`), and the exact image pin
 * (`EAPI_VERSION_MISMATCH`). The train check runs **before** the pin check so a wrong-device version is
 * reported as the near miss it is: `4.28.13.1M` against a `4.28.14M` pin is the same train and a
 * different image, which is the DR-043 case (a lab run that reached the hardware's firmware level),
 * while `4.31.2F` is not that lane at all. Conflating the two is how a wrong-device match gets waved
 * through.
 */
export function matchesDeviceIdentity(target: LiveTarget, reported: ReportedIdentity): LiveRefusal | undefined {
  if (!matchesExactly(reported.modelName, target.allowModel)) {
    return refusal(
      'EAPI_MODEL_MISMATCH',
      `the target reported modelName=${JSON.stringify(reported.modelName)} but this run requires ${JSON.stringify(target.allowModel)} — refusing to run against a different device (DR-043)`,
    )
  }
  if (!versionInTrain(reported.version, target.versionTrain)) {
    return refusal(
      'EAPI_VERSION_TRAIN_MISMATCH',
      `the target reported version=${JSON.stringify(reported.version)} but the run assumes the ${target.versionTrain} train (docs/TESTING.md:148) — matched at a train boundary, so "4.28" never satisfies "4.280" and vice versa`,
    )
  }
  if (!matchesExactly(reported.version, target.allowVersion)) {
    return refusal(
      'EAPI_VERSION_MISMATCH',
      `the target reported version=${JSON.stringify(reported.version)} but this run requires the exact image version ${JSON.stringify(target.allowVersion)} (docs/CEOS.md:113) — no prefix matching, so 4.28.13.1M never satisfies a 4.28.14M pin (DR-043 keeps the 7050TX-64 lane separate)`,
    )
  }
  return undefined
}

/** `4.28` matches `4.28`, `4.28.13.1M`, `4.28.14M `; it does not match `4.280.1` or `14.28`. */
export function versionInTrain(version: string, train: string): boolean {
  return new RegExp(`^${escapeRegExp(train.trim())}(?:[._-]|$)`, 'u').test(version.trim())
}

/** Minimal regex escape, because the train comes from env and is interpolated into a boundary test. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

/**
 * Which lane is asking for the scratch interface. Defaults to the lab lane, and that default is
 * load-bearing: it is what keeps a hardware-shaped env from mutating a switch through a lab suite.
 */
export interface ScratchInterfaceGateOptions {
  /**
   * `true` only from `src/hw-session-probe.live.test.ts` — the one lane whose switch writes are fenced
   * by their own consent chain (`EAPI_HW_SESSION_PROBE=1`, a probe spec reviewed on the PR, and the
   * scratch-still-unused check before a commit batch). Everything else must take the refusal.
   */
  readonly hardwareSessionProbe?: boolean | undefined
}

/**
 * The write-side gate: DR-035(b) lets a live test touch only `EAPI_SCRATCH_INTERFACE`, and
 * docs/CEOS.md:131 keeps the management path out of test mutations — so a name must parse as an
 * interface (`validators.ts:97-99`, the same rule the resources use) **and** be an `Ethernet…`.
 * A write-side live test calls this and fails loudly when it is unset rather than picking an interface.
 *
 * The first class check is the hardware fence (DR-132): the readiness gate deliberately accepts a
 * hardware env for every suite, and on 2026-11-08 that meant the *lab* lane's scratch writes really
 * landed on a physical switch (`default interface Ethernet22`, trunk/access writes) before the identity
 * check stopped the rest of the run. `requireLabFullWrite` only covered the DR-126 full-write families,
 * so the fence for the scratch-only families sits here, at the gate every one of those suites already
 * calls, rather than in 19 hand-written files a future suite can forget.
 */
export function requireScratchInterface(target: LiveTarget, options: ScratchInterfaceGateOptions = {}): { ok: true; name: string } | LiveRefusal {
  if (target.targetClass === HARDWARE_TARGET_CLASS && options.hardwareSessionProbe !== true) {
    return refusal(
      'EAPI_HARDWARE_WRITE_FENCE',
      'this scratch gate is the lab lane write gate: with EAPI_TARGET_CLASS=hardware the only allowed mutation path is src/hw-session-probe.live.test.ts running a reviewed probe spec (DR-124/DR-125/DR-132) — a lab suite staging lines on a switch port is exactly the accident that fence exists to prevent',
    )
  }
  const name = target.scratchInterface
  if (name === undefined) {
    return refusal('EAPI_SCRATCH_INTERFACE_MISSING', 'EAPI_SCRATCH_INTERFACE is not set — a write needs an explicitly named scratch port, never one inferred from `show interfaces` (DR-035(b), PLAN.md:394)')
  }
  if (!isInterfaceName(name)) {
    return refusal('EAPI_SCRATCH_INTERFACE_INVALID', `EAPI_SCRATCH_INTERFACE=${JSON.stringify(name)} is not an interface name the client recognises (src/resources/validators.ts:97-99)`)
  }
  if (!/^Ethernet/u.test(name)) {
    return refusal('EAPI_SCRATCH_INTERFACE_NOT_ETHERNET', `EAPI_SCRATCH_INTERFACE=${JSON.stringify(name)} is not an Ethernet port — management/Vlan/Port-Channel names are off-limits for test writes (docs/CEOS.md:131)`)
  }
  return { ok: true, name }
}

/**
 * The scratch-VLAN gate: the VLAN half of DR-035(b), added for #14's full-write lab lane (DR-126).
 * The pyeapi `test_vlans` suite creates/renames/deletes VLANs by fixed id; on a *throwaway* container
 * that is allowed — but still only inside one explicitly-declared spare id, so an env typo or a suite
 * bug cannot wander across the container's provisioned VLAN set (VLANs 10/100/110 carry the capture
 * fixtures' meaning, per `lab-provision`).
 *
 * Bounds: digits, 2–4094 (1 is the default VLAN every port starts on), and **1006–1199 excluded** —
 * EOS's reserved-range window, off-limits even on containers so a suite that passes here cannot pass
 * differently than it would on the SKU.
 */
export function requireScratchVlan(target: LiveTarget): { ok: true; vlan: number } | LiveRefusal {
  const raw = target.scratchVlan
  if (raw === undefined) {
    return refusal('EAPI_SCRATCH_VLAN_MISSING', 'EAPI_SCRATCH_VLAN is not set — a VLAN write needs an explicitly declared spare id, never one the suite picked (DR-035(b)/DR-126)')
  }
  if (!/^\d+$/u.test(raw)) {
    return refusal('EAPI_SCRATCH_VLAN_INVALID', `EAPI_SCRATCH_VLAN=${JSON.stringify(raw)} is not a decimal VLAN id (the value the gate will not print is also never a name — EOS vlans are numbered)`)
  }
  const vlan = Number(raw)
  if (!Number.isInteger(vlan) || vlan < 2 || vlan > 4_094) {
    return refusal('EAPI_SCRATCH_VLAN_INVALID', `EAPI_SCRATCH_VLAN=${String(vlan)} is outside the configurable range (2-4094; vlan 1 is the default every port begins on and is never a scratch)`)
  }
  if (vlan >= 1_006 && vlan <= 1_199) {
    return refusal('EAPI_SCRATCH_VLAN_INVALID', `EAPI_SCRATCH_VLAN=${String(vlan)} falls in EOS's reserved range 1006-1199 — refused here so the lane cannot pass on a container and then answer differently on the SKU`)
  }
  return { ok: true, vlan }
}

/**
 * The full-write-lab consent (#14 D-phase, DR-126): the user decision was that the port of
 * `pyeapi/test/system/*` writes **fully** against the disposable container — users, VLANs, routes,
 * protocols — because the container is thrown away. That widens DR-035(b)'s scratch rule for the
 * `lab` class ONLY, and only behind this explicit env opt-in; the hardware class can never get here
 * (`EAPI_FULL_WRITE_NOT_LAB`, its writes stay behind `hw-session-probe`'s scratch fence), and
 * `live-session-policy.ts:labWriteScope` still keeps the self-lockout set (the listener, the
 * management path, the API user in use, `copy run start`) off-limits on the container too — a
 * self-destructed run is still a dead run even when the box is disposable.
 */
export function requireLabFullWrite(target: LiveTarget, env: LiveEnv): LiveRefusal | undefined {
  if (target.targetClass !== LAB_TARGET_CLASS) {
    return refusal('EAPI_FULL_WRITE_NOT_LAB', 'full-write lab sessions are refused for a hardware target — switch writes stay inside the reviewed hw-session-probe fence (DR-124/DR-125); this is the lane the container-only decision covers')
  }
  if (env['EAPI_LAB_FULL_WRITE']?.trim() !== '1') {
    return refusal('EAPI_LAB_FULL_WRITE_MISSING', 'EAPI_LAB_FULL_WRITE=1 is not set — a live suite that writes beyond the scratch interface/VLAN must declare it is talking to the throwaway lab container (user decision 2026-11-07, DR-126). The scratch-only rules of DR-035(b) still stand for lab suites that do not opt in')
  }
  return undefined
}

/**
 * The persistence ban, spelled as a check rather than a comment: DR-035(c) and docs/CEOS.md:83-84 say
 * a live lane never saves the startup config. `docs/TESTING.md:157-159` reserves one exempt file for a
 * dedicated persistence test — that file (if it is ever written) must not call this guard.
 */
export function assertNoPersistenceCommand(commands: readonly unknown[]): LiveRefusal | undefined {
  const offender = commands.find((command) => /(?:^|\s)copy\s+running-config\s+startup-config|(?:^|\s)copy\s+run\s+start/iu.test(String(commandText(command))))
  if (offender === undefined) return undefined
  return refusal('EAPI_PERSISTENCE_REFUSED', `a live batch contains a persistence command (${JSON.stringify(commandText(offender))}) — DR-035(c) forbids \`copy run start\` in the live lane, and docs/CEOS.md:83-84 says to bootstrap a fresh container instead`)
}

/** Text of a command in either wire form; same shape as `command-layer.ts:226`'s private helper. */
function commandText(command: unknown): string {
  if (typeof command === 'string') return command
  if (command !== null && typeof command === 'object' && 'cmd' in command) return String((command as { cmd: unknown }).cmd)
  return String(command)
}
