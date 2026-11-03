/**
 * Connection profiles — M3 (#5). Port of the profile half of `pyeapi/client.py` (BSD-3-Clause,
 * Arista Networks — DR-001): the `[connection:<name>]` registry (`client.py:127-312`), the
 * `config_for` / `hosts_for_tag` lookups (`client.py:334-367`), and the transport-name lookup
 * `make_connection` performs (`client.py:370-391`).
 *
 * **Browser-safe** (DR-002): no `node:*` import, no filesystem, no environment reading. It therefore
 * knows nothing about *where* an `eapi.conf` lives — that is `src/internal/eapi-conf.ts` (search
 * order, `$EAPI_CONF`, `~`) plus its Node binding `src/node-profiles.ts` (DR-038/DR-044). The browser
 * half of DR-038 is {@link createProfiles}.
 *
 * Three layers, split so a config file and an application's own config object cannot drift apart:
 *  - {@link parseEapiConf} owns **structure** — sections, keys, comments, continuations, and what to
 *    do about a file that is not valid INI. It never decides what a key means.
 *  - {@link normalizeProfile} + {@link ProfileStore} own **meaning** — one table that coerces and
 *    validates every key.
 *  - {@link profileToTransportOptions} owns **translation** — profile plus per-call overrides → one
 *    member of M2's {@link TransportOptions} union. It does not build the transport: each entry point
 *    does that with its own factory, which is what keeps `unix`, `http-local`, `session`, client certs
 *    and DR-013 trust material out of a browser bundle (DR-002/DR-008/DR-013/DR-014/DR-018).
 *
 * pyeapi quirks kept, each pinned by `src/profiles.test.ts` and reviewed in
 * [MIGRATION.md §5 rows 54-60](../docs/MIGRATION.md#5-semantic-divergences-worth-reviewing):
 *  - a `[connection:<name>]` section with no `host` **key** gets `host = <section name>`
 *    (`client.py:207-211`) — how upstream's `nohost.conf` fixture yields `host: 'test'`
 *    (`test_client.py::test_config_for_replaces_host_w_name`). Row 51.
 *  - Section names are case-sensitive while option keys are lowercased by `configparser.optionxform`,
 *    so `[connection:sw1]` and `[connection:SW1]` are two different profiles and `EnablePwd:` is the
 *    same option as `enablepwd:`. Row 51.
 *  - Inline comments are **not** stripped: `password = p#1` reads as `p#1`. Only a line whose first
 *    non-blank character is `#` or `;` is a comment. Row 49.
 *  - An indented line with no delimiter joins onto the previous value with `\n` (verified: pyeapi reads
 *    `host: 1.1.1.1` + `  more` as `'1.1.1.1\nmore'`). Row 49.
 *  - A `[DEFAULT]` section seeds every connection, the way configparser's default section does. Row 50.
 *  - `tags: a,b` feeds {@link ProfileStore.hostsForTag}; the index is rebuilt after every
 *    `addConnection` (`client.py:312`), a tag nobody carries yields `undefined` rather than `[]`
 *    (upstream returns `None` and its `test_hosts_for_tag_returns_none` asserts it), and each tag is
 *    trimmed while an empty one is still indexed (`client.py:230`). Row 53.
 *  - A missing `transport` means `https` (`DEFAULT_TRANSPORT`, `client.py:124`, applied at `:452`). Row 52.
 *
 * Deliberately **not** kept:
 *  - the module-global `config = Config()` that autoloads a file at import (`client.py:318`) — no
 *    hidden state (DR-038/DR-044, row 54);
 *  - the implicit `connection:localhost` → **socket** profile injected into every config
 *    (`client.py:214-221`). That injection lives on the Node side only, and even there the profile
 *    cannot become a transport until the caller states the DR-008/DR-014 risk. Row 48.
 *  - configparser's `%` interpolation, which makes a value like `p%s` throw `InterpolationSyntaxError`
 *    out of `load_config` — the interpolation happens in the `items()` call at `client.py:207`. Row 50.
 *  - the whole-file discard a duplicate section causes, where every profile after it is lost
 *    (`client.py:198-203`). Row 49.
 */

import { NotSupportedError } from './errors'
import { normalizeTransportKind, TRANSPORT_ALIASES } from './transports/contract'
import type { NodeSettings } from './command-layer'
import type { TransportKind, TransportOptions } from './transports/contract'

/** pyeapi `DEFAULT_TRANSPORT` (`client.py:124`), which `connect()` applies at `client.py:452`. */
export const DEFAULT_PROFILE_TRANSPORT: TransportKind = 'https'

/** The section prefix pyeapi adds to a connection name (`client.py:268`, `:301`). */
export const CONNECTION_SECTION_PREFIX = 'connection:'

/** The name pyeapi's `_add_default_connection` injects (`client.py:214-221`) — Node side only (row 55). */
export const DEFAULT_LOCAL_CONNECTION_NAME = 'localhost'

/** A value as it can arrive: an INI/env string, or a typed value from application config. */
export type ProfileFieldValue = string | number | boolean | readonly string[]

/** One connection's raw field map — pyeapi's `dict(self.items(name))` (`client.py:209`). */
export type ProfileFields = Readonly<Record<string, ProfileFieldValue>>

/** An application's own profiles: connection name → its fields (DR-038's browser half). */
export type ProfileRecord = Readonly<Record<string, ProfileFields>>

/** What can go wrong: the file's structure, or the meaning of one key. */
export type ProfileIssueKind =
  /** A section header with nothing after `connection:` — no caller could look it up (row 58). */
  | 'empty-name'
  /** A section that is not `[connection:<name>]`. pyeapi treats every section as a connection (row 58). */
  | 'non-connection-section'
  /** A section repeated in one file; pyeapi's read aborts there and loses everything after it (row 56). */
  | 'duplicate-section'
  /** A line configparser rejects: no `:`/`=` separator, no key, or a continuation with nothing to continue (row 56). */
  | 'invalid-line'
  /** A key outside both the pyeapi and this client's profile vocabulary (row 59). */
  | 'unknown-key'
  /** A recognized key whose value this client cannot honour (row 59). */
  | 'invalid-value'
  /** `transport =` present but empty; pyeapi treats empty as unset and uses `https` (`client.py:452`) (row 60). */
  | 'empty-transport'

export interface ProfileIssue {
  /** The connection this issue belongs to; `''` when the problem is outside any connection. */
  readonly profile: string
  /** The offending key as its author spelled it, lowercased — never the key's **value** (DR-011). */
  readonly key?: string | undefined
  /** 1-based line number, when the issue came from a file {@link parseEapiConf} was handed. */
  readonly line?: number | undefined
  readonly kind: ProfileIssueKind
  /**
   * Secret-free by construction: an issue names a profile, a key and a line, and never quotes a value,
   * because the value at that position could be a device password (DR-011).
   */
  readonly message: string
}

/**
 * One connection's settings, normalized once by {@link ProfileStore}. The vocabulary is pyeapi's
 * config file (`transport`, `host`, `port`, `path`, `username`, `password`, `enablepwd`, `tags`,
 * `default`, `timeout`, `default_socket_path`, plus `connect()`'s `key_file`/`cert_file`/`ca_file` at
 * `client.py:394`) renamed to this package's camelCase, together with the M2 options a text file has
 * no good way to carry (`baseUrl`, request-id knobs).
 *
 * Units follow this client, not pyeapi: `timeoutMs`, never a bare `timeout` (DR-019,
 * MIGRATION.md §5 row 22).
 */
export interface ConnectionProfile {
  /** The connection name: everything right of `connection:` in the section header (`client.py:301`). */
  readonly name: string
  /** The transport **spelling** as its author wrote it. Resolved and validated on use (row 60). */
  readonly transport?: string | undefined
  readonly host?: string | undefined
  readonly port?: number | undefined
  /** Request path, honoured — pyeapi accepts `path` and then posts `/command-api` regardless (row 24). */
  readonly path?: string | undefined
  /** Same-origin/dev-proxy origin instead of host/port (DR-036). */
  readonly baseUrl?: string | undefined
  /** pyeapi's socket path for a `socket` profile (`eapilib.py:644-647`, `client.py` uses `default_socket_path`). */
  readonly socketPath?: string | undefined
  readonly username?: string | undefined
  /** Device password. Sent to the device (an `enable` input has to reach the CLI — M1), never logged. */
  readonly password?: string | undefined
  /** pyeapi's `enablepwd` (`client.py:504`): the enable-mode password, applied by the `Node`. */
  readonly enablePassword?: string | undefined
  /** pyeapi `tags: a,b` (`client.py:223-233`). */
  readonly tags?: readonly string[] | undefined
  /**
   * `default = true`: **parsed, never acted on** (row 59). Letting a file pick which switch to talk to
   * is the kind of hidden default DR-008/DR-038 removed, so the caller always names the profile.
   */
  readonly default?: boolean | undefined
  /** Client deadline for one round trip, in **ms** (DR-019). A conf `timeout:` is seconds (row 22). */
  readonly timeoutMs?: number | undefined
  /** TLS trust material (DR-013). Reachable here as data; only the Node entry can build with it. */
  readonly ca?: string | readonly string[] | undefined
  /** pyeapi `cert_file` (`client.py:394`): client certificate, for `https_certs`/mTLS. */
  readonly cert?: string | undefined
  /** pyeapi `key_file` (`client.py:394`): client private key. */
  readonly key?: string | undefined
  /** SNI/verification name when it must differ from `host`. */
  readonly serverName?: string | undefined
  /** Pinned device certificate, SHA-1/SHA-256 hex (DR-013). */
  readonly fingerprint?: string | undefined
  /** The loud escape hatch (DR-013). Set it in a file and the transport warns at construction. */
  readonly dangerouslyDisableTlsVerification?: boolean | undefined
  /** Cleartext opt-in for `http`/`session` (DR-008/DR-013). */
  readonly allowInsecureTransport?: boolean | undefined
  /** Switch-local opt-in for `unix`/`http-local`: required by those kinds, never implied (DR-008/DR-014). */
  readonly allowLocalUnauthenticated?: boolean | undefined
  /** Request-id knobs carried by the profile (DR-017). */
  readonly nonce?: string | undefined
  readonly seed?: string | undefined
  readonly idStart?: number | undefined
  /** What normalization could not honour. {@link profileToTransportOptions} is the loud gate (row 59). */
  readonly issues?: readonly ProfileIssue[] | undefined
}

/** The writable view of {@link ConnectionProfile} used while one connection is being normalized. */
type MutableProfile = { -readonly [K in keyof ConnectionProfile]?: ConnectionProfile[K] | undefined }

/** Fields that profile input can set — `name` is identity, `issues` is derived output. */
type ProfileFieldName = Exclude<keyof ConnectionProfile, 'name' | 'issues'>

type FieldCoercion =
  | 'string'
  /** `ca` accepts inline PEM, one path, or a **list** of either (`TlsMaterialOptions.ca`). */
  | 'caList'
  | 'trimmedString'
  | 'port'
  | 'boolean'
  | 'timeoutSeconds'
  | 'timeoutMs'
  | 'idStart'
  | 'tags'
  | 'transport'

interface FieldSpec {
  readonly field: ProfileFieldName
  readonly coerce: FieldCoercion
  /** Whether the key comes from pyeapi's vocabulary or from this client's own options. */
  readonly origin: 'pyeapi' | 'client'
}

/**
 * One table for both ingestion paths, so a conf section and an application's config object are
 * coerced identically — that is what makes "the file and the object behave the same way" testable
 * rather than aspirational (DR-038).
 *
 * pyeapi has no such list. It forwards `**kwargs` into a connection constructor that quietly ignores
 * whatever it does not name (`eapilib.py:661`, `:671`, `:705`), which is how a typo'd `deafult` or an
 * `api_version` changes nothing at all (MIGRATION.md §5 row 31).
 */
const PROFILE_FIELDS: ReadonlyMap<string, FieldSpec> = new Map<string, FieldSpec>([
  ['transport', { field: 'transport', coerce: 'transport', origin: 'pyeapi' }],
  ['host', { field: 'host', coerce: 'string', origin: 'pyeapi' }],
  ['port', { field: 'port', coerce: 'port', origin: 'pyeapi' }],
  ['path', { field: 'path', coerce: 'trimmedString', origin: 'pyeapi' }],
  ['socket_path', { field: 'socketPath', coerce: 'string', origin: 'pyeapi' }],
  ['default_socket_path', { field: 'socketPath', coerce: 'string', origin: 'pyeapi' }],
  ['base_url', { field: 'baseUrl', coerce: 'string', origin: 'client' }],
  ['username', { field: 'username', coerce: 'string', origin: 'pyeapi' }],
  ['password', { field: 'password', coerce: 'string', origin: 'pyeapi' }],
  ['enablepwd', { field: 'enablePassword', coerce: 'string', origin: 'pyeapi' }],
  ['enable_password', { field: 'enablePassword', coerce: 'string', origin: 'client' }],
  ['tags', { field: 'tags', coerce: 'tags', origin: 'pyeapi' }],
  ['default', { field: 'default', coerce: 'boolean', origin: 'pyeapi' }],
  ['timeout', { field: 'timeoutMs', coerce: 'timeoutSeconds', origin: 'pyeapi' }],
  ['timeout_ms', { field: 'timeoutMs', coerce: 'timeoutMs', origin: 'client' }],
  ['ca_file', { field: 'ca', coerce: 'caList', origin: 'pyeapi' }],
  ['cert_file', { field: 'cert', coerce: 'string', origin: 'pyeapi' }],
  ['key_file', { field: 'key', coerce: 'string', origin: 'pyeapi' }],
  // The DR-013 keys by their *profile* spelling as well as their file spelling. This is not sugar: a
  // `ConnectionProfile` is fed back through this table whenever a store re-normalizes it
  // ({@link ProfileStore.add}) and whenever a call layers overrides on top of a profile
  // ({@link profileToTransportOptions}), and without these three entries a profile's `ca`/`cert`/`key`
  // would come back as `unknown-key` and be **dropped** — which makes an `https_certs` profile
  // unbuildable (`ProfileStore.add(parseEapiConf(...).profiles[0])` silently loses the client
  // identity). Pinned by the round-trip test in `src/profiles.test.ts`.
  ['ca', { field: 'ca', coerce: 'caList', origin: 'client' }],
  ['cert', { field: 'cert', coerce: 'string', origin: 'client' }],
  ['key', { field: 'key', coerce: 'string', origin: 'client' }],
  ['server_name', { field: 'serverName', coerce: 'string', origin: 'client' }],
  ['fingerprint', { field: 'fingerprint', coerce: 'string', origin: 'client' }],
  ['dangerously_disable_tls_verification', {
    field: 'dangerouslyDisableTlsVerification',
    coerce: 'boolean',
    origin: 'client',
  }],
  ['allow_insecure_transport', { field: 'allowInsecureTransport', coerce: 'boolean', origin: 'client' }],
  ['allow_local_unauthenticated', { field: 'allowLocalUnauthenticated', coerce: 'boolean', origin: 'client' }],
  ['nonce', { field: 'nonce', coerce: 'string', origin: 'client' }],
  ['seed', { field: 'seed', coerce: 'string', origin: 'client' }],
  ['id_start', { field: 'idStart', coerce: 'idStart', origin: 'client' }],
])

/**
 * The same table with separators folded away, so one lookup answers both spellings of an option: a
 * config file's `enable_password` (which configparser hands over already lowercased) and an app
 * record's `enablePassword`. `socket-path` and `defaultSocketPath` fold too.
 */
const PROFILE_FIELDS_FOLDED: ReadonlyMap<string, FieldSpec> = new Map(
  [...PROFILE_FIELDS].map(([key, spec]) => [key.replace(/[_-]/g, ''), spec]),
)

function fieldSpecFor(rawKey: string): FieldSpec | undefined {
  const lowered = rawKey.trim().toLowerCase()
  return PROFILE_FIELDS.get(lowered) ?? PROFILE_FIELDS_FOLDED.get(lowered.replace(/[\s_-]/g, ''))
}

/** How a key is quoted back to its author: lowercased, as configparser's `optionxform` would see it. */
function keyLabel(rawKey: string): string {
  return rawKey.trim().toLowerCase()
}

const TRUE_VALUES: readonly string[] = ['true', '1', 'yes', 'on', 'enabled']
const FALSE_VALUES: readonly string[] = ['false', '0', 'no', 'off', 'disabled']

/** An issue about one key of one profile. It never carries the key's value (DR-011). */
function fieldIssue(profile: string, key: string, kind: ProfileIssueKind, reason: string): ProfileIssue {
  return { profile, key, kind, message: `connection profile ${JSON.stringify(profile)}: ${key} — ${reason}` }
}

function asText(value: ProfileFieldValue): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return (value as readonly string[]).join(',')
  return String(value)
}

function coerceBoolean(value: ProfileFieldValue): boolean | undefined {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value === 1 ? true : value === 0 ? false : undefined
  if (typeof value !== 'string') return undefined
  const text = value.trim().toLowerCase()
  if (TRUE_VALUES.includes(text)) return true
  if (FALSE_VALUES.includes(text)) return false
  return undefined
}

function coerceNumber(value: ProfileFieldValue): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  if (text === '') return undefined
  // `Number('0x539')`/`Number('1e3')` would accept things an eapi.conf never spells. Integer-or-decimal
  // only, because a silently-parsed radix value is another option-does-nothing bug.
  if (!/^-?\d+(?:\.\d+)?$/.test(text)) return undefined
  const parsed = Number(text)
  return Number.isFinite(parsed) ? parsed : undefined
}

function coerceTags(value: ProfileFieldValue): readonly string[] {
  const parts = typeof value === 'string' ? value.split(',') : Array.isArray(value) ? (value as readonly string[]) : [asText(value)]
  // pyeapi's `generate_tags` strips each tag but keeps an empty one (`client.py:230`), so `tags: a,,b`
  // really does index a `''` tag. Kept, and pinned by a test (row 60).
  return parts.map((part) => part.trim())
}

/**
 * Move one already-coercible value into the profile being built. The `switch` is over the field rather
 * than the value type because every field accepts exactly one type, so the compiler checks this table
 * against {@link ConnectionProfile} instead of a cast doing it.
 */
function assignField(
  target: MutableProfile,
  field: ProfileFieldName,
  value: string | number | boolean | readonly string[],
): void {
  switch (field) {
    case 'transport':
      target.transport = value as string
      return
    case 'host':
      target.host = value as string
      return
    case 'port':
      target.port = value as number
      return
    case 'path':
      target.path = value as string
      return
    case 'socketPath':
      target.socketPath = value as string
      return
    case 'baseUrl':
      target.baseUrl = value as string
      return
    case 'username':
      target.username = value as string
      return
    case 'password':
      target.password = value as string
      return
    case 'enablePassword':
      target.enablePassword = value as string
      return
    case 'tags':
      target.tags = value as readonly string[]
      return
    case 'default':
      target.default = value as boolean
      return
    case 'timeoutMs':
      target.timeoutMs = value as number
      return
    case 'ca':
      target.ca = value as string | readonly string[]
      return
    case 'cert':
      target.cert = value as string
      return
    case 'key':
      target.key = value as string
      return
    case 'serverName':
      target.serverName = value as string
      return
    case 'fingerprint':
      target.fingerprint = value as string
      return
    case 'dangerouslyDisableTlsVerification':
      target.dangerouslyDisableTlsVerification = value as boolean
      return
    case 'allowInsecureTransport':
      target.allowInsecureTransport = value as boolean
      return
    case 'allowLocalUnauthenticated':
      target.allowLocalUnauthenticated = value as boolean
      return
    case 'nonce':
      target.nonce = value as string
      return
    case 'seed':
      target.seed = value as string
      return
    case 'idStart':
      target.idStart = value as number
      return
    default: {
      const unassignable: never = field
      throw new TypeError(`profile field ${JSON.stringify(String(unassignable))} has nowhere to be stored`)
    }
  }
}

/** Issues that make a profile unusable, as opposed to ones merely worth showing the operator. */
function blockingIssues(issues: readonly ProfileIssue[]): readonly ProfileIssue[] {
  return issues.filter((issue) => issue.kind !== 'unknown-key')
}

/**
 * Normalize one connection: coerce every recognized key and record everything that could not be
 * honoured.
 *
 * Deliberately not a throw (row 56): one bad `port` in a profile nobody is using today must not make
 * the other nine profiles unreadable the way pyeapi's whole-file read abort does. The issue rides on
 * the profile, which matters because a value that failed to coerce is **not** stored and so can never
 * be rediscovered later. {@link profileToTransportOptions} then refuses to build a transport from it
 * (row 59) instead of quietly taking the kind's default port — which is what pyeapi leaves behind when
 * its deep `int(port)` runs (`eapilib.py:666`).
 */
export function normalizeProfile(
  name: string,
  fields: ProfileFields,
): { profile: ConnectionProfile; issues: ProfileIssue[] } {
  const issues: ProfileIssue[] = []
  const target: MutableProfile = {}

  for (const [rawKey, value] of Object.entries(fields)) {
    const spec = fieldSpecFor(rawKey)
    const key = keyLabel(rawKey)
    if (spec === undefined) {
      issues.push(
        fieldIssue(
          name,
          key,
          'unknown-key',
          'is not a key this client reads. It is recorded so a typo stays visible instead of vanishing the way an unrecognised runCmds parameter does (MIGRATION.md §5 row 31)',
        ),
      )
      continue
    }

    let coerced: string | number | boolean | readonly string[] | undefined
    switch (spec.coerce) {
      case 'string': {
        const text = asText(value)
        coerced = text === '' ? undefined : text
        break
      }
      case 'trimmedString': {
        const text = asText(value).trim()
        coerced = text === '' ? undefined : text
        break
      }
      case 'caList': {
        // A file can only ever carry one value, but an application config record may hand over
        // `ca: [bundleA, bundleB]` — and `ca` is re-read from the stored profile on every
        // `addConnection`/`profileToTransportOptions` round trip. Coercing it through `asText` would
        // join the list into one impossible path (`a.pem,b.pem`), so lists stay lists.
        coerced = Array.isArray(value)
          ? (value as readonly string[]).map((entry) => entry.trim()).filter((entry) => entry !== '')
          : (asText(value).trim() === '' ? undefined : asText(value))
        break
      }
      case 'transport': {
        const text = asText(value).trim()
        if (text === '') {
          issues.push(
            fieldIssue(
              name,
              key,
              'empty-transport',
              'is empty. pyeapi treats an empty transport as unset and connects with "https" (client.py:452); this client records it as an error instead, so a half-typed transport cannot quietly pick a different listener',
            ),
          )
          continue
        }
        coerced = text
        break
      }
      case 'port': {
        const parsed = coerceNumber(value)
        if (parsed === undefined || !Number.isInteger(parsed) || parsed < 0 || parsed > 65_535) {
          issues.push(
            fieldIssue(
              name,
              key,
              'invalid-value',
              'is not a port number. Keeping the profile anyway would put it on the transport\'s default port while the operator believes the file said otherwise (pyeapi defers this to int(port) inside the connection constructor — eapilib.py:666)',
            ),
          )
          continue
        }
        coerced = parsed
        break
      }
      case 'timeoutSeconds': {
        const parsed = coerceNumber(value)
        if (parsed === undefined || parsed <= 0) {
          issues.push(
            fieldIssue(
              name,
              key,
              'invalid-value',
              'is not a positive number of seconds. pyeapi measures timeout in seconds and keeps it a string; this client stores timeoutMs (DR-019, MIGRATION.md §5 row 22)',
            ),
          )
          continue
        }
        coerced = Math.round(parsed * 1000)
        break
      }
      case 'timeoutMs': {
        const parsed = coerceNumber(value)
        if (parsed === undefined || parsed <= 0) {
          issues.push(fieldIssue(name, key, 'invalid-value', 'is not a positive number of milliseconds (DR-019)'))
          continue
        }
        coerced = Math.round(parsed)
        break
      }
      case 'idStart': {
        const parsed = coerceNumber(value)
        if (parsed === undefined || !Number.isInteger(parsed) || parsed < 0) {
          issues.push(fieldIssue(name, key, 'invalid-value', 'is not a non-negative integer request-id sequence (DR-017)'))
          continue
        }
        coerced = parsed
        break
      }
      case 'boolean': {
        const parsed = coerceBoolean(value)
        if (parsed === undefined) {
          issues.push(
            fieldIssue(
              name,
              key,
              'invalid-value',
              'needs an explicit truth value (true/1/yes/on or false/0/no/off). An unreadable value is not read as false, because these gates decide whether credentials travel in cleartext (DR-008/DR-013)',
            ),
          )
          continue
        }
        coerced = parsed
        break
      }
      case 'tags': {
        coerced = coerceTags(value)
        break
      }
    }

    if (coerced === undefined) continue
    assignField(target, spec.field, coerced)
  }

  // `name` is assigned LAST on purpose: {@link MutableProfile} makes every property optional, so a
  // `{ name, ...target }` spread would let an (optional, absent) `target.name` overwrite the identity
  // the caller passed — and TypeScript rightly refused the result as `name?: string | undefined`.
  const profile: ConnectionProfile =
    issues.length === 0
      ? { ...target, name }
      : { ...target, name, issues: Object.freeze([...issues]) as readonly ProfileIssue[] }
  return { profile: Object.freeze(profile), issues }
}

/**
 * Profiles plus everything the file did wrong. Key-level complaints ride on each profile's `issues`;
 * {@link ParsedEapiConf.issues} holds those **and** the file's structural problems.
 */
export interface ParsedEapiConf {
  /** Connection sections in file order — pyeapi's `sections()` filtered to `connection:` (`client.py:207`). */
  readonly profiles: readonly ConnectionProfile[]
  /** Structure-level problems, plus every profile's key-level ones. */
  readonly issues: readonly ProfileIssue[]
  /** Section names that are not `[connection:<name>]`, `DEFAULT` included (row 58). */
  readonly otherSections: readonly string[]
  /** The `[DEFAULT]` section's fields — configparser merges them into every section (row 57). */
  readonly defaults?: ProfileFields | undefined
}

export interface ParseEapiConfOptions {
  /**
   * Reproduce pyeapi's host defaulting (`client.py:207-211`): a connection section with no `host` key
   * gets `host = <section name>`. Default `true`, because keeping the quirk is what makes an operator's
   * existing `~/.eapi.conf` behave the way they already read it (row 58).
   */
  readonly applyHostDefault?: boolean | undefined
}

/** configparser accepts `:` or `=`; the first one on the line splits the key from the value. */
const KEY_VALUE_SPLIT = /[:=]/
/** configparser's comment prefixes, and only when the line begins (after indentation) with one. */
const COMMENT_PREFIX = /^[#;]/
const SECTION_HEADER = /^\[(.*)\]$/

interface RawSection {
  readonly name: string
  readonly fields: Record<string, ProfileFieldValue>
}

/** pyeapi's `str(section).replace('connection:', '')`, applied only when the prefix is really there. */
function bareSectionName(name: string): string {
  return name.startsWith(CONNECTION_SECTION_PREFIX) ? name.slice(CONNECTION_SECTION_PREFIX.length) : name
}

/**
 * The minimal INI reader PLAN M3 asks for: no dependency, and deliberately not a general INI library.
 * It reads the subset an `eapi.conf` uses and **tolerates** everything else, reporting instead of
 * discarding (row 56, DR-045).
 *
 * What tolerance means, measured against real pyeapi/`configparser` behaviour in this environment
 * rather than assumed:
 *  - a junk line inside a section → pyeapi logs `ParsingError: parsing error in eapi conf file: …`
 *    and keeps what it had parsed (`client.py:198-203`). Here: one issue for that line, parsing goes on.
 *  - a duplicate section → pyeapi's read **aborts**; the same `except` swallows `DuplicateSectionError`
 *    and every profile after the duplicate is gone. Here: both blocks are read and merged (first value
 *    wins per key) with one `duplicate-section` issue.
 *  - a stray line before the first header → `MissingSectionHeaderError`, and the **whole file** is
 *    ignored — which is why upstream's `eapi.conf.yaml` fixture ends up with only `localhost`
 *    (`test_client.py::test_load_config_yaml`). Here: issues, and the file is still read.
 *  - a value containing `%` → pyeapi's `read()` throws `InterpolationSyntaxError` out through
 *    `load_config`, because configparser interpolates at the `items()` call on `client.py:207`. Here:
 *    no interpolation at all, so `p%s` stays a password (row 57).
 *  - a UTF-8 BOM, or a section that is not a connection: pyeapi discards the file / crashes in
 *    `generate_tags` (`client.py:233`); here both are reported and reading continues (row 56/58).
 *
 * Option keys are lowercased and section names are not, exactly as configparser does it (row 58), and
 * every issue carries a 1-based line number.
 */
export function parseEapiConf(text: string, options: ParseEapiConfOptions = {}): ParsedEapiConf {
  const applyHostDefault = options.applyHostDefault ?? true
  const issues: ProfileIssue[] = []
  const otherSections: string[] = []
  let defaults: ProfileFields | undefined

  const sections: RawSection[] = []
  const sectionIndex = new Map<string, number>()
  let current: RawSection | undefined
  let lastKey: string | undefined

  const issueFor = (
    sectionName: string | undefined,
    kind: ProfileIssueKind,
    message: string,
    line?: number,
    key?: string,
  ): ProfileIssue => ({
    profile: sectionName === undefined ? '' : bareSectionName(sectionName),
    ...(key === undefined ? {} : { key }),
    ...(line === undefined ? {} : { line }),
    kind,
    message,
  })

  const startSection = (name: string, line: number): void => {
    if (name === '') {
      issues.push(
        issueFor(undefined, 'empty-name', `a section header at line ${String(line)} has no name, so no caller could look that profile up`, line),
      )
      current = undefined
      lastKey = undefined
      return
    }
    const existing = sectionIndex.get(name)
    if (existing === undefined) {
      current = { name, fields: {} }
      sectionIndex.set(name, sections.push(current) - 1)
      lastKey = undefined
      return
    }
    issues.push(
      issueFor(name, 'duplicate-section', `section ${JSON.stringify(name)} repeats at line ${String(line)}, so the two blocks are merged and the first value of a repeated key wins. ` +
        'pyeapi raises DuplicateSectionError here and stops reading, losing every profile that came after the duplicate (client.py:198-203)', line),
    )
    current = sections[existing]
    lastKey = undefined
  }

  const badLine = (line: number, reason: string, sectionName: string | undefined): void => {
    issues.push(
      issueFor(sectionName, 'invalid-line',
        `${sectionName === undefined ? '' : `connection profile ${JSON.stringify(bareSectionName(sectionName))}: `}line ${String(line)} ${reason}, so it is skipped. ` +
        'pyeapi reports the file as one parse error instead ("parsing error in eapi conf file" — client.py:198-203)', line),
    )
  }

  const lines = text.replace(/^\ufeff/, '').split(/\r\n|\n|\r/)
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] as string
    const lineStart = index + 1
    const trimmed = line.trim()
    if (trimmed === '') continue
    if (COMMENT_PREFIX.test(trimmed)) continue

    const header = SECTION_HEADER.exec(trimmed)
    if (header !== null) {
      startSection((header[1] as string).trim(), lineStart)
      continue
    }

    // An indented line with no delimiter continues the previous value, joined with `\n` — verified
    // against configparser, which reads `host: 1.1.1.1` followed by `  more` as `'1.1.1.1\nmore'`.
    // An indented line that *does* carry a delimiter stays an ordinary option (row 56).
    if (/^\s/.test(line) && current !== undefined && !KEY_VALUE_SPLIT.test(trimmed)) {
      if (lastKey === undefined) {
        badLine(lineStart, 'is indented as if it continued a value, but the section has no value to continue yet', current.name)
        continue
      }
      const previous = current.fields[lastKey]
      current.fields[lastKey] = typeof previous === 'string' ? `${previous}\n${trimmed}` : trimmed
      continue
    }

    if (current === undefined) {
      badLine(lineStart, 'appears before any `[connection:<name>]` section header', undefined)
      continue
    }

    const split = KEY_VALUE_SPLIT.exec(trimmed)
    if (split === null) {
      badLine(lineStart, 'is not a `key = value` or `key: value` pair', current.name)
      continue
    }
    const rawKey = trimmed.slice(0, split.index)
    // Everything after the first delimiter is the value, with **surrounding** blanks removed and any
    // inline `#`/`;` kept. configparser's option regex consumes the whitespace around the delimiter
    // (`\s*(=|:)\s*` before the value capture, which is then `strip()`ed as added), so a real
    // `eapi.conf` author's `enablepwd: enablepwd` reads as `enablepwd`, not `' enablepwd'` — verified
    // against a live pyeapi read of upstream's own fixture. Inline comments are still not stripped,
    // so a password containing `#1` survives (row 56).
    const value = trimmed.slice(split.index + 1).trim()
    const key = keyLabel(rawKey)
    if (key === '') {
      badLine(lineStart, 'has no key before its separator', current.name)
      continue
    }
    if (Object.prototype.hasOwnProperty.call(current.fields, key)) {
      issues.push(
        issueFor(current.name, 'invalid-line',
          `connection profile ${JSON.stringify(bareSectionName(current.name))} sets ${JSON.stringify(key)} again at line ${String(lineStart)}; the first value is kept. ` +
          'pyeapi raises DuplicateOptionError here and stops reading the rest of the file (client.py:198-203)', lineStart, key),
      )
      continue
    }
    current.fields[key] = value
    lastKey = key
  }

  const profiles: ConnectionProfile[] = []
  for (const section of sections) {
    if (section.name.toLowerCase() === 'default') {
      defaults = { ...section.fields }
      continue
    }
    if (!section.name.startsWith(CONNECTION_SECTION_PREFIX)) {
      otherSections.push(section.name)
      issues.push(
        issueFor(section.name, 'non-connection-section',
          `section ${JSON.stringify(section.name)} is not a \`[${CONNECTION_SECTION_PREFIX}<name>]\` section, so it is not a connection profile. ` +
          'pyeapi lists every section as a connection (client.py:151-156) and then crashes in generate_tags when one has no colon (client.py:233)'),
      )
      continue
    }
    const name = section.name.slice(CONNECTION_SECTION_PREFIX.length)
    if (name === '') {
      issues.push(
        issueFor(section.name, 'empty-name',
          `section ${JSON.stringify(section.name)} has no connection name after \`${CONNECTION_SECTION_PREFIX}\`, so nothing can look it up. ` +
          'pyeapi registers it under the empty string and then gives it host = "" (client.py:207-211)'),
      )
      continue
    }

    // `[DEFAULT]` first, the section's own keys on top: configparser merges its default section into
    // every `items()` call, and pyeapi reads sections through `items()` (row 57).
    const fields: Record<string, ProfileFieldValue> = { ...(defaults ?? {}), ...section.fields }
    // pyeapi's quirk, verified against a run: the substitution happens when the `host` **key** is
    // absent, not when its value is blank (`client.py:207-211`). A present-but-empty `host` therefore
    // stays empty here — and unlike pyeapi, which would post to `https://:443/command-api`, the
    // transport refuses to build one at all (MIGRATION.md §5 row 8).
    if (applyHostDefault && fields['host'] === undefined) fields['host'] = name
    const normalized = normalizeProfile(name, fields)
    profiles.push(normalized.profile)
    issues.push(...normalized.issues)
  }

  return { profiles, issues, otherSections, ...(defaults === undefined ? {} : { defaults }) }
}

/**
 * The pyeapi profile registry (`client.py:127-312`) without the file — and without pyeapi's
 * module-global instance (`client.py:318`), which autoloaded a config at import time. A caller
 * constructs the store it uses; the Node entry fills one from `eapi.conf` on demand
 * (DR-038/DR-044, row 54).
 */
export class ProfileStore {
  #profiles = new Map<string, ConnectionProfile>()
  #tags = new Map<string, string[]>()

  /**
   * pyeapi `Config.add_connection(name, **kwargs)` (`client.py:289-312`), where `name` is the part right
   * of `connection:` — the prefix is the file's business, not the caller's. Re-adding a name replaces
   * it, and the tag index is rebuilt exactly as `client.py:312` does. Unlike upstream, the values are
   * normalized here instead of being left as strings for a connection constructor to interpret later
   * (row 59).
   */
  addConnection(name: string, fields: ProfileFields = {}): ConnectionProfile {
    const trimmed = name.trim()
    if (trimmed === '') {
      throw new NotSupportedError(
        `a connection profile needs a name: \`${CONNECTION_SECTION_PREFIX}\` with nothing after it cannot be looked up (pyeapi still registers one under the empty string — client.py:207-211)`,
      )
    }
    const normalized = normalizeProfile(trimmed, fields)
    this.#profiles.set(trimmed, normalized.profile)
    this.generateTags()
    return normalized.profile
  }

  /** Add an already-normalized profile — the route {@link parseEapiConf} output takes. */
  add(profile: ConnectionProfile): ConnectionProfile {
    return this.addConnection(profile.name, profileFieldsOf(profile))
  }

  /** pyeapi `Config.get_connection` (`client.py:259-287`): `undefined` for a miss, not `null`. */
  get(name: string): ConnectionProfile | undefined {
    return this.#profiles.get(name.trim())
  }

  /** pyeapi `config_for(name)` (`client.py:334-349`), spelled for this package (MIGRATION.md §2). */
  configFor(name: string): ConnectionProfile | undefined {
    return this.get(name)
  }

  has(name: string): boolean {
    return this.#profiles.has(name.trim())
  }

  /** pyeapi `Config.connections` (`client.py:151-156`): the names, with the prefix already removed. */
  names(): string[] {
    return [...this.#profiles.keys()]
  }

  get size(): number {
    return this.#profiles.size
  }

  /** Every profile in insertion order — explicit instead of pyeapi's iteration magic (DR-041). */
  all(): readonly ConnectionProfile[] {
    return [...this.#profiles.values()]
  }

  /**
   * pyeapi `Config.generate_tags` (`client.py:223-233`). Public and idempotent for the same reason
   * upstream exposes it: the tag index is derived state, and `addConnection` re-runs it
   * (`client.py:312`). pyeapi walks **every** section and crashes on one without a colon
   * (`client.py:233`); this walks connection profiles only (row 58).
   */
  generateTags(): void {
    this.#tags = new Map<string, string[]>()
    for (const profile of this.#profiles.values()) {
      for (const tag of profile.tags ?? []) {
        const hosts = this.#tags.get(tag)
        if (hosts === undefined) this.#tags.set(tag, [profile.name])
        else hosts.push(profile.name)
      }
    }
  }

  /**
   * pyeapi `hosts_for_tag(tag)` (`client.py:352-367`). `undefined` when the tag is unknown, because
   * upstream returns `None` and its own test asserts exactly that
   * (`test/unit/test_client.py::test_hosts_for_tag_returns_none`). An empty array would let
   * `for (const host of …)` look like a fan-out that succeeded and found nobody (row 60).
   */
  hostsForTag(tag: string): readonly string[] | undefined {
    const hosts = this.#tags.get(tag.trim())
    return hosts === undefined ? undefined : Object.freeze([...hosts])
  }

  /** The tag index as data, for a UI that lists which tags exist. */
  tags(): ReadonlyMap<string, readonly string[]> {
    return new Map([...this.#tags].map(([tag, hosts]) => [tag, Object.freeze([...hosts]) as readonly string[]]))
  }

  /**
   * pyeapi `_add_default_connection` (`client.py:214-221`): the implicit
   * `[connection:localhost] transport = socket`. Called **only** by the Node loader (DR-008) — a
   * browser app never receives a hidden localhost, and even in Node this profile cannot become a
   * transport until the caller states the DR-008/DR-014 risk (row 55).
   */
  addDefaultLocalConnection(): ConnectionProfile {
    return this.addConnection(DEFAULT_LOCAL_CONNECTION_NAME, { transport: 'socket' })
  }

  /** Names only. Listing a store's *contents* would put credentials into a log line (DR-011). */
  toString(): string {
    return `ProfileStore(connections=${JSON.stringify(this.names())})`
  }
}

/** A stored profile back in the field vocabulary, for re-normalizing with per-call overrides. */
function profileFieldsOf(profile: ConnectionProfile): ProfileFields {
  const fields: Record<string, ProfileFieldValue> = {}
  for (const [key, value] of Object.entries(profile)) {
    if (key === 'name' || key === 'issues' || value === undefined) continue
    fields[key] = value as ProfileFieldValue
  }
  return fields
}

/**
 * DR-038's browser half: profiles out of application state —
 * `createProfiles({ sw1: { transport: 'https', host: 'sw1.lan' } })` — never a file, and never a
 * fallback host. It also accepts the `ConnectionProfile[]` {@link parseEapiConf} produced, so both
 * paths yield the same kind of store.
 */
export function createProfiles(source: ProfileRecord | Iterable<ConnectionProfile> = {}): ProfileStore {
  const store = new ProfileStore()
  if (typeof (source as Iterable<ConnectionProfile>)[Symbol.iterator] === 'function') {
    for (const profile of source as Iterable<ConnectionProfile>) store.add(profile)
    return store
  }
  for (const [name, fields] of Object.entries(source as ProfileRecord)) store.addConnection(name, fields)
  return store
}

/** Which entry point is translating: that is what decides which kinds are reachable (DR-002). */
export type ProfileEntry = 'browser' | 'node'

export interface ProfileTransportOptions {
  readonly entry: ProfileEntry
  /**
   * Per-call overrides, in the same key vocabulary as the profile itself. This is how a caller states
   * `allowLocalUnauthenticated` (DR-008/DR-014) or aims a shared profile at one host for a single call,
   * without editing anybody's config file.
   */
  readonly overrides?: ProfileFields | undefined
}

/** The kinds each entry point can construct — mirrors the two `createTransport` switches (DR-002). */
const KINDS_BY_ENTRY: Readonly<Record<ProfileEntry, readonly TransportKind[]>> = Object.freeze({
  browser: ['https', 'http'],
  node: ['https', 'http', 'session', 'https-client-cert', 'unix', 'http-local', 'mock'],
})

/**
 * Options a profile may not set for a given kind. Dropping them silently is what MIGRATION.md §5 row 31
 * refuses, and this layer — unlike M2's `assertOptionKeys` — can name the profile. pyeapi's
 * `socket`/`http_local` constructors take no host and no credentials either (`eapilib.py:644-658`),
 * and DR-014 says there is no https-local listener to configure at all.
 */
const FORBIDDEN_KEYS_BY_KIND: Readonly<Record<TransportKind, readonly ProfileFieldName[]>> = Object.freeze({
  unix: ['host', 'port', 'path', 'baseUrl', 'username', 'password', 'allowInsecureTransport', 'ca', 'cert', 'key', 'serverName', 'fingerprint', 'dangerouslyDisableTlsVerification'],
  'http-local': ['host', 'baseUrl', 'username', 'password', 'socketPath', 'allowInsecureTransport', 'ca', 'cert', 'key', 'serverName', 'fingerprint', 'dangerouslyDisableTlsVerification'],
  'https-client-cert': ['socketPath', 'allowInsecureTransport', 'allowLocalUnauthenticated'],
  session: ['socketPath', 'allowLocalUnauthenticated'],
  http: ['ca', 'cert', 'key', 'serverName', 'fingerprint', 'dangerouslyDisableTlsVerification', 'socketPath', 'allowLocalUnauthenticated'],
  https: ['socketPath', 'allowInsecureTransport', 'allowLocalUnauthenticated'],
  mock: ['host', 'port', 'path', 'baseUrl', 'username', 'password', 'socketPath'],
})

/**
 * The accepted transport spellings, derived from M2's {@link TRANSPORT_ALIASES} so the list cannot
 * drift from the map that actually resolves them (`contract.ts`; pyeapi `TRANSPORTS`, `client.py:114-122`).
 */
export function acceptedTransportNames(entry: ProfileEntry): string[] {
  const allowed = KINDS_BY_ENTRY[entry]
  return Object.entries(TRANSPORT_ALIASES)
    .filter(([, kind]) => allowed.includes(kind))
    .map(([name]) => name)
    .sort()
}

/** The DR-008/DR-014 refusal, phrased once for both switch-local kinds. */
function profileWithoutLocalOptIn(kind: 'unix' | 'http-local'): NotSupportedError {
  return new NotSupportedError(
    `the switch-local ${JSON.stringify(kind)} transport needs the risk stated out loud: allow_local_unauthenticated = true in the file, or allowLocalUnauthenticated: true in app config. On 4.28 the unix socket and the 127.0.0.1:8080 listener are DISABLE_AAA — whatever reaches them is priv-15 on the switch (DR-008/DR-014)`,
    { commands: [] },
  )
}

/**
 * pyeapi `make_connection(transport, **kwargs)` (`client.py:370-391`): the name is looked up in
 * `TRANSPORTS`, and an unknown one raises `TypeError('invalid transport specified')`
 * (`client.py:388-389`, asserted by upstream's `test_make_connection_raises_typeerror`).
 *
 * Here the lookup goes through M2's {@link TRANSPORT_ALIASES}, so a profile may spell its transport
 * pyeapi's way (`socket`, `http_local`, `https_certs`, `http_session`, `https_session`) or use this
 * package's kind name, and the switch over {@link TransportKind} below is exhaustive: an unhandled kind
 * is a compile error, an unknown *name* is a {@link NotSupportedError} that lists what is accepted and
 * never falls back to a default transport, and a name that resolves to a kind the calling entry point
 * cannot build fails with a message naming the `./node` import (DR-046, MIGRATION.md §5 row 60).
 */
export function profileToTransportOptions(profile: ConnectionProfile, options: ProfileTransportOptions): TransportOptions {
  const { entry } = options
  const merged = normalizeProfile(profile.name, { ...profileFieldsOf(profile), ...(options.overrides ?? {}) })
  const effective = merged.profile

  const blocking = [...blockingIssues(profile.issues ?? []), ...blockingIssues(merged.issues)]
  if (blocking.length > 0) {
    throw new NotSupportedError(
      `refusing to build a connection from profile ${JSON.stringify(profile.name)}: ${blocking.map((issue) => issue.message).join('; ')}`,
      { commands: [] },
    )
  }

  const spelling = (effective.transport ?? DEFAULT_PROFILE_TRANSPORT).trim().toLowerCase()
  const kind = normalizeTransportKind(spelling)
  if (kind === undefined) {
    throw new NotSupportedError(
      `invalid transport specified: profile ${JSON.stringify(profile.name)} says ${JSON.stringify(effective.transport)}. ` +
        `Accepted names are pyeapi's spellings and the ${entry === 'node' ? "'./node' entry's" : 'browser entry\'s'} own kinds: ${acceptedTransportNames(entry).join(', ')} (pyeapi client.py:114-122, :388-389)`,
      { commands: [] },
    )
  }
  if (!KINDS_BY_ENTRY[entry].includes(kind)) {
    throw new NotSupportedError(
      `transport ${JSON.stringify(spelling)} in profile ${JSON.stringify(profile.name)} resolves to kind ${JSON.stringify(kind)}, which the ${entry === 'node' ? './node' : 'browser'} build does not have: import createNode/createConnection from '@devhax-heavy-industries/arista-eapi/node' (DR-002)`,
      { commands: [] },
    )
  }

  const misplaced = FORBIDDEN_KEYS_BY_KIND[kind].filter((field) => effective[field] !== undefined)
  if (misplaced.length > 0) {
    throw new NotSupportedError(
      `profile ${JSON.stringify(profile.name)} sets ${misplaced.join(', ')} for transport kind ${JSON.stringify(kind)}, which has no such option, so those keys would do nothing. Either change the transport or remove the keys (MIGRATION.md §5 row 31)`,
      { commands: [] },
    )
  }

  const common = {
    ...(effective.timeoutMs === undefined ? {} : { timeoutMs: effective.timeoutMs }),
    ...(effective.nonce === undefined ? {} : { nonce: effective.nonce }),
    ...(effective.seed === undefined ? {} : { seed: effective.seed }),
    ...(effective.idStart === undefined ? {} : { idStart: effective.idStart }),
  }
  const endpoint = {
    ...(effective.host === undefined ? {} : { host: effective.host }),
    ...(effective.port === undefined ? {} : { port: effective.port }),
    ...(effective.path === undefined ? {} : { path: effective.path }),
    ...(effective.baseUrl === undefined ? {} : { baseUrl: effective.baseUrl }),
  }
  const credentials = {
    ...(effective.username === undefined ? {} : { username: effective.username }),
    ...(effective.password === undefined ? {} : { password: effective.password }),
  }

  switch (kind) {
    case 'https':
      return {
        kind: 'https',
        ...common,
        ...endpoint,
        ...credentials,
        ...tlsMaterialOptions(effective),
      }
    case 'http':
      return {
        kind: 'http',
        ...common,
        ...endpoint,
        ...credentials,
        ...(effective.allowInsecureTransport === undefined ? {} : { allowInsecureTransport: effective.allowInsecureTransport }),
      }
    case 'session':
      return {
        kind: 'session',
        ...common,
        ...endpoint,
        ...credentials,
        ...tlsMaterialOptions(effective),
        ...(effective.allowInsecureTransport === undefined ? {} : { allowInsecureTransport: effective.allowInsecureTransport }),
      }
    case 'https-client-cert': {
      // pyeapi's `HTTPSConnection` needs both halves of the identity and raises `ValueError` without
      // them (`eapilib.py:706-709`); M2 made that a `TypeError` at construction (MIGRATION.md §5 row 25),
      // so the profile path checks it here, where the message can name the profile.
      const cert = effective.cert
      const key = effective.key
      if (typeof cert !== 'string' || typeof key !== 'string') {
        throw new TypeError(
          `profile ${JSON.stringify(profile.name)} selects transport ${JSON.stringify('https_certs')} but sets no cert_file/cert and key_file/key: mTLS needs a client certificate **and** its key`,
        )
      }
      return {
        kind: 'https-client-cert',
        ...common,
        ...endpoint,
        ...credentials,
        ...tlsMaterialOptions(effective),
        cert,
        key,
      }
    }
    case 'unix':
      if (effective.allowLocalUnauthenticated !== true) throw profileWithoutLocalOptIn('unix')
      return {
        kind: 'unix',
        ...common,
        allowLocalUnauthenticated: true,
        ...(effective.socketPath === undefined ? {} : { socketPath: effective.socketPath }),
      }
    case 'http-local':
      if (effective.allowLocalUnauthenticated !== true) throw profileWithoutLocalOptIn('http-local')
      return {
        kind: 'http-local',
        ...common,
        allowLocalUnauthenticated: true,
        ...(effective.port === undefined ? {} : { port: effective.port }),
        ...(effective.path === undefined ? {} : { path: effective.path }),
      }
    case 'mock':
      // `createTransport` refuses this kind in both entries (M2 #4): a scripted device must be an
      // explicit dependency, so a profile can never point production code at a mock by accident.
      return { kind: 'mock', ...common }
    default: {
      const exhaustive: never = kind
      throw new NotSupportedError(
        `unhandled transport kind ${JSON.stringify(String(exhaustive))} for profile ${JSON.stringify(profile.name)}`,
        { commands: [] },
      )
    }
  }
}

/** DR-013 trust material, assembled once. `cert`/`key` are per-kind, so they stay at the call sites. */
function tlsMaterialOptions(effective: ConnectionProfile): Pick<HttpsTlsFields, 'ca' | 'serverName' | 'fingerprint' | 'dangerouslyDisableTlsVerification'> {
  return {
    ...(effective.ca === undefined ? {} : { ca: effective.ca }),
    ...(effective.serverName === undefined ? {} : { serverName: effective.serverName }),
    ...(effective.fingerprint === undefined ? {} : { fingerprint: effective.fingerprint }),
    ...(effective.dangerouslyDisableTlsVerification === undefined
      ? {}
      : { dangerouslyDisableTlsVerification: effective.dangerouslyDisableTlsVerification }),
  }
}

/** The trust-fields subset of `HttpsTransportOptions`, named once for {@link tlsMaterialOptions}. */
type HttpsTlsFields = Extract<TransportOptions, { kind: 'https' }>

/**
 * The per-`Node` settings a profile carries: pyeapi's `enablepwd` (`client.py:504`), which
 * `connect_to` folds into the `Node` kwargs (`client.py:1066`) rather than into the connection.
 */
export function profileNodeSettings(profile: ConnectionProfile): NodeSettings {
  return {
    ...(profile.enablePassword === undefined ? {} : { enablePassword: profile.enablePassword }),
  }
}
